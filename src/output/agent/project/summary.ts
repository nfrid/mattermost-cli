import type { PermalinkResolution } from "../../../context/types.ts";
import type { EvidenceStatus } from "../../../evidence/evidence.ts";
import {
	MAX_DECISION_POST_IDS,
	MAX_OPEN_QUESTIONS,
} from "../../../evidence/signals.ts";
import type {
	AgentBriefDecision,
	AgentBriefOpenQuestion,
	AgentLateAcknowledgement,
	AgentMergedBrief,
	AgentMergedBriefDecision,
	AgentMergedBriefOpenQuestion,
	AgentResearchSummary,
	AgentThread,
	PurposeHintLabel,
} from "../types.ts";
import { BLOCKED_PERMALINK_STATUSES } from "./shared.ts";

/** Strongest first — mirrors domain `DECISION_KIND_PRIORITY` for merged briefs. */
export const DECISION_KIND_RANK: Readonly<
	Record<AgentBriefDecision["kind"], number>
> = {
	approved_decision: 0,
	discussion_outcome: 1,
	implementation_intent: 2,
	proposal: 3,
};

/**
 * Best purpose first — mirrors domain `PURPOSE_HINT_PRIORITY` for orientation
 * when no decision-bearing thread exists.
 */
const PURPOSE_HINT_RANK: Readonly<Record<PurposeHintLabel, number>> = {
	decision: 0,
	open_question: 1,
	debugging: 2,
	announce: 3,
	status: 4,
	noise: 5,
};

/** Matches domain `NOISE_MAX_POSTS` — thin automation / ticket-ping stubs. */
export const THIN_ORIENTATION_MAX_POSTS = 3;

/**
 * Merge per-thread decision layers for `projection: "brief"`. Strongest
 * decisions and most dangling open questions win the global caps; each entry
 * keeps `threadId` so locality is recoverable without scanning `threads[]`.
 */
export function mergeThreadBriefs(
	threads: readonly AgentThread[],
): AgentMergedBrief | undefined {
	const decisions: AgentMergedBriefDecision[] = [];
	const openQuestions: AgentMergedBriefOpenQuestion[] = [];
	let lateAcknowledgement:
		| (AgentLateAcknowledgement & { threadId: string })
		| undefined;
	for (const thread of threads) {
		for (const decision of thread.brief?.decisions ?? []) {
			decisions.push({ ...decision, threadId: thread.threadId });
		}
		for (const question of thread.brief?.openQuestions ?? []) {
			openQuestions.push({ ...question, threadId: thread.threadId });
		}
		const late = thread.brief?.lateAcknowledgement;
		if (late) {
			const candidate = { ...late, threadId: thread.threadId };
			if (
				!lateAcknowledgement ||
				candidate.confidence > lateAcknowledgement.confidence ||
				(candidate.confidence === lateAcknowledgement.confidence &&
					candidate.at > lateAcknowledgement.at)
			) {
				lateAcknowledgement = candidate;
			}
		}
	}
	decisions.sort(compareMergedDecisions);
	openQuestions.sort(compareMergedOpenQuestions);
	const cappedDecisions = decisions.slice(0, MAX_DECISION_POST_IDS);
	// Prefer every unresolved question in the merge; answered /
	// possibly_answered ones fill remaining slots up to the usual cap. Only the
	// unresolved count aligns with `researchSummary.unresolvedOpenQuestions`.
	const unresolved = openQuestions.filter(isUnresolvedOpenQuestion);
	const answered = openQuestions.filter(
		(question) => !isUnresolvedOpenQuestion(question),
	);
	const answeredSlots = Math.max(0, MAX_OPEN_QUESTIONS - unresolved.length);
	const cappedQuestions = [...unresolved, ...answered.slice(0, answeredSlots)];
	if (
		!cappedDecisions.length &&
		!cappedQuestions.length &&
		!lateAcknowledgement
	) {
		return undefined;
	}
	return {
		...(cappedDecisions.length ? { decisions: cappedDecisions } : {}),
		...(cappedQuestions.length ? { openQuestions: cappedQuestions } : {}),
		...(lateAcknowledgement ? { lateAcknowledgement } : {}),
	};
}

export function compareMergedDecisions(
	left: AgentMergedBriefDecision,
	right: AgentMergedBriefDecision,
): number {
	return (
		DECISION_KIND_RANK[left.kind] - DECISION_KIND_RANK[right.kind] ||
		right.at.localeCompare(left.at) ||
		left.id.localeCompare(right.id)
	);
}

export function compareMergedOpenQuestions(
	left: AgentMergedBriefOpenQuestion,
	right: AgentMergedBriefOpenQuestion,
): number {
	return (
		Number(isUnresolvedOpenQuestion(right)) -
			Number(isUnresolvedOpenQuestion(left)) ||
		Number(right.isThreadTail ?? false) - Number(left.isThreadTail ?? false) ||
		Number(left.kind === "follow_up") - Number(right.kind === "follow_up") ||
		left.repliesAfter - right.repliesAfter ||
		right.at.localeCompare(left.at) ||
		left.id.localeCompare(right.id)
	);
}

