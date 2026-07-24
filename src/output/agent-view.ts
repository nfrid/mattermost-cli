import type {
	ContextResult,
	ContextThread,
	RelatedTicketPointer,
	SearchContextResult,
	ThreadResult,
} from "../context/index.ts";
import { buildEvidence, shouldRecommendFull } from "../evidence/evidence.ts";
import type {
	EvidencePost,
	PackedPost,
	PackedThread,
	PackTimelineItem,
} from "../evidence/packing.ts";
import { largestTimelineSkip } from "../evidence/packing.ts";
import {
	segmentThreadByTicketProximity,
	type TicketSegment,
} from "../evidence/ticket-segments.ts";
import {
	extractEngineeringEntities,
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
} from "../search/extract.ts";
import {
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../search/match-utils.ts";
import type {
	CommandResult,
	SCHEMA_VERSION,
	Warning,
} from "../shared/command-result.ts";
import { isoTimestamp, subjectValue } from "./shared.ts";

export interface AgentFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}

export interface AgentMessage {
	id: string;
	text: string;
	at?: string;
	editedAt?: string;
	deleted?: true;
	files?: AgentFile[];
}

/** Consecutive posts from one author, collapsed to reduce envelope noise. */
export interface AgentMessageGroup {
	author: string;
	messages: AgentMessage[];
}

/** Omitted chronological span between returned posts. */
export interface AgentSkip {
	skip: {
		posts: number;
		after?: string;
		before?: string;
		reason?: string;
	};
}

export type AgentTimelineItem = AgentMessageGroup | AgentSkip;

export interface AgentStatus {
	freshness: "local" | "network";
}

export interface AgentOmission {
	posts: number;
	attachments: number;
	files?: string[];
}

export interface AgentRelatedTicket {
	key: string;
	mentions: number;
	threadId?: string;
	url?: string;
	conversation?: string;
	latestAt?: string;
	excerpt?: string;
	sourceThreadId?: string;
	hydrated: false;
}

export type AgentAnchorKind =
	| "root"
	| "ticket_mention"
	| "match_hit"
	| "file"
	| "multi_ticket"
	| "codeish"
	| "latest";

export interface AgentAnchor {
	kind: AgentAnchorKind;
	postId: string;
	at: string;
	text?: string;
	matched?: string[];
	files?: Array<{ id: string; name: string; mimeType?: string }>;
}

export interface AgentCluster {
	startPostId: string;
	endPostId: string;
	posts: number;
	reason: TicketSegment["reason"];
	recommendHydrate?: boolean;
}

export interface AgentThread {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	omitted: AgentOmission;
	/** True when omit/skip is large enough that `mm thread --full` is warranted. */
	recommendFull?: boolean;
	largestSkip?: number;
	omittedRatio?: number;
	role?: "primary" | "secondary";
	span?: { firstAt: string; lastAt: string; totalPosts: number };
	anchors?: AgentAnchor[];
	clusters?: AgentCluster[];
	relatedTicketsInThread?: string[];
	ticketDensity?: number;
	nearestTicketDistance?: number | null;
	posts: AgentTimelineItem[];
	/** Prior DM root posts for short threads (not replies of this thread). */
	surround?: AgentMessageGroup[];
}

export interface AgentCandidate {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	latestAt: string;
	excerpts: string[];
}

export type AgentCommandResult =
	| {
			command: string;
			schemaVersion: typeof SCHEMA_VERSION;
			success: true;
			warnings: Warning[];
			[key: string]: unknown;
	  }
	| Extract<CommandResult<never>, { success: false }>;

const SHORT_MESSAGE_LIMIT = 8;

/** Build the compact agent view from the same validated result used by JSON output. */
export function projectAgentResult(
	result: CommandResult<unknown>,
): AgentCommandResult {
	if (!result.success) return result;

	const envelope = {
		command: result.command,
		schemaVersion: result.schemaVersion,
		success: true as const,
	};

	switch (result.command) {
		case "context":
			return projectContext(
				envelope,
				result.data as ContextResult,
				result.warnings,
			);
		case "search":
			return projectSearch(
				envelope,
				result.data as SearchContextResult,
				result.warnings,
			);
		case "thread":
			return projectThread(
				envelope,
				result.data as ThreadResult,
				result.warnings,
			);
		case "file":
			return {
				...envelope,
				...(isRecord(result.data) ? result.data : { result: result.data }),
				warnings: result.warnings,
			};
		default:
			return {
				...envelope,
				...(isRecord(result.data) ? result.data : { result: result.data }),
				warnings: result.warnings,
			};
	}
}

