export {
	directCandidate,
	mergeRemoteSearchCandidate,
	mergeThreadCandidates,
	remoteSearchCandidate,
	scoreVector,
} from "./candidates.ts";
export {
	reciprocalRankFusionScore,
	weightedReciprocalRankFusionScore,
} from "./fusion.ts";
export { searchThreads } from "./lexical.ts";
export {
	expandQueryTerms,
	matchesQueryExpansion,
	type QueryExpansion,
} from "./query-expansion.ts";
export {
	buildRankingReasons,
	candidateFromGroup,
	evaluateThreadEvidence,
} from "./ranking.ts";
export {
	configuredConversations,
	routeConversations,
	widenedRouting,
} from "./routing.ts";
export { classifySubject, resolveProbes } from "./subject.ts";
export {
	type AgentProbeInput,
	type AgentProbeKind,
	type LexicalMatchEvidence,
	type MattermostSubject,
	type RankFusionContribution,
	type RankingReason,
	RETRIEVAL_SOURCE_WEIGHTS,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingEvidenceType,
	type RoutingResult,
	RRF_RANK_CONSTANT,
	type SearchMatch,
	type SearchResult,
	type StructuredSearchMatch,
	type ThreadCandidate,
	type ThreadRankingEvidence,
} from "./types.ts";