/**
 * Thin deterministic roll-up. Emitted when at least one field carries signal;
 * never invents prose about what the research "found".
 */
export function buildResearchSummary(input: {
	threads: readonly AgentThread[];
	evidence: EvidenceStatus;
	permalinks?: readonly PermalinkResolution[];
}): AgentResearchSummary | undefined {
	const decisionThreadIds = collectDecisionThreadIds(input.threads);
	const primaryThreadId = pickOrientationPrimaryThreadId(
		input.threads,
		decisionThreadIds,
	);
	const decisionsByKind: NonNullable<AgentResearchSummary["decisionsByKind"]> =
		{};
	let unresolvedOpenQuestions = 0;
	for (const thread of input.threads) {
		for (const decision of thread.brief?.decisions ?? []) {
			decisionsByKind[decision.kind] =
				(decisionsByKind[decision.kind] ?? 0) + 1;
		}
		for (const question of thread.brief?.openQuestions ?? []) {
			if (isUnresolvedOpenQuestion(question)) unresolvedOpenQuestions += 1;
		}
	}
	const blockedOrUnresolvedPermalinks = (input.permalinks ?? [])
		.filter((entry) => BLOCKED_PERMALINK_STATUSES.has(entry.status))
		.map((entry) => entry.input);
	const recommendedNext = input.evidence.next
		.filter((step) => step.priority === "recommended")
		.map((step) => step.action);
	const hasDecisions = Object.keys(decisionsByKind).length > 0;
	if (
		!primaryThreadId &&
		!decisionThreadIds.length &&
		!hasDecisions &&
		unresolvedOpenQuestions === 0 &&
		!blockedOrUnresolvedPermalinks.length &&
		!recommendedNext.length
	) {
		return undefined;
	}
	return {
		...(primaryThreadId ? { primaryThreadId } : {}),
		decisionThreadIds,
		...(hasDecisions ? { decisionsByKind } : {}),
		unresolvedOpenQuestions,
		...(blockedOrUnresolvedPermalinks.length
			? { blockedOrUnresolvedPermalinks }
			: {}),
		recommendedNext,
	};
}

/**
 * Threads that contribute brief decisions, ordered by each thread's strongest
 * decision (kind priority, then recency / id).
 */
export function collectDecisionThreadIds(
	threads: readonly AgentThread[],
): string[] {
	const strongestByThread: AgentMergedBriefDecision[] = [];
	for (const thread of threads) {
		// Per-thread `brief.decisions` is already strongest-first.
		const strongest = thread.brief?.decisions?.[0];
		if (!strongest) continue;
		strongestByThread.push({ ...strongest, threadId: thread.threadId });
	}
	strongestByThread.sort(compareMergedDecisions);
	return strongestByThread.map((entry) => entry.threadId);
}

/**
 * Orientation target for `researchSummary.primaryThreadId`. Prefer the
 * strongest decision-bearing thread; otherwise score ticket signal and
 * non-noise purpose, and do not trust `role: "primary"` on noise / thin stubs.
 */
export function pickOrientationPrimaryThreadId(
	threads: readonly AgentThread[],
	decisionThreadIds: readonly string[],
): string | undefined {
	if (decisionThreadIds[0]) return decisionThreadIds[0];
	if (!threads.length) return undefined;
	let bestIndex = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const [index, thread] of threads.entries()) {
		const score = orientationThreadScore(thread);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return threads[bestIndex]?.threadId;
}

export function orientationThreadScore(thread: AgentThread): number {
	const topPurpose = thread.brief?.purposeHints?.[0]?.label;
	const isNoisePurpose = topPurpose === "noise";
	const thinAutomation = thread.totalPosts <= THIN_ORIENTATION_MAX_POSTS;
	const purposeBoost =
		topPurpose && !isNoisePurpose
			? (PURPOSE_HINT_RANK.noise - PURPOSE_HINT_RANK[topPurpose]) * 20
			: 0;
	return (
		(isNoisePurpose ? -1000 : 0) +
		(thinAutomation ? -50 : 0) +
		purposeBoost +
		Math.round((thread.ticketDensity ?? 0) * 100) +
		(thread.nearestTicketDistance === 0 ? 15 : 0) +
		// Role is only a weak tie-breaker once noise / thin stubs are penalized.
		(thread.role === "primary" && !isNoisePurpose && !thinAutomation ? 5 : 0) +
		Math.min(thread.totalPosts, 24)
	);
}

export function isUnresolvedOpenQuestion(
	question: AgentBriefOpenQuestion,
): boolean {
	return (
		question.resolution !== "possibly_answered" &&
		question.resolution !== "answered"
	);
}
