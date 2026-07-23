import type {
	ContextResult,
	ContextThread,
	FreshnessEvidence,
	RemoteSearchEvidence,
	SelectionEvidence,
} from "../context/types.ts";
import { largestTimelineSkip } from "./packing.ts";

export type CoverageTrust = "high" | "partial" | "low";

export type CoverageGapCode =
	| "incomplete_history"
	| "search_deadline"
	| "stale_local_index"
	| "remote_search_failed"
	| "remote_search_unavailable"
	| "local_index_fallback"
	| "freshen_lock_busy"
	| "packing_omitted_between_ticket_anchors"
	| "packing_incomplete"
	| "selection_dropped_thin"
	| "selection_dropped_budget"
	| "no_results";

export interface CoverageEvidence {
	trust: CoverageTrust;
	search: {
		complete: boolean;
		conversationsSearched: number;
		conversationsWithHits: number;
		cutoffBoundedConversations: number;
		deadlineHit: boolean;
	};
	freshness: {
		mode: "local" | "network" | "forced";
		staleRouted: number;
		freshened: number;
		localFallback: boolean;
	};
	remoteSearch: {
		performed: boolean;
		reason: RemoteSearchEvidence["reason"] | "local_already_sufficient" | null;
		probes: number;
		acceptedPosts: number;
		candidateThreads: number;
		failures: number;
	};
	selection: {
		candidateThreads: number;
		returnedThreads: number;
		droppedThin: number;
		droppedByBudget: number;
	};
	packing: {
		threadsComplete: boolean;
		omittedPosts: number;
		largestSkip: number;
		recommendFullThreadIds: string[];
	};
	gaps: CoverageGapCode[];
}

const RECOMMEND_FULL_MIN_OMITTED_RATIO = 0.25;
const RECOMMEND_FULL_MIN_LARGEST_SKIP = 5;

