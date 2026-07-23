export {
	directCandidate,
	mergeRemoteSearchCandidate,
	mergeThreadCandidates,
	remoteSearchCandidate,
	scoreVector,
} from "./candidates.ts";
export {
	type EngineeringEntity,
	type EngineeringEntityKind,
	extractEngineeringEntities,
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
	PERMALINK_PATH_PATTERN,
	TICKET_PATTERN,
} from "./extract.ts";
export {
	reciprocalRankFusionScore,
	weightedReciprocalRankFusionScore,
} from "./fusion.ts";
export { searchThreads } from "./lexical.ts";
export {
	POINTER_EXCERPT_LIMIT,
	SEARCH_EXCERPT_LIMIT,
	truncateExcerpt,
} from "./match-utils.ts";
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
export {
	type ConceptQueryMatch,
	conceptIndexFingerprint,
	conceptQueryMatches,
	conceptToken,
	conceptTokensForText,
} from "./search-concepts.ts";
export {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeMorphText,
} from "./search-token-normalization.ts";
export { classifySubject, resolveProbes } from "./subject.ts";
export {
	containsNormalizedExactText,
	containsNormalizedText,
	normalizeSearchText,
	STOP_WORDS,
} from "./text.ts";
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
