/**
 * The `context` and `thread` envelopes: read order, people, background
 * pointers, per-thread bodies, and gap recovery.
 */
import { AGENT_BACKGROUND_NON_NOISE_LIMIT } from "../../../context/background.ts";
import type {
	ContextResult,
	ContextThread,
	RemoteSearchEvidence,
	SelectionEvidence,
	ThreadResult,
} from "../../../context/index.ts";
import type { PersonRef } from "../../../context/people.ts";
import { pickPrimaryThreadIndex } from "../../../context/selection.ts";
import type { EvidenceNextStep } from "../../../evidence/evidence.ts";
import { buildEvidence } from "../../../evidence/evidence.ts";
import type { PackedThread } from "../../../evidence/packing.ts";
import { narrowerAroundSidePosts } from "../../../evidence/packing.ts";
import type { Warning } from "../../../shared/command-result.ts";
import { isoTimestamp, subjectValue } from "../../shared.ts";
import { buildCrossThreadTimeline } from "../../timeline.ts";
import { shortMessagesFromThreads } from "../messages.ts";
import {
	projectRelatedTickets,
	relatedTicketsFromPosts,
} from "../related-tickets.ts";
import { projectContextThread, projectPackedThread } from "../thread.ts";
import type {
	AgentBackgroundThread,
	AgentCommandResult,
	AgentEnvelope,
	AgentResolvedSubject,
	AgentThread,
} from "../types.ts";
import {
	inspectionByFollowedFile,
	mergeAttachmentInspections,
	projectFollowedAttachment,
} from "./attachments.ts";
import { SHORT_MESSAGE_LIMIT } from "./search.ts";
import { status } from "./shared.ts";
import { buildResearchSummary, mergeThreadBriefs } from "./summary.ts";

/** Neutral placeholders for projections with no discovery of their own. */
export const NO_REMOTE_SEARCH: RemoteSearchEvidence = {
	requested: false,
	performed: false,
	reason: null,
	queries: [],
	candidateThreads: 0,
	failures: 0,
};

export const SINGLE_THREAD_SELECTION: SelectionEvidence = {
	candidateThreads: 1,
	returnedThreads: 1,
	droppedThin: 0,
	droppedByBudget: 0,
	droppedByBudgetSubjectMatched: 0,
	droppedNoMatch: 0,
	droppedCandidates: [],
};

