import type {
	ContextResult,
	ContextThread,
	SearchContextResult,
	ThreadResult,
} from "./context.ts";
import type {
	EvidencePost,
	PackedPost,
	PackedThread,
	PackTimelineItem,
} from "./packing.ts";
import type { CommandResult, Warning } from "./results.ts";
import type { MattermostSubject } from "./retrieval.ts";

export interface AgentFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}

export interface AgentMessage {
	id: string;
	text: string;
	at?: string;
	editedAt?: string;
	deleted?: true;
	files?: AgentFile[];
}

/** Consecutive posts from one author, collapsed to reduce envelope noise. */
export interface AgentMessageGroup {
	author: string;
	messages: AgentMessage[];
}

/** Omitted chronological span between returned posts. */
export interface AgentSkip {
	skip: {
		posts: number;
		after?: string;
		before?: string;
	};
}

export type AgentTimelineItem = AgentMessageGroup | AgentSkip;

export interface AgentStatus {
	freshness: "local" | "network";
	searchComplete: boolean;
	/** True when every returned thread has no packing omissions. */
	threadsComplete: boolean;
}

export interface AgentOmission {
	posts: number;
	attachments: number;
	files?: string[];
}

export interface AgentThread {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	omitted: AgentOmission;
	posts: AgentTimelineItem[];
	/** Prior DM root posts for short threads (not replies of this thread). */
	surround?: AgentMessageGroup[];
}

export interface AgentCandidate {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	latestAt: string;
	excerpts: string[];
}

export type AgentCommandResult =
	| {
			command: string;
			schemaVersion: 1;
			success: true;
			warnings: Warning[];
			[key: string]: unknown;
	  }
	| Extract<CommandResult<never>, { success: false }>;

/** Build the compact agent view from the same validated result used by JSON output. */
export function projectAgentResult(
	result: CommandResult<unknown>,
): AgentCommandResult {
	if (!result.success) return result;

	const envelope = {
		command: result.command,
		schemaVersion: result.schemaVersion,
		success: true as const,
	};

	switch (result.command) {
		case "context":
			return projectContext(
				envelope,
				result.data as ContextResult,
				result.warnings,
			);
		case "search":
			return projectSearch(
				envelope,
				result.data as SearchContextResult,
				result.warnings,
			);
		case "thread":
			return projectThread(
				envelope,
				result.data as ThreadResult,
				result.warnings,
			);
		case "file":
			return {
				...envelope,
				...(isRecord(result.data) ? result.data : { result: result.data }),
				warnings: result.warnings,
			};
		default:
			return {
				...envelope,
				...(isRecord(result.data) ? result.data : { result: result.data }),
				warnings: result.warnings,
			};
	}
}

function projectContext(
	envelope: { command: string; schemaVersion: 1; success: true },
	data: ContextResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(
			data.freshnessMode,
			data.searchCoverageComplete,
			data.selectedThreadsComplete,
		),
		...(data.remoteSearch.performed || data.remoteSearch.requested
			? { remoteSearch: data.remoteSearch }
			: {}),
		threads: data.threads.map(projectContextThread),
		warnings,
	};
}

function projectSearch(
	envelope: { command: string; schemaVersion: 1; success: true },
	data: SearchContextResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode, data.searchCoverageComplete, false),
		candidates: data.candidates.map(
			(candidate): AgentCandidate => ({
				threadId: candidate.threadId,
				conversation: candidate.conversationAlias,
				kind: candidate.conversationKind,
				url: candidate.link,
				latestAt: iso(candidate.latestActivityAt),
				excerpts: [...new Set(candidate.matches.map(({ excerpt }) => excerpt))],
			}),
		),
		warnings,
	};
}

function projectThread(
	envelope: { command: string; schemaVersion: 1; success: true },
	data: ThreadResult,
	warnings: Warning[],
): AgentCommandResult {
	const packingComplete =
		data.thread.omittedPosts === 0 && data.thread.totalOmittedAttachments === 0;
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode, true, packingComplete),
		thread: projectPackedThread(
			data.thread,
			data.conversation.alias,
			data.conversation.kind,
			data.link,
		),
		warnings,
	};
}

