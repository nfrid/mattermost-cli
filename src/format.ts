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
import type { SyncResult } from "./sync.ts";

interface WhoamiResult {
	id: string;
	username: string;
	displayName: string;
}

export function formatHumanResult(result: CommandResult<unknown>): string {
	if (!result.success) {
		return `Error [${result.error.source}/${result.error.kind}]: ${result.error.message}`;
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

	const warnings = result.warnings.map(
		(warning) => `Warning: ${warning.message}`,
	);
	return [body, ...warnings].filter(Boolean).join("\n");
}

function formatWhoami(data: WhoamiResult): string {
	return `${data.displayName} (@${data.username}) · ${data.id}`;
}

function formatChannels(data: ConfiguredConversationsResult): string {
	const channels = data.channels.map(
		(channel) =>
			`#${channel.alias} · ${channel.name} · ${channel.id ?? "unresolved"}`,
	);
	const directMessages = data.directMessages.map((directMessage) =>
		[
			`DM ${directMessage.alias}`,
			directMessage.channelId,
			directMessage.participants?.join(", "),
		]
			.filter(Boolean)
			.join(" · "),
	);
	return [
		`Channels (${channels.length})`,
		...(channels.length ? channels : ["(none)"]),
		`Direct messages (${directMessages.length})`,
		...(directMessages.length ? directMessages : ["(none)"]),
	].join("\n");
}

function formatValidation(data: ChannelValidationResult): string {
	return [
		`Configured conversations: ${data.valid ? "valid" : "invalid"}`,
		...data.items.map(
			(item) =>
				`${item.valid ? "OK" : "FAIL"} · ${item.kind} · ${item.alias} · ${item.resolvedId ?? item.configuredId ?? "unresolved"}${item.error ? ` · ${item.error}` : ""}`,
		),
	].join("\n");
}

function formatDoctor(data: DoctorResult): string {
	return [
		`Mattermost doctor: ${data.healthy ? "healthy" : "unhealthy"}`,
		...data.checks.map(
			(check) =>
				`${check.ok ? "OK" : "FAIL"} · ${check.name} · ${check.message}`,
		),
	].join("\n");
}

function formatSync(data: SyncResult): string {
	return [
		`Synchronized ${data.conversations.length} conversation(s).`,
		...data.conversations.map(
			(conversation) =>
				`${conversation.alias} · ${conversation.mode} · ${conversation.postsProcessed} posts · ${conversation.coverageComplete ? "complete" : "cutoff-bounded"}`,
		),
	].join("\n");
}

function formatContext(data: ContextResult): string {
	return [
		`Mattermost context · ${formatSubject(data.subject)} · ${data.freshnessMode}`,
		`Searched: ${data.searchedConversations.map((conversation) => `${conversation.kind === "channel" ? "#" : "DM "}${conversation.alias}`).join(", ") || "none"}`,
		`Widened: ${data.widening.performed ? "yes" : "no"} · search coverage: ${data.searchCoverageComplete ? "complete" : "incomplete"} · selected threads: ${data.selectedThreadsComplete ? "complete" : "incomplete"}`,
		`Budget: ${data.budget.used}/${data.budget.limit} ${data.budget.measurement} · max threads ${data.budget.maxThreads}`,
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
				`\n${thread.conversationKind === "channel" ? "#" : "DM "}${thread.conversationAlias} · ${thread.link}`,
				`Why: ${thread.reasons.join(", ")}`,
				`Posts: ${thread.returnedPosts}/${thread.totalPosts} · omitted ${thread.omittedPosts} · attachments ${thread.returnedAttachments} returned/${thread.totalOmittedAttachments} omitted`,
				...(displayedPosts.length < thread.posts.length
					? [
							`Compact human view: showing ${displayedPosts.length}/${thread.returnedPosts} returned posts; use --more for expanded rendering or --json for the complete packet.`,
						]
					: []),
				`Thread budget: ${thread.budget.used}/${thread.budget.limit} · strategy ${thread.selectionStrategy.join(", ")}`,
				...thread.omittedAttachments.map(
					(attachment) =>
						`Omitted attachment: ${attachment.name} · ${attachment.mimeType} · ${attachment.size} bytes · post ${attachment.postId}`,
				),
				...(thread.unreportedOmittedAttachments
					? [
							`Unreported omitted attachments: ${thread.unreportedOmittedAttachments}`,
						]
					: []),
				...displayedPosts.flatMap((post) => [
					`[${new Date(post.createAt).toISOString()}] @${post.authorUsername}: ${post.deleteAt ? "[deleted]" : post.message}`,
					...post.attachments.map(
						(attachment) =>
							`Attachment: ${attachment.name} · ${attachment.mimeType} · ${attachment.size} bytes · ${attachment.id}`,
					),
				]),
			];
		}),
	].join("\n");
}

function formatSearch(data: SearchContextResult): string {
	return [
		`Mattermost search · ${formatSubject(data.subject)} · ${data.candidates.length} thread(s) · local`,
		`Routing: ${data.routing.reason} · widened: ${data.widened ? "yes" : "no"} · search coverage: ${data.searchCoverageComplete ? "complete" : "incomplete"}`,
		`Probes: ${data.probes.map(({ value }) => value).join(", ") || "none"} · ranking signals, not required filters`,
		...data.candidates.map(
			(candidate) =>
				`${candidate.conversationKind === "channel" ? "#" : "DM "}${candidate.conversationAlias} · ${candidate.link} · ${candidate.reasons.join(", ")} · ${candidate.matches.map(({ excerpt }) => excerpt).join(" | ") || "no text probe match; selected by other evidence"}`,
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
		`Mattermost thread · ${data.conversation.kind === "channel" ? "#" : "DM "}${data.conversation.alias} · ${data.link}`,
		`Freshness: ${data.freshnessMode} · complete: ${data.complete ? "yes" : "no"} · observed ${new Date(data.freshness.observedAt).toISOString()}`,
		`Posts: ${data.thread.returnedPosts}/${data.thread.totalPosts} · omitted ${data.thread.omittedPosts} · attachments ${data.thread.returnedAttachments} returned/${data.thread.totalOmittedAttachments} omitted`,
		`Budget: ${data.thread.budget.used}/${data.thread.budget.limit} ${data.thread.budget.measurement} · strategy ${data.thread.selectionStrategy.join(", ")}`,
		...data.thread.omittedAttachments.map(
			(attachment) =>
				`Omitted attachment: ${attachment.name} · ${attachment.mimeType} · ${attachment.size} bytes · post ${attachment.postId}`,
		),
		...(data.thread.unreportedOmittedAttachments
			? [
					`Unreported omitted attachments: ${data.thread.unreportedOmittedAttachments}`,
				]
			: []),
		...data.thread.posts.flatMap((post) => [
			`[${new Date(post.createAt).toISOString()}] @${post.authorUsername}: ${post.deleteAt ? "[deleted]" : post.message}`,
			...post.attachments.map(
				(attachment) =>
					`Attachment: ${attachment.name} · ${attachment.mimeType} · ${attachment.size} bytes · ${attachment.id}`,
			),
		]),
	].join("\n");
}

function formatSubject(subject: ContextResult["subject"]): string {
	return subject.kind === "ticket"
		? subject.ticketKey
		: subject.kind === "post"
			? subject.postId
			: subject.text;
}
