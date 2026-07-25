import type {
	ContextResult,
	ContextThread,
	SearchContextResult,
	ThreadResult,
} from "../context/index.ts";
import type { PeopleResult } from "../context/people.ts";
import { pickPrimaryThreadIndex } from "../context/selection.ts";
import { isMediaOnlyPost, type PackedPost } from "../evidence/packing.ts";
import {
	briefRetainedPostIds,
	buildThreadBrief,
	type ThreadBrief,
} from "../evidence/signals.ts";
import type { CommandResult } from "../shared/command-result.ts";
import type { FileBatchDownloadResult } from "../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../sync/file-download.ts";
import type {
	ChannelValidationResult,
	ConfiguredConversationsResult,
	DoctorResult,
} from "../sync/setup.ts";
import type { SyncResult } from "../sync/sync.ts";
import { conversationLabel, formatSubject, isoTimestamp } from "./shared.ts";
import { styles } from "./styles.ts";
import { buildCrossThreadTimeline } from "./timeline.ts";

interface WhoamiResult {
	id: string;
	username: string;
	displayName: string;
}

export function formatHumanResult(result: CommandResult<unknown>): string {
	if (!result.success) {
		return styles.error(
			`Error [${result.error.source}/${result.error.kind}]: ${result.error.message}`,
		);
	}

	let body: string;
	switch (result.command) {
		case "whoami":
			body = formatWhoami(result.data as WhoamiResult);
			break;
		case "channels":
			body = formatChannels(result.data as ConfiguredConversationsResult);
			break;
		case "channels.validate":
			body = formatValidation(result.data as ChannelValidationResult);
			break;
		case "doctor":
			body = formatDoctor(result.data as DoctorResult);
			break;
		case "sync":
			body = formatSync(result.data as SyncResult);
			break;
		case "context":
			body = formatContext(result.data as ContextResult);
			break;
		case "people":
			body = formatPeople(result.data as PeopleResult);
			break;
		case "search":
			body = formatSearch(result.data as SearchContextResult);
			break;
		case "thread":
			body = formatThread(result.data as ThreadResult);
			break;
		case "file":
			body = formatFile(result.data as FileDownloadResult);
			break;
		case "files":
			body = formatFiles(result.data as FileBatchDownloadResult);
			break;
		default:
			body = JSON.stringify(result.data, null, 2);
	}

	const warnings = result.warnings.map((warning) =>
		styles.warning(`Warning: ${warning.message}`),
	);
	return [body, ...warnings].filter(Boolean).join("\n");
}

function formatWhoami(data: WhoamiResult): string {
	return joinParts([
		`${styles.label(data.displayName)} ${styles.username(`(@${data.username})`)}`,
		styles.identifier(data.id),
	]);
}

function formatChannels(data: ConfiguredConversationsResult): string {
	const channels = data.channels.map((channel) =>
		joinParts([
			formatConversation("channel", channel.alias),
			channel.name,
			channel.id ? styles.identifier(channel.id) : styles.warning("unresolved"),
		]),
	);
	const directMessages = data.directMessages.map((directMessage) =>
		joinParts(
			[
				formatConversation("direct", directMessage.alias),
				directMessage.channelId
					? styles.identifier(directMessage.channelId)
					: undefined,
				directMessage.participants
					?.map((participant) => styles.username(participant))
					.join(", "),
			].filter((part): part is string => Boolean(part)),
		),
	);
	return [
		styles.label(`Channels (${styles.accent(String(channels.length))})`),
		...(channels.length ? channels : [styles.hint("(none)")]),
		styles.label(
			`Direct messages (${styles.accent(String(directMessages.length))})`,
		),
		...(directMessages.length ? directMessages : [styles.hint("(none)")]),
	].join("\n");
}