/** Deterministic coverage summary for agents reading a context packet. */
export function buildCoverage(input: {
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
}): CoverageEvidence {
	const warningKinds = new Set(input.warnings.map(({ kind }) => kind));
	const conversationsWithHits = new Set(
		input.threads.map(({ conversationId }) => conversationId),
	).size;
	const cutoffBoundedConversations = input.freshness.filter(
		({ coverageComplete }) => !coverageComplete,
	).length;
	const staleRouted = input.freshness.filter(({ stale }) => stale).length;
	const deadlineHit = warningKinds.has("search_deadline");
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

	const remoteAcceptedPosts = input.remoteSearch.queries.reduce(
		(sum, query) => sum + query.acceptedPosts,
		0,
	);
	const remoteReason =
		input.remoteSearch.performed || input.remoteSearch.requested
			? input.remoteSearch.reason
			: input.threads.length > 0
				? ("local_already_sufficient" as const)
				: null;

	const gaps = collectGaps({
		warningKinds,
		cutoffBoundedConversations,
		deadlineHit,
		staleRouted,
		localMode: input.freshnessMode === "local",
		selectedThreadsComplete: input.selectedThreadsComplete,
		recommendFullThreadIds,
		threads: input.threads,
		selection: input.selection,
		remoteFailures: input.remoteSearch.failures,
	});

	return {
		trust: trustLevel({
			searchComplete: input.searchCoverageComplete,
			threadsComplete: input.selectedThreadsComplete,
			deadlineHit,
			cutoffBoundedConversations,
			localFallback,
			remoteFailures: input.remoteSearch.failures,
			recommendFull: recommendFullThreadIds.length > 0,
			noResults: input.threads.length === 0,
			returnedThreads: input.selection.returnedThreads,
			gaps,
		}),
		search: {
			complete: input.searchCoverageComplete,
			conversationsSearched: input.searchedConversations.length,
			conversationsWithHits,
			cutoffBoundedConversations,
			deadlineHit,
		},
		freshness: {
			mode: input.freshnessMode,
			staleRouted,
			freshened: input.freshenedConversationCount ?? 0,
			localFallback,
		},
		remoteSearch: {
			performed: input.remoteSearch.performed,
			reason: remoteReason,
			probes: input.remoteSearch.queries.length,
			acceptedPosts: remoteAcceptedPosts,
			candidateThreads: input.remoteSearch.candidateThreads,
			failures: input.remoteSearch.failures,
		},
		selection: {
			candidateThreads: input.selection.candidateThreads,
			returnedThreads: input.selection.returnedThreads,
			droppedThin: input.selection.droppedThin,
			droppedByBudget: input.selection.droppedByBudget,
		},
		packing: {
			threadsComplete: input.selectedThreadsComplete,
			omittedPosts,
			largestSkip,
			recommendFullThreadIds,
		},
		gaps,
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

function trustLevel(input: {
	searchComplete: boolean;
	threadsComplete: boolean;
	deadlineHit: boolean;
	cutoffBoundedConversations: number;
	localFallback: boolean;
	remoteFailures: number;
	recommendFull: boolean;
	noResults: boolean;
	returnedThreads: number;
	gaps: readonly CoverageGapCode[];
}): CoverageTrust {
	if (input.noResults) return "low";
	const hardDegrade =
		input.deadlineHit || input.localFallback || input.remoteFailures > 0;
	if (hardDegrade) {
		return input.searchComplete && !input.recommendFull ? "partial" : "low";
	}
	// Cutoff-bounded history alone is incomplete, not untrustworthy, when we
	// already returned usable threads.
	if (
		!input.searchComplete ||
		!input.threadsComplete ||
		input.recommendFull ||
		input.cutoffBoundedConversations > 0 ||
		input.gaps.includes("incomplete_history")
	) {
		return "partial";
	}
	if (input.returnedThreads <= 0) return "low";
	return "high";
}

function collectGaps(input: {
	warningKinds: ReadonlySet<string>;
	cutoffBoundedConversations: number;
	deadlineHit: boolean;
	staleRouted: number;
	localMode: boolean;
	selectedThreadsComplete: boolean;
	recommendFullThreadIds: readonly string[];
	threads: readonly ContextThread[];
	selection: SelectionEvidence;
	remoteFailures: number;
}): CoverageGapCode[] {
	const gaps: CoverageGapCode[] = [];
	const push = (code: CoverageGapCode) => {
		if (!gaps.includes(code)) gaps.push(code);
	};

	if (
		input.cutoffBoundedConversations > 0 ||
		input.warningKinds.has("incomplete_history")
	) {
		push("incomplete_history");
	}
	if (input.deadlineHit) push("search_deadline");
	if (input.localMode && input.staleRouted > 0) push("stale_local_index");
	if (
		input.warningKinds.has("remote_search_failed") ||
		input.remoteFailures > 0
	) {
		push("remote_search_failed");
	}
	if (input.warningKinds.has("remote_search_unavailable")) {
		push("remote_search_unavailable");
	}
	if (input.warningKinds.has("local_index_fallback"))
		push("local_index_fallback");
	if (input.warningKinds.has("freshen_lock_busy")) push("freshen_lock_busy");
	if (!input.selectedThreadsComplete) push("packing_incomplete");
	if (
		input.threads.some((thread) =>
			thread.timeline.some(
				(item) =>
					item.kind === "skip" &&
					item.skip.reason === "outside_ticket_window" &&
					item.skip.posts >= RECOMMEND_FULL_MIN_LARGEST_SKIP,
			),
		) ||
		input.recommendFullThreadIds.length > 0
	) {
		if (
			input.threads.some((thread) =>
				thread.timeline.some(
					(item) =>
						item.kind === "skip" &&
						(item.skip.reason === "outside_ticket_window" ||
							item.skip.reason === "omitted_gap"),
				),
			)
		) {
			push("packing_omitted_between_ticket_anchors");
		}
	}
	if (input.selection.droppedThin > 0) push("selection_dropped_thin");
	if (input.selection.droppedByBudget > 0) push("selection_dropped_budget");
	if (!input.threads.length) push("no_results");
	return gaps;
}
