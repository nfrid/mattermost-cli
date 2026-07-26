import {
	budgetAwareAroundSidePosts,
	estimateAveragePostUnits,
	largestTimelineSkip,
	MAX_AROUND_SIDE_POSTS,
} from "../packing.ts";
import {
	isActionableDroppedCandidate,
	isSubjectMatchedBudgetDrop,
	shouldRecommendInspectDropped,
} from "../selection-policy.ts";
import { buildThreadBrief } from "../signals.ts";
import type {
	ContextThread,
	DroppedCandidate,
	EvidenceAdequacy,
	EvidenceCurrency,
	EvidenceNextStep,
	EvidenceSelectionCompleteness,
	FreshnessEvidence,
	SelectionEvidence,
} from "../types.ts";

/**
 * The types this module produces live in `./types.ts` (see the note there).
 * Re-exported so `evidence/evidence.ts` stays the documented import site.
 */
export type * from "../types.ts";

import {
	attachmentNextStep,
	isSpreadsheetDataFileName,
	type UnreadOutcomeAttachment,
} from "./attachments.ts";

/** Below this, unexamined candidates are ranking tail, not a visible gap. */
export const SELECTION_REVIEW_MIN_DROPPED_BY_BUDGET = 3;

export const RECOMMEND_FULL_MIN_OMITTED_RATIO = 0.25;

export const RECOMMEND_FULL_MIN_LARGEST_SKIP = 5;

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
export function rankTruncatedThreads(
	threads: readonly ContextThread[],
	primaryThreadId: string | undefined,
): ContextThread[] {
	return [...threads].sort((left, right) => {
		const leftPrimary = left.threadId === primaryThreadId ? 0 : 1;
		const rightPrimary = right.threadId === primaryThreadId ? 0 : 1;
		const leftRatio =
			left.totalPosts > 0 ? left.omittedPosts / left.totalPosts : 0;
		const rightRatio =
			right.totalPosts > 0 ? right.omittedPosts / right.totalPosts : 0;
		return (
			leftPrimary - rightPrimary ||
			largestTimelineSkip(right.timeline) -
				largestTimelineSkip(left.timeline) ||
			rightRatio - leftRatio ||
			left.threadId.localeCompare(right.threadId)
		);
	});
}

export const MAX_TARGETED_AROUND_POSTS = MAX_AROUND_SIDE_POSTS;

/**
 * Prefer one bounded omitted range over replaying the complete thread. The kept
 * post before an internal/trailing skip is the preferred `--around` anchor, so
 * normal chronological selection starts with the nearest omitted posts. A
 * leading skip uses the kept post after it. Side-post counts are capped by both
 * {@link MAX_TARGETED_AROUND_POSTS} and the thread's character budget so the
 * recommended argv is expected to fit; fall back to `--full` only when no
 * usable boundary exists.
 *
 * Skip choice prefers gaps that recover truncated decision/open-question text
 * or `responseExcerpts` anchors over merely the largest skip.
 */
