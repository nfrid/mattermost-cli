import type { MattermostConfig } from "../config/config.ts";
import {
	isActionableDroppedCandidate,
	SUBJECT_EVIDENCE_REASONS,
} from "../evidence/selection-policy.ts";
import type {
	MattermostSubject,
	RankingReason,
	ThreadCandidate,
} from "../search/index.ts";
import { redactCredentialExcerpts } from "../text/index.ts";
import { postLink } from "./helpers.ts";
import type {
	DroppedCandidate,
	DroppedCandidateReason,
	SelectionEvidence,
} from "./types.ts";

/**
 * The pure selection predicates shared with `buildEvidence` live in
 * `evidence/selection-policy.ts`; re-exported here so `context/selection.ts`
 * remains the single import site for selection judgments.
 */
export {
	isActionableDroppedCandidate,
	isSubjectMatchedBudgetDrop,
	pickPrimaryThreadIndex,
	shouldRecommendInspectDropped,
} from "../evidence/selection-policy.ts";

const DROPPED_CANDIDATES_LIMIT = 5;

/**
 * For ticket subjects, keep at most maxThreads-1 substantive threads ahead of
 * the best thin ticket stub so a short DM signal is not crowded out.
 */
export function orderCandidatesForThinReserve(
	candidates: readonly ThreadCandidate[],
	subject: MattermostSubject,
	maxThreads: number,
): ThreadCandidate[] {
	if (subject.kind !== "ticket" || maxThreads < 2 || candidates.length <= 1) {
		return [...candidates];
	}
	const substantive: ThreadCandidate[] = [];
	const thin: ThreadCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.reasons.includes("thin_thread")) thin.push(candidate);
		else substantive.push(candidate);
	}
	if (!thin.length) return [...candidates];

	const reserved = thin[0];
	if (!reserved) return [...candidates];
	const head = substantive.slice(0, maxThreads - 1);
	const restSubstantive = substantive.slice(maxThreads - 1);
	const restThin = thin.slice(1);
	return [...head, reserved, ...restSubstantive, ...restThin];
}

/**
 * Reasons that mean the query actually matched thread content (lexical,
 * morphological, or structured). Ordering artifacts — `rank_fusion`,
 * `routing_*`, `conversation_priority`, `latest_activity` — are deliberately
 * absent: on their own they say only that the thread was ranked, not that it is
 * about the subject, and they used to fill the dropped-candidate cap with noise.
 */
const MATCH_REASONS: ReadonlySet<RankingReason> = new Set<RankingReason>([
	"direct_post",
	"remote_search",
	"structured_entity_match",
	"subject_in_root",
	"exact_phrase",
	"exact_phrase_in_root",
	"exact_phrase_in_reply",
	"all_terms_in_thread",
	"all_expanded_terms_in_thread",
	"exact_terms_near",
	"morph_terms_near",
	"exact_terms_same_post",
	"morph_terms_same_post",
	"expanded_terms_same_post",
	"terms_across_thread",
	"morphology_match",
	"concept_match",
	"keyboard_layout_match",
	"transliteration_match",
	"mixed_script_match",
	"prefix_match",
	"typo_match",
	"query_expansion",
	"multiple_probes_in_thread",
]);

/** Whether a candidate matched content rather than only being ranked/routed. */
function hasMatchReason(reasons: readonly RankingReason[]): boolean {
	return reasons.some((reason) => MATCH_REASONS.has(reason));
}

export function buildDroppedCandidates(input: {
	candidates: readonly ThreadCandidate[];
	selectedIds: ReadonlySet<string>;
	noMatchIds: ReadonlySet<string>;
	/** Candidates whose thread could not be retrieved this request. */
	unavailableIds?: ReadonlySet<string>;
	config: MattermostConfig;
	limit?: number;
}): DroppedCandidate[] {
	const limit = input.limit ?? DROPPED_CANDIDATES_LIMIT;
	const dropped: DroppedCandidate[] = [];
	for (const candidate of input.candidates) {
		if (input.selectedIds.has(candidate.threadId)) continue;
		const dropReason = resolveDropReason(
			candidate,
			input.noMatchIds.has(candidate.threadId),
			Boolean(input.unavailableIds?.has(candidate.threadId)),
		);
		const reasons = [...candidate.reasons];
		if (
			!isActionableDroppedCandidate({ dropReason, reasons }) &&
			!hasMatchReason(reasons)
		) {
			continue;
		}
		const excerpts = [
			...new Set(
				candidate.matches
					.map(({ excerpt }) => redactCredentialExcerpts(excerpt))
					.filter((excerpt) => excerpt.length > 0),
			),
		].slice(0, 2);
		const excerpt = excerpts[0];
		dropped.push({
			threadId: candidate.threadId,
			url: postLink(input.config, candidate.rootPostId),
			conversationId: candidate.conversationId,
			conversationAlias: candidate.conversationAlias,
			conversationKind: candidate.conversationKind,
			dropReason,
			reasons,
			...(excerpt ? { excerpt } : {}),
			...(excerpts.length ? { excerpts } : {}),
		});
	}
	dropped.sort(compareDroppedCandidates);
	return dropped.slice(0, limit);
}

