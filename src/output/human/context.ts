import type { ContextResult, ContextThread } from "../../context/index.ts";
import { pickPrimaryThreadIndex } from "../../context/selection.ts";
import { buildThreadBrief } from "../../evidence/signals.ts";
import { formatSubject, isoTimestamp } from "../shared.ts";
import { styles } from "../styles.ts";
import { buildCrossThreadTimeline } from "../timeline.ts";
import {
	formatBriefTimeline,
	formatDecisions,
	formatOpenQuestions,
	formatPurposeHints,
	formatSelectionStrategy,
	formatTimeline,
} from "./brief.ts";
import {
	formatCompleteness,
	formatConversation,
	formatField,
	formatFilters,
	formatOmittedAttachment,
	joinParts,
} from "./fields.ts";

export function formatContext(data: ContextResult): string {
	return [
		joinParts([
			styles.label("Mattermost context"),
			styles.accent(formatSubject(data.subject)),
			styles.hint(data.freshnessMode),
		]),
		formatField(
			"Searched",
			data.searchedConversations
				.map((conversation) =>
					formatConversation(conversation.kind, conversation.alias),
				)
				.join(", ") || styles.hint("none"),
		),
		...(formatFilters(data.filters) ? [formatFilters(data.filters)] : []),
		formatField(
			"Remote search",
			data.remoteSearch?.performed
				? joinParts([
						styles.accent(data.remoteSearch.reason ?? "fallback"),
						`${styles.accent(String(data.remoteSearch.candidateThreads))} candidate thread(s)`,
					])
				: styles.hint(
						data.remoteSearch?.requested ? "unavailable" : "not used",
					),
		),
		...(data.evidence
			? [
					joinParts([
						formatField("Evidence", styles.accent(data.evidence.adequacy)),
						formatField("currency", styles.accent(data.evidence.currency)),
						formatField(
							"threads",
							styles.accent(data.evidence.completeness.selectedThreads),
						),
						...(data.evidence.completeness.selection
							? [
									formatField(
										"selection",
										data.evidence.completeness.selection === "complete"
											? styles.accent("complete")
											: styles.warning("budget_bounded"),
									),
								]
							: []),
						formatField(
							"index",
							styles.accent(data.evidence.completeness.indexHistory),
						),
						formatField(
							"next",
							data.evidence.next.length
								? styles.warning(
										data.evidence.next.map(({ action }) => action).join(", "),
									)
								: styles.hint("none"),
						),
					]),
					// The roll-up in one line, so the detailed axes above do not have to
					// be re-derived on every read.
					joinParts([
						formatField(
							"Verdict",
							data.evidence.verdict.canAnswerFromSelectedEvidence
								? styles.accent("answerable from selected evidence")
								: styles.warning("not answerable from selected evidence"),
						),
						formatField(
							"other threads",
							data.evidence.verdict.mayHaveMissedOtherThreads
								? styles.warning("may have been missed")
								: styles.hint("fully examined"),
						),
						formatField(
							"selected evidence",
							data.evidence.verdict.selectedEvidenceMayBeStale
								? styles.warning("may be stale")
								: styles.hint("current"),
						),
						formatField(
							"recommended action",
							data.evidence.verdict.recommendedActionRequired
								? styles.warning("required")
								: styles.hint("none"),
						),
					]),
				]
			: []),
		joinParts([
			formatField(
				"Widened",
				data.widening.performed ? styles.warning("yes") : styles.hint("no"),
			),
			formatField(
				"search coverage",
				formatCompleteness(data.searchCoverageComplete),
			),
			formatField(
				"selected threads",
				formatCompleteness(data.selectedThreadsComplete),
			),
		]),
		joinParts([
			formatField(
				"Budget",
				`${styles.accent(`${data.budget.used}/${data.budget.limit}`)} ${styles.hint(data.budget.measurement)}`,
			),
			`max threads ${styles.accent(String(data.budget.maxThreads))}`,
		]),
		...(data.people?.some(({ role }) => role)
			? [
					formatField(
						"People",
						data.people
							.map((person) =>
								person.role
									? `${styles.username(`@${person.username}`)} ${styles.hint(person.role)}`
									: styles.username(`@${person.username}`),
							)
							.join(", "),
					),
				]
			: []),
		...(data.timeline ? formatCrossThreadTimeline(data) : []),
		...orderThreadsForReading(data.threads).flatMap(({ thread, rank, role }) =>
			formatContextThread(thread, {
				rank,
				role,
				brief: Boolean(data.brief),
				// With a merged chronology the per-thread transcript would repeat every
				// message; the thread sections stay as headers plus their brief.
				omitTranscript: Boolean(data.timeline),
				subjectTicket:
					data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
			}),
		),
		...(data.background?.length
			? [
					`\n${styles.label("Background (outside ticket routing, not hydrated):")}`,
					...data.background.map((pointer) =>
						joinParts(
							[
								formatConversation(
									pointer.conversationKind,
									pointer.conversationAlias,
								),
								styles.link(pointer.url),
								styles.timestamp(isoTimestamp(pointer.latestActivityAt)),
								styles.hint(`probes: ${pointer.matchedProbes.join(", ")}`),
								pointer.noise ? styles.warning("noise") : undefined,
								styles.hint(pointer.whyBackground),
								pointer.excerpts.join(" | "),
							].filter((part): part is string => Boolean(part)),
						),
					),
				]
			: []),
		...(data.probeCoverage?.length
			? [
					`\n${styles.label("Probe coverage:")}`,
					...data.probeCoverage.map((coverage) =>
						joinParts([
							styles.identifier(coverage.probe),
							coverage.status === "matched_selected"
								? styles.hint("matched selected evidence")
								: coverage.status === "background_only"
									? styles.hint(
											`background only (${coverage.backgroundThreads} pointer(s))`,
										)
									: styles.warning("no full match"),
							...(coverage.matchedTerms?.length
								? [
										styles.hint(
											`partial: ${coverage.matchedTerms.join(", ")}; missing: ${(coverage.missingTerms ?? []).join(", ")}`,
										),
									]
								: []),
							...(coverage.hint ? [styles.hint(coverage.hint)] : []),
						]),
					),
				]
			: []),
	].join("\n");
}

