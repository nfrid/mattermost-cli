/**
 * Human rendering of the decision brief and thread timelines.
 *
 * Shared by the `context` packet and by `thread`, which both show a brief; it
 * lived in the context formatter only because that is where it was written.
 */
import type { ContextThread } from "../../context/index.ts";
import type { PackedPost } from "../../evidence/packing.ts";
import {
	briefRetainedPostIds,
	type ThreadBrief,
} from "../../evidence/signals.ts";
import { isoTimestamp } from "../shared.ts";
import { styles } from "../styles.ts";
import {
	formatField,
	formatPost,
	joinParts,
	truncatedTextHint,
} from "./fields.ts";
/**
 * Collapse consecutive repeats (`a, b, b, b` → `a, b ×3`): a packing strategy
 * repeated once per neighborhood says nothing more than its count.
 */
export function formatSelectionStrategy(strategies: readonly string[]): string {
	const runs: Array<{ value: string; count: number }> = [];
	for (const strategy of strategies) {
		const last = runs[runs.length - 1];
		if (last?.value === strategy) last.count += 1;
		else runs.push({ value: strategy, count: 1 });
	}
	return runs
		.map(({ value, count }) =>
			count > 1 ? styles.hint(`${value} ×${count}`) : styles.hint(value),
		)
		.join(", ");
}

/** Advisory purpose hints, so the text view says what a thread is *for*. */
export function formatPurposeHints(brief: ThreadBrief): string[] {
	if (!brief.purposeHints.length) return [];
	return [
		formatField(
			"Purpose",
			brief.purposeHints
				.map(
					({ label, confidence }) =>
						`${styles.accent(label)} ${styles.hint(String(confidence))}`,
				)
				.join(", "),
		),
	];
}

/**
 * Decision-only transcript: the posts the brief points at, with everything the
 * projection withholds collapsed into an explicit marker. Packing's own skips
 * keep their own counts, so the two omission kinds stay attributable.
 */
export function formatBriefTimeline(
	timeline: ContextThread["timeline"],
	posts: readonly PackedPost[],
	brief: ThreadBrief,
): string[] {
	const retained = briefRetainedPostIds(brief, posts);
	const decisionIds = new Set(brief.decisionPostIds);
	const lines: string[] = [];
	let withheld = 0;
	const flush = () => {
		if (!withheld) return;
		lines.push(
			styles.hint(`… withheld ${withheld} message(s) (brief projection)`),
		);
		withheld = 0;
	};
	for (const item of timeline) {
		if (item.kind === "skip") {
			flush();
			lines.push(...formatTimeline([item]));
			continue;
		}
		if (!retained.has(item.post.id)) {
			withheld += 1;
			continue;
		}
		flush();
		const [head, ...rest] = formatPost(item.post);
		lines.push(
			decisionIds.has(item.post.id)
				? `${styles.warning("[decision candidate]")} ${head}`
				: (head ?? ""),
			...rest,
		);
	}
	flush();
	return lines;
}

export function formatTimeline(timeline: ContextThread["timeline"]): string[] {
	const lines: string[] = [];
	for (const item of timeline) {
		if (item.kind === "skip") {
			lines.push(
				styles.hint(
					`… skipped ${item.skip.posts} message(s)${
						item.skip.after || item.skip.before
							? ` (${[item.skip.after ? `after ${item.skip.after}` : "", item.skip.before ? `before ${item.skip.before}` : ""].filter(Boolean).join(", ")})`
							: ""
					}`,
				),
			);
			continue;
		}
		lines.push(...formatPost(item.post));
	}
	return lines;
}

/**
 * Inlined open questions so the text view answers "what is still hanging",
 * symmetric to the decision block.
 */
export function formatOpenQuestions(brief: ThreadBrief): string[] {
	const questions = brief.openQuestions ?? [];
	if (!questions.length) return [];
	return [
		`${styles.label("Open questions:")} ${styles.hint("mechanical cues; the packet contains no answer, which is not proof there is none")}`,
		...questions.map((question) =>
			joinParts([
				styles.timestamp(`[${isoTimestamp(question.createAt)}]`),
				styles.label(
					question.kind === "follow_up" ? "[follow-up]" : "[question]",
				),
				styles.username(`@${question.author}`),
				question.excerpt,
				...(question.excerptTruncated ? [truncatedTextHint()] : []),
				question.isThreadTail
					? styles.warning("thread ends here")
					: styles.hint(`${question.repliesAfter} later message(s)`),
			]),
		),
	];
}

/** Inlined decision candidates so the text view answers "what was decided". */
export function formatDecisions(brief: ThreadBrief): string[] {
	const decisions = brief.decisions ?? [];
	if (!decisions.length) return [];
	return [
		`${styles.label("Decision candidates:")} ${styles.hint("mechanical cues, not verified outcomes")}`,
		...decisions.flatMap((decision) => [
			joinParts([
				styles.timestamp(`[${isoTimestamp(decision.createAt)}]`),
				styles.label(`[${decision.kind.replace(/_/gu, " ")}]`),
				styles.username(`@${decision.author}`),
				decision.excerpt,
				...(decision.excerptTruncated ? [truncatedTextHint()] : []),
				...(decision.ackPostId
					? [styles.hint(`acked by ${decision.ackPostId}`)]
					: []),
			]),
			...(decision.refinements ?? []).map((refinement) =>
				joinParts([
					`  ${styles.warning("scope:")} ${styles.timestamp(`[${isoTimestamp(refinement.createAt)}]`)}`,
					styles.username(`@${refinement.author}`),
					refinement.excerpt,
					...(refinement.excerptTruncated ? [truncatedTextHint()] : []),
				]),
			),
		]),
	];
}
