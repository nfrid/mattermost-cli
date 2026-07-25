import {
	isActionableDroppedCandidate,
	pickPrimaryThreadIndex,
	shouldRecommendInspectDropped,
} from "../context/selection.ts";
import type {
	ContextResult,
	ContextThread,
	DroppedCandidate,
	FreshnessEvidence,
	RemoteSearchEvidence,
	SelectionEvidence,
} from "../context/types.ts";
import { extractTicketKeys } from "../search/extract.ts";
import { isMediaOnlyPost, largestTimelineSkip } from "./packing.ts";

export type EvidenceAdequacy = "usable" | "thin" | "insufficient";
export type EvidenceCurrency = "current" | "possibly_stale" | "local_only";
export type EvidenceThreadCompleteness = "complete" | "truncated";
export type EvidenceIndexHistory = "full" | "cutoff_bounded";
export type EvidenceDiscoveryCurrency =
	| "current"
	| "possibly_stale"
	| "local_only";

export type EvidenceNextAction =
	| "thread_full"
	| "thread_around"
	| "sync"
	| "inspect_dropped"
	| "fresh_or_remote"
	| "read_attachments";

export type EvidenceNextPriority = "recommended" | "optional";

export type EvidenceNextImpact =
	| "may_recover_omitted_core"
	| "older_discovery_only"
	| "may_add_dropped_pointer"
	| "may_refresh_selected_or_discovery"
	| "may_contradict_visible_text";

export interface EvidenceNextStep {
	action: EvidenceNextAction;
	reason: string;
	priority: EvidenceNextPriority;
	impact: EvidenceNextImpact;
	/** Argv only — never a shell string. Omitted when no safe follow-up exists. */
	command?: string[];
	threadId?: string;
	conversationId?: string;
	/** Post carrying the evidence, for `read_attachments`. */
	postId?: string;
}

export interface EvidenceStatus {
	adequacy: EvidenceAdequacy;
	currency: EvidenceCurrency;
	completeness: {
		selectedThreads: EvidenceThreadCompleteness;
		indexHistory: EvidenceIndexHistory;
		/** Additive since schema version 2; absent in older packets. */
		discovery?: EvidenceDiscoveryCurrency;
	};
	next: EvidenceNextStep[];
	selection: {
		candidateThreads: number;
		returnedThreads: number;
		droppedThin: number;
		droppedByBudget: number;
		/**
		 * Candidates that survived ranking but carried no current content match
		 * once hydrated. A non-zero count with an empty `droppedCandidates` means
		 * the drops were ranking noise, not withheld evidence.
		 */
		droppedNoMatch: number;
		droppedCandidates: DroppedCandidate[];
	};
	packing: {
		omittedPosts: number;
		largestSkip: number;
		recommendFullThreadIds: string[];
	};
	/** Present only when some searched conversation has cutoff-bounded history. */
	history?: EvidenceHistory;
}

/**
 * Which conversations are cutoff-bounded and how far back they reach, so the
 * `incomplete_history` warning can be judged instead of guessed. Compare
 * `oldestIndexedAt` with the thread's `latestAt`, and weigh
 * `inSelectedThreads` — a bounded channel nobody selected rarely matters.
 */
export interface EvidenceHistory {
	cutoffBounded: Array<{
		alias: string;
		conversationId: string;
		/** ISO timestamp of the oldest indexed post; absent when never synced. */
		oldestIndexedAt?: string;
		inSelectedThreads: boolean;
	}>;
	/** Cutoff-bounded conversations beyond the reported cap. */
	additional?: number;
}

const RECOMMEND_FULL_MIN_OMITTED_RATIO = 0.25;
const RECOMMEND_FULL_MIN_LARGEST_SKIP = 5;

