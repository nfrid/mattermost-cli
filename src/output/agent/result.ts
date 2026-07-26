import type {
	ContextResult,
	ContextThread,
	RemoteSearchEvidence,
	SearchContextResult,
	SelectionEvidence,
	ThreadResult,
} from "../../context/index.ts";
import type { PersonRef } from "../../context/people.ts";
import { pickPrimaryThreadIndex } from "../../context/selection.ts";
import { buildEvidence } from "../../evidence/evidence.ts";
import type { PackedThread } from "../../evidence/packing.ts";
import type { CommandResult, Warning } from "../../shared/command-result.ts";
import type { FileBatchDownloadResult } from "../../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../../sync/file-download.ts";
import { isoTimestamp, subjectValue } from "../shared.ts";
import { buildCrossThreadTimeline } from "../timeline.ts";
import { shortMessagesFromThreads } from "./messages.ts";
import {
	projectRelatedTickets,
	relatedTicketsFromPosts,
} from "./related-tickets.ts";
import { projectContextThread, projectPackedThread } from "./thread.ts";
import type {
	AgentBackgroundThread,
	AgentCandidate,
	AgentCommandResult,
	AgentEnvelope,
	AgentResolvedSubject,
	AgentStatus,
} from "./types.ts";

const SHORT_MESSAGE_LIMIT = 8;

/** Neutral placeholders for projections with no discovery of their own. */
const NO_REMOTE_SEARCH: RemoteSearchEvidence = {
	requested: false,
	performed: false,
	reason: null,
	queries: [],
	candidateThreads: 0,
	failures: 0,
};

const SINGLE_THREAD_SELECTION: SelectionEvidence = {
	candidateThreads: 1,
	returnedThreads: 1,
	droppedThin: 0,
	droppedByBudget: 0,
	droppedByBudgetSubjectMatched: 0,
	droppedNoMatch: 0,
	droppedCandidates: [],
};

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
			return projectFileDownload(
				envelope,
				result.data as FileDownloadResult,
				result.warnings,
			);
		case "files":
			return projectFiles(
				envelope,
				result.data as FileBatchDownloadResult,
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
	envelope: AgentEnvelope,
	data: ContextResult,
	warnings: Warning[],
): AgentCommandResult {
	const relatedTickets = projectRelatedTickets(data.relatedTickets);
	const navigate = Boolean(data.navigate);
	const short = Boolean(data.short);
	const brief = Boolean(data.brief);
	const timeline = Boolean(data.timeline);
	const subjectTicket =
		data.subject.kind === "ticket" ? data.subject.ticketKey : undefined;
	const includeSignals = Boolean(data.signals);
	const primaryIndex = pickPrimaryThreadIndex(data.threads);
	const resolved = resolvedSubject(data.subject, data.threads);
	const threads = data.threads.map((thread, index) =>
		projectContextThread(thread, {
			short,
			navigate,
			brief,
			// The merged chronology already carries every packed message; repeating
			// them per thread would double the packet for no added evidence.
			omitPosts: timeline,
			includeSignals,
			rank: index + 1,
			role: index === primaryIndex ? "primary" : "secondary",
			subjectTicket,
			...(resolved ? { anchorPostId: resolved.postId } : {}),
		}),
	);
	const messages =
		short && !navigate
			? shortMessagesFromThreads(
					data.threads,
					primaryIndex,
					SHORT_MESSAGE_LIMIT,
				)
			: undefined;
	return {
		...envelope,
		subject: subjectValue(data.subject),
		...(resolved ? { resolved } : {}),
		status: status(data.freshnessMode),
		// The packet says which projection produced it: `brief` withholds packed
		// posts by request, and a reader must not mistake that for the transcript.
		...(brief ? { projection: "brief" as const } : {}),
		...(timeline
			? {
					timeline: buildCrossThreadTimeline(data.threads, {
						brief,
						...(subjectTicket ? { subjectTicket } : {}),
						...(resolved ? { anchorPostId: resolved.postId } : {}),
					}),
				}
			: {}),
		evidence:
			data.evidence ??
			buildEvidence({
				searchCoverageComplete: data.searchCoverageComplete,
				selectedThreadsComplete: data.selectedThreadsComplete,
				freshnessMode: data.freshnessMode,
				freshness: data.freshness,
				searchedConversations: data.searchedConversations,
				threads: data.threads,
				remoteSearch: data.remoteSearch,
				selection: data.selection ?? {
					...SINGLE_THREAD_SELECTION,
					candidateThreads: data.threads.length,
					returnedThreads: data.threads.length,
				},
				warnings,
				subject: subjectValue(data.subject),
				...(data.subject.kind === "ticket"
					? { subjectTicket: data.subject.ticketKey }
					: {}),
			}),
		...(data.remoteSearch.performed || data.remoteSearch.requested
			? { remoteSearch: data.remoteSearch }
			: {}),
		...(data.people?.length ? { people: data.people.map(projectPerson) } : {}),
		...(relatedTickets.length ? { relatedTickets } : {}),
		...(messages?.length ? { messages } : {}),
		threads,
		...(data.background?.length
			? { background: data.background.map(projectBackgroundThread) }
			: {}),
		...(data.probeCoverage?.length
			? { probeCoverage: data.probeCoverage }
			: {}),
		...(data.permalinks?.length ? { permalinks: data.permalinks } : {}),
		warnings,
	};
}

/**
 * Roster entry for the agent view: username and role only. Display names add
 * bytes and a second name for the same person without changing what the packet
 * can be used for — `username` is the identifier every other field cites.
 */
function projectPerson(person: PersonRef): {
	username: string;
	role?: string;
	roleSource?: "profile" | "config";
	isBot?: true;
} {
	return {
		username: person.username,
		...(person.role ? { role: person.role } : {}),
		...(person.roleSource ? { roleSource: person.roleSource } : {}),
		...(person.isBot ? { isBot: true as const } : {}),
	};
}

