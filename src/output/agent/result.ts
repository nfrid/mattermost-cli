import { AGENT_BACKGROUND_NON_NOISE_LIMIT } from "../../context/background.ts";
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
import type { PermalinkResolution } from "../../context/types.ts";
import type { EvidenceStatus } from "../../evidence/evidence.ts";
import { buildEvidence } from "../../evidence/evidence.ts";
import type { PackedThread } from "../../evidence/packing.ts";
import {
	MAX_DECISION_POST_IDS,
	MAX_OPEN_QUESTIONS,
} from "../../evidence/signals.ts";
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
	AgentBriefDecision,
	AgentBriefOpenQuestion,
	AgentCandidate,
	AgentCommandResult,
	AgentEnvelope,
	AgentMergedBrief,
	AgentMergedBriefDecision,
	AgentMergedBriefOpenQuestion,
	AgentResearchSummary,
	AgentResolvedSubject,
	AgentStatus,
	AgentThread,
	PurposeHintLabel,
} from "./types.ts";

/** Strongest first — mirrors domain `DECISION_KIND_PRIORITY` for merged briefs. */
const DECISION_KIND_RANK: Readonly<Record<AgentBriefDecision["kind"], number>> =
	{
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
const THIN_ORIENTATION_MAX_POSTS = 3;

const BLOCKED_PERMALINK_STATUSES = new Set<PermalinkResolution["status"]>([
	"not_allowed",
	"unresolved",
	"invalid",
]);

const SHORT_MESSAGE_LIMIT = 8;
const SEARCH_CONTRIBUTING_PROBES_LIMIT = 12;

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
	const evidence =
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
		});
	const mergedBrief = brief ? mergeThreadBriefs(threads) : undefined;
	const researchSummary = buildResearchSummary({
		threads,
		evidence,
		permalinks: data.permalinks,
	});
	return {
		...envelope,
		subject: subjectValue(data.subject),
		...(resolved ? { resolved } : {}),
		status: status(data.freshnessMode),
		// The packet says which projection produced it: `brief` withholds packed
		// posts by request, and a reader must not mistake that for the transcript.
		...(brief ? { projection: "brief" as const } : {}),
		...(mergedBrief ? { brief: mergedBrief } : {}),
		...(researchSummary ? { researchSummary } : {}),
		...(timeline
			? {
					timeline: buildCrossThreadTimeline(data.threads, {
						brief,
						...(subjectTicket ? { subjectTicket } : {}),
						...(resolved ? { anchorPostId: resolved.postId } : {}),
					}),
				}
			: {}),
		evidence,
		...(data.remoteSearch.performed || data.remoteSearch.requested
			? { remoteSearch: data.remoteSearch }
			: {}),
		...(data.people?.length ? { people: data.people.map(projectPerson) } : {}),
		...(relatedTickets.length ? { relatedTickets } : {}),
		...(messages?.length ? { messages } : {}),
		threads,
		...(projectAgentBackground(data.background).length
			? { background: projectAgentBackground(data.background) }
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

function projectAgentBackground(
	pointers: ContextResult["background"],
): AgentBackgroundThread[] {
	return (pointers ?? [])
		.filter((pointer) => !pointer.noise)
		.slice(0, AGENT_BACKGROUND_NON_NOISE_LIMIT)
		.map(projectBackgroundThread);
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
		whyBackground: thread.whyBackground,
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
			const contributingProbes = [
				...new Set(candidate.matches.map(({ probe }) => probe)),
			].filter(Boolean);
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
				...(contributingProbes.length
					? {
							contributingProbes: contributingProbes.slice(
								0,
								SEARCH_CONTRIBUTING_PROBES_LIMIT,
							),
							...(contributingProbes.length > SEARCH_CONTRIBUTING_PROBES_LIMIT
								? {
										omittedContributingProbes:
											contributingProbes.length -
											SEARCH_CONTRIBUTING_PROBES_LIMIT,
									}
								: {}),
						}
					: {}),
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
	const evidenceThread = data.retrieval
		? {
				...contextThread,
				totalPosts: data.retrieval.requestedPosts,
				returnedPosts: data.retrieval.returnedPosts,
				omittedPosts:
					data.retrieval.requestedPosts - data.retrieval.returnedPosts,
				totalOmittedAttachments: 0,
				omittedAttachments: [],
				unreportedOmittedAttachments: 0,
				timeline: contextThread.timeline.filter((item) => item.kind === "post"),
			}
		: contextThread;
	const evidence = buildEvidence({
		searchCoverageComplete: data.complete,
		selectedThreadsComplete: data.retrieval
			? data.retrieval.requestedRangeComplete
			: data.thread.omittedPosts === 0 &&
				data.thread.totalOmittedAttachments === 0,
		freshnessMode: data.freshnessMode,
		freshness: [data.freshness],
		searchedConversations: [{ id: data.conversation.id }],
		threads: [evidenceThread],
		remoteSearch: NO_REMOTE_SEARCH,
		selection: SINGLE_THREAD_SELECTION,
		warnings,
		selectedEvidenceCurrent,
		subject: subjectValue(data.subject),
		...(data.subject.kind === "ticket"
			? { subjectTicket: data.subject.ticketKey }
			: {}),
	});
	const deltaNext = data.retrieval
		? evidence.next.filter(
				(step) =>
					step.action !== "thread_around" && step.action !== "thread_full",
			)
		: [];
	const scopedEvidence = data.retrieval
		? {
				...evidence,
				scope: "gap_recovery" as const,
				verdict: {
					...evidence.verdict,
					// A delta never recommends chasing intentionally out-of-range posts.
					recommendedActionRequired: deltaNext.some(
						({ priority }) => priority === "recommended",
					),
				},
				packing: {
					...evidence.packing,
					recommendedHydrationThreadIds: [],
					recommendFullThreadIds: [],
				},
				next: deltaNext,
				gapRecovery: {
					requestedRangeComplete: data.retrieval.requestedRangeComplete,
					remainingPostsOutsideRange:
						data.thread.totalPosts - data.retrieval.requestedPosts,
					...(!data.retrieval.requestedRangeComplete
						? {
								noActionAvailable: true as const,
								reason:
									"requested posts exceeded the bounded character budget; retry with a narrower window",
							}
						: {}),
				},
			}
		: evidence;
	const threads = [projected];
	const mergedBrief = data.brief ? mergeThreadBriefs(threads) : undefined;
	const researchSummary = buildResearchSummary({
		threads,
		evidence: scopedEvidence,
	});
	return {
		...envelope,
		subject: subjectValue(data.subject),
		...(resolved ? { resolved } : {}),
		status: status(data.freshnessMode),
		...(data.brief ? { projection: "brief" as const } : {}),
		...(mergedBrief ? { brief: mergedBrief } : {}),
		...(researchSummary ? { researchSummary } : {}),
		...(relatedTickets.length ? { relatedTickets } : {}),
		evidence: scopedEvidence,
		...(data.retrieval ? { retrieval: data.retrieval } : {}),
		threads,
		warnings,
	};
}

/**
 * Merge per-thread decision layers for `projection: "brief"`. Strongest
 * decisions and most dangling open questions win the global caps; each entry
 * keeps `threadId` so locality is recoverable without scanning `threads[]`.
 */
function mergeThreadBriefs(
	threads: readonly AgentThread[],
): AgentMergedBrief | undefined {
	const decisions: AgentMergedBriefDecision[] = [];
	const openQuestions: AgentMergedBriefOpenQuestion[] = [];
	for (const thread of threads) {
		for (const decision of thread.brief?.decisions ?? []) {
			decisions.push({ ...decision, threadId: thread.threadId });
		}
		for (const question of thread.brief?.openQuestions ?? []) {
			openQuestions.push({ ...question, threadId: thread.threadId });
		}
	}
	decisions.sort(compareMergedDecisions);
	openQuestions.sort(compareMergedOpenQuestions);
	const cappedDecisions = decisions.slice(0, MAX_DECISION_POST_IDS);
	const cappedQuestions = openQuestions.slice(0, MAX_OPEN_QUESTIONS);
	if (!cappedDecisions.length && !cappedQuestions.length) return undefined;
	return {
		...(cappedDecisions.length ? { decisions: cappedDecisions } : {}),
		...(cappedQuestions.length ? { openQuestions: cappedQuestions } : {}),
	};
}

function compareMergedDecisions(
	left: AgentMergedBriefDecision,
	right: AgentMergedBriefDecision,
): number {
	return (
		DECISION_KIND_RANK[left.kind] - DECISION_KIND_RANK[right.kind] ||
		right.at.localeCompare(left.at) ||
		left.id.localeCompare(right.id)
	);
}

function compareMergedOpenQuestions(
	left: AgentMergedBriefOpenQuestion,
	right: AgentMergedBriefOpenQuestion,
): number {
	return (
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
function buildResearchSummary(input: {
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
function collectDecisionThreadIds(threads: readonly AgentThread[]): string[] {
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
function pickOrientationPrimaryThreadId(
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

function orientationThreadScore(thread: AgentThread): number {
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

function isUnresolvedOpenQuestion(question: AgentBriefOpenQuestion): boolean {
	return (
		question.resolution !== "possibly_answered" &&
		question.resolution !== "answered"
	);
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