/** Deterministic evidence status for agents reading a context packet. */
export function buildEvidence(input: {
	searchCoverageComplete: boolean;
	selectedThreadsComplete: boolean;
	freshnessMode: ContextResult["freshnessMode"];
	freshness: readonly FreshnessEvidence[];
	searchedConversations: readonly { id: string }[];
	threads: readonly ContextThread[];
	remoteSearch: RemoteSearchEvidence;
	selection: SelectionEvidence;
	warnings: readonly { kind: string }[];
	freshenedConversationCount?: number;
	/** Selected threads are fresh locally or were hydrated during this request. */
	selectedEvidenceCurrent?: boolean;
	/** Subject string for follow-up argv (ticket key, post id, or text). */
	subject?: string;
	/** Subject ticket key, when the subject is a ticket. */
	subjectTicket?: string;
}): EvidenceStatus {
	const warningKinds = new Set(input.warnings.map(({ kind }) => kind));
	const cutoffBoundedConversations = input.freshness.filter(
		({ coverageComplete }) => !coverageComplete,
	).length;
	const staleRouted = input.freshness.filter(({ stale }) => stale).length;
	const localFallback =
		warningKinds.has("local_index_fallback") ||
		warningKinds.has("remote_hydrate_failed") ||
		warningKinds.has("remote_resolve_failed") ||
		warningKinds.has("remote_freshen_failed");

	const omittedPosts = input.threads.reduce(
		(sum, thread) => sum + thread.omittedPosts,
		0,
	);
	const largestSkip = input.threads.reduce(
		(max, thread) => Math.max(max, largestTimelineSkip(thread.timeline)),
		0,
	);
	const truncatedThreads = input.threads.filter((thread) =>
		shouldRecommendFull(thread),
	);
	const recommendFullThreadIds = truncatedThreads.map(
		({ threadId }) => threadId,
	);
	const rankedFullThreadIds = rankTruncatedThreads(
		truncatedThreads,
		input.threads[pickPrimaryThreadIndex(input.threads)]?.threadId,
	);

	const onlyThinThreads =
		input.threads.length > 0 &&
		input.threads.every((thread) => thread.reasons.includes("thin_thread"));

	const adequacy: EvidenceAdequacy = !input.threads.length
		? "insufficient"
		: onlyThinThreads
			? "thin"
			: "usable";

	const selectedEvidenceCurrent =
		input.selectedEvidenceCurrent ?? staleRouted === 0;
	const currency: EvidenceCurrency =
		input.freshnessMode === "local"
			? "local_only"
			: localFallback ||
					input.remoteSearch.failures > 0 ||
					!selectedEvidenceCurrent
				? "possibly_stale"
				: "current";
	const discovery: EvidenceDiscoveryCurrency =
		input.freshnessMode === "local"
			? "local_only"
			: staleRouted === 0 ||
					(input.remoteSearch.performed && input.remoteSearch.failures === 0)
				? "current"
				: "possibly_stale";

	const selectedThreads: EvidenceThreadCompleteness =
		!input.selectedThreadsComplete || recommendFullThreadIds.length > 0
			? "truncated"
			: "complete";
	const indexHistory: EvidenceIndexHistory =
		cutoffBoundedConversations > 0 ? "cutoff_bounded" : "full";

	const history = buildHistory(input.freshness, input.threads);
	const selectedMessages = input.threads.flatMap((thread) =>
		thread.posts.map(({ message }) => message),
	);
	const next = collectNextActions({
		rankedFullThreadIds,
		cutoffBoundedConversations,
		staleRouted,
		localFallback,
		localMode: input.freshnessMode === "local",
		remoteFailures: input.remoteSearch.failures,
		remoteSearchSuccessful:
			input.remoteSearch.performed && input.remoteSearch.failures === 0,
		selectedEvidenceCurrent,
		adequacy,
		currency,
		selectedThreadsComplete: selectedThreads === "complete",
		selectedMessages,
		droppedCandidates: input.selection.droppedCandidates,
		freshness: input.freshness,
		warningKinds,
		subject: input.subject,
		unreadOutcomeAttachment: findUnreadOutcomeAttachment(
			input.threads,
			input.subjectTicket,
		),
	});

	return {
		adequacy,
		currency,
		completeness: {
			selectedThreads,
			indexHistory,
			discovery,
		},
		next,
		selection: {
			candidateThreads: input.selection.candidateThreads,
			returnedThreads: input.selection.returnedThreads,
			droppedThin: input.selection.droppedThin,
			droppedByBudget: input.selection.droppedByBudget,
			droppedNoMatch: input.selection.droppedNoMatch,
			droppedCandidates: input.selection.droppedCandidates,
		},
		packing: {
			omittedPosts,
			largestSkip,
			recommendFullThreadIds,
		},
		...(history ? { history } : {}),
	};
}

/** Cutoff-bounded conversations reported per packet. */
const CUTOFF_BOUNDED_REPORT_CAP = 8;

/**
 * Selected-thread conversations first, then alias order: a bounded channel that
 * actually carried returned evidence is the one worth acting on.
 */
