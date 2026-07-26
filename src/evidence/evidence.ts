import { largestTimelineSkip } from "./packing.ts";
import { pickPrimaryThreadIndex } from "./selection-policy.ts";
import type {
	ContextThread,
	EvidenceAdequacy,
	EvidenceCurrency,
	EvidenceDiscoveryCurrency,
	EvidenceHistory,
	EvidenceIndexHistory,
	EvidenceMayHaveMissedReason,
	EvidenceNextStep,
	EvidenceSelectionCompleteness,
	EvidenceStatus,
	EvidenceThreadCompleteness,
	FreshnessEvidence,
	RemoteSearchEvidence,
	SelectionEvidence,
} from "./types.ts";

/**
 * The types this module produces live in `./types.ts` (see the note there).
 * Re-exported so `evidence/evidence.ts` stays the documented import site.
 */
export type * from "./types.ts";

import {
	findDecisionDataAttachment,
	findDecisionImageAttachment,
	findUnreadOutcomeAttachment,
	requiresExternalReader,
} from "./status/attachments.ts";
import {
	collectNextActions,
	rankTruncatedThreads,
	shouldRecommendFull,
} from "./status/next-steps.ts";

/** Deterministic evidence status for agents reading a context packet. */
/** Re-exported so `evidence.ts` stays the import site for the whole layer. */
export { shouldRecommendFull } from "./status/next-steps.ts";

