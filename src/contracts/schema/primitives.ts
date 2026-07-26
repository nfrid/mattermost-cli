/**
 * Shared V1 schema primitives: warnings, subjects, probes, routing, packed
 * posts and threads, and ranked candidates.
 *
 * Split out of the single 1000-line `contracts.ts` so a change to the packed
 * post shape is not read alongside forty command envelopes. Every export here
 * is internal to `contracts/`; the public surface stays `contracts.ts`.
 */
import { z } from "zod";

export const warningSchema = z.object({
	kind: z.string(),
	message: z.string(),
	severity: z.enum(["material", "informational"]).optional(),
});
export const conversationKindSchema = z.enum(["channel", "direct_message"]);
export const subjectSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("ticket"),
		ticketKey: z.string(),
		raw: z.string(),
	}),
	z.object({
		kind: z.literal("post"),
		postId: z.string(),
		raw: z.string(),
		source: z.enum(["permalink", "id"]),
	}),
	z.object({ kind: z.literal("text"), text: z.string(), raw: z.string() }),
]);
export const agentProbeKindSchema = z.enum([
	"ticket_title",
	"ticket_description",
	"repository",
	"file_path",
	"symbol",
	"error_message",
	"service",
	"participant",
]);
export const queryExpansionSchema = z.object({
	sourceTerm: z.string(),
	value: z.string(),
	kind: z.enum([
		"russian_variant",
		"synonym",
		"keyboard_layout",
		"transliteration",
		"mixed_script",
	]),
	match: z.enum(["exact", "morph", "prefix"]),
});
export const probeSchema = z.object({
	value: z.string(),
	phrases: z.array(z.string()),
	terms: z.array(z.string()),
	morphTerms: z.array(z.string()).optional(),
	conceptMatches: z
		.array(
			z.object({
				conceptId: z.string(),
				sourcePhrase: z.string(),
			}),
		)
		.optional(),
	kind: agentProbeKindSchema.optional(),
	expansions: z.array(queryExpansionSchema).optional(),
});
export const routingEvidenceSchema = z.object({
	type: z.enum([
		"explicit_channel",
		"scope",
		"repository",
		"ticket_relationship",
		"all_configured",
		"widened",
	]),
	value: z.string(),
});
export const routedConversationSchema = z.object({
	id: z.string(),
	alias: z.string(),
	kind: conversationKindSchema,
	name: z.string(),
	description: z.string(),
	priority: z.number(),
	evidence: z.array(routingEvidenceSchema),
});
export const searchedConversationSchema = routedConversationSchema.pick({
	id: true,
	alias: true,
	kind: true,
	evidence: true,
});
export const freshnessSchema = z.object({
	alias: z.string(),
	conversationId: z.string(),
	kind: conversationKindSchema,
	observedAt: z.number().int().nonnegative(),
	lastSuccessAt: z.number().int().nonnegative().nullable(),
	ageSeconds: z.number().nonnegative().nullable(),
	stale: z.boolean(),
	coverageComplete: z.boolean(),
	oldestCoveredAt: z.number().int().nonnegative().nullable(),
});
export const attachmentSchema = z.object({
	id: z.string(),
	postId: z.string(),
	name: z.string(),
	extension: z.string(),
	size: z.number().int().nonnegative(),
	mimeType: z.string(),
	deleteAt: z.number().int().nonnegative(),
});
export const postSchema = z.object({
	id: z.string(),
	rootId: z.string(),
	userId: z.string(),
	authorUsername: z.string(),
	authorDisplayName: z.string(),
	createAt: z.number().int().nonnegative(),
	updateAt: z.number().int().nonnegative(),
	deleteAt: z.number().int().nonnegative(),
	message: z.string(),
	attachments: z.array(attachmentSchema),
	renderedUnits: z.number().int().nonnegative(),
});
export const budgetSchema = z.object({
	measurement: z.literal("unicode_code_points_in_rendered_post"),
	limit: z.number().int().nonnegative(),
	used: z.number().int().nonnegative(),
});
export const packedThreadSchema = z.object({
	threadId: z.string(),
	selectionStrategy: z.array(z.string()),
	totalPosts: z.number().int().nonnegative(),
	returnedPosts: z.number().int().nonnegative(),
	omittedPosts: z.number().int().nonnegative(),
	returnedAttachments: z.number().int().nonnegative(),
	totalOmittedAttachments: z.number().int().nonnegative(),
	omittedAttachments: z.array(attachmentSchema),
	unreportedOmittedAttachments: z.number().int().nonnegative(),
	budget: budgetSchema,
	posts: z.array(postSchema),
	timeline: z.array(
		z.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("post"),
				post: postSchema,
			}),
			z.object({
				kind: z.literal("skip"),
				skip: z.object({
					posts: z.number().int().positive(),
					after: z.string().optional(),
					before: z.string().optional(),
					reason: z
						.enum(["outside_ticket_window", "omitted_gap", "budget"])
						.optional(),
					files: z.number().int().positive().optional(),
					authors: z.array(z.string()).max(4).optional(),
					fromAt: z.string().optional(),
					toAt: z.string().optional(),
				}),
			}),
		]),
	),
});
export const rankingReasonSchema = z.enum([
	"direct_post",
	"explicit_ticket_relationship",
	"ticket_in_root",
	"ticket_in_reply",
	"structured_entity_match",
	"remote_search",
	"subject_in_root",
	"exact_phrase",
	"exact_phrase_in_root",
	"exact_phrase_in_reply",
	"all_terms_in_thread",
	"all_expanded_terms_in_thread",
	"exact_terms_near",
	"morph_terms_near",
	"exact_terms_same_post",
	"morph_terms_same_post",
	"expanded_terms_same_post",
	"terms_across_thread",
	"morphology_match",
	"concept_match",
	"keyboard_layout_match",
	"transliteration_match",
	"mixed_script_match",
	"prefix_match",
	"typo_match",
	"query_expansion",
	"multiple_probes_in_thread",
	"substantive_thread_depth",
	"thin_thread",
	"multi_ticket_root",
	"rank_fusion",
	"routing_explicit_channel",
	"routing_scope",
	"routing_repository",
	"routing_ticket_relationship",
	"routing_all_configured",
	"routing_widened",
	"conversation_priority",
	"latest_activity",
]);
export const lexicalSourceSchema = z.enum([
	"exact_phrase",
	"strict_fts",
	"broad_fts",
	"term_fts",
	"morph_fts",
	"concept_fts",
	"prefix_fts",
	"trigram",
]);
export const rankFusionSourceSchema = z.enum([
	"exact_phrase",
	"strict_fts",
	"broad_fts",
	"term_fts",
	"morph_fts",
	"concept_fts",
	"synonym",
	"keyboard_layout",
	"transliteration",
	"mixed_script",
	"prefix_fts",
	"trigram",
]);
export const matchSchema = z.object({
	postId: z.string(),
	probe: z.string(),
	probeKind: agentProbeKindSchema.optional(),
	excerpt: z.string(),
	lexicalSource: lexicalSourceSchema.optional(),
	sourceQuery: z.string().optional(),
	sourceRank: z.number().int().positive().optional(),
	bm25: z.number().finite().optional(),
	lexicalEvidence: z
		.array(
			z.object({
				source: lexicalSourceSchema,
				sourceQuery: z.string(),
				rank: z.number().int().positive(),
				bm25: z.number().finite(),
			}),
		)
		.optional(),
	remoteRank: z.number().int().positive().optional(),
});
export const engineeringEntityKindSchema = z.enum([
	"ticket",
	"repository",
	"pull_request",
	"commit",
	"url",
	"permalink",
	"file_path",
	"package",
	"symbol",
	"error_code",
	"username",
	"service",
	"attachment_filename",
]);
export const searchFiltersSchema = z.object({
	from: z.string().optional(),
	after: z.string().datetime().optional(),
	before: z.string().datetime().optional(),
	hasFile: z.boolean().optional(),
	file: z.string().optional(),
});
export const candidateSchema = z.object({
	threadId: z.string(),
	rootPostId: z.string(),
	conversationId: z.string(),
	conversationAlias: z.string(),
	conversationKind: conversationKindSchema,
	matchingPostIds: z.array(z.string()),
	matches: z.array(matchSchema),
	reasons: z.array(rankingReasonSchema),
	latestActivityAt: z.number().int().nonnegative(),
	priority: z.number(),
	scoreVector: z.array(z.number()),
	rankingEvidence: z
		.object({
			subjectInRoot: z.boolean(),
			subjectInReplies: z.boolean(),
			exactPhraseInRootCount: z.number().int().nonnegative(),
			exactPhraseInReplyCount: z.number().int().nonnegative(),
			matchedProbeCount: z.number().int().nonnegative(),
			fullyMatchedProbeCount: z.number().int().nonnegative(),
			exactFullyMatchedProbeCount: z.number().int().nonnegative().optional(),
			totalProbeCount: z.number().int().nonnegative(),
			matchedTermCount: z.number().int().nonnegative(),
			morphMatchedTermCount: z.number().int().nonnegative().optional(),
			expandedMatchedTermCount: z.number().int().nonnegative().optional(),
			fallbackMatchedTermCount: z.number().int().nonnegative().optional(),
			expansionMatchCount: z.number().int().nonnegative().optional(),
			exactTermsInSamePost: z.number().int().nonnegative().optional(),
			morphTermsInSamePost: z.number().int().nonnegative().optional(),
			matchedTermsInSamePost: z.number().int().nonnegative().optional(),
			minimumTokenWindow: z.number().int().positive().nullable().optional(),
			matchedTermsAcrossThread: z.number().int().nonnegative().optional(),
			matchedTermsInRoot: z.number().int().nonnegative().optional(),
			matchedTermsInReplies: z.number().int().nonnegative().optional(),
			distinctProbeCoverage: z.number().int().nonnegative().optional(),
			proximityKind: z
				.enum([
					"exact_terms_near",
					"morph_terms_near",
					"exact_terms_same_post",
					"morph_terms_same_post",
					"expanded_terms_same_post",
					"terms_across_thread",
				])
				.optional(),
			totalTermCount: z.number().int().nonnegative(),
			matchingPostCount: z.number().int().nonnegative(),
			threadPostCount: z.number().int().nonnegative().optional(),
			substantivePostCount: z.number().int().nonnegative().optional(),
			threadDepthScore: z.number().int().nonnegative().optional(),
			thinTicketStub: z.boolean().optional(),
			multiTicketRoot: z.boolean().optional(),
			ticketDensity: z.number().nonnegative().optional(),
			nearestTicketDistance: z
				.number()
				.int()
				.nonnegative()
				.nullable()
				.optional(),
			rootAnchoredFocused: z.boolean().optional(),
			exclusiveSubjectKey: z.boolean().optional(),
			otherTicketDominated: z.boolean().optional(),
			latestRelevantMatchAt: z.number().int().nonnegative().nullable(),
		})
		.optional(),
	fusionScore: z.number().finite().nonnegative().optional(),
	fusionContributions: z
		.array(
			z.object({
				probe: z.string(),
				probeKind: agentProbeKindSchema.optional(),
				source: rankFusionSourceSchema,
				sourceQuery: z.string(),
				rank: z.number().int().positive(),
				weight: z.number().finite().positive(),
				score: z.number().finite().positive(),
				conceptId: z.string().optional(),
				sourcePhrase: z.string().optional(),
				fallbackKind: z
					.enum(["identifier", "latin_technical_term", "russian_word"])
					.optional(),
				minimumSimilarity: z.number().finite().min(0).max(1).optional(),
				maximumEditDistance: z.number().int().positive().optional(),
			}),
		)
		.optional(),
	structuredMatches: z
		.array(
			z.object({
				postId: z.string(),
				probe: z.string(),
				probeKind: agentProbeKindSchema.optional(),
				kind: engineeringEntityKindSchema,
				value: z.string(),
			}),
		)
		.optional(),
	link: z.string().url().optional(),
});
export const routingSchema = z.object({
	conversations: z.array(routedConversationSchema),
	explicitChannelPolicy: z.literal("restrict"),
	unmatchedHints: z
		.object({
			scopes: z.array(z.string()),
			repositories: z.array(z.string()),
		})
		.optional(),
	reason: z.enum([
		"explicit_channels",
		"scopes",
		"repositories",
		"ticket_relationships",
		"all_configured",
	]),
	canWiden: z.boolean(),
});
