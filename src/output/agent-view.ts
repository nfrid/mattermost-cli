import { scoreSurroundRelevance } from "../context/helpers.ts";
import type {
	ContextResult,
	ContextThread,
	RelatedTicketPointer,
	SearchContextResult,
	ThreadResult,
} from "../context/index.ts";
import { pickPrimaryThreadIndex } from "../context/selection.ts";
import type { SurroundRelevance } from "../context/types.ts";
import { buildEvidence, shouldRecommendFull } from "../evidence/evidence.ts";
import type {
	EvidencePost,
	PackedPost,
	PackedThread,
	PackTimelineItem,
} from "../evidence/packing.ts";
import { largestTimelineSkip } from "../evidence/packing.ts";
import {
	buildThreadBrief,
	buildThreadSignals,
	type ThreadBrief,
	type ThreadSignals,
} from "../evidence/signals.ts";
import {
	segmentThreadByTicketProximity,
	type TicketSegment,
} from "../evidence/ticket-segments.ts";
import {
	type EngineeringEntityKind,
	extractEngineeringEntities,
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
} from "../search/extract.ts";
import {
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../search/match-utils.ts";
import { normalizeSearchText } from "../search/text.ts";
import type {
	CommandResult,
	SCHEMA_VERSION,
	Warning,
} from "../shared/command-result.ts";
import type { FileBatchDownloadResult } from "../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../sync/file-download.ts";
import { isoTimestamp, subjectValue } from "./shared.ts";

export type {
	CandidateSpan,
	CandidateSpanKind,
	OutcomeWindow,
	PurposeHint,
	PurposeHintLabel,
	RoleHint,
	RoleHintLabel,
	ThreadBrief,
	ThreadSignals,
} from "../evidence/signals.ts";

export interface AgentFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	/** Argv segments only — copy; never auto-exec or join into a shell string. */
	downloadCommand: string[];
}

export interface AgentTechnicalEntity {
	kind: EngineeringEntityKind;
	value: string;
	sourcePostIds: string[];
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
	/** True when the related target is already visible in the selected packet. */
	alreadyInPacket?: true;
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
	files?: AgentFile[];
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
	/**
	 * Narrow consumption hint. `announce` marks secondary multi-ticket bulletin
	 * roots (`multi_ticket_root`); never replaces `role`.
	 */
	presentation?: "announce";
	span?: { firstAt: string; lastAt: string; totalPosts: number };
	anchors?: AgentAnchor[];
	clusters?: AgentCluster[];
	relatedTicketsInThread?: string[];
	ticketDensity?: number;
	nearestTicketDistance?: number | null;
	/**
	 * Dense author-group timeline. Omitted for `--navigate` (use anchors /
	 * clusters / skips instead).
	 */
	posts?: AgentTimelineItem[];
	/** Skip markers extracted for lean `--navigate` projection. */
	skips?: AgentSkip["skip"][];
	/** Engineering entities from packed posts only (capped). */
	technicalEntities?: AgentTechnicalEntity[];
	/**
	 * Advisory candidate spans / roleHints / mechanical outcome window from
	 * packed posts only. Never authoritative decisions or ranking input.
	 */
	signals?: ThreadSignals;
	/**
	 * Lean default-agent briefing from packed posts. Present for both default
	 * `--agent` and `--signals` (alongside full signals when requested).
	 * Omitted when empty.
	 */
	brief?: ThreadBrief;
	/** True when any packed post carries attachments (even with empty text). */
	filesPresent?: true;
	/** Prior DM root posts for short threads (not replies of this thread). */
	surround?: AgentMessageGroup[];
	/** Skip guidance for attached surround; only when surround is present. */
	surroundRelevance?: SurroundRelevance;
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
/** Cap technical entities emitted per agent thread. */
const TECHNICAL_ENTITY_CAP = 40;

function fileDownloadCommand(id: string): string[] {
	return ["mm", "file", id];
}

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
			return projectFileDownload(
				envelope,
				result.data as FileDownloadResult,
				result.warnings,
			);
		case "files":
			return projectFiles(
				envelope,
				result.data as FileBatchDownloadResult,
				result.warnings,
			);
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
	const navigate = Boolean(data.navigate);
	const short = Boolean(data.short);
	const includeSignals = Boolean(data.signals);
	const primaryIndex = pickPrimaryThreadIndex(data.threads);
	const threads = data.threads.map((thread, index) =>
		projectContextThread(thread, {
			short,
			navigate,
			includeSignals,
			role: index === primaryIndex ? "primary" : "secondary",
			subjectTicket:
				data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
		}),
	);
	const messages =
		short && !navigate
			? shortMessagesFromThreads(
					data.threads,
					primaryIndex,
					SHORT_MESSAGE_LIMIT,
				)
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
				subject: subjectValue(data.subject),
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
	const projected = projectPackedThread(
		data.thread,
		data.conversation.alias,
		data.conversation.kind,
		data.link,
		{
			includeSignals: Boolean(data.signals),
			subjectTicket:
				data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
		},
	);
	const contextThread: ContextThread = {
		...data.thread,
		conversationId: data.conversation.id,
		conversationAlias: data.conversation.alias,
		conversationKind: data.conversation.kind,
		reasons: [],
		matchingPostIds: [],
		latestActivityAt:
			data.thread.posts.at(-1)?.createAt ?? data.freshness.observedAt,
		link: data.link,
	};
	const selectedEvidenceCurrent =
		data.freshnessMode !== "local" || !data.freshness.stale;
	const evidence = buildEvidence({
		searchCoverageComplete: data.complete,
		selectedThreadsComplete:
			data.thread.omittedPosts === 0 &&
			data.thread.totalOmittedAttachments === 0,
		freshnessMode: data.freshnessMode,
		freshness: [data.freshness],
		searchedConversations: [{ id: data.conversation.id }],
		threads: [contextThread],
		remoteSearch: {
			requested: false,
			performed: false,
			reason: null,
			queries: [],
			candidateThreads: 0,
			failures: 0,
		},
		selection: {
			candidateThreads: 1,
			returnedThreads: 1,
			droppedThin: 0,
			droppedByBudget: 0,
			droppedNoMatch: 0,
			droppedCandidates: [],
		},
		warnings,
		selectedEvidenceCurrent,
		subject: subjectValue(data.subject),
	});
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode),
		...(relatedTickets.length ? { relatedTickets } : {}),
		evidence,
		thread: projected,
		threads: [projected],
		warnings,
	};
}

