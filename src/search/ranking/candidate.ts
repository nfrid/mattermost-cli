import type {
	IndexedPost,
	MattermostStore,
	TicketThreadRelationship,
} from "../../store/index.ts";
import { containsNormalizedExactText } from "../../text/index.ts";
import { scoreVector } from "../candidates.ts";
import { deduplicateMatches } from "../match-utils.ts";
import { routeReason, routeWeight } from "../routing.ts";
import type {
	CandidateGroup,
	MattermostSubject,
	RankFusionContribution,
	RetrievalProbe,
	RoutedConversation,
	ThreadCandidate,
} from "../types.ts";
import { proximityTier, proximityWindowRank } from "./proximity.ts";
import { buildRankingReasons } from "./reasons.ts";
import {
	evaluateThreadEvidence,
	LOW_TICKET_DENSITY_MIN_POSTS,
	LOW_TICKET_DENSITY_THRESHOLD,
	MIN_SUBSTANTIVE_THREAD_POSTS,
} from "./thread-evidence.ts";

export function candidateFromGroup(
	store: MattermostStore,
	threadId: string,
	group: CandidateGroup,
	conversations: ReadonlyMap<string, RoutedConversation>,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
	relationships: readonly TicketThreadRelationship[],
	getThread: (threadId: string) => IndexedPost[] = (id) => store.getThread(id),
): ThreadCandidate | null {
	const { matches } = group;
	const thread = getThread(threadId);
	if (!thread.length) return null;
	const root = thread.find((post) => post.id === threadId) ?? thread[0];
	if (!root) return null;
	const conversation = conversations.get(root.conversationId);
	if (!conversation) return null;
	const ticketKey = subject.kind === "ticket" ? subject.ticketKey : undefined;
	const rootHasTicket = Boolean(
		ticketKey && containsNormalizedExactText(root.message, ticketKey),
	);
	const replyHasTicket = Boolean(
		ticketKey &&
			thread.some(
				(post) =>
					post.id !== root.id &&
					containsNormalizedExactText(post.message, ticketKey),
			),
	);
	const explicitRelationship = relationships.some(
		(relationship) =>
			relationship.threadId === threadId && relationship.origin === "explicit",
	);
	const rankingEvidence = evaluateThreadEvidence(
		thread,
		root.id,
		subject,
		probes,
		group.matches,
	);
	const structuredMatches = [...group.structuredMatches.values()].sort(
		(left, right) =>
			left.postId.localeCompare(right.postId) ||
			left.probe.localeCompare(right.probe) ||
			left.kind.localeCompare(right.kind) ||
			left.value.localeCompare(right.value),
	);
	const fusionContributions = [...group.fusionContributions.values()].sort(
		compareFusionContributions,
	);
	const fusionScore = fusionContributions.reduce(
		(total, contribution) => total + contribution.score,
		0,
	);
	if (
		!(rankingEvidence.threadDepthScore ?? 0) &&
		(rankingEvidence.substantivePostCount ?? 0) >=
			MIN_SUBSTANTIVE_THREAD_POSTS &&
		fusionContributions.some(
			({ source, sourcePhrase }) =>
				source === "concept_fts" && Boolean(sourcePhrase?.trim().includes(" ")),
		)
	) {
		rankingEvidence.threadDepthScore =
			rankingEvidence.substantivePostCount ?? 0;
	}
	const latestActivityAt = Math.max(
		...thread.map((post) =>
			Math.max(post.createAt, post.updateAt, post.deleteAt),
		),
	);
	const reasons = buildRankingReasons({
		explicitRelationship,
		rootHasTicket,
		replyHasTicket,
		hasStructuredMatch: structuredMatches.length > 0,
		rankingEvidence,
		fusionContributions,
		fusionScore,
		routingReason: routeReason(conversation),
		priority: Boolean(conversation.priority),
	});
	const thinTicketStub = Boolean(rankingEvidence.thinTicketStub);
	const multiTicketRoot = Boolean(rankingEvidence.multiTicketRoot);
	const demoteRootTicket = thinTicketStub || multiTicketRoot;
	const ticketDensity = rankingEvidence.ticketDensity ?? 0;
	const rootAnchoredFocused = Boolean(rankingEvidence.rootAnchoredFocused);
	const exclusiveSubjectKey = Boolean(rankingEvidence.exclusiveSubjectKey);
	const otherTicketDominated = Boolean(rankingEvidence.otherTicketDominated);
	const substantiveDepth = rankingEvidence.threadDepthScore ?? 0;
	const hasSubjectTicket = rootHasTicket || replyHasTicket;
	const ticketFocus = ticketFocusScore({
		isTicketSubject: subject.kind === "ticket",
		demoteRootTicket,
		hasSubjectTicket,
		otherTicketDominated,
		rootAnchoredFocused,
		exclusiveSubjectKey,
		ticketDensity,
	});
	// Low density only hurts multi-topic threads. Root-anchored support chains
	// (ticket only in the announce) are the opposite of off-topic.
	const densityPenalty =
		subject.kind === "ticket" &&
		!demoteRootTicket &&
		!rootAnchoredFocused &&
		!exclusiveSubjectKey &&
		(rankingEvidence.threadPostCount ?? 0) >= LOW_TICKET_DENSITY_MIN_POSTS &&
		ticketDensity < LOW_TICKET_DENSITY_THRESHOLD
			? -2
			: 0;
	// Cap density boost by substantive depth so a 2-post announce with
	// density=1 cannot outrank a long discussion thread.
	const ticketProximityBoost =
		subject.kind === "ticket" && !demoteRootTicket && !otherTicketDominated
			? Math.min(
					Math.round(ticketDensity * 10),
					Math.max(1, substantiveDepth + 1),
				) +
				(rootAnchoredFocused ? 2 : 0) +
				(rootHasTicket || rankingEvidence.nearestTicketDistance === 0 ? 1 : 0) -
				((rankingEvidence.nearestTicketDistance ?? 0) > 20 ? 1 : 0)
			: 0;
	return {
		threadId,
		rootPostId: root.id,
		conversationId: conversation.id,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [
			...new Set([
				...matches.map(({ postId }) => postId),
				...structuredMatches.map(({ postId }) => postId),
			]),
		].sort(),
		matches: deduplicateMatches(matches),
		reasons,
		latestActivityAt,
		priority: conversation.priority,
		scoreVector: scoreVector({
			explicitTicketRelationship: explicitRelationship ? 1 : 0,
			// Thin URL/ticket stubs and multi-ticket bulletin roots keep reply-tier
			// ticket signal so focused discussions outrank list dumps.
			ticketInRoot: rootHasTicket && !demoteRootTicket ? 1 : 0,
			ticketInReply:
				replyHasTicket || (rootHasTicket && demoteRootTicket) ? 1 : 0,
			ticketFocus,
			subjectInRoot: rankingEvidence.subjectInRoot && !demoteRootTicket ? 1 : 0,
			exactPhraseInRoot: demoteRootTicket
				? 0
				: rankingEvidence.exactPhraseInRootCount,
			proximityTier: proximityTier(rankingEvidence.proximityKind),
			proximityWindow: proximityWindowRank(rankingEvidence),
			fullProbeCoverage:
				(rankingEvidence.exactFullyMatchedProbeCount ?? 0) * 2 +
				(rankingEvidence.fullyMatchedProbeCount -
					(rankingEvidence.exactFullyMatchedProbeCount ?? 0)),
			matchedProbeCount: rankingEvidence.matchedProbeCount,
			structuredMatchCount: structuredMatches.length,
			routing: routeWeight(conversation),
			// Negative depth demotes thin stubs / bulletins before fusion/recency.
			// Ticket proximity folds into depth so long low-density threads lose.
			threadDepth: demoteRootTicket
				? multiTicketRoot
					? -2
					: -1
				: (rankingEvidence.threadDepthScore ?? 0) +
					ticketProximityBoost +
					densityPenalty,
			fusion: fusionScore,
			matchedTermCount: rankingEvidence.matchedTermCount,
			exactPhraseInReply:
				rankingEvidence.exactPhraseInReplyCount +
				(demoteRootTicket ? rankingEvidence.exactPhraseInRootCount : 0),
			conversationPriority: conversation.priority,
			latestRelevantMatchAt: rankingEvidence.latestRelevantMatchAt ?? 0,
			latestActivityAt,
		}),
		rankingEvidence,
		fusionScore,
		fusionContributions,
		...(structuredMatches.length ? { structuredMatches } : {}),
	};
}

/** Early score-vector dim: this-ticket focus vs related-mention neighborhood. */
export function ticketFocusScore(input: {
	isTicketSubject: boolean;
	demoteRootTicket: boolean;
	hasSubjectTicket: boolean;
	otherTicketDominated: boolean;
	rootAnchoredFocused: boolean;
	exclusiveSubjectKey: boolean;
	ticketDensity: number;
}): number {
	if (
		!input.isTicketSubject ||
		input.demoteRootTicket ||
		!input.hasSubjectTicket
	) {
		return 0;
	}
	if (input.otherTicketDominated) return 0;
	if (input.rootAnchoredFocused || input.exclusiveSubjectKey) return 3;
	if (input.ticketDensity >= 0.4) return 2;
	return 1;
}

export function compareFusionContributions(
	left: RankFusionContribution,
	right: RankFusionContribution,
): number {
	return (
		left.probe.localeCompare(right.probe) ||
		(left.probeKind ?? "").localeCompare(right.probeKind ?? "") ||
		left.source.localeCompare(right.source) ||
		left.sourceQuery.localeCompare(right.sourceQuery) ||
		left.rank - right.rank
	);
}
