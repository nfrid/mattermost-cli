import { scoreSurroundRelevance } from "../../context/helpers.ts";
import type { ContextThread } from "../../context/index.ts";
import { shouldRecommendFull } from "../../evidence/evidence.ts";
import type { PackedPost, PackedThread } from "../../evidence/packing.ts";
import {
	isMediaOnlyPost,
	largestTimelineSkip,
} from "../../evidence/packing.ts";
import {
	briefRetainedPostIds,
	buildThreadBrief,
	buildThreadSignals,
	type ThreadBrief,
	type ThreadSignals,
} from "../../evidence/signals.ts";
import {
	segmentThreadByTicketProximity,
	type TicketSegment,
} from "../../evidence/ticket-segments.ts";
import {
	extractEngineeringEntities,
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
} from "../../search/extract.ts";
import {
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../../search/match-utils.ts";
import {
	containsNormalizedText,
	normalizeSearchText,
} from "../../search/text.ts";
import { isoTimestamp } from "../shared.ts";
import {
	fileDownloadCommand,
	groupEvidencePosts,
	projectFile,
	projectMessage,
	projectTimeline,
	timelineSkips,
} from "./messages.ts";
import { finalizeRelatedTicketKeys } from "./related-tickets.ts";
import type {
	AgentAnchor,
	AgentAnchorKind,
	AgentBriefDecision,
	AgentBriefOpenQuestion,
	AgentCluster,
	AgentMessageGroup,
	AgentTechnicalEntity,
	AgentThread,
	AgentThreadAttachment,
	AgentThreadBrief,
	AgentThreadTail,
	AgentTimelineItem,
} from "./types.ts";

/** Cap technical entities emitted per agent thread. */
const TECHNICAL_ENTITY_CAP = 40;
/** Cap entries in the flat per-thread attachment index. */
const THREAD_ATTACHMENT_CAP = 50;

/**
 * Short mechanical markers that a thread stopped on trouble rather than on an
 * outcome. Substring matched after search normalization.
 */
const TAIL_ERROR_CUES: readonly string[] = [
	"ошибк",
	"упал",
	"завис",
	"не проход",
	"failed",
	"error",
];

export function projectContextThread(
	thread: ContextThread,
	options: {
		short: boolean;
		navigate: boolean;
		brief: boolean;
		/** Packed posts travel in the merged cross-thread timeline instead. */
		omitPosts?: boolean;
		includeSignals: boolean;
		rank: number;
		role: "primary" | "secondary";
		subjectTicket?: string;
		anchorPostId?: string;
	},
): AgentThread {
	const base = projectPackedThread(
		thread,
		thread.conversationAlias,
		thread.conversationKind,
		thread.link,
		{
			short: options.short,
			navigate: options.navigate,
			brief: options.brief,
			omitPosts: options.omitPosts,
			includeSignals: options.includeSignals,
			rank: options.rank,
			role: options.role,
			subjectTicket: options.subjectTicket,
			...(options.anchorPostId ? { anchorPostId: options.anchorPostId } : {}),
			matchingPostIds: thread.matchingPostIds,
			segments: thread.segments,
			ticketDensity: thread.ticketDensity,
			nearestTicketDistance: thread.nearestTicketDistance,
			reasons: thread.reasons,
		},
	);
	const lean = options.short || options.navigate || options.brief;
	if (!thread.surround?.length || lean) return base;
	const rootMessage =
		thread.posts.find((post) => post.id === thread.threadId)?.message ??
		thread.posts[0]?.message ??
		"";
	return {
		...base,
		surround: groupEvidencePosts(thread.surround),
		surroundRelevance: scoreSurroundRelevance(
			thread.surround,
			options.subjectTicket,
			rootMessage,
		),
	};
}

export function projectPackedThread(
	thread: PackedThread,
	conversation: string,
	kind: "channel" | "direct_message",
	url: string,
	options: {
		short?: boolean;
		navigate?: boolean;
		brief?: boolean;
		omitPosts?: boolean;
		includeSignals?: boolean;
		rank?: number;
		role?: "primary" | "secondary";
		subjectTicket?: string;
		matchingPostIds?: readonly string[];
		segments?: TicketSegment[];
		ticketDensity?: number;
		nearestTicketDistance?: number | null;
		reasons?: readonly string[];
		/** Requested post id, marked with `anchor` in the timeline. */
		anchorPostId?: string;
	} = {},
): AgentThread {
	const omittedNames = [
		...new Set(thread.omittedAttachments.map(({ name }) => name)),
	];
	const packingHints =
		thread.omittedPosts > 0 ? packingCompletenessHints(thread) : undefined;
	const clusters = compactClusters(options.segments);
	const cardMode = Boolean(options.short || options.navigate);
	const card = cardMode
		? evidenceCardFields(thread, {
				role: options.role ?? "primary",
				subjectTicket: options.subjectTicket,
				matchingPostIds: options.matchingPostIds ?? [],
				segments: options.segments,
			})
		: undefined;
	const includeSignals = Boolean(options.includeSignals);
	const technicalEntities = includeSignals
		? collectTechnicalEntities(thread.posts)
		: [];
	const signals = includeSignals
		? projectThreadSignals(thread.posts, options.subjectTicket)
		: undefined;
	const skips = options.navigate ? timelineSkips(thread.timeline) : undefined;
	const presentation =
		options.role === "secondary" &&
		options.reasons?.includes("multi_ticket_root")
			? ("announce" as const)
			: undefined;
	const domainBrief = buildThreadBrief(thread.posts, {
		subjectTicket: options.subjectTicket,
		reasons: options.reasons,
		presentation,
		omittedPosts: thread.omittedPosts,
	});
	const brief = projectThreadBrief(domainBrief);
	const filesPresent = thread.posts.some((post) => post.attachments.length > 0)
		? (true as const)
		: undefined;
	const attachmentIndex = collectThreadAttachments(thread);
	const latest = latestPackedPost(thread.posts);
	const tail = threadTail(thread, latest);
	return {
		threadId: thread.threadId,
		conversation,
		kind,
		url,
		omitted: {
			posts: thread.omittedPosts,
			attachments: thread.totalOmittedAttachments,
			...(omittedNames.length ? { files: omittedNames } : {}),
			...(thread.unreportedOmittedAttachments > 0
				? { unreportedAttachments: thread.unreportedOmittedAttachments }
				: {}),
		},
		messageCount: thread.posts.length,
		...(latest ? { latestAt: isoTimestamp(latest.createAt) } : {}),
		...(tail ? { tail } : {}),
		...(attachmentIndex.attachments.length
			? { attachments: attachmentIndex.attachments }
			: {}),
		...(attachmentIndex.truncated
			? { attachmentsTruncated: true as const }
			: {}),
		...(packingHints ?? {}),
		...(options.ticketDensity !== undefined
			? { ticketDensity: options.ticketDensity }
			: {}),
		...(options.nearestTicketDistance !== undefined
			? { nearestTicketDistance: options.nearestTicketDistance }
			: {}),
		...(options.rank !== undefined ? { rank: options.rank } : {}),
		...(options.role ? { role: options.role } : {}),
		...(presentation ? { presentation } : {}),
		...(filesPresent ? { filesPresent } : {}),
		...(!cardMode && clusters?.length ? { clusters } : {}),
		...(card ?? {}),
		...(technicalEntities.length ? { technicalEntities } : {}),
		...(signals ? { signals } : {}),
		...(brief ? { brief } : {}),
		...(skips?.length ? { skips } : {}),
		...(options.navigate || options.omitPosts
			? {}
			: {
					posts: options.brief
						? briefTimeline(thread, domainBrief, options.anchorPostId)
						: projectTimeline(thread.timeline, options.anchorPostId),
				}),
	};
}

/**
 * Decision-only timeline: the outcome window plus the posts the brief points
 * at. Packed posts the projection withholds collapse into `brief_projection`
 * skips — so shown messages plus those skips always equal the packed message
 * count — while packing's own skips pass through with their original reason.
 * Falls back to the last packed post when a thread yielded no brief at all.
 */
function briefTimeline(
	thread: PackedThread,
	brief: ThreadBrief,
	anchorPostId?: string,
): AgentTimelineItem[] {
	const kept = briefRetainedPostIds(brief, thread.posts, anchorPostId);
	const items: AgentTimelineItem[] = [];
	let group: AgentMessageGroup | undefined;
	let withheld = 0;
	let files = 0;
	let after: string | undefined;
	const flushGroup = () => {
		if (group) items.push(group);
		group = undefined;
	};
	const flushWithheld = (before?: string) => {
		if (withheld <= 0) return;
		flushGroup();
		items.push({
			skip: {
				posts: withheld,
				...(after ? { after } : {}),
				...(before ? { before } : {}),
				reason: "brief_projection",
				...(files > 0 ? { files } : {}),
			},
		});
		withheld = 0;
		files = 0;
	};
	for (const item of thread.timeline) {
		if (item.kind === "skip") {
			// Packing omissions keep their own reason and count: mixing them into
			// the projection skip would make neither number attributable.
			flushWithheld();
			flushGroup();
			items.push({ skip: item.skip });
			continue;
		}
		if (!kept.has(item.post.id)) {
			withheld += 1;
			files += item.post.attachments.filter(({ deleteAt }) => !deleteAt).length;
			continue;
		}
		flushWithheld(item.post.id);
		const message = projectMessage(item.post, anchorPostId);
		if (group && group.author === item.post.authorUsername) {
			group.messages.push(message);
		} else {
			flushGroup();
			group = { author: item.post.authorUsername, messages: [message] };
		}
		after = item.post.id;
	}
	flushWithheld();
	flushGroup();
	return items;
}

/**
 * Flat attachment index over returned posts first, then attachments carried by
 * omitted posts. `omittedAttachments` is itself budget-capped; the residual
 * count travels as `omitted.unreportedAttachments`.
 */
function collectThreadAttachments(thread: PackedThread): {
	attachments: AgentThreadAttachment[];
	truncated: boolean;
} {
	const attachments: AgentThreadAttachment[] = [];
	const seen = new Set<string>();
	const push = (
		attachment: PackedPost["attachments"][number],
		inPacket: boolean,
		mediaOnly = false,
	) => {
		if (attachment.deleteAt || seen.has(attachment.id)) return;
		seen.add(attachment.id);
		attachments.push({
			id: attachment.id,
			name: attachment.name,
			postId: attachment.postId,
			...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
			...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
			inPacket,
			...(mediaOnly ? { mediaOnly: true as const } : {}),
			downloadCommand: fileDownloadCommand(attachment.id),
		});
	};
	for (const post of thread.posts) {
		const mediaOnly = isMediaOnlyPost(post);
		for (const attachment of post.attachments)
			push(attachment, true, mediaOnly);
	}
	for (const attachment of thread.omittedAttachments) push(attachment, false);
	return {
		attachments: attachments.slice(0, THREAD_ATTACHMENT_CAP),
		truncated: attachments.length > THREAD_ATTACHMENT_CAP,
	};
}

function latestPackedPost(
	posts: readonly PackedPost[],
): PackedPost | undefined {
	let latest: PackedPost | undefined;
	for (const post of posts) {
		if (!latest || post.createAt > latest.createAt) latest = post;
	}
	return latest;
}

/**
 * Mechanical tail classification. Only for threads with nothing omitted — a
 * truncated packet has no standing to claim how the discussion ended.
 */
function threadTail(
	thread: PackedThread,
	latest: PackedPost | undefined,
): AgentThreadTail | undefined {
	if (!latest || thread.omittedPosts > 0 || latest.deleteAt) return undefined;
	const message = latest.message.trim();
	if (!message) return undefined;
	const kind = message.endsWith("?")
		? ("question" as const)
		: TAIL_ERROR_CUES.some((cue) => containsNormalizedText(message, cue))
			? ("error" as const)
			: undefined;
	if (!kind) return undefined;
	return { kind, postId: latest.id, at: isoTimestamp(latest.createAt) };
}

function projectThreadBrief(brief: ThreadBrief): AgentThreadBrief | undefined {
	if (
		!brief.purposeHints.length &&
		!brief.decisionPostIds.length &&
		!brief.openQuestions?.length &&
		!brief.outcomeWindow
	) {
		return undefined;
	}
	const decisions = (brief.decisions ?? []).map(
		(decision): AgentBriefDecision => ({
			id: decision.postId,
			author: decision.author,
			at: isoTimestamp(decision.createAt),
			text: decision.excerpt,
			...(decision.excerptTruncated ? { textTruncated: true as const } : {}),
			...(decision.ackPostId ? { ackPostId: decision.ackPostId } : {}),
			...(decision.refinements?.length
				? {
						refinements: decision.refinements.map((refinement) => ({
							id: refinement.postId,
							author: refinement.author,
							at: isoTimestamp(refinement.createAt),
							text: refinement.excerpt,
							...(refinement.excerptTruncated
								? { textTruncated: true as const }
								: {}),
						})),
					}
				: {}),
		}),
	);
	const openQuestions = (brief.openQuestions ?? []).map(
		(question): AgentBriefOpenQuestion => ({
			id: question.postId,
			author: question.author,
			at: isoTimestamp(question.createAt),
			text: question.excerpt,
			...(question.excerptTruncated ? { textTruncated: true as const } : {}),
			repliesAfter: question.repliesAfter,
			...(question.isThreadTail ? { isThreadTail: true as const } : {}),
		}),
	);
	return {
		purposeHints: brief.purposeHints,
		decisionPostIds: brief.decisionPostIds,
		...(decisions.length ? { decisions } : {}),
		...(openQuestions.length ? { openQuestions } : {}),
		...(brief.outcomeWindow ? { outcomeWindow: brief.outcomeWindow } : {}),
	};
}

function projectThreadSignals(
	posts: readonly PackedPost[],
	subjectTicket?: string,
): ThreadSignals | undefined {
	const signals = buildThreadSignals(posts, { subjectTicket });
	if (
		!signals.candidateSpans.length &&
		!signals.roleHints.length &&
		!signals.outcomeWindow
	) {
		return undefined;
	}
	return {
		candidateSpans: signals.candidateSpans,
		...(signals.outcomeWindow ? { outcomeWindow: signals.outcomeWindow } : {}),
		roleHints: signals.roleHints,
	};
}

function compactClusters(
	segments: TicketSegment[] | undefined,
): AgentCluster[] | undefined {
	if (!segments?.length) return undefined;
	return segments.map((segment) => ({
		startPostId: segment.startPostId,
		endPostId: segment.endPostId,
		posts: segment.posts,
		reason: segment.reason,
		...(segment.recommendHydrate ? { recommendHydrate: true } : {}),
	}));
}

function evidenceCardFields(
	thread: PackedThread,
	options: {
		role: "primary" | "secondary";
		subjectTicket?: string;
		matchingPostIds: readonly string[];
		segments?: TicketSegment[];
	},
): Pick<
	AgentThread,
	"role" | "span" | "anchors" | "clusters" | "relatedTicketsInThread"
> {
	const chronological = [...thread.posts].sort(
		(left, right) =>
			left.createAt - right.createAt || left.id.localeCompare(right.id),
	);
	const first = chronological[0];
	const last = chronological[chronological.length - 1];
	const segments =
		options.segments ??
		(options.subjectTicket
			? segmentThreadByTicketProximity(chronological, {
					subjectTicket: options.subjectTicket,
					matchingPostIds: options.matchingPostIds,
				}).segments
			: []);
	const relatedTicketsInThread = finalizeRelatedTicketKeys(
		new Set(chronological.flatMap((post) => extractTicketKeys(post.message))),
		options.subjectTicket,
	);
	return {
		role: options.role,
		span: {
			firstAt: isoTimestamp(first?.createAt ?? 0),
			lastAt: isoTimestamp(last?.createAt ?? 0),
			totalPosts: thread.totalPosts,
		},
		anchors: collectAnchors(chronological, {
			subjectTicket: options.subjectTicket,
			matchingPostIds: options.matchingPostIds,
			rootId: thread.threadId,
		}),
		clusters: compactClusters(segments) ?? [],
		relatedTicketsInThread,
	};
}

function collectAnchors(
	posts: readonly PackedPost[],
	options: {
		subjectTicket?: string;
		matchingPostIds: readonly string[];
		rootId: string;
	},
): AgentAnchor[] {
	// Insertion-ordered so anchors stay chronological, one entry per post.
	const anchors = new Map<string, AgentAnchor>();
	const push = (kind: AgentAnchorKind, anchor: Omit<AgentAnchor, "kinds">) => {
		const existing = anchors.get(anchor.postId);
		if (!existing) {
			anchors.set(anchor.postId, { kinds: [kind], ...anchor });
			return;
		}
		if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
		if (anchor.matched?.length) {
			existing.matched = [
				...new Set([...(existing.matched ?? []), ...anchor.matched]),
			];
		}
		if (!existing.files?.length && anchor.files?.length) {
			existing.files = anchor.files;
		}
		if (existing.text === undefined && anchor.text !== undefined) {
			existing.text = anchor.text;
		}
	};
	const subject = options.subjectTicket?.toUpperCase();
	const matchIds = new Set(options.matchingPostIds);
	for (const [index, post] of posts.entries()) {
		const keys = extractTicketKeys(post.message);
		if (index === 0 || post.id === options.rootId) {
			push("root", {
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
			});
		}
		if (subject && keys.includes(subject)) {
			push("ticket_mention", {
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
			});
		}
		if (matchIds.has(post.id)) {
			push("match_hit", {
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
				matched: subject ? [subject] : keys.slice(0, 3),
			});
		}
		const liveFiles = post.attachments.filter((file) => !file.deleteAt);
		if (liveFiles.length) {
			push("file", {
				postId: post.id,
				at: isoTimestamp(post.createAt),
				files: liveFiles.map((file) => projectFile(file)),
			});
		}
		if (keys.length >= MULTI_TICKET_BULLETIN_MIN_KEYS) {
			push("multi_ticket", {
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
				matched: keys,
			});
		}
		const entities = extractEngineeringEntities(post.message);
		if (
			/```/.test(post.message) ||
			entities.some((entity) =>
				["file_path", "symbol", "error_code"].includes(entity.kind),
			)
		) {
			push("codeish", {
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
			});
		}
	}
	const latest = posts[posts.length - 1];
	if (latest) {
		push("latest", {
			postId: latest.id,
			at: isoTimestamp(latest.createAt),
			text: truncateExcerpt(latest.message, POINTER_EXCERPT_LIMIT),
		});
	}
	return [...anchors.values()];
}

function packingCompletenessHints(thread: PackedThread): {
	recommendFull: boolean;
	largestSkip: number;
	omittedRatio: number;
} {
	const largestSkip = largestTimelineSkip(thread.timeline);
	const omittedRatio =
		thread.totalPosts > 0
			? Math.round((thread.omittedPosts / thread.totalPosts) * 100) / 100
			: 0;
	return {
		recommendFull: shouldRecommendFull(thread),
		largestSkip,
		omittedRatio,
	};
}

function collectTechnicalEntities(
	posts: readonly PackedPost[],
): AgentTechnicalEntity[] {
	const merged = new Map<string, AgentTechnicalEntity>();
	for (const post of posts) {
		const extracted = [
			...extractEngineeringEntities(post.message),
			...post.attachments
				.filter((file) => !file.deleteAt)
				.map((file) => ({
					kind: "attachment_filename" as const,
					value: file.name,
					normalizedValue: normalizeSearchText(file.name),
				})),
		];
		for (const entity of extracted) {
			if (!entity.normalizedValue) continue;
			const key = `${entity.kind}\0${entity.normalizedValue}`;
			const existing = merged.get(key);
			if (existing) {
				if (!existing.sourcePostIds.includes(post.id)) {
					existing.sourcePostIds.push(post.id);
				}
				continue;
			}
			merged.set(key, {
				kind: entity.kind,
				value: entity.value,
				sourcePostIds: [post.id],
			});
		}
	}
	return [...merged.values()]
		.sort(
			(left, right) =>
				left.kind.localeCompare(right.kind) ||
				left.value.localeCompare(right.value),
		)
		.slice(0, TECHNICAL_ENTITY_CAP);
}
