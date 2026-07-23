import type {
	ConversationRecord,
	IndexedPost,
	LexicalRetrievalSource,
	StructuredEntityHit,
	TicketThreadRelationship,
} from "../store/index.ts";
import type { QueryExpansion } from "./query-expansion.ts";
import type { ConceptQueryMatch } from "./search-concepts.ts";

export const RRF_RANK_CONSTANT = 60;

export type RankFusionSource =
	| LexicalRetrievalSource
	| "synonym"
	| "keyboard_layout"
	| "transliteration"
	| "mixed_script";

export type TypoFallbackKind =
	| "identifier"
	| "latin_technical_term"
	| "russian_word";

export const RETRIEVAL_SOURCE_WEIGHTS: Readonly<
	Record<RankFusionSource, number>
> = Object.freeze({
	exact_phrase: 1,
	strict_fts: 0.9,
	term_fts: 0.75,
	broad_fts: 0.55,
	morph_fts: 0.45,
	concept_fts: 0.35,
	synonym: 0.35,
	keyboard_layout: 0.25,
	transliteration: 0.25,
	mixed_script: 0.25,
	prefix_fts: 0.2,
	trigram: 0.15,
});

export type MattermostSubject =
	| { kind: "ticket"; ticketKey: string; raw: string }
	| { kind: "post"; postId: string; raw: string; source: "permalink" | "id" }
	| { kind: "text"; text: string; raw: string };

export type AgentProbeKind =
	| "ticket_title"
	| "ticket_description"
	| "repository"
	| "file_path"
	| "symbol"
	| "error_message"
	| "service"
	| "participant";

export interface AgentProbeInput {
	kind: AgentProbeKind;
	value: string;
}

export interface RetrievalProbe {
	value: string;
	phrases: string[];
	terms: string[];
	morphTerms?: string[];
	conceptMatches?: ConceptQueryMatch[];
	kind?: AgentProbeKind;
	expansions?: QueryExpansion[];
}

export type RoutingEvidenceType =
	| "explicit_channel"
	| "scope"
	| "repository"
	| "ticket_relationship"
	| "all_configured"
	| "widened";

export interface RoutedConversation extends ConversationRecord {
	priority: number;
	evidence: Array<{ type: RoutingEvidenceType; value: string }>;
}

export interface RoutingResult {
	conversations: RoutedConversation[];
	explicitChannelPolicy: "restrict";
	unmatchedHints: { scopes: string[]; repositories: string[] };
	reason:
		| "explicit_channels"
		| "scopes"
		| "repositories"
		| "ticket_relationships"
		| "all_configured";
	canWiden: boolean;
}

export interface LexicalMatchEvidence {
	source: LexicalRetrievalSource;
	sourceQuery: string;
	rank: number;
	bm25: number;
}

export interface SearchMatch {
	postId: string;
	probe: string;
	probeKind?: AgentProbeKind;
	excerpt: string;
	lexicalSource?: LexicalRetrievalSource;
	sourceQuery?: string;
	sourceRank?: number;
	bm25?: number;
	lexicalEvidence?: LexicalMatchEvidence[];
	remoteRank?: number;
}

export type RankingReason =
	| "direct_post"
	| "explicit_ticket_relationship"
	| "ticket_in_root"
	| "ticket_in_reply"
	| "structured_entity_match"
	| "remote_search"
	| "subject_in_root"
	| "exact_phrase"
	| "exact_phrase_in_root"
	| "exact_phrase_in_reply"
	| "all_terms_in_thread"
	| "all_expanded_terms_in_thread"
	| "exact_terms_near"
	| "morph_terms_near"
	| "exact_terms_same_post"
	| "morph_terms_same_post"
	| "expanded_terms_same_post"
	| "terms_across_thread"
	| "morphology_match"
	| "concept_match"
	| "keyboard_layout_match"
	| "transliteration_match"
	| "mixed_script_match"
	| "prefix_match"
	| "typo_match"
	| "query_expansion"
	| "multiple_probes_in_thread"
	| "substantive_thread_depth"
	| "thin_thread"
	| "multi_ticket_root"
	| "rank_fusion"
	| "routing_explicit_channel"
	| "routing_scope"
	| "routing_repository"
	| "routing_ticket_relationship"
	| "routing_all_configured"
	| "routing_widened"
	| "conversation_priority"
	| "latest_activity";