export function buildEvidence(input: {
	searchCoverageComplete: boolean;
	selectedThreadsComplete: boolean;
	/** Selection stopped before judging every candidate (room or hydration). */
	selectionBudgetBounded?: boolean;
	freshnessMode: "local" | "network" | "forced";
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
	/**
	 * Attachment file ids already interpreted via `--inspect` / follow
	 * (`preview` or `text_extracted`). Clears pending mediaOnly answerability
	 * blocks so OCR / workbook preview can complete a recommended step.
	 */
	resolvedAttachmentFileIds?: readonly string[];
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
	const rankedTruncated = rankTruncatedThreads(
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

	const selectedThreads: EvidenceThreadCompleteness = !input.threads.length
		? "not_applicable"
		: !input.selectedThreadsComplete || recommendFullThreadIds.length > 0
			? "truncated"
			: "complete";
	const selectionCompleteness: EvidenceSelectionCompleteness =
		input.selectionBudgetBounded || input.selection.droppedByBudget > 0
			? "budget_bounded"
			: "complete";
	const indexHistory: EvidenceIndexHistory =
		cutoffBoundedConversations > 0 ? "cutoff_bounded" : "full";

	const history = buildHistory(input.freshness, input.threads);
	const selectedMessages = input.threads.flatMap((thread) =>
		thread.posts.map(({ message }) => message),
	);
	const resolvedAttachmentIds = new Set(input.resolvedAttachmentFileIds ?? []);
	const unreadOutcomeAttachment = findUnreadOutcomeAttachment(
		input.threads,
		input.subjectTicket,
		resolvedAttachmentIds,
	);
	const decisionDataAttachment = findDecisionDataAttachment(
		input.threads,
		input.subjectTicket,
		unreadOutcomeAttachment?.postId,
		resolvedAttachmentIds,
	);
	const decisionImageAttachment = findDecisionImageAttachment(
		input.threads,
		input.subjectTicket,
		unreadOutcomeAttachment?.postId ?? decisionDataAttachment?.postId,
		resolvedAttachmentIds,
	);
	// A media-only outcome (or external-reader decision attachment) still pending
	// means the packet's text may omit the root cause — do not claim answerable.
	const pendingMaterialAttachment = Boolean(
		unreadOutcomeAttachment ||
			(decisionDataAttachment &&
				requiresExternalReader(decisionDataAttachment.fileName)) ||
			decisionImageAttachment,
	);
	const canAnswerFromSelectedEvidence =
		adequacy === "usable" &&
		selectedThreads === "complete" &&
		!pendingMaterialAttachment;
	// One rule, one place: `next` and `verdict` both ask whether the packet is
	// trustworthy on its own, and two spellings of that would drift apart.
	const packetTrusted = canAnswerFromSelectedEvidence && currency === "current";
	const mayHaveMissedReason = resolveMayHaveMissedReason({
		discovery,
		indexHistory,
		packetTrusted,
		droppedByBudgetSubjectMatched:
			input.selection.droppedByBudgetSubjectMatched,
	});
	const mayHaveMissedOtherThreads = mayHaveMissedReason !== undefined;
	const next = collectNextActions({
		packetTrusted,
		rankedTruncated,
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
		selectionCompleteness,
		selectionCounts: input.selection,
		selectedMessages,
		droppedCandidates: input.selection.droppedCandidates,
		freshness: input.freshness,
		warningKinds,
		subject: input.subject,
		unreadOutcomeAttachment,
		decisionDataAttachment,
		decisionImageAttachment,
	});
	const selectedEvidenceMayBeStale = currency !== "current";
	const recommendedActionRequired = next.some(
		({ priority }) => priority === "recommended",
	);
	const verdictNoAction = resolveVerdictNoAction({
		mayHaveMissedOtherThreads,
		mayHaveMissedReason,
		selectedEvidenceMayBeStale,
		canAnswerFromSelectedEvidence,
		next,
	});
	// `noActionAvailable` means an uncovered verdict axis has no safe follow-up.
	// When recommended next already exists, suppress the flag so agents are not
	// told both "you must act" and "no action available".
	const safeNoAction =
		verdictNoAction && !recommendedActionRequired ? verdictNoAction : undefined;

	return {
		adequacy,
		currency,
		verdict: {
			canAnswerFromSelectedEvidence,
			mayHaveMissedOtherThreads,
			...(mayHaveMissedReason ? { mayHaveMissedReason } : {}),
			selectedEvidenceMayBeStale,
			recommendedActionRequired,
			...safeNoAction,
		},
		completeness: {
			selectedThreads,
			selection: selectionCompleteness,
			indexHistory,
			discovery,
		},
		next,
		selection: {
			candidateThreads: input.selection.candidateThreads,
			returnedThreads: input.selection.returnedThreads,
			droppedThin: input.selection.droppedThin,
			droppedByBudget: input.selection.droppedByBudget,
			droppedByBudgetSubjectMatched:
				input.selection.droppedByBudgetSubjectMatched,
			droppedNoMatch: input.selection.droppedNoMatch,
			droppedCandidates: input.selection.droppedCandidates,
		},
		packing: {
			omittedPosts,
			largestSkip,
			recommendedHydrationThreadIds: recommendFullThreadIds,
			recommendFullThreadIds,
		},
		...(history ? { history } : {}),
	};
}

/** Prefer the most actionable cause when several axes would set the flag. */
function resolveMayHaveMissedReason(input: {
	discovery: EvidenceDiscoveryCurrency;
	indexHistory: EvidenceIndexHistory;
	packetTrusted: boolean;
	droppedByBudgetSubjectMatched: number;
}): EvidenceMayHaveMissedReason | undefined {
	if (input.droppedByBudgetSubjectMatched > 0) {
		return "subject_matched_budget_drops";
	}
	if (input.discovery === "local_only") return "local_discovery";
	if (input.discovery === "possibly_stale") return "stale_discovery";
	if (input.indexHistory === "cutoff_bounded" && !input.packetTrusted) {
		return "index_cutoff";
	}
	return undefined;
}

/**
 * Every `true` verdict flag must either point at a `next` step or declare that
 * no safe follow-up exists. Without this, agents stall on a lit flag with an
 * empty `next[]`.
 */
function resolveVerdictNoAction(input: {
	mayHaveMissedOtherThreads: boolean;
	mayHaveMissedReason: EvidenceMayHaveMissedReason | undefined;
	selectedEvidenceMayBeStale: boolean;
	canAnswerFromSelectedEvidence: boolean;
	next: readonly EvidenceNextStep[];
}): { noActionAvailable: true; noActionReason: string } | undefined {
	const actions = new Set(input.next.map(({ action }) => action));
	if (input.mayHaveMissedOtherThreads) {
		const covered =
			actions.has("inspect_dropped") ||
			actions.has("review_candidates") ||
			actions.has("sync") ||
			actions.has("fresh_or_remote");
		if (!covered) {
			return {
				noActionAvailable: true,
				noActionReason: mayHaveMissedNoActionReason(input.mayHaveMissedReason),
			};
		}
	}
	if (input.selectedEvidenceMayBeStale && !actions.has("fresh_or_remote")) {
		return {
			noActionAvailable: true,
			noActionReason:
				"selected evidence may be stale but no refresh step is available for this packet",
		};
	}
	if (
		!input.canAnswerFromSelectedEvidence &&
		!actions.has("thread_around") &&
		!actions.has("thread_full") &&
		!actions.has("read_attachments")
	) {
		// Empty / thin packets and complete-but-unusable selections already
		// expose adequacy; only flag when nothing explains the gap.
		if (input.next.length === 0) {
			return {
				noActionAvailable: true,
				noActionReason:
					"selected evidence is not answerable and no follow-up command is available",
			};
		}
	}
	return undefined;
}

function mayHaveMissedNoActionReason(
	reason: EvidenceMayHaveMissedReason | undefined,
): string {
	switch (reason) {
		case "index_cutoff":
			return "index history is cutoff-bounded; no channel-scoped sync step is available";
		case "stale_discovery":
			return "discovery may be stale; no refresh step is available for this packet";
		case "local_discovery":
			return "discovery used the local index only; no refresh step is available for this packet";
		case "subject_matched_budget_drops":
			return "subject-matched candidates were dropped by budget but no review_candidates or inspect_dropped step is available";
		default:
			return "mayHaveMissedOtherThreads is set but no follow-up command is available";
	}
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
