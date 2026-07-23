import type {
	ContextResult,
	ContextThread,
	SearchContextResult,
	ThreadResult,
} from "./context.ts";
import type { PackedPost, PackedThread } from "./packing.ts";
import type { CommandResult, Warning } from "./results.ts";
import type { MattermostSubject, RankingReason } from "./retrieval.ts";

export interface AgentFile {
	name: string;
	mimeType: string;
	size: number;
}

export interface AgentPost {
	id: string;
	at: string;
	author: string;
	text: string;
	displayName?: string;
	editedAt?: string;
	deleted?: true;
	files?: AgentFile[];
}

export interface AgentStatus {
	freshness: "local" | "network";
	searchComplete: boolean;
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
	why?: RankingReason[];
	omitted: AgentOmission;
	posts: AgentPost[];
}

export interface AgentCandidate {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	latestAt: string;
	why: RankingReason[];
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
				why: meaningfulReasons(candidate.reasons),
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
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode, true, data.complete),
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
		why: meaningfulReasons(thread.reasons),
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
		posts: thread.posts.map(projectPost),
	};
}

function projectPost(post: PackedPost): AgentPost {
	const files = post.attachments.map(({ name, mimeType, size }) => ({
		name,
		mimeType,
		size,
	}));
	return {
		id: post.id,
		at: iso(post.createAt),
		author: post.authorUsername,
		text: post.message,
		...(post.authorDisplayName && post.authorDisplayName !== post.authorUsername
			? { displayName: post.authorDisplayName }
			: {}),
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

function meaningfulReasons(reasons: readonly RankingReason[]): RankingReason[] {
	return reasons.filter(
		(reason) =>
			reason !== "conversation_priority" && reason !== "latest_activity",
	);
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