/**
 * Substance before retrieval order: `role: primary` is the thread picked for
 * depth, and burying it under a higher-ranked stub puts the most informative
 * transcript below the fold. `rank` stays printed so the reading order can be
 * mapped back to the `--agent` `threads[]` order, which never changes.
 */
function orderThreadsForReading(threads: readonly ContextThread[]): Array<{
	thread: ContextThread;
	rank: number;
	role: "primary" | "secondary";
}> {
	const primaryIndex = pickPrimaryThreadIndex(threads);
	return threads
		.map((thread, index) => ({
			thread,
			rank: index + 1,
			role: (index === primaryIndex ? "primary" : "secondary") as
				| "primary"
				| "secondary",
		}))
		.sort(
			(left, right) =>
				Number(right.role === "primary") - Number(left.role === "primary") ||
				left.rank - right.rank,
		);
}

function formatContextThread(
	thread: ContextThread,
	options: {
		rank: number;
		role: "primary" | "secondary";
		brief: boolean;
		/** Messages travel in the merged chronology instead of per thread. */
		omitTranscript?: boolean;
		subjectTicket?: string;
	},
): string[] {
	const brief = buildThreadBrief(thread.posts, {
		subjectTicket: options.subjectTicket,
		reasons: thread.reasons,
		omittedPosts: thread.omittedPosts,
	});
	return [
		`\n${joinParts([
			formatConversation(thread.conversationKind, thread.conversationAlias),
			options.role === "primary"
				? styles.accent("[primary]")
				: styles.hint("[secondary]"),
			styles.hint(`rank ${options.rank}`),
			styles.link(thread.link),
		])}`,
		formatField(
			"Why",
			thread.reasons.map((reason) => styles.accent(reason)).join(", "),
		),
		joinParts([
			formatField(
				"Posts",
				styles.accent(`${thread.returnedPosts}/${thread.totalPosts}`),
			),
			`omitted ${styles.warning(String(thread.omittedPosts))}`,
			`attachments ${styles.accent(String(thread.returnedAttachments))} returned/${styles.warning(String(thread.totalOmittedAttachments))} omitted`,
		]),
		joinParts([
			formatField(
				"Thread budget",
				styles.accent(`${thread.budget.used}/${thread.budget.limit}`),
			),
			`strategy ${formatSelectionStrategy(thread.selectionStrategy)}`,
		]),
		...formatPurposeHints(brief),
		...thread.omittedAttachments.map(formatOmittedAttachment),
		...(thread.unreportedOmittedAttachments
			? [
					`${styles.warning("Unreported omitted attachments:")} ${styles.warning(String(thread.unreportedOmittedAttachments))}`,
				]
			: []),
		// In brief mode the transcript *is* the decision layer and marks its own
		// candidates inline; repeating them above would double the packet's core.
		...(options.brief ? [] : formatDecisions(brief)),
		...(options.brief ? [] : formatOpenQuestions(brief)),
		...(options.omitTranscript
			? []
			: options.brief
				? formatBriefTimeline(thread.timeline, thread.posts, brief)
				: formatTimeline(thread.timeline)),
	];
}

/**
 * Merged chronology across the selected threads. Ranking order routinely puts a
 * "we are rolling it out" message after the report that it broke; reading the
 * packet in time order is the only way that sequence is recoverable without
 * re-sorting timestamps by hand.
 */
function formatCrossThreadTimeline(data: ContextResult): string[] {
	const entries = buildCrossThreadTimeline(data.threads, {
		brief: Boolean(data.brief),
		...(data.subject.kind === "ticket"
			? { subjectTicket: data.subject.ticketKey }
			: {}),
	});
	if (!entries.length) return [];
	const tagOf = threadTagger(data.threads);
	return [
		`\n${styles.label("Timeline across threads")} ${styles.hint(`(${entries.length} event(s), earliest first)`)}`,
		...entries.map((entry) =>
			"skip" in entry
				? styles.hint(
						`[${entry.at}] ${tagOf(entry)} … skipped ${entry.skip.posts} message(s)`,
					)
				: joinParts([
						`${styles.timestamp(`[${entry.at}]`)} ${tagOf(entry)} ${styles.username(`@${entry.author}`)}: ${entry.text}`,
						...(entry.files?.length
							? [styles.warning(`${entry.files.length} attachment(s)`)]
							: []),
					]),
		),
	];
}

/**
 * Conversation tag for a merged event, disambiguated by retrieval rank when one
 * conversation contributed several selected threads — otherwise two unrelated
 * discussions interleave under one identical label.
 */
function threadTagger(
	threads: readonly ContextThread[],
): (entry: { conversation: string; threadId: string }) => string {
	const perConversation = new Map<string, number>();
	for (const thread of threads) {
		perConversation.set(
			thread.conversationAlias,
			(perConversation.get(thread.conversationAlias) ?? 0) + 1,
		);
	}
	const rankOf = new Map(
		threads.map((thread, index) => [thread.threadId, index + 1]),
	);
	return ({ conversation, threadId }) =>
		styles.channel(
			(perConversation.get(conversation) ?? 0) > 1
				? `[${conversation} · rank ${rankOf.get(threadId) ?? "?"}]`
				: `[${conversation}]`,
		);
}