function buildHistory(
	freshness: readonly FreshnessEvidence[],
	threads: readonly ContextThread[],
): EvidenceHistory | undefined {
	const bounded = freshness.filter(({ coverageComplete }) => !coverageComplete);
	if (!bounded.length) return undefined;
	const selectedIds = new Set(
		threads.map(({ conversationId }) => conversationId),
	);
	const entries = bounded
		.map((item) => ({
			alias: item.alias,
			conversationId: item.conversationId,
			...(item.oldestCoveredAt
				? { oldestIndexedAt: new Date(item.oldestCoveredAt).toISOString() }
				: {}),
			inSelectedThreads: selectedIds.has(item.conversationId),
		}))
		.sort(
			(left, right) =>
				Number(right.inSelectedThreads) - Number(left.inSelectedThreads) ||
				left.alias.localeCompare(right.alias),
		);
	const additional = entries.length - CUTOFF_BOUNDED_REPORT_CAP;
	return {
		cutoffBounded: entries.slice(0, CUTOFF_BOUNDED_REPORT_CAP),
		...(additional > 0 ? { additional } : {}),
	};
}

/** One media-only post whose file is the thread's unread last word. */
interface UnreadOutcomeAttachment {
	threadId: string;
	postId: string;
	fileId: string;
	files: number;
}

/**
 * Media-only posts that land on the outcome side of the thread: after the last
 * packed mention of the subject ticket, or — with no subject ticket — as the
 * very last packed post. Such a post reads as empty in the timeline while
 * carrying the evidence that may contradict the surrounding text, so it is
 * worth one recommended download. Earlier media-only posts stay silent: they
 * are already visible as `mediaOnly` messages and in `attachments[]`.
 */
function findUnreadOutcomeAttachment(
	threads: readonly ContextThread[],
	subjectTicket?: string,
): UnreadOutcomeAttachment | undefined {
	const subject = subjectTicket?.toUpperCase();
	let best: (UnreadOutcomeAttachment & { createAt: number }) | undefined;
	for (const thread of threads) {
		const posts = [...thread.posts].sort(
			(left, right) =>
				left.createAt - right.createAt || left.id.localeCompare(right.id),
		);
		let anchorIndex = -1;
		if (subject) {
			for (const [index, post] of posts.entries()) {
				if (extractTicketKeys(post.message).includes(subject))
					anchorIndex = index;
			}
			if (anchorIndex < 0) continue;
		} else {
			anchorIndex = posts.length - 2;
		}
		for (const post of posts.slice(anchorIndex + 1)) {
			if (!isMediaOnlyPost(post)) continue;
			const live = post.attachments.filter(({ deleteAt }) => !deleteAt);
			const first = live[0];
			if (!first) continue;
			const candidate = {
				threadId: thread.threadId,
				postId: post.id,
				fileId: first.id,
				files: live.length,
				createAt: post.createAt,
			};
			if (
				!best ||
				candidate.createAt > best.createAt ||
				(candidate.createAt === best.createAt && candidate.postId < best.postId)
			) {
				best = candidate;
			}
		}
	}
	if (!best) return undefined;
	const { createAt: _createAt, ...found } = best;
	return found;
}

export function shouldRecommendFull(thread: {
	omittedPosts: number;
	totalPosts: number;
	timeline: ContextThread["timeline"];
}): boolean {
	if (thread.omittedPosts <= 0) return false;
	const largestSkip = largestTimelineSkip(thread.timeline);
	const omittedRatio =
		thread.totalPosts > 0 ? thread.omittedPosts / thread.totalPosts : 0;
	return (
		omittedRatio >= RECOMMEND_FULL_MIN_OMITTED_RATIO ||
		largestSkip >= RECOMMEND_FULL_MIN_LARGEST_SKIP
	);
}

/**
 * Truncated threads ordered so the single recommended `thread_full` is the most
 * valuable one: primary thread first, then the widest skip, then the largest
 * omitted ratio, then thread id for determinism.
 */
