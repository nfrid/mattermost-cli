import type { IndexedPost, MattermostStore } from "../store/index.ts";
import { reciprocalRankFusionScore } from "./fusion.ts";
import { deduplicateMatches, excerpt } from "./match-utils.ts";
import { routeReason, routeWeight } from "./routing.ts";
import type {
	AgentProbeKind,
	CandidateGroup,
	CandidateRank,
	RankFusionContribution,
	RankingReason,
	RoutedConversation,
	ScoreVector,
	SearchMatch,
	StructuredSearchMatch,
	ThreadCandidate,
} from "./types.ts";

export function scoreVector(rank: Partial<CandidateRank>): ScoreVector {
	return [
		rank.direct ?? 0,
		rank.explicitTicketRelationship ?? 0,
		rank.ticketInRoot ?? 0,
		rank.ticketInReply ?? 0,
		rank.subjectInRoot ?? 0,
		rank.exactPhraseInRoot ?? 0,
		rank.fullProbeCoverage ?? 0,
		rank.matchedProbeCount ?? 0,
		rank.proximityTier ?? 0,
		rank.proximityWindow ?? 0,
		rank.structuredMatchCount ?? 0,
		rank.routing ?? 0,
		rank.threadDepth ?? 0,
		rank.fusion ?? 0,
		rank.matchedTermCount ?? 0,
		rank.exactPhraseInReply ?? 0,
		rank.conversationPriority ?? 0,
		rank.latestRelevantMatchAt ?? 0,
		rank.latestActivityAt ?? 0,
	];
}

export function remoteSearchCandidate(
	post: IndexedPost,
	conversation: RoutedConversation,
	probe: string,
	rank: number,
	probeKind?: AgentProbeKind,
): ThreadCandidate {
	if (!Number.isInteger(rank) || rank < 1) {
		throw new Error("Remote search rank must be a positive integer.");
	}
	const latestActivityAt = Math.max(
		post.createAt,
		post.updateAt,
		post.deleteAt,
	);
	const fusionScore = reciprocalRankFusionScore(rank);
	const reasons: RankingReason[] = [
		"remote_search",
		"rank_fusion",
		routeReason(conversation),
	];
	if (conversation.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	return {
		threadId: post.threadId,
		rootPostId: post.rootId || post.id,
		conversationId: post.conversationId,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [post.id],
		matches: [
			{
				postId: post.id,
				probe,
				...(probeKind ? { probeKind } : {}),
				excerpt: excerpt(post.message),
				remoteRank: rank,
			},
		],
		reasons,
		latestActivityAt,
		priority: conversation.priority,
		scoreVector: scoreVector({
			matchedProbeCount: 1,
			routing: routeWeight(conversation),
			fusion: fusionScore,
			conversationPriority: conversation.priority,
			latestRelevantMatchAt: latestActivityAt,
			latestActivityAt,
		}),
		fusionScore,
	};
}

export function mergeRemoteSearchCandidate(
	existing: ThreadCandidate,
	candidate: ThreadCandidate,
	conversation: RoutedConversation,
): void {
	existing.matchingPostIds = [
		...new Set([...existing.matchingPostIds, ...candidate.matchingPostIds]),
	].sort();
	existing.matches = [...existing.matches, ...candidate.matches];
	existing.latestActivityAt = Math.max(
		existing.latestActivityAt,
		candidate.latestActivityAt,
	);
	existing.fusionScore =
		(existing.fusionScore ?? 0) + (candidate.fusionScore ?? 0);
	existing.scoreVector = scoreVector({
		matchedProbeCount: new Set(existing.matches.map(({ probe }) => probe)).size,
		routing: routeWeight(conversation),
		fusion: existing.fusionScore,
		conversationPriority: conversation.priority,
		latestRelevantMatchAt: existing.latestActivityAt,
		latestActivityAt: existing.latestActivityAt,
	});
}

export function directCandidate(
	post: IndexedPost,
	conversation: RoutedConversation,
): ThreadCandidate {
	return {
		threadId: post.threadId,
		rootPostId: post.rootId || post.id,
		conversationId: post.conversationId,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [post.id],
		matches: [
			{ postId: post.id, probe: post.id, excerpt: excerpt(post.message) },
		],
		reasons: ["direct_post", routeReason(conversation)],
		latestActivityAt: post.updateAt || post.createAt,
		priority: conversation.priority,
		scoreVector: scoreVector({
			direct: 1,
			routing: routeWeight(conversation),
			conversationPriority: conversation.priority,
			latestRelevantMatchAt: post.updateAt || post.createAt,
			latestActivityAt: post.updateAt || post.createAt,
		}),
	};
}

export function createCandidateGroup(): CandidateGroup {
	return {
		matches: [],
		structuredMatches: new Map<string, StructuredSearchMatch>(),
		fusionContributions: new Map<string, RankFusionContribution>(),
	};
}

export function mergeThreadCandidates(
	...candidateLists: ReadonlyArray<readonly ThreadCandidate[]>
): ThreadCandidate[] {
	const merged = new Map<string, ThreadCandidate>();
	for (const candidate of candidateLists.flat()) {
		const existing = merged.get(candidate.threadId);
		if (!existing) {
			merged.set(candidate.threadId, structuredClone(candidate));
			continue;
		}
		const preferred =
			compareCandidates(existing, candidate) <= 0 ? existing : candidate;
		const other = preferred === existing ? candidate : existing;
		preferred.matchingPostIds = [
			...new Set([...preferred.matchingPostIds, ...other.matchingPostIds]),
		].sort();
		preferred.matches = deduplicateMatches([
			...preferred.matches,
			...other.matches,
		]);
		preferred.reasons = [...new Set([...preferred.reasons, ...other.reasons])];
		preferred.latestActivityAt = Math.max(
			preferred.latestActivityAt,
			other.latestActivityAt,
		);
		merged.set(candidate.threadId, preferred);
	}
	return [...merged.values()].sort(compareCandidates);
}

export function compareCandidates(
	left: ThreadCandidate,
	right: ThreadCandidate,
): number {
	for (const [index, rightValue] of right.scoreVector.entries()) {
		const difference = rightValue - (left.scoreVector[index] ?? 0);
		if (difference) return difference;
	}
	return left.threadId.localeCompare(right.threadId);
}
