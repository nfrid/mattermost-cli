import type {
	ContextResult,
	SearchContextResult,
	ThreadResult,
} from "./context.ts";
import type { PackedPost } from "./packing.ts";
import type { CommandResult } from "./results.ts";
import type {
	ChannelValidationResult,
	ConfiguredConversationsResult,
	DoctorResult,
} from "./setup.ts";
import { styles } from "./styles.ts";
import type { SyncResult } from "./sync.ts";

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
		case "search":
			body = formatSearch(result.data as SearchContextResult);
			break;
		case "thread":
			body = formatThread(result.data as ThreadResult);
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
		...data.threads.flatMap((thread) => {
			const displayedPosts =
				data.detailLevel === "expanded"
					? thread.posts
					: compactThreadPosts(
							thread.posts,
							thread.matchingPostIds,
							thread.threadId,
						);
			return [
				`\n${joinParts([
					formatConversation(thread.conversationKind, thread.conversationAlias),
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
				...(displayedPosts.length < thread.posts.length
					? [
							styles.hint(
								`Compact human view: showing ${displayedPosts.length}/${thread.returnedPosts} returned posts; use --more for expanded rendering or --json for the complete packet.`,
							),
						]
					: []),
				joinParts([
					formatField(
						"Thread budget",
						styles.accent(`${thread.budget.used}/${thread.budget.limit}`),
					),
					`strategy ${thread.selectionStrategy.map((strategy) => styles.hint(strategy)).join(", ")}`,
				]),
				...thread.omittedAttachments.map(formatOmittedAttachment),
				...(thread.unreportedOmittedAttachments
					? [
							`${styles.warning("Unreported omitted attachments:")} ${styles.warning(String(thread.unreportedOmittedAttachments))}`,
						]
					: []),
				...displayedPosts.flatMap(formatPost),
			];
		}),
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

function compactThreadPosts(
	posts: readonly PackedPost[],
	matchingPostIds: readonly string[],
	threadId: string,
): PackedPost[] {
	if (posts.length <= 6) return [...posts];
	const byId = new Map(posts.map((post) => [post.id, post]));
	const selected = new Set<string>();
	if (byId.has(threadId)) selected.add(threadId);
	for (const id of matchingPostIds.slice(0, 2)) {
		if (byId.has(id)) selected.add(id);
	}
	for (const post of posts.slice(-3)) selected.add(post.id);
	return posts.filter(({ id }) => selected.has(id));
}

function formatThread(data: ThreadResult): string {
	return [
		joinParts([
			styles.label("Mattermost thread"),
			formatConversation(data.conversation.kind, data.conversation.alias),
			styles.link(data.link),
		]),
		joinParts([
			formatField("Freshness", styles.hint(data.freshnessMode)),
			formatField("complete", formatCompleteness(data.complete, "yes", "no")),
			`observed ${styles.timestamp(new Date(data.freshness.observedAt).toISOString())}`,
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
			`strategy ${data.thread.selectionStrategy.map((strategy) => styles.hint(strategy)).join(", ")}`,
		]),
		...data.thread.omittedAttachments.map(formatOmittedAttachment),
		...(data.thread.unreportedOmittedAttachments
			? [
					`${styles.warning("Unreported omitted attachments:")} ${styles.warning(String(data.thread.unreportedOmittedAttachments))}`,
				]
			: []),
		...data.thread.posts.flatMap(formatPost),
	].join("\n");
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
	return styles.channel(`${kind === "channel" ? "#" : "DM "}${alias}`);
}

function formatPost(post: PackedPost): string[] {
	return [
		`${styles.timestamp(`[${new Date(post.createAt).toISOString()}]`)} ${styles.username(`@${post.authorUsername}`)}: ${post.deleteAt ? styles.warning("[deleted]") : post.message}`,
		...post.attachments.map((attachment) =>
			joinParts([
				`${styles.warning("Attachment:")} ${styles.label(attachment.name)}`,
				styles.hint(attachment.mimeType),
				`${styles.accent(String(attachment.size))} bytes`,
				styles.identifier(attachment.id),
			]),
		),
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

function formatSubject(subject: ContextResult["subject"]): string {
	return subject.kind === "ticket"
		? subject.ticketKey
		: subject.kind === "post"
			? subject.postId
			: subject.text;
}