function formatValidation(data: ChannelValidationResult): string {
	return [
		`${styles.label("Configured conversations:")} ${formatHealth(data.valid, "valid", "invalid")}`,
		...data.items.map((item) =>
			joinParts([
				formatHealth(item.valid, "OK", "FAIL"),
				styles.hint(item.kind),
				styles.channel(item.alias),
				item.resolvedId || item.configuredId
					? styles.identifier(item.resolvedId ?? item.configuredId ?? "")
					: styles.warning("unresolved"),
				...(item.error ? [styles.error(item.error)] : []),
			]),
		),
	].join("\n");
}

function formatDoctor(data: DoctorResult): string {
	return [
		`${styles.label("Mattermost doctor:")} ${formatHealth(data.healthy, "healthy", "unhealthy")}`,
		...data.checks.map((check) =>
			joinParts([
				formatHealth(check.ok, "OK", "FAIL"),
				styles.label(check.name),
				check.message,
			]),
		),
	].join("\n");
}

function formatSync(data: SyncResult): string {
	return [
		styles.success(
			`Synchronized ${data.conversations.length} conversation(s).`,
		),
		...data.conversations.map((conversation) =>
			joinParts([
				styles.channel(conversation.alias),
				styles.hint(conversation.mode),
				`${styles.accent(String(conversation.postsProcessed))} posts`,
				conversation.coverageComplete
					? styles.success("complete")
					: styles.warning("cutoff-bounded"),
			]),
		),
	].join("\n");
}