function projectContextThread(thread: ContextThread): AgentThread {
	return {
		...projectPackedThread(
			thread,
			thread.conversationAlias,
			thread.conversationKind,
			thread.link,
		),
		...(thread.surround?.length
			? { surround: groupEvidencePosts(thread.surround) }
			: {}),
	};
}

function projectPackedThread(
	thread: PackedThread,
	conversation: string,
	kind: "channel" | "direct_message",
	url: string,
): AgentThread {
	const omittedNames = [
		...new Set(thread.omittedAttachments.map(({ name }) => name)),
	];
	return {
		threadId: thread.threadId,
		conversation,
		kind,
		url,
		omitted: {
			posts: thread.omittedPosts,
			attachments: thread.totalOmittedAttachments,
			...(omittedNames.length ? { files: omittedNames } : {}),
		},
		posts: projectTimeline(thread.timeline),
	};
}

function projectTimeline(
	timeline: readonly PackTimelineItem[],
): AgentTimelineItem[] {
	const items: AgentTimelineItem[] = [];
	let openGroup: AgentMessageGroup | undefined;

	const flushGroup = () => {
		if (openGroup) {
			items.push(openGroup);
			openGroup = undefined;
		}
	};

	for (const item of timeline) {
		if (item.kind === "skip") {
			flushGroup();
			items.push({ skip: item.skip });
			continue;
		}
		const message = projectMessage(item.post);
		if (openGroup && openGroup.author === item.post.authorUsername) {
			openGroup.messages.push(message);
			continue;
		}
		flushGroup();
		openGroup = {
			author: item.post.authorUsername,
			messages: [message],
		};
	}
	flushGroup();
	return items;
}

function groupEvidencePosts(
	posts: readonly EvidencePost[],
): AgentMessageGroup[] {
	return groupPosts(
		posts.map((post) => ({
			id: post.id,
			author: post.authorUsername,
			createAt: post.createAt,
			updateAt: post.updateAt,
			deleteAt: post.deleteAt,
			message: post.message,
			attachments: post.attachments,
		})),
	);
}

function groupPosts(
	posts: readonly {
		id: string;
		author: string;
		createAt: number;
		updateAt: number;
		deleteAt: number;
		message: string;
		attachments: PackedPost["attachments"];
	}[],
): AgentMessageGroup[] {
	const groups: AgentMessageGroup[] = [];
	for (const post of posts) {
		const message = projectMessage(post);
		const previous = groups[groups.length - 1];
		if (previous && previous.author === post.author) {
			previous.messages.push(message);
			continue;
		}
		groups.push({
			author: post.author,
			messages: [message],
		});
	}
	return groups;
}

function projectMessage(post: {
	id: string;
	createAt: number;
	updateAt: number;
	deleteAt: number;
	message: string;
	attachments: PackedPost["attachments"];
}): AgentMessage {
	const files = post.attachments.map((attachment) => ({
		id: attachment.id,
		name: attachment.name,
		...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
		...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
	}));
	return {
		id: post.id,
		text: post.message,
		at: iso(post.createAt),
		...(post.updateAt > post.createAt ? { editedAt: iso(post.updateAt) } : {}),
		...(post.deleteAt ? { deleted: true as const } : {}),
		...(files.length ? { files } : {}),
	};
}

function status(
	freshnessMode: "local" | "network" | "forced",
	searchComplete: boolean,
	threadsComplete: boolean,
): AgentStatus {
	return {
		freshness: freshnessMode === "local" ? "local" : "network",
		searchComplete,
		threadsComplete,
	};
}

function subjectValue(subject: MattermostSubject): string {
	switch (subject.kind) {
		case "ticket":
			return subject.ticketKey;
		case "post":
			return subject.postId;
		case "text":
			return subject.text;
	}
}

function iso(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