export function projectContext(
	envelope: AgentEnvelope,
	data: ContextResult,
	warnings: Warning[],
): AgentCommandResult {
	const relatedTickets = projectRelatedTickets(data.relatedTickets);
	const navigate = Boolean(data.navigate);
	const short = Boolean(data.short);
	const brief = Boolean(data.brief);
	const fullPosts = Boolean(data.fullPosts);
	/** Withhold packed posts into brief_projection skips only in lean brief mode. */
	const withholdForBrief = brief && !fullPosts;
	const timeline = Boolean(data.timeline);
	const subjectTicket =
		data.subject.kind === "ticket" ? data.subject.ticketKey : undefined;
	const includeSignals = Boolean(data.signals);
	const primaryIndex = pickPrimaryThreadIndex(data.threads);
	const resolved = resolvedSubject(data.subject, data.threads);
	const projected = data.threads.map((thread, index) =>
		projectContextThread(thread, {
			short,
			navigate,
			brief: withholdForBrief,
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
	const researchSummarySeed = buildResearchSummary({
		threads: projected,
		evidence,
		permalinks: data.permalinks,
	});
	// Align `role` with orientation: agents were reading noise stubs marked
	// primary while `researchSummary.primaryThreadId` pointed at the decision.
	const orientationId = researchSummarySeed?.primaryThreadId;
	const threads = orientationId
		? projected.map((thread, index) => {
				const role = (
					thread.threadId === orientationId ? "primary" : "secondary"
				) as "primary" | "secondary";
				const reasons = data.threads[index]?.reasons ?? [];
				const presentation =
					role === "secondary" && reasons.includes("multi_ticket_root")
						? ("announce" as const)
						: undefined;
				const { presentation: _dropped, ...rest } = thread;
				return {
					...rest,
					role,
					...(presentation ? { presentation } : {}),
				};
			})
		: projected;
	const mergedBrief = brief ? mergeThreadBriefs(threads) : undefined;
	const researchSummary = buildResearchSummary({
		threads,
		evidence,
		permalinks: data.permalinks,
	});
	const inspectionByFileId = inspectionByFollowedFile(data.followedAttachments);
	const threadsWithInspection = mergeAttachmentInspections(
		threads,
		inspectionByFileId,
	);
	const timelineComplete = packetTimelineComplete(
		threadsWithInspection,
		withholdForBrief,
	);
	return {
		...envelope,
		subject: subjectValue(data.subject),
		...(resolved ? { resolved } : {}),
		status: status(data.freshnessMode),
		hints: {
			readOrder: contextReadOrder({
				brief: Boolean(mergedBrief),
				navigate,
				timeline,
			}),
		},
		// Mark brief whenever the decision layer is present — lean withholds posts;
		// full-posts keeps dense transcript + brief and still sets the marker so
		// agents keying on `projection` see that top-level brief is there.
		...(mergedBrief || withholdForBrief
			? { projection: "brief" as const }
			: {}),
		...(mergedBrief ? { brief: mergedBrief } : {}),
		...(researchSummary ? { researchSummary } : {}),
		...(timeline || withholdForBrief || fullPosts ? { timelineComplete } : {}),
		...(timeline
			? {
					timeline: buildCrossThreadTimeline(data.threads, {
						brief: withholdForBrief,
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
		threads: threadsWithInspection,
		...(data.followLog
			? {
					followLog: data.followLog,
					...(data.followExhausted ? { followExhausted: true as const } : {}),
				}
			: {}),
		...(data.followedAttachments?.length
			? {
					followedAttachments: data.followedAttachments.map((file) =>
						projectFollowedAttachment(file),
					),
				}
			: {}),
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

/** Stable orientation path for agents reading a context packet. */
export function contextReadOrder(input: {
	brief: boolean;
	navigate: boolean;
	timeline: boolean;
}): string[] {
	const order = ["evidence.verdict", "researchSummary", "hints.readOrder"];
	if (input.brief) {
		order.push("brief", "brief.lateAcknowledgement");
	}
	order.push("evidence.next", "people");
	if (input.timeline) order.push("timeline");
	if (input.navigate) order.push("threads[].anchors", "threads[].skips");
	else order.push("threads");
	order.push("attachments");
	return order;
}

/**
 * Roster entry for the agent view: username and role only. Display names add
 * bytes and a second name for the same person without changing what the packet
 * can be used for — `username` is the identifier every other field cites.
 */
export function projectPerson(person: PersonRef): {
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

export function projectAgentBackground(
	pointers: ContextResult["background"],
): AgentBackgroundThread[] {
	return (pointers ?? [])
		.filter((pointer) => !pointer.noise)
		.slice(0, AGENT_BACKGROUND_NON_NOISE_LIMIT)
		.map(projectBackgroundThread);
}

export function projectBackgroundThread(
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

export function projectThread(
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
	const incompleteGapPage =
		data.retrieval && !data.retrieval.requestedRangeComplete
			? gapRecoveryPageStep(data.retrieval, data.thread.threadId)
			: undefined;
	if (incompleteGapPage) deltaNext.unshift(incompleteGapPage);
	const scopedEvidence = data.retrieval
		? {
				...evidence,
				scope: "gap_recovery" as const,
				verdict: {
					...evidence.verdict,
					// A delta never recommends chasing intentionally out-of-range posts
					// except the narrower page that recovers this incomplete window.
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
						? incompleteGapPage
							? {
									reason:
										"requested posts exceeded the bounded character budget; a narrower page is in next[]",
								}
							: {
									noActionAvailable: true as const,
									reason:
										"requested posts exceeded the bounded character budget; even a single-post window does not fit — retry manually with a leaner around post or higher budget",
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
 * When a gap window overran the character budget, emit the next half-sized
 * page instead of leaving the agent with `noActionAvailable` and no argv.
 */
export function gapRecoveryPageStep(
	retrieval: NonNullable<ThreadResult["retrieval"]>,
	threadId: string,
): EvidenceNextStep | undefined {
	const nextBefore =
		retrieval.requestedBefore > 0
			? narrowerAroundSidePosts(retrieval.requestedBefore)
			: 0;
	const nextAfter =
		retrieval.requestedAfter > 0
			? narrowerAroundSidePosts(retrieval.requestedAfter)
			: 0;
	// A non-zero side that cannot shrink further leaves no machine-safe page.
	if (nextBefore === undefined || nextAfter === undefined) return undefined;
	if (
		nextBefore === retrieval.requestedBefore &&
		nextAfter === retrieval.requestedAfter
	) {
		return undefined;
	}
	return {
		action: "thread_around",
		reason: "gap_window_budget_page",
		priority: "recommended",
		impact: "may_recover_omitted_core",
		command: [
			"mm",
			"thread",
			threadId,
			"--around",
			retrieval.anchorPostId,
			"--before-posts",
			String(nextBefore),
			"--after-posts",
			String(nextAfter),
			"--window-only",
			"--agent",
		],
		threadId,
	};
}

/**
 * Where a post-id / permalink subject landed. Emitted for post subjects only;
 * for every other subject there is nothing to reconcile.
 */
export function resolvedSubject(
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

/**
 * False when packing omitted posts or brief projection collapsed chronology
 * into `brief_projection` skips — agents should not treat the visible timeline
 * as complete.
 */
export function packetTimelineComplete(
	threads: readonly AgentThread[],
	withholdForBrief: boolean,
): boolean {
	for (const thread of threads) {
		if (thread.omitted.posts > 0) return false;
		if (!withholdForBrief) continue;
		for (const item of thread.posts ?? []) {
			if ("skip" in item && item.skip.reason === "brief_projection") {
				return false;
			}
		}
	}
	return true;
}