function formatContext(data: ContextResult): string {
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
						joinParts([
							formatConversation(
								pointer.conversationKind,
								pointer.conversationAlias,
							),
							styles.link(pointer.url),
							styles.timestamp(isoTimestamp(pointer.latestActivityAt)),
							styles.hint(`probes: ${pointer.matchedProbes.join(", ")}`),
							pointer.excerpts.join(" | "),
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

/**
 * Collapse consecutive repeats (`a, b, b, b` → `a, b ×3`): a packing strategy
 * repeated once per neighborhood says nothing more than its count.
 */
function formatSelectionStrategy(strategies: readonly string[]): string {
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
function formatPurposeHints(brief: ThreadBrief): string[] {
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

/** Aliases named inline before the scope line switches to a count. */
const SCOPE_ALIAS_LIMIT = 6;

function formatPeople(data: PeopleResult): string {
	// A full alias roster is dozens of DMs long; name them only when the scope is
	// narrow enough that naming them is the point.
	const scope =
		data.conversations.length <= SCOPE_ALIAS_LIMIT
			? data.conversations.join(", ")
			: `${data.conversations.length} configured conversation(s)`;
	return [
		joinParts([
			styles.label("Mattermost people"),
			styles.accent(
				data.people.length < data.total
					? `${data.people.length}/${data.total}`
					: `${data.total}`,
			),
			styles.hint(scope),
		]),
		...(data.people.length
			? data.people.map((person) =>
					joinParts([
						styles.username(`@${person.username}`),
						person.displayName ?? "",
						person.role
							? `${styles.accent(person.role)} ${styles.hint(person.roleSource ?? "")}`
							: styles.hint("role unknown"),
						`${styles.accent(String(person.messages))} message(s)`,
						styles.timestamp(isoTimestamp(person.latestAt)),
						...(person.isBot ? [styles.warning("bot")] : []),
					]),
				)
			: [styles.hint("(none indexed)")]),
	].join("\n");
}

function formatSearch(data: SearchContextResult): string {
	return [
		joinParts([
			styles.label("Mattermost search"),
			styles.accent(formatSubject(data.subject)),
			`${styles.accent(String(data.candidates.length))} thread(s)`,
			styles.hint("local"),
		]),
		joinParts([
			formatField("Routing", styles.accent(data.routing.reason)),
			formatField(
				"widened",
				data.widened ? styles.warning("yes") : styles.hint("no"),
			),
			formatField(
				"search coverage",
				formatCompleteness(data.searchCoverageComplete),
			),
		]),
		joinParts([
			formatField(
				"Probes",
				data.probes.map(({ value }) => styles.accent(value)).join(", ") ||
					styles.hint("none"),
			),
			styles.hint("ranking signals, not required filters"),
		]),
		...(formatFilters(data.filters) ? [formatFilters(data.filters)] : []),
		...data.candidates.map((candidate) =>
			joinParts([
				formatConversation(
					candidate.conversationKind,
					candidate.conversationAlias,
				),
				styles.link(candidate.link),
				candidate.reasons.map((reason) => styles.accent(reason)).join(", "),
				candidate.matches.map(({ excerpt }) => excerpt).join(" | ") ||
					styles.hint("no text probe match; selected by other evidence"),
			]),
		),
	].join("\n");
}

function formatFilters(filters: {
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
}): string {
	const values = [
		filters.from ? `from=${filters.from}` : "",
		filters.after ? `after=${filters.after}` : "",
		filters.before ? `before=${filters.before}` : "",
		filters.hasFile ? "has-file" : "",
		filters.file ? `file=${filters.file}` : "",
	].filter(Boolean);
	return values.length
		? formatField(
				"Filters",
				values.map((value) => styles.accent(value)).join(", "),
			)
		: "";
}

/**
 * Decision-only transcript: the posts the brief points at, with everything the
 * projection withholds collapsed into an explicit marker. Packing's own skips
 * keep their own counts, so the two omission kinds stay attributable.
 */
function formatBriefTimeline(
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

function formatTimeline(timeline: ContextThread["timeline"]): string[] {
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

function formatThread(data: ThreadResult): string {
	const brief = buildThreadBrief(data.thread.posts, {
		subjectTicket:
			data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
		omittedPosts: data.thread.omittedPosts,
	});
	return [
		joinParts([
			styles.label("Mattermost thread"),
			formatConversation(data.conversation.kind, data.conversation.alias),
			styles.link(data.link),
		]),
		joinParts([
			formatField("Freshness", styles.hint(data.freshnessMode)),
			formatField("complete", formatCompleteness(data.complete, "yes", "no")),
			`observed ${styles.timestamp(isoTimestamp(data.freshness.observedAt))}`,
		]),
		joinParts([
			formatField(
				"Posts",
				styles.accent(`${data.thread.returnedPosts}/${data.thread.totalPosts}`),
			),
			`omitted ${styles.warning(String(data.thread.omittedPosts))}`,
			`attachments ${styles.accent(String(data.thread.returnedAttachments))} returned/${styles.warning(String(data.thread.totalOmittedAttachments))} omitted`,
		]),
		joinParts([
			formatField(
				"Budget",
				`${styles.accent(`${data.thread.budget.used}/${data.thread.budget.limit}`)} ${styles.hint(data.thread.budget.measurement)}`,
			),
			`strategy ${formatSelectionStrategy(data.thread.selectionStrategy)}`,
		]),
		...formatPurposeHints(brief),
		...data.thread.omittedAttachments.map(formatOmittedAttachment),
		...(data.thread.unreportedOmittedAttachments
			? [
					`${styles.warning("Unreported omitted attachments:")} ${styles.warning(String(data.thread.unreportedOmittedAttachments))}`,
				]
			: []),
		...(data.brief ? [] : formatDecisions(brief)),
		...(data.brief ? [] : formatOpenQuestions(brief)),
		...(data.brief
			? formatBriefTimeline(data.thread.timeline, data.thread.posts, brief)
			: formatTimeline(data.thread.timeline)),
	].join("\n");
}

function formatFile(data: FileDownloadResult): string {
	return joinParts([
		styles.success("Downloaded"),
		styles.label(data.name),
		styles.identifier(data.id),
		styles.hint(data.mimeType),
		`${styles.accent(String(data.size))} bytes`,
		styles.link(data.path),
	]);
}

function formatFiles(data: FileBatchDownloadResult): string {
	const summary = joinParts([
		styles.success(`Downloaded ${data.downloaded}`),
		styles.hint(`${data.failed} failed`),
		styles.hint(`${data.skipped} skipped`),
		`${styles.accent(String(data.totalBytes))} bytes`,
		styles.link(data.outDir),
	]);
	const lines = data.files.map((item) => {
		if (item.status === "downloaded") {
			return joinParts([
				styles.success("ok"),
				styles.label(item.name),
				styles.identifier(item.id),
				styles.link(item.path),
			]);
		}
		return joinParts(
			[
				styles.warning(item.status),
				item.name ? styles.label(item.name) : undefined,
				item.id ? styles.identifier(item.id) : undefined,
				styles.hint(`${item.error.kind}: ${item.error.message}`),
			].filter((part): part is string => Boolean(part)),
		);
	});
	return [summary, ...lines].join("\n");
}

function joinParts(parts: string[]): string {
	return parts.join(styles.hint(" · "));
}

function formatField(label: string, value: string): string {
	return `${styles.hint(`${label}:`)} ${value}`;
}

function formatHealth(
	healthy: boolean,
	success: string,
	failure: string,
): string {
	return healthy ? styles.success(success) : styles.error(failure);
}

function formatCompleteness(
	complete: boolean,
	success = "complete",
	failure = "incomplete",
): string {
	return complete ? styles.success(success) : styles.warning(failure);
}

function formatConversation(kind: string, alias: string): string {
	return styles.channel(conversationLabel(kind, alias));
}

function formatPost(post: PackedPost): string[] {
	const body = post.deleteAt
		? styles.warning("[deleted]")
		: isMediaOnlyPost(post)
			? styles.warning("[no text — the attachment is the whole message]")
			: post.message;
	return [
		`${styles.timestamp(`[${isoTimestamp(post.createAt)}]`)} ${styles.username(`@${post.authorUsername}`)}: ${body}`,
		...post.attachments.map((attachment) =>
			joinParts([
				`${styles.warning("Attachment:")} ${styles.label(attachment.name)}`,
				styles.hint(attachment.mimeType),
				`${styles.accent(String(attachment.size))} bytes`,
				styles.identifier(attachment.id),
				styles.hint(`mm file ${attachment.id}`),
			]),
		),
	];
}

/**
 * Inlined open questions so the text view answers "what is still hanging",
 * symmetric to the decision block.
 */
function formatOpenQuestions(brief: ThreadBrief): string[] {
	const questions = brief.openQuestions ?? [];
	if (!questions.length) return [];
	return [
		`${styles.label("Open questions:")} ${styles.hint("mechanical cues; the packet contains no answer, which is not proof there is none")}`,
		...questions.map((question) =>
			joinParts([
				styles.timestamp(`[${isoTimestamp(question.createAt)}]`),
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

/**
 * Marks a decision-layer text the packet had to cut. Without it the only sign
 * of loss is a trailing `…`, which an author may equally have typed themselves.
 */
function truncatedTextHint(): string {
	return styles.warning("[text truncated — read the post]");
}

/** Inlined decision candidates so the text view answers "what was decided". */
function formatDecisions(brief: ThreadBrief): string[] {
	const decisions = brief.decisions ?? [];
	if (!decisions.length) return [];
	return [
		`${styles.label("Decision candidates:")} ${styles.hint("mechanical cues, not verified outcomes")}`,
		...decisions.flatMap((decision) => [
			joinParts([
				styles.timestamp(`[${isoTimestamp(decision.createAt)}]`),
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

function formatOmittedAttachment(attachment: {
	name: string;
	mimeType: string;
	size: number;
	postId: string;
}): string {
	return joinParts([
		`${styles.warning("Omitted attachment:")} ${styles.label(attachment.name)}`,
		styles.hint(attachment.mimeType),
		`${styles.accent(String(attachment.size))} bytes`,
		`post ${styles.identifier(attachment.postId)}`,
	]);
}