function projectContext(
	envelope: {
		command: string;
		schemaVersion: typeof SCHEMA_VERSION;
		success: true;
	},
	data: ContextResult,
	warnings: Warning[],
): AgentCommandResult {
	const relatedTickets = projectRelatedTickets(data.relatedTickets);
	const short = Boolean(data.short);
	const primaryIndex = pickPrimaryThreadIndex(data.threads);
	const threads = data.threads.map((thread, index) =>
		projectContextThread(thread, {
			short,
			role: index === primaryIndex ? "primary" : "secondary",
			subjectTicket:
				data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
		}),
	);
	const messages = short
		? shortMessagesFromThreads(data.threads, primaryIndex, SHORT_MESSAGE_LIMIT)
		: undefined;
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode),
		evidence:
			data.evidence ??
			buildEvidence({
				searchCoverageComplete: data.searchCoverageComplete,
				selectedThreadsComplete: data.selectedThreadsComplete,
				freshnessMode: data.freshnessMode,
				freshness: data.freshness,
				searchedConversations: data.searchedConversations,
				threads: data.threads,
				remoteSearch: data.remoteSearch,
				selection: data.selection ?? {
					candidateThreads: data.threads.length,
					returnedThreads: data.threads.length,
					droppedThin: 0,
					droppedByBudget: 0,
					droppedNoMatch: 0,
					droppedCandidates: [],
				},
				warnings,
			}),
		...(data.remoteSearch.performed || data.remoteSearch.requested
			? { remoteSearch: data.remoteSearch }
			: {}),
		...(relatedTickets.length ? { relatedTickets } : {}),
		...(messages?.length ? { messages } : {}),
		threads,
		warnings,
	};
}

function projectSearch(
	envelope: {
		command: string;
		schemaVersion: typeof SCHEMA_VERSION;
		success: true;
	},
	data: SearchContextResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode),
		candidates: data.candidates.map(
			(candidate): AgentCandidate => ({
				threadId: candidate.threadId,
				conversation: candidate.conversationAlias,
				kind: candidate.conversationKind,
				url: candidate.link,
				latestAt: isoTimestamp(candidate.latestActivityAt),
				excerpts: [...new Set(candidate.matches.map(({ excerpt }) => excerpt))],
			}),
		),
		warnings,
	};
}

function projectThread(
	envelope: {
		command: string;
		schemaVersion: typeof SCHEMA_VERSION;
		success: true;
	},
	data: ThreadResult,
	warnings: Warning[],
): AgentCommandResult {
	const relatedTickets = relatedTicketsFromPosts(
		data.thread.posts,
		data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
	);
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode),
		...(relatedTickets.length ? { relatedTickets } : {}),
		thread: projectPackedThread(
			data.thread,
			data.conversation.alias,
			data.conversation.kind,
			data.link,
		),
		warnings,
	};
}

function projectContextThread(
	thread: ContextThread,
	options: {
		short: boolean;
		role: "primary" | "secondary";
		subjectTicket?: string;
	},
): AgentThread {
	const base = projectPackedThread(
		thread,
		thread.conversationAlias,
		thread.conversationKind,
		thread.link,
		{
			short: options.short,
			role: options.role,
			subjectTicket: options.subjectTicket,
			matchingPostIds: thread.matchingPostIds,
			segments: thread.segments,
			ticketDensity: thread.ticketDensity,
			nearestTicketDistance: thread.nearestTicketDistance,
		},
	);
	return {
		...base,
		...(thread.surround?.length && !options.short
			? { surround: groupEvidencePosts(thread.surround) }
			: {}),
	};
}

