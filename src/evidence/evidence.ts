import type {
	ContextResult,
	ContextThread,
	DroppedCandidate,
	FreshnessEvidence,
	RemoteSearchEvidence,
	SelectionEvidence,
} from "../context/types.ts";
import { largestTimelineSkip } from "./packing.ts";

export type EvidenceAdequacy = "usable" | "thin" | "insufficient";
export type EvidenceCurrency = "current" | "possibly_stale" | "local_only";
export type EvidenceThreadCompleteness = "complete" | "truncated";
export type EvidenceIndexHistory = "full" | "cutoff_bounded";

export type EvidenceNextAction =
	| "thread_full"
	| "sync"
	| "inspect_dropped"
	| "fresh_or_remote";

export interface EvidenceNextStep {
	action: EvidenceNextAction;
	reason: string;
	threadId?: string;
	conversationId?: string;
}

export interface EvidenceStatus {
	adequacy: EvidenceAdequacy;
	currency: EvidenceCurrency;
	completeness: {
		selectedThreads: EvidenceThreadCompleteness;
		indexHistory: EvidenceIndexHistory;
	};
	next: EvidenceNextStep[];
	selection: {
		candidateThreads: number;
		returnedThreads: number;
		droppedThin: number;
		droppedByBudget: number;
		droppedCandidates: DroppedCandidate[];
	};
	packing: {
		omittedPosts: number;
		largestSkip: number;
		recommendFullThreadIds: string[];
	};
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
	const recommendFullThreadIds = input.threads
		.filter((thread) => shouldRecommendFull(thread))
		.map(({ threadId }) => threadId);

	const onlyThinThreads =
		input.threads.length > 0 &&
		input.threads.every((thread) => thread.reasons.includes("thin_thread"));

	const adequacy: EvidenceAdequacy = !input.threads.length
		? "insufficient"
		: onlyThinThreads
			? "thin"
			: "usable";

	const currency: EvidenceCurrency =
		input.freshnessMode === "local"
			? "local_only"
			: staleRouted > 0 || localFallback || input.remoteSearch.failures > 0
				? "possibly_stale"
				: "current";

	const selectedThreads: EvidenceThreadCompleteness =
		!input.selectedThreadsComplete || recommendFullThreadIds.length > 0
			? "truncated"
			: "complete";
	const indexHistory: EvidenceIndexHistory =
		cutoffBoundedConversations > 0 ? "cutoff_bounded" : "full";

	const next = collectNextActions({
		recommendFullThreadIds,
		cutoffBoundedConversations,
		staleRouted,
		localFallback,
		localMode: input.freshnessMode === "local",
		remoteFailures: input.remoteSearch.failures,
		droppedCandidates: input.selection.droppedCandidates,
		freshness: input.freshness,
		warningKinds,
	});

	return {
		adequacy,
		currency,
		completeness: {
			selectedThreads,
			indexHistory,
		},
		next,
		selection: {
			candidateThreads: input.selection.candidateThreads,
			returnedThreads: input.selection.returnedThreads,
			droppedThin: input.selection.droppedThin,
			droppedByBudget: input.selection.droppedByBudget,
			droppedCandidates: input.selection.droppedCandidates,
		},
		packing: {
			omittedPosts,
			largestSkip,
			recommendFullThreadIds,
		},
	};
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

function collectNextActions(input: {
	recommendFullThreadIds: readonly string[];
	cutoffBoundedConversations: number;
	staleRouted: number;
	localFallback: boolean;
	localMode: boolean;
	remoteFailures: number;
	droppedCandidates: readonly DroppedCandidate[];
	freshness: readonly FreshnessEvidence[];
	warningKinds: ReadonlySet<string>;
}): EvidenceNextStep[] {
	const next: EvidenceNextStep[] = [];
	for (const threadId of input.recommendFullThreadIds) {
		next.push({
			action: "thread_full",
			reason: "packing_incomplete",
			threadId,
		});
	}
	if (
		input.cutoffBoundedConversations > 0 ||
		input.warningKinds.has("incomplete_history")
	) {
		const conversationId = input.freshness.find(
			({ coverageComplete }) => !coverageComplete,
		)?.conversationId;
		next.push({
			action: "sync",
			reason: "incomplete_history",
			...(conversationId ? { conversationId } : {}),
		});
	}
	if (input.droppedCandidates.length > 0) {
		next.push({
			action: "inspect_dropped",
			reason: "selection_dropped",
		});
	}
	if (
		input.localFallback ||
		input.remoteFailures > 0 ||
		(input.localMode && input.staleRouted > 0) ||
		(!input.localMode && input.staleRouted > 0)
	) {
		next.push({
			action: "fresh_or_remote",
			reason: input.localFallback
				? "local_index_fallback"
				: input.remoteFailures > 0
					? "remote_search_failed"
					: "stale_local_index",
		});
	}
	return next;
}