function rankTruncatedThreads(
	threads: readonly ContextThread[],
	primaryThreadId: string | undefined,
): string[] {
	return threads
		.map((thread) => ({
			threadId: thread.threadId,
			primaryRank: thread.threadId === primaryThreadId ? 0 : 1,
			largestSkip: largestTimelineSkip(thread.timeline),
			omittedRatio:
				thread.totalPosts > 0 ? thread.omittedPosts / thread.totalPosts : 0,
		}))
		.sort(
			(left, right) =>
				left.primaryRank - right.primaryRank ||
				right.largestSkip - left.largestSkip ||
				right.omittedRatio - left.omittedRatio ||
				(left.threadId < right.threadId
					? -1
					: left.threadId > right.threadId
						? 1
						: 0),
		)
		.map(({ threadId }) => threadId);
}

function collectNextActions(input: {
	/** Truncated threads, best first; only the first is `recommended`. */
	rankedFullThreadIds: readonly string[];
	cutoffBoundedConversations: number;
	staleRouted: number;
	localFallback: boolean;
	localMode: boolean;
	remoteFailures: number;
	remoteSearchSuccessful: boolean;
	selectedEvidenceCurrent: boolean;
	adequacy: EvidenceAdequacy;
	currency: EvidenceCurrency;
	selectedThreadsComplete: boolean;
	selectedMessages: readonly string[];
	droppedCandidates: readonly DroppedCandidate[];
	freshness: readonly FreshnessEvidence[];
	warningKinds: ReadonlySet<string>;
	subject?: string;
	unreadOutcomeAttachment?: UnreadOutcomeAttachment;
}): EvidenceNextStep[] {
	const next: EvidenceNextStep[] = [];
	const attachment = input.unreadOutcomeAttachment;
	if (attachment) {
		next.push({
			action: "read_attachments",
			reason:
				attachment.files > 1
					? "media_only_outcome_post_multiple_files"
					: "media_only_outcome_post",
			priority: "recommended",
			impact: "may_contradict_visible_text",
			command: ["mm", "file", attachment.fileId, "--agent"],
			threadId: attachment.threadId,
			postId: attachment.postId,
		});
	}
	for (const [index, threadId] of input.rankedFullThreadIds.entries()) {
		next.push({
			action: "thread_full",
			reason: "packing_incomplete",
			priority: index === 0 ? "recommended" : "optional",
			impact: "may_recover_omitted_core",
			command: ["mm", "thread", threadId, "--full", "--agent"],
			threadId,
		});
	}
	const historyIncomplete =
		input.cutoffBoundedConversations > 0 ||
		input.warningKinds.has("incomplete_history");
	const packetTrusted =
		input.adequacy === "usable" &&
		input.currency === "current" &&
		input.selectedThreadsComplete;
	if (historyIncomplete && !packetTrusted) {
		const incomplete = input.freshness.filter(
			({ coverageComplete }) => !coverageComplete,
		);
		const conversationId = incomplete[0]?.conversationId;
		const uniqueChannelAlias =
			incomplete.length === 1 ? incomplete[0]?.alias : undefined;
		next.push({
			action: "sync",
			reason: "incomplete_history",
			priority: "optional",
			impact: "older_discovery_only",
			command: uniqueChannelAlias
				? ["mm", "sync", "--channel", uniqueChannelAlias, "--agent"]
				: ["mm", "sync", "--agent"],
			...(conversationId ? { conversationId } : {}),
		});
	}
	const actionableDropped = input.droppedCandidates.find(
		(candidate) =>
			isActionableDroppedCandidate(candidate) &&
			shouldRecommendInspectDropped(candidate, input.selectedMessages),
	);
	if (actionableDropped) {
		const droppedThreadId = actionableDropped.threadId;
		next.push({
			action: "inspect_dropped",
			reason: "selection_dropped",
			priority: "optional",
			impact: "may_add_dropped_pointer",
			...(droppedThreadId
				? {
						command: ["mm", "thread", droppedThreadId, "--agent"],
						threadId: droppedThreadId,
					}
				: {}),
		});
	}
	if (
		input.localFallback ||
		input.remoteFailures > 0 ||
		(input.staleRouted > 0 &&
			(input.localMode ||
				(!input.remoteSearchSuccessful &&
					(!input.selectedEvidenceCurrent || input.adequacy !== "usable"))))
	) {
		next.push({
			action: "fresh_or_remote",
			reason: input.localFallback
				? "local_index_fallback"
				: input.remoteFailures > 0
					? "remote_search_failed"
					: "stale_local_index",
			priority: "optional",
			impact: "may_refresh_selected_or_discovery",
			...(input.subject
				? {
						command: ["mm", "context", input.subject, "--fresh", "--agent"],
					}
				: {}),
		});
	}
	return next;
}
