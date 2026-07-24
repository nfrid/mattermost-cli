import {
	isActionableDroppedCandidate,
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
import { largestTimelineSkip } from "./packing.ts";

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
	| "fresh_or_remote";

export type EvidenceNextPriority = "recommended" | "optional";

export type EvidenceNextImpact =
	| "may_recover_omitted_core"
	| "older_discovery_only"
	| "may_add_dropped_pointer"
	| "may_refresh_selected_or_discovery";

export interface EvidenceNextStep {
	action: EvidenceNextAction;
	reason: string;
	priority: EvidenceNextPriority;
	impact: EvidenceNextImpact;
	/** Argv only — never a shell string. Omitted when no safe follow-up exists. */
	command?: string[];
	threadId?: string;
	conversationId?: string;
}

export interface EvidenceStatus {
	adequacy: EvidenceAdequacy;
	currency: EvidenceCurrency;
	completeness: {
		selectedThreads: EvidenceThreadCompleteness;
		indexHistory: EvidenceIndexHistory;
		/** Additive schema-version-2 field; absent in older packets. */
		discovery?: EvidenceDiscoveryCurrency;
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
	/** Selected threads are fresh locally or were hydrated during this request. */
	selectedEvidenceCurrent?: boolean;
	/** Subject string for follow-up argv (ticket key, post id, or text). */
	subject?: string;
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

	const selectedMessages = input.threads.flatMap((thread) =>
		thread.posts.map(({ message }) => message),
	);
	const next = collectNextActions({
		recommendFullThreadIds,
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
}): EvidenceNextStep[] {
	const next: EvidenceNextStep[] = [];
	for (const threadId of input.recommendFullThreadIds) {
		next.push({
			action: "thread_full",
			reason: "packing_incomplete",
			priority: "recommended",
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