function projectPackedThread(
	thread: PackedThread,
	conversation: string,
	kind: "channel" | "direct_message",
	url: string,
	options: {
		short?: boolean;
		role?: "primary" | "secondary";
		subjectTicket?: string;
		matchingPostIds?: readonly string[];
		segments?: TicketSegment[];
		ticketDensity?: number;
		nearestTicketDistance?: number | null;
	} = {},
): AgentThread {
	const omittedNames = [
		...new Set(thread.omittedAttachments.map(({ name }) => name)),
	];
	const packingHints =
		thread.omittedPosts > 0 ? packingCompletenessHints(thread) : undefined;
	const clusters = compactClusters(options.segments);
	const card = options.short
		? evidenceCardFields(thread, {
				role: options.role ?? "primary",
				subjectTicket: options.subjectTicket,
				matchingPostIds: options.matchingPostIds ?? [],
				segments: options.segments,
			})
		: undefined;
	return {
		threadId: thread.threadId,
		conversation,
		kind,
		url,
		omitted: {
			posts: thread.omittedPosts,
			attachments: thread.totalOmittedAttachments,
			...(omittedNames.length ? { files: omittedNames } : {}),
		},
		...(packingHints ?? {}),
		...(options.ticketDensity !== undefined
			? { ticketDensity: options.ticketDensity }
			: {}),
		...(options.nearestTicketDistance !== undefined
			? { nearestTicketDistance: options.nearestTicketDistance }
			: {}),
		...(options.role ? { role: options.role } : {}),
		...(!options.short && clusters?.length ? { clusters } : {}),
		...(card ?? {}),
		posts: projectTimeline(thread.timeline),
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
	const anchors: AgentAnchor[] = [];
	const seen = new Set<string>();
	const push = (anchor: AgentAnchor) => {
		const key = `${anchor.kind}:${anchor.postId}`;
		if (seen.has(key)) return;
		seen.add(key);
		anchors.push(anchor);
	};
	const subject = options.subjectTicket?.toUpperCase();
	const matchIds = new Set(options.matchingPostIds);
	for (const [index, post] of posts.entries()) {
		const keys = extractTicketKeys(post.message);
		if (index === 0 || post.id === options.rootId) {
			push({
				kind: "root",
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
			});
		}
		if (subject && keys.includes(subject)) {
			push({
				kind: "ticket_mention",
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
			});
		}
		if (matchIds.has(post.id)) {
			push({
				kind: "match_hit",
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
				matched: subject ? [subject] : keys.slice(0, 3),
			});
		}
		const liveFiles = post.attachments.filter((file) => !file.deleteAt);
		if (liveFiles.length) {
			push({
				kind: "file",
				postId: post.id,
				at: isoTimestamp(post.createAt),
				files: liveFiles.map((file) => ({
					id: file.id,
					name: file.name,
					...(file.mimeType ? { mimeType: file.mimeType } : {}),
				})),
			});
		}
		if (keys.length >= MULTI_TICKET_BULLETIN_MIN_KEYS) {
			push({
				kind: "multi_ticket",
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
			push({
				kind: "codeish",
				postId: post.id,
				at: isoTimestamp(post.createAt),
				text: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
			});
		}
	}
	const latest = posts[posts.length - 1];
	if (latest) {
		push({
			kind: "latest",
			postId: latest.id,
			at: isoTimestamp(latest.createAt),
			text: truncateExcerpt(latest.message, POINTER_EXCERPT_LIMIT),
		});
	}
	return anchors;
}

function shortMessagesFromThreads(
	threads: readonly ContextThread[],
	primaryIndex: number,
	limit: number,
): AgentMessage[] {
	const messages: AgentMessage[] = [];
	const order = [
		primaryIndex,
		...threads
			.map((_, index) => index)
			.filter((index) => index !== primaryIndex),
	];
	for (const index of order) {
		const thread = threads[index];
		if (!thread) continue;
		for (const item of thread.timeline) {
			if (item.kind !== "post") continue;
			messages.push(projectMessage(item.post));
			if (messages.length >= limit) return messages;
		}
	}
	return messages;
}

/** Prefer substantive / deeper threads over thin announce stubs for `role: primary`. */
function pickPrimaryThreadIndex(threads: readonly ContextThread[]): number {
	if (threads.length <= 1) return 0;
	let bestIndex = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const [index, thread] of threads.entries()) {
		const thin =
			thread.reasons.includes("thin_thread") ||
			thread.reasons.includes("multi_ticket_root");
		const substantive = thread.reasons.includes("substantive_thread_depth")
			? 20
			: 0;
		const score =
			(thin ? -100 : 0) +
			substantive +
			thread.totalPosts +
			Math.round((thread.ticketDensity ?? 0) * 5) -
			thread.omittedPosts * 0.01;
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return bestIndex;
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

function projectRelatedTickets(
	pointers: readonly RelatedTicketPointer[] | undefined,
): AgentRelatedTicket[] {
	if (!pointers?.length) return [];
	return pointers.map((pointer) => ({
		key: pointer.key,
		mentions: pointer.mentions,
		...(pointer.threadId ? { threadId: pointer.threadId } : {}),
		...(pointer.url ? { url: pointer.url } : {}),
		...(pointer.conversation ? { conversation: pointer.conversation } : {}),
		...(pointer.latestAt !== undefined
			? { latestAt: isoTimestamp(pointer.latestAt) }
			: {}),
		...(pointer.excerpt ? { excerpt: pointer.excerpt } : {}),
		...(pointer.sourceThreadId
			? { sourceThreadId: pointer.sourceThreadId }
			: {}),
		hydrated: false,
	}));
}

function relatedTicketsFromPosts(
	posts: readonly EvidencePost[],
	subjectTicket?: string,
): AgentRelatedTicket[] {
	const keys = finalizeRelatedTicketKeys(
		new Set(posts.flatMap((post) => extractTicketKeys(post.message))),
		subjectTicket,
	);
	return keys.map((key) => ({ key, mentions: 1, hydrated: false as const }));
}

function finalizeRelatedTicketKeys(
	keys: ReadonlySet<string>,
	subjectTicket?: string,
): string[] {
	const subject = subjectTicket?.toUpperCase();
	return [...keys]
		.filter((key) => key !== subject)
		.sort((left, right) => left.localeCompare(right));
}

function projectTimeline(
	timeline: readonly PackTimelineItem[],
): AgentTimelineItem[] {
	const items: AgentTimelineItem[] = [];
	let openGroup: AgentMessageGroup | undefined;

	const flushGroup = () => {
		if (openGroup) {
			items.push(openGroup);
			openGroup = undefined;
		}
	};

	for (const item of timeline) {
		if (item.kind === "skip") {
			flushGroup();
			items.push({ skip: item.skip });
			continue;
		}
		const message = projectMessage(item.post);
		if (openGroup && openGroup.author === item.post.authorUsername) {
			openGroup.messages.push(message);
			continue;
		}
		flushGroup();
		openGroup = {
			author: item.post.authorUsername,
			messages: [message],
		};
	}
	flushGroup();
	return items;
}

function groupEvidencePosts(
	posts: readonly EvidencePost[],
): AgentMessageGroup[] {
	return groupPosts(
		posts.map((post) => ({
			id: post.id,
			author: post.authorUsername,
			createAt: post.createAt,
			updateAt: post.updateAt,
			deleteAt: post.deleteAt,
			message: post.message,
			attachments: post.attachments,
		})),
	);
}

function groupPosts(
	posts: readonly {
		id: string;
		author: string;
		createAt: number;
		updateAt: number;
		deleteAt: number;
		message: string;
		attachments: PackedPost["attachments"];
	}[],
): AgentMessageGroup[] {
	const groups: AgentMessageGroup[] = [];
	for (const post of posts) {
		const message = projectMessage(post);
		const previous = groups[groups.length - 1];
		if (previous && previous.author === post.author) {
			previous.messages.push(message);
			continue;
		}
		groups.push({
			author: post.author,
			messages: [message],
		});
	}
	return groups;
}

function projectMessage(post: {
	id: string;
	createAt: number;
	updateAt: number;
	deleteAt: number;
	message: string;
	attachments: PackedPost["attachments"];
}): AgentMessage {
	const files = post.attachments.map((attachment) => ({
		id: attachment.id,
		name: attachment.name,
		...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
		...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
	}));
	return {
		id: post.id,
		text: post.message,
		at: isoTimestamp(post.createAt),
		...(post.updateAt > post.createAt
			? { editedAt: isoTimestamp(post.updateAt) }
			: {}),
		...(post.deleteAt ? { deleted: true as const } : {}),
		...(files.length ? { files } : {}),
	};
}

function status(freshnessMode: "local" | "network" | "forced"): AgentStatus {
	return {
		freshness: freshnessMode === "local" ? "local" : "network",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