/** Flatten single-file download metadata only — never file bytes. */
function projectFileDownload(
	envelope: {
		command: string;
		schemaVersion: typeof SCHEMA_VERSION;
		success: true;
	},
	data: FileDownloadResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		id: data.id,
		name: data.name,
		mimeType: data.mimeType,
		size: data.size,
		path: data.path,
		postId: data.postId,
		conversationId: data.conversationId,
		warnings,
	};
}

/** Flatten batch download metadata only — never file bytes. */
function projectFiles(
	envelope: {
		command: string;
		schemaVersion: typeof SCHEMA_VERSION;
		success: true;
	},
	data: FileBatchDownloadResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		outDir: data.outDir,
		selector: data.selector,
		limits: data.limits,
		downloaded: data.downloaded,
		failed: data.failed,
		skipped: data.skipped,
		totalBytes: data.totalBytes,
		files: data.files.map((item) => {
			if (item.status === "downloaded") {
				return {
					status: "downloaded" as const,
					id: item.id,
					name: item.name,
					mimeType: item.mimeType,
					size: item.size,
					path: item.path,
					postId: item.postId,
					conversationId: item.conversationId,
				};
			}
			return {
				status: item.status,
				...(item.id ? { id: item.id } : {}),
				...(item.name ? { name: item.name } : {}),
				error: item.error,
			};
		}),
		warnings,
	};
}

function projectContextThread(
	thread: ContextThread,
	options: {
		short: boolean;
		navigate: boolean;
		includeSignals: boolean;
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
			navigate: options.navigate,
			includeSignals: options.includeSignals,
			role: options.role,
			subjectTicket: options.subjectTicket,
			matchingPostIds: thread.matchingPostIds,
			segments: thread.segments,
			ticketDensity: thread.ticketDensity,
			nearestTicketDistance: thread.nearestTicketDistance,
			reasons: thread.reasons,
		},
	);
	const lean = options.short || options.navigate;
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

function projectPackedThread(
	thread: PackedThread,
	conversation: string,
	kind: "channel" | "direct_message",
	url: string,
	options: {
		short?: boolean;
		navigate?: boolean;
		includeSignals?: boolean;
		role?: "primary" | "secondary";
		subjectTicket?: string;
		matchingPostIds?: readonly string[];
		segments?: TicketSegment[];
		ticketDensity?: number;
		nearestTicketDistance?: number | null;
		reasons?: readonly string[];
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
	const brief = projectThreadBrief(thread.posts, {
		subjectTicket: options.subjectTicket,
		reasons: options.reasons,
		presentation,
	});
	const filesPresent = thread.posts.some((post) => post.attachments.length > 0)
		? (true as const)
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
		...(presentation ? { presentation } : {}),
		...(filesPresent ? { filesPresent } : {}),
		...(!cardMode && clusters?.length ? { clusters } : {}),
		...(card ?? {}),
		...(technicalEntities.length ? { technicalEntities } : {}),
		...(signals ? { signals } : {}),
		...(brief ? { brief } : {}),
		...(skips?.length ? { skips } : {}),
		...(options.navigate ? {} : { posts: projectTimeline(thread.timeline) }),
	};
}

function projectThreadBrief(
	posts: readonly PackedPost[],
	options: {
		subjectTicket?: string;
		reasons?: readonly string[];
		presentation?: "announce";
	},
): ThreadBrief | undefined {
	const brief = buildThreadBrief(posts, options);
	if (
		!brief.purposeHints.length &&
		!brief.decisionPostIds.length &&
		!brief.outcomeWindow
	) {
		return undefined;
	}
	return {
		purposeHints: brief.purposeHints,
		decisionPostIds: brief.decisionPostIds,
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
				files: liveFiles.map((file) => projectFile(file)),
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
		...(pointer.alreadyInPacket ? { alreadyInPacket: true as const } : {}),
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
	const files = post.attachments.map((attachment) => projectFile(attachment));
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

function projectFile(attachment: {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}): AgentFile {
	return {
		id: attachment.id,
		name: attachment.name,
		...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
		...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
		downloadCommand: fileDownloadCommand(attachment.id),
	};
}

function timelineSkips(
	timeline: readonly PackTimelineItem[],
): AgentSkip["skip"][] {
	return timeline
		.filter(
			(item): item is Extract<PackTimelineItem, { kind: "skip" }> =>
				item.kind === "skip",
		)
		.map((item) => item.skip);
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

function status(freshnessMode: "local" | "network" | "forced"): AgentStatus {
	return {
		freshness: freshnessMode === "local" ? "local" : "network",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