export function targetedHydrationStep(
	thread: ContextThread,
	recommended: boolean,
): EvidenceNextStep {
	const brief = buildThreadBrief(thread.posts, {
		omittedPosts: thread.omittedPosts,
		reasons: thread.reasons,
	});
	const highValuePostIds = highValueGapAnchorIds(brief);
	const skips = thread.timeline
		.filter((item) => item.kind === "skip")
		.map(({ skip }) => skip)
		.sort((left, right) => {
			const leftValue = skipGapValue(left, highValuePostIds);
			const rightValue = skipGapValue(right, highValuePostIds);
			return rightValue - leftValue || right.posts - left.posts;
		});
	const skip = skips[0];
	const priority = recommended ? "recommended" : "optional";
	const averagePostUnits = estimateAveragePostUnits(thread.posts);
	const characterBudget = thread.budget.limit;
	const sidePosts = (requested: number) =>
		budgetAwareAroundSidePosts({
			requestedSidePosts: Math.min(requested, MAX_TARGETED_AROUND_POSTS),
			characterBudget,
			averagePostUnits,
		});
	if (skip?.after) {
		const afterPosts = sidePosts(skip.posts);
		return {
			action: "thread_around",
			reason: "packing_incomplete_range",
			priority,
			impact: "may_recover_omitted_core",
			command: [
				"mm",
				"thread",
				thread.threadId,
				"--around",
				skip.after,
				"--before-posts",
				"0",
				"--after-posts",
				String(afterPosts),
				"--window-only",
				"--agent",
			],
			threadId: thread.threadId,
		};
	}
	if (skip?.before) {
		const beforePosts = sidePosts(skip.posts);
		return {
			action: "thread_around",
			reason: "packing_incomplete_range",
			priority,
			impact: "may_recover_omitted_core",
			command: [
				"mm",
				"thread",
				thread.threadId,
				"--around",
				skip.before,
				"--before-posts",
				String(beforePosts),
				"--after-posts",
				"0",
				"--window-only",
				"--agent",
			],
			threadId: thread.threadId,
		};
	}
	return {
		action: "thread_full",
		reason: "packing_incomplete",
		priority,
		impact: "may_recover_omitted_core",
		command: ["mm", "thread", thread.threadId, "--full", "--agent"],
		threadId: thread.threadId,
	};
}

/** Post ids whose neighboring skip is more valuable than raw size. */
export function highValueGapAnchorIds(
	brief: ReturnType<typeof buildThreadBrief>,
): {
	truncatedDecisionOrQuestion: ReadonlySet<string>;
	responseAnchors: ReadonlySet<string>;
} {
	const truncatedDecisionOrQuestion = new Set<string>();
	const responseAnchors = new Set<string>();
	for (const decision of brief.decisions ?? []) {
		if (decision.excerptTruncated)
			truncatedDecisionOrQuestion.add(decision.postId);
	}
	for (const question of brief.openQuestions ?? []) {
		if (question.excerptTruncated)
			truncatedDecisionOrQuestion.add(question.postId);
		for (const id of question.responsePostIds ?? []) responseAnchors.add(id);
	}
	return { truncatedDecisionOrQuestion, responseAnchors };
}

export function skipGapValue(
	skip: { after?: string; before?: string; posts: number },
	anchors: {
		truncatedDecisionOrQuestion: ReadonlySet<string>;
		responseAnchors: ReadonlySet<string>;
	},
): number {
	const neighbors = [skip.after, skip.before].filter((id): id is string =>
		Boolean(id),
	);
	let value = 0;
	for (const id of neighbors) {
		if (anchors.truncatedDecisionOrQuestion.has(id)) value += 100;
		if (anchors.responseAnchors.has(id)) value += 50;
	}
	return value;
}