/**
 * Candidates the budget stopped the packer from examining that nonetheless
 * carried subject-level evidence. `droppedByBudget` alone conflates these with
 * the long weak tail, which is why a packet with 173 unexamined candidates
 * could not say whether any of them mattered.
 */
export function countSubjectMatchedBudgetDrops(input: {
	candidates: readonly ThreadCandidate[];
	/** Ids the packer actually dropped for lack of room — never re-derived. */
	budgetDroppedIds: ReadonlySet<string>;
}): number {
	let count = 0;
	for (const candidate of input.candidates) {
		if (!input.budgetDroppedIds.has(candidate.threadId)) continue;
		if (
			candidate.reasons.some((reason) => SUBJECT_EVIDENCE_REASONS.has(reason))
		) {
			count += 1;
		}
	}
	return count;
}

/**
 * Candidates whose selection must survive `--query` probe re-evaluation: they
 * already carry subject-level ticket evidence or were caller-pinned via
 * permalink. Free-text subjects stay unpinned so stale hydrates that no longer
 * match the query can still drop as no_match.
 */
export function isProbePinnedCandidate(
	reasons: readonly RankingReason[],
	subjectKind: MattermostSubject["kind"],
): boolean {
	if (reasons.includes("direct_post")) return true;
	if (subjectKind !== "ticket") return false;
	return reasons.some(
		(reason) =>
			reason === "explicit_ticket_relationship" ||
			SUBJECT_EVIDENCE_REASONS.has(reason),
	);
}

function compareDroppedCandidates(
	left: DroppedCandidate,
	right: DroppedCandidate,
): number {
	const leftActionable = isActionableDroppedCandidate(left) ? 0 : 1;
	const rightActionable = isActionableDroppedCandidate(right) ? 0 : 1;
	if (leftActionable !== rightActionable) {
		return leftActionable - rightActionable;
	}
	const leftThin = left.dropReason === "thin" ? 0 : 1;
	const rightThin = right.dropReason === "thin" ? 0 : 1;
	return leftThin - rightThin;
}

function resolveDropReason(
	candidate: ThreadCandidate,
	noMatch: boolean,
	unavailable: boolean,
): DroppedCandidateReason {
	if (unavailable) return "unavailable";
	if (noMatch) return "no_match";
	if (candidate.reasons.includes("thin_thread")) return "thin";
	return "budget";
}

/**
 * Fill the packer's running selection counters with the figures only the
 * orchestrator can see (every candidate it examined, and which of them the
 * packet finally returned).
 *
 * Mutates `selection` in place, as the packer's own bookkeeping does.
 */
export function finalizeSelectionEvidence(input: {
	selection: SelectionEvidence;
	/** Every candidate the packer examined, selected or not. */
	seenCandidates: readonly ThreadCandidate[];
	/** Candidates offered to the packer, including ones it never reached. */
	offeredCandidates: readonly ThreadCandidate[];
	selectedIds: ReadonlySet<string>;
	returnedThreads: number;
	budgetDroppedIds: ReadonlySet<string>;
	noMatchIds: ReadonlySet<string>;
	unavailableIds: ReadonlySet<string>;
	config: MattermostConfig;
}): SelectionEvidence {
	const { selection, seenCandidates, selectedIds } = input;
	selection.candidateThreads = Math.max(
		selection.candidateThreads,
		seenCandidates.length,
		input.offeredCandidates.length,
	);
	selection.returnedThreads = input.returnedThreads;
	selection.droppedThin = seenCandidates.filter(
		(candidate) =>
			!selectedIds.has(candidate.threadId) &&
			candidate.reasons.includes("thin_thread"),
	).length;
	selection.droppedByBudgetSubjectMatched = countSubjectMatchedBudgetDrops({
		candidates: seenCandidates,
		budgetDroppedIds: input.budgetDroppedIds,
	});
	selection.droppedCandidates = buildDroppedCandidates({
		candidates: seenCandidates,
		selectedIds,
		noMatchIds: input.noMatchIds,
		unavailableIds: input.unavailableIds,
		config: input.config,
	});
	return selection;
}
