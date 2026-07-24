import type { MattermostConfig } from "../config/config.ts";
import type { MattermostSubject, ThreadCandidate } from "../search/index.ts";
import { postLink } from "./helpers.ts";
import type {
	DroppedCandidate,
	DroppedCandidateReason,
	SelectionEvidence,
} from "./types.ts";

export const DROPPED_CANDIDATES_LIMIT = 5;

export function selectionEvidence(input: {
	candidateThreads: number;
	returnedThreads: number;
	droppedThin: number;
	droppedByBudget: number;
	droppedNoMatch: number;
	droppedCandidates?: readonly DroppedCandidate[];
}): SelectionEvidence {
	return {
		candidateThreads: input.candidateThreads,
		returnedThreads: input.returnedThreads,
		droppedThin: input.droppedThin,
		droppedByBudget: input.droppedByBudget,
		droppedNoMatch: input.droppedNoMatch,
		droppedCandidates: [...(input.droppedCandidates ?? [])],
	};
}

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

export function buildDroppedCandidates(input: {
	candidates: readonly ThreadCandidate[];
	selectedIds: ReadonlySet<string>;
	noMatchIds: ReadonlySet<string>;
	config: MattermostConfig;
	limit?: number;
}): DroppedCandidate[] {
	const limit = input.limit ?? DROPPED_CANDIDATES_LIMIT;
	const dropped: DroppedCandidate[] = [];
	for (const candidate of input.candidates) {
		if (input.selectedIds.has(candidate.threadId)) continue;
		if (dropped.length >= limit) break;
		const dropReason = resolveDropReason(
			candidate,
			input.noMatchIds.has(candidate.threadId),
		);
		const excerpt = candidate.matches[0]?.excerpt;
		dropped.push({
			threadId: candidate.threadId,
			url: postLink(input.config, candidate.rootPostId),
			conversationId: candidate.conversationId,
			conversationAlias: candidate.conversationAlias,
			conversationKind: candidate.conversationKind,
			dropReason,
			reasons: [...candidate.reasons],
			...(excerpt ? { excerpt } : {}),
		});
	}
	return dropped;
}

function resolveDropReason(
	candidate: ThreadCandidate,
	noMatch: boolean,
): DroppedCandidateReason {
	if (noMatch) return "no_match";
	if (candidate.reasons.includes("thin_thread")) return "thin";
	return "budget";
}
