import type {
	RankFusionContribution,
	RankingReason,
	ThreadRankingEvidence,
} from "../types.ts";

export interface RankingReasonInput {
	preserve?: readonly RankingReason[];
	explicitRelationship?: boolean;
	rootHasTicket?: boolean;
	replyHasTicket?: boolean;
	hasStructuredMatch?: boolean;
	rankingEvidence: Pick<
		ThreadRankingEvidence,
		| "subjectInRoot"
		| "exactPhraseInRootCount"
		| "exactPhraseInReplyCount"
		| "exactFullyMatchedProbeCount"
		| "fullyMatchedProbeCount"
		| "proximityKind"
		| "morphMatchedTermCount"
		| "expansionMatchCount"
		| "matchedProbeCount"
		| "threadDepthScore"
		| "thinTicketStub"
		| "multiTicketRoot"
	>;
	fusionContributions?: readonly Pick<RankFusionContribution, "source">[];
	fusionScore?: number;
	routingReason?: RankingReason;
	priority?: boolean;
}

/** Shared ranking-reason list for candidate construction and post-hydrate reevaluation. */
export function buildRankingReasons(
	input: RankingReasonInput,
): RankingReason[] {
	const reasons: RankingReason[] = [];
	const preserved = new Set(input.preserve ?? []);
	if (preserved.has("direct_post")) reasons.push("direct_post");
	if (preserved.has("remote_search")) reasons.push("remote_search");
	if (
		input.explicitRelationship ||
		preserved.has("explicit_ticket_relationship")
	) {
		reasons.push("explicit_ticket_relationship");
	}
	if (input.rootHasTicket) reasons.push("ticket_in_root");
	if (input.replyHasTicket) reasons.push("ticket_in_reply");
	if (input.hasStructuredMatch) reasons.push("structured_entity_match");
	const evidence = input.rankingEvidence;
	if (evidence.subjectInRoot) reasons.push("subject_in_root");
	const exactPhrase =
		evidence.exactPhraseInRootCount > 0 || evidence.exactPhraseInReplyCount > 0;
	if (exactPhrase) reasons.push("exact_phrase");
	if (evidence.exactPhraseInRootCount) reasons.push("exact_phrase_in_root");
	if (evidence.exactPhraseInReplyCount) reasons.push("exact_phrase_in_reply");
	if ((evidence.exactFullyMatchedProbeCount ?? 0) > 0) {
		reasons.push("all_terms_in_thread");
	}
	if (
		evidence.fullyMatchedProbeCount >
		(evidence.exactFullyMatchedProbeCount ?? 0)
	) {
		reasons.push("all_expanded_terms_in_thread");
	}
	if (evidence.proximityKind) reasons.push(evidence.proximityKind);
	if ((evidence.morphMatchedTermCount ?? 0) > 0) {
		reasons.push("morphology_match");
	}
	const fusionSources = new Set(
		(input.fusionContributions ?? []).map(({ source }) => source),
	);
	if (fusionSources.has("concept_fts")) reasons.push("concept_match");
	if (fusionSources.has("keyboard_layout"))
		reasons.push("keyboard_layout_match");
	if (fusionSources.has("transliteration"))
		reasons.push("transliteration_match");
	if (fusionSources.has("mixed_script")) reasons.push("mixed_script_match");
	if (fusionSources.has("prefix_fts")) reasons.push("prefix_match");
	if (fusionSources.has("trigram")) reasons.push("typo_match");
	if ((evidence.expansionMatchCount ?? 0) > 0) reasons.push("query_expansion");
	if (evidence.matchedProbeCount > 1) reasons.push("multiple_probes_in_thread");
	if ((evidence.threadDepthScore ?? 0) > 0) {
		reasons.push("substantive_thread_depth");
	}
	if (evidence.thinTicketStub) reasons.push("thin_thread");
	if (evidence.multiTicketRoot) reasons.push("multi_ticket_root");
	if (input.fusionScore) reasons.push("rank_fusion");
	if (input.routingReason) reasons.push(input.routingReason);
	if (input.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	return reasons;
}