export type ProximityKind =
	| "exact_terms_near"
	| "morph_terms_near"
	| "exact_terms_same_post"
	| "morph_terms_same_post"
	| "expanded_terms_same_post"
	| "terms_across_thread";

export interface ThreadRankingEvidence {
	subjectInRoot: boolean;
	subjectInReplies: boolean;
	exactPhraseInRootCount: number;
	exactPhraseInReplyCount: number;
	matchedProbeCount: number;
	fullyMatchedProbeCount: number;
	exactFullyMatchedProbeCount?: number;
	totalProbeCount: number;
	matchedTermCount: number;
	morphMatchedTermCount?: number;
	expandedMatchedTermCount?: number;
	fallbackMatchedTermCount?: number;
	expansionMatchCount?: number;
	exactTermsInSamePost?: number;
	morphTermsInSamePost?: number;
	matchedTermsInSamePost?: number;
	minimumTokenWindow?: number | null;
	matchedTermsAcrossThread?: number;
	matchedTermsInRoot?: number;
	matchedTermsInReplies?: number;
	distinctProbeCoverage?: number;
	proximityKind?: ProximityKind;
	totalTermCount: number;
	matchingPostCount: number;
	threadPostCount?: number;
	substantivePostCount?: number;
	threadDepthScore?: number;
	thinTicketStub?: boolean;
	multiTicketRoot?: boolean;
	ticketDensity?: number;
	nearestTicketDistance?: number | null;
	rootAnchoredFocused?: boolean;
	latestRelevantMatchAt: number | null;
}

export interface StructuredSearchMatch {
	postId: string;
	probe: string;
	probeKind?: AgentProbeKind;
	kind: StructuredEntityHit["kind"];
	value: string;
}

export interface RankFusionContribution {
	probe: string;
	probeKind?: AgentProbeKind;
	source: RankFusionSource;
	sourceQuery: string;
	rank: number;
	weight: number;
	score: number;
	conceptId?: string;
	sourcePhrase?: string;
	fallbackKind?: TypoFallbackKind;
	minimumSimilarity?: number;
	maximumEditDistance?: number;
}

export type ScoreVector = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

export interface CandidateRank {
	direct: number;
	explicitTicketRelationship: number;
	ticketInRoot: number;
	ticketInReply: number;
	subjectInRoot: number;
	exactPhraseInRoot: number;
	proximityTier: number;
	proximityWindow: number;
	fullProbeCoverage: number;
	matchedProbeCount: number;
	structuredMatchCount: number;
	routing: number;
	threadDepth: number;
	fusion: number;
	matchedTermCount: number;
	exactPhraseInReply: number;
	conversationPriority: number;
	latestRelevantMatchAt: number;
	latestActivityAt: number;
}

export interface ThreadCandidate {
	threadId: string;
	rootPostId: string;
	conversationId: string;
	conversationAlias: string;
	conversationKind: ConversationRecord["kind"];
	matchingPostIds: string[];
	matches: SearchMatch[];
	reasons: RankingReason[];
	latestActivityAt: number;
	priority: number;
	scoreVector: ScoreVector;
	rankingEvidence?: ThreadRankingEvidence;
	fusionScore?: number;
	fusionContributions?: RankFusionContribution[];
	structuredMatches?: StructuredSearchMatch[];
}

export interface CandidateGroup {
	matches: SearchMatch[];
	structuredMatches: Map<string, StructuredSearchMatch>;
	fusionContributions: Map<string, RankFusionContribution>;
}

export interface SearchResult {
	subject: MattermostSubject;
	probes: RetrievalProbe[];
	routing: RoutingResult;
	candidates: ThreadCandidate[];
}