export function collectNextActions(input: {
	/** Truncated threads, best first; only the first is `recommended`. */
	rankedTruncated: readonly ContextThread[];
	/** Usable, complete inside the selected threads, and current. */
	packetTrusted: boolean;
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
	selectionCompleteness: EvidenceSelectionCompleteness;
	selectionCounts: SelectionEvidence;
	selectedMessages: readonly string[];
	droppedCandidates: readonly DroppedCandidate[];
	freshness: readonly FreshnessEvidence[];
	warningKinds: ReadonlySet<string>;
	subject?: string;
	unreadOutcomeAttachment?: UnreadOutcomeAttachment;
	decisionDataAttachment?: UnreadOutcomeAttachment;
	decisionImageAttachment?: UnreadOutcomeAttachment;
}): EvidenceNextStep[] {
	const next: EvidenceNextStep[] = [];
	const attachment = input.unreadOutcomeAttachment;
	if (attachment) {
		next.push(
			attachmentNextStep(attachment, {
				reason:
					attachment.files > 1
						? "media_only_outcome_post_multiple_files"
						: "media_only_outcome_post",
				interpretablePriority: "recommended",
				interpretableImpact: "may_contradict_visible_text",
				keepRecommendedWhenExternal: true,
			}),
		);
	}
	const dataFile = input.decisionDataAttachment;
	if (dataFile) {
		next.push(
			attachmentNextStep(dataFile, {
				reason: "data_file_on_decision_post",
				// A media-only post is unreadable without its file; this post has text,
				// so it is the second call to make, not the first.
				interpretablePriority: attachment ? "optional" : "recommended",
				interpretableImpact: isSpreadsheetDataFileName(dataFile.fileName)
					? "cannot_verify_quantities"
					: "may_verify_quantitative_claim",
			}),
		);
	}
	const decisionImage = input.decisionImageAttachment;
	if (decisionImage) {
		next.push(
			attachmentNextStep(decisionImage, {
				reason: "image_on_decision_post",
				interpretablePriority:
					attachment || dataFile ? "optional" : "recommended",
				interpretableImpact: "may_contradict_visible_text",
				keepRecommendedWhenExternal: true,
			}),
		);
	}
	for (const [index, thread] of input.rankedTruncated.entries()) {
		next.push(targetedHydrationStep(thread, index === 0));
	}
	const historyIncomplete =
		input.cutoffBoundedConversations > 0 ||
		input.warningKinds.has("incomplete_history");
	if (historyIncomplete && !input.packetTrusted) {
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
	// When subject-matched budget drops set mayHaveMissedOtherThreads but no
	// thin/ticket inspect fired, point at the best budget drop that still adds
	// an unseen excerpt. Promote to recommended — the flag already says real
	// subject evidence may be missing.
	const subjectMatchedBudgetDrop =
		!actionableDropped &&
		input.selectionCounts.droppedByBudgetSubjectMatched > 0
			? input.droppedCandidates.find(
					(candidate) =>
						isSubjectMatchedBudgetDrop(candidate) &&
						shouldRecommendInspectDropped(candidate, input.selectedMessages),
				)
			: undefined;
	const inspectDropped = actionableDropped ?? subjectMatchedBudgetDrop;
	if (inspectDropped) {
		const droppedThreadId = inspectDropped.threadId;
		const subjectMatchedOnly =
			!actionableDropped && subjectMatchedBudgetDrop !== undefined;
		next.push({
			action: "inspect_dropped",
			reason: subjectMatchedOnly
				? "subject_matched_budget_drops"
				: "selection_dropped",
			priority: subjectMatchedOnly ? "recommended" : "optional",
			impact: "may_add_dropped_pointer",
			...(droppedThreadId
				? {
						command: ["mm", "thread", droppedThreadId, "--agent"],
						threadId: droppedThreadId,
					}
				: {}),
		});
	}
	// Always recommend a higher --max-threads re-run when subject-matched
	// candidates were budget-dropped — even if inspect_dropped was withheld for
	// a thin bulletin — so --follow-recommended can bump the selection cap.
	if (
		input.selectionCounts.droppedByBudgetSubjectMatched > 0 &&
		input.subject
	) {
		const bumpedMaxThreads = Math.min(
			20,
			Math.max(
				5,
				input.selectionCounts.returnedThreads +
					input.selectionCounts.droppedByBudgetSubjectMatched,
			),
		);
		next.push({
			action: "review_candidates",
			reason: "subject_matched_budget_drops",
			priority: "recommended",
			impact: "may_add_dropped_pointer",
			command: [
				"mm",
				"context",
				input.subject,
				"--max-threads",
				String(bumpedMaxThreads),
				"--agent",
			],
		});
	}
	if (
		input.selectionCompleteness === "budget_bounded" &&
		input.selectionCounts.droppedByBudget >=
			SELECTION_REVIEW_MIN_DROPPED_BY_BUDGET &&
		input.selectionCounts.droppedByBudget >
			input.selectionCounts.returnedThreads
	) {
		// The packet cannot speak for candidates it never examined; `search` lists
		// them without spending this request's packing budget.
		next.push({
			action: "review_candidates",
			reason: "selection_budget_bounded",
			priority: "optional",
			impact: "may_add_dropped_pointer",
			...(input.subject
				? { command: ["mm", "search", input.subject, "--agent"] }
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