function projectBackgroundThread(
	thread: NonNullable<ContextResult["background"]>[number],
): AgentBackgroundThread {
	return {
		threadId: thread.threadId,
		conversation: thread.conversationAlias,
		kind: thread.conversationKind,
		url: thread.url,
		latestAt: isoTimestamp(thread.latestActivityAt),
		matchedProbes: thread.matchedProbes,
		excerpts: thread.excerpts,
		command: ["mm", "thread", thread.threadId, "--agent"],
	};
}

function projectSearch(
	envelope: AgentEnvelope,
	data: SearchContextResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode),
		candidates: data.candidates.map((candidate, index): AgentCandidate => {
			const excerpts = [
				...new Set(candidate.matches.map(({ excerpt }) => excerpt)),
			].filter((excerpt) => excerpt.length > 0);
			return {
				rank: index + 1,
				threadId: candidate.threadId,
				conversation: candidate.conversationAlias,
				kind: candidate.conversationKind,
				url: candidate.link,
				latestAt: isoTimestamp(candidate.latestActivityAt),
				reasons: [...candidate.reasons],
				excerpts: excerpts.slice(0, data.excerptLimit),
				...(excerpts.length > data.excerptLimit
					? { omittedExcerpts: excerpts.length - data.excerptLimit }
					: {}),
			};
		}),
		warnings,
	};
}

function projectThread(
	envelope: AgentEnvelope,
	data: ThreadResult,
	warnings: Warning[],
): AgentCommandResult {
	const relatedTickets = relatedTicketsFromPosts(
		data.thread.posts,
		data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
	);
	const resolved = resolvedSubject(data.subject, [data.thread]);
	const projected = projectPackedThread(
		data.thread,
		data.conversation.alias,
		data.conversation.kind,
		data.link,
		{
			brief: Boolean(data.brief),
			includeSignals: Boolean(data.signals),
			subjectTicket:
				data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
			...(resolved ? { anchorPostId: resolved.postId } : {}),
		},
	);
	const contextThread: ContextThread = {
		...data.thread,
		conversationId: data.conversation.id,
		conversationAlias: data.conversation.alias,
		conversationKind: data.conversation.kind,
		reasons: [],
		matchingPostIds: [],
		latestActivityAt:
			data.thread.posts.at(-1)?.createAt ?? data.freshness.observedAt,
		link: data.link,
	};
	const selectedEvidenceCurrent =
		data.freshnessMode !== "local" || !data.freshness.stale;
	const evidence = buildEvidence({
		searchCoverageComplete: data.complete,
		selectedThreadsComplete:
			data.thread.omittedPosts === 0 &&
			data.thread.totalOmittedAttachments === 0,
		freshnessMode: data.freshnessMode,
		freshness: [data.freshness],
		searchedConversations: [{ id: data.conversation.id }],
		threads: [contextThread],
		remoteSearch: NO_REMOTE_SEARCH,
		selection: SINGLE_THREAD_SELECTION,
		warnings,
		selectedEvidenceCurrent,
		subject: subjectValue(data.subject),
		...(data.subject.kind === "ticket"
			? { subjectTicket: data.subject.ticketKey }
			: {}),
	});
	return {
		...envelope,
		subject: subjectValue(data.subject),
		...(resolved ? { resolved } : {}),
		status: status(data.freshnessMode),
		...(data.brief ? { projection: "brief" as const } : {}),
		...(relatedTickets.length ? { relatedTickets } : {}),
		evidence,
		threads: [projected],
		warnings,
	};
}

/**
 * Where a post-id / permalink subject landed. Emitted for post subjects only;
 * for every other subject there is nothing to reconcile.
 */
function resolvedSubject(
	subject: ContextResult["subject"],
	threads: readonly PackedThread[],
): AgentResolvedSubject | undefined {
	if (subject.kind !== "post") return undefined;
	const carrier = threads.find((thread) =>
		thread.posts.some(({ id }) => id === subject.postId),
	);
	const thread = carrier ?? threads[0];
	if (!thread) return undefined;
	return {
		postId: subject.postId,
		from: subject.source,
		threadId: thread.threadId,
		inPacket: Boolean(carrier),
	};
}

/** Flatten download metadata and an explicitly requested bounded inspection. */
function projectFileDownload(
	envelope: AgentEnvelope,
	data: FileDownloadResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		id: data.id,
		name: data.name,
		mimeType: data.mimeType,
		size: data.size,
		path: data.path,
		postId: data.postId,
		conversationId: data.conversationId,
		...(data.inspection ? { inspection: data.inspection } : {}),
		warnings,
	};
}

/** Flatten batch download metadata only — never file bytes. */
function projectFiles(
	envelope: AgentEnvelope,
	data: FileBatchDownloadResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		outDir: data.outDir,
		selector: data.selector,
		limits: data.limits,
		downloaded: data.downloaded,
		failed: data.failed,
		skipped: data.skipped,
		totalBytes: data.totalBytes,
		files: data.files.map((item) => {
			if (item.status === "downloaded") {
				return {
					status: "downloaded" as const,
					id: item.id,
					name: item.name,
					mimeType: item.mimeType,
					size: item.size,
					path: item.path,
					postId: item.postId,
					conversationId: item.conversationId,
				};
			}
			return {
				status: item.status,
				...(item.id ? { id: item.id } : {}),
				...(item.name ? { name: item.name } : {}),
				error: item.error,
			};
		}),
		warnings,
	};
}

function status(freshnessMode: "local" | "network" | "forced"): AgentStatus {
	return {
		freshness: freshnessMode === "local" ? "local" : "network",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
