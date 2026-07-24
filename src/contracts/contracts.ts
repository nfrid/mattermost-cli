import { z } from "zod";
import { SCHEMA_VERSION } from "../shared/command-result.ts";

const warningSchema = z.object({ kind: z.string(), message: z.string() });
const conversationKindSchema = z.enum(["channel", "direct_message"]);
const subjectSchema = z.discriminatedUnion("kind", [
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
const agentProbeKindSchema = z.enum([
	"ticket_title",
	"ticket_description",
	"repository",
	"file_path",
	"symbol",
	"error_message",
	"service",
	"participant",
]);
const queryExpansionSchema = z.object({
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
const probeSchema = z.object({
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
const routingEvidenceSchema = z.object({
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
const routedConversationSchema = z.object({
	id: z.string(),
	alias: z.string(),
	kind: conversationKindSchema,
	name: z.string(),
	description: z.string(),
	priority: z.number(),
	evidence: z.array(routingEvidenceSchema),
});
const searchedConversationSchema = routedConversationSchema.pick({
	id: true,
	alias: true,
	kind: true,
	evidence: true,
});
const freshnessSchema = z.object({
	alias: z.string(),
	conversationId: z.string(),
	kind: conversationKindSchema,
	observedAt: z.number().int().nonnegative(),
	lastSuccessAt: z.number().int().nonnegative().nullable(),
	ageSeconds: z.number().nonnegative().nullable(),
	stale: z.boolean(),
	coverageComplete: z.boolean(),
});
const attachmentSchema = z.object({
	id: z.string(),
	postId: z.string(),
	name: z.string(),
	extension: z.string(),
	size: z.number().int().nonnegative(),
	mimeType: z.string(),
	deleteAt: z.number().int().nonnegative(),
});
const postSchema = z.object({
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
const budgetSchema = z.object({
	measurement: z.literal("unicode_code_points_in_rendered_post"),
	limit: z.number().int().nonnegative(),
	used: z.number().int().nonnegative(),
});
const packedThreadSchema = z.object({
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
				}),
			}),
		]),
	),
});
const rankingReasonSchema = z.enum([
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
const lexicalSourceSchema = z.enum([
	"exact_phrase",
	"strict_fts",
	"broad_fts",
	"term_fts",
	"morph_fts",
	"concept_fts",
	"prefix_fts",
	"trigram",
]);
const rankFusionSourceSchema = z.enum([
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
const matchSchema = z.object({
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
const engineeringEntityKindSchema = z.enum([
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
const searchFiltersSchema = z.object({
	from: z.string().optional(),
	after: z.string().datetime().optional(),
	before: z.string().datetime().optional(),
	hasFile: z.boolean().optional(),
	file: z.string().optional(),
});
const candidateSchema = z.object({
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
const routingSchema = z.object({
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

const whoamiDataSchema = z.object({
	id: z.string(),
	username: z.string(),
	displayName: z.string(),
});
const routeMetadataSchema = z.object({
	description: z.string(),
	tags: z.array(z.string()),
	repositories: z.array(z.string()),
	scopes: z.array(z.string()),
	priority: z.number().int(),
});
const channelsDataSchema = z.object({
	channels: z.array(
		routeMetadataSchema.extend({
			alias: z.string(),
			id: z.string().optional(),
			name: z.string(),
		}),
	),
	directMessages: z.array(
		routeMetadataSchema.extend({
			alias: z.string(),
			channelId: z.string(),
			participants: z.array(z.string()).optional(),
		}),
	),
});
const channelsValidateDataSchema = z.object({
	valid: z.boolean(),
	items: z.array(
		z.object({
			alias: z.string(),
			kind: conversationKindSchema,
			valid: z.boolean(),
			configuredId: z.string().optional(),
			resolvedId: z.string().optional(),
			name: z.string().optional(),
			type: z.string().optional(),
			error: z.string().optional(),
		}),
	),
	configUpdated: z.literal(false),
});
const doctorDataSchema = z.object({
	healthy: z.boolean(),
	checks: z.array(
		z.object({ name: z.string(), ok: z.boolean(), message: z.string() }),
	),
});
const syncDataSchema = z.object({
	conversations: z.array(
		z.object({
			alias: z.string(),
			conversationId: z.string(),
			mode: z.enum(["initial", "incremental"]),
			postsProcessed: z.number().int().nonnegative(),
			coverageComplete: z.boolean(),
			oldestCoveredAt: z.number().int().nonnegative().nullable(),
			lastSuccessAt: z.number().int().nonnegative(),
		}),
	),
});
const searchDataSchema = z.object({
	subject: subjectSchema,
	probes: z.array(probeSchema),
	filters: searchFiltersSchema.optional(),
	routing: routingSchema,
	candidates: z.array(candidateSchema),
	freshnessMode: z.literal("local"),
	complete: z.boolean(),
	searchCoverageComplete: z.boolean().optional(),
	freshness: z.array(freshnessSchema),
	searchedConversations: z.array(searchedConversationSchema),
	widened: z.boolean(),
	warnings: z.array(warningSchema),
});
const contextThreadSchema = packedThreadSchema.extend({
	conversationId: z.string(),
	conversationAlias: z.string(),
	conversationKind: conversationKindSchema,
	reasons: z.array(rankingReasonSchema),
	matchingPostIds: z.array(z.string()),
	latestActivityAt: z.number().int().nonnegative(),
	link: z.string(),
	ticketDensity: z.number().nonnegative().optional(),
	nearestTicketDistance: z.number().int().nonnegative().nullable().optional(),
	rootAnchoredFocused: z.boolean().optional(),
	segments: z
		.array(
			z.object({
				startPostId: z.string(),
				endPostId: z.string(),
				posts: z.number().int().positive(),
				reason: z.enum([
					"ticket_window",
					"match_window",
					"off_topic_gap",
					"omitted_gap",
				]),
				recommendHydrate: z.boolean().optional(),
			}),
		)
		.optional(),
	surround: z
		.array(
			z.object({
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
			}),
		)
		.optional(),
});
const remoteSearchEvidenceSchema = z.object({
	requested: z.boolean(),
	performed: z.boolean(),
	reason: z
		.enum(["explicit", "incomplete_local_coverage", "stale_local_index"])
		.nullable(),
	queries: z.array(
		z.object({
			probe: z.string(),
			probeKind: agentProbeKindSchema.optional(),
			returnedPosts: z.number().int().nonnegative(),
			acceptedPosts: z.number().int().nonnegative(),
		}),
	),
	candidateThreads: z.number().int().nonnegative(),
	failures: z.number().int().nonnegative(),
});
const selectionEvidenceSchema = z.object({
	candidateThreads: z.number().int().nonnegative(),
	returnedThreads: z.number().int().nonnegative(),
	droppedThin: z.number().int().nonnegative(),
	droppedByBudget: z.number().int().nonnegative(),
	droppedNoMatch: z.number().int().nonnegative(),
	droppedCandidates: z.array(
		z.object({
			threadId: z.string(),
			url: z.string(),
			conversationId: z.string(),
			conversationAlias: z.string(),
			conversationKind: z.enum(["channel", "direct_message"]),
			dropReason: z.enum(["budget", "no_match", "thin"]),
			reasons: z.array(rankingReasonSchema),
			excerpt: z.string().optional(),
			excerpts: z.array(z.string()).max(2).optional(),
		}),
	),
});
const relatedTicketPointerSchema = z.object({
	key: z.string(),
	mentions: z.number().int().positive(),
	threadId: z.string().optional(),
	url: z.string().optional(),
	conversation: z.string().optional(),
	latestAt: z.number().int().nonnegative().optional(),
	excerpt: z.string().optional(),
	sourceThreadId: z.string().optional(),
	alreadyInPacket: z.literal(true).optional(),
	hydrated: z.literal(false),
});
const evidenceStatusSchema = z.object({
	adequacy: z.enum(["usable", "thin", "insufficient"]),
	currency: z.enum(["current", "possibly_stale", "local_only"]),
	completeness: z.object({
		selectedThreads: z.enum(["complete", "truncated"]),
		indexHistory: z.enum(["full", "cutoff_bounded"]),
		discovery: z.enum(["current", "possibly_stale", "local_only"]).optional(),
	}),
	next: z.array(
		z.object({
			action: z.enum([
				"thread_full",
				"thread_around",
				"sync",
				"inspect_dropped",
				"fresh_or_remote",
			]),
			reason: z.string(),
			priority: z.enum(["recommended", "optional"]),
			impact: z.enum([
				"may_recover_omitted_core",
				"older_discovery_only",
				"may_add_dropped_pointer",
				"may_refresh_selected_or_discovery",
			]),
			/** Argv segments only — never a joined shell string. */
			command: z.array(z.string()).optional(),
			threadId: z.string().optional(),
			conversationId: z.string().optional(),
		}),
	),
	selection: z.object({
		candidateThreads: z.number().int().nonnegative(),
		returnedThreads: z.number().int().nonnegative(),
		droppedThin: z.number().int().nonnegative(),
		droppedByBudget: z.number().int().nonnegative(),
		droppedCandidates: selectionEvidenceSchema.shape.droppedCandidates,
	}),
	packing: z.object({
		omittedPosts: z.number().int().nonnegative(),
		largestSkip: z.number().int().nonnegative(),
		recommendFullThreadIds: z.array(z.string()),
	}),
});
const contextDataSchema = z.object({
	subject: subjectSchema,
	probes: z.array(probeSchema),
	filters: searchFiltersSchema.optional(),
	remoteSearch: remoteSearchEvidenceSchema.optional(),
	freshnessMode: z.enum(["local", "network", "forced"]),
	complete: z.boolean(),
	searchCoverageComplete: z.boolean().optional(),
	selectedThreadsComplete: z.boolean().optional(),
	freshness: z.array(freshnessSchema),
	unmatchedHints: z
		.object({
			scopes: z.array(z.string()),
			repositories: z.array(z.string()),
		})
		.optional(),
	searchedConversations: z.array(searchedConversationSchema),
	explicitChannelPolicy: z.literal("restrict"),
	widening: z.object({ allowed: z.boolean(), performed: z.boolean() }),
	selection: selectionEvidenceSchema.optional(),
	relatedTickets: z.array(relatedTicketPointerSchema).optional(),
	evidence: evidenceStatusSchema.optional(),
	threads: z.array(contextThreadSchema),
	budget: budgetSchema.extend({ maxThreads: z.number().int().positive() }),
	warnings: z.array(warningSchema),
	short: z.boolean().optional(),
	navigate: z.boolean().optional(),
	signals: z.boolean().optional(),
});
const threadDataSchema = z.object({
	subject: subjectSchema,
	freshnessMode: z.enum(["local", "network"]),
	complete: z.boolean(),
	freshness: freshnessSchema,
	conversation: searchedConversationSchema.omit({ evidence: true }),
	link: z.string(),
	thread: packedThreadSchema,
	warnings: z.array(warningSchema),
	signals: z.boolean().optional(),
});

const successResult = <Command extends string, Data extends z.ZodType>(
	command: Command,
	data: Data,
) =>
	z.object({
		command: z.literal(command),
		schemaVersion: z.literal(SCHEMA_VERSION),
		success: z.literal(true),
		data,
		warnings: z.array(warningSchema),
	});

export const whoamiResultV1Schema = successResult("whoami", whoamiDataSchema);
export const channelsResultV1Schema = successResult(
	"channels",
	channelsDataSchema,
);
export const channelsValidateResultV1Schema = successResult(
	"channels.validate",
	channelsValidateDataSchema,
);
export const doctorResultV1Schema = successResult("doctor", doctorDataSchema);
export const syncResultV1Schema = successResult("sync", syncDataSchema);
export const searchResultV1Schema = successResult("search", searchDataSchema);
export const contextResultV1Schema = successResult(
	"context",
	contextDataSchema,
);
export const threadResultV1Schema = successResult("thread", threadDataSchema);
const fileDataSchema = z.object({
	id: z.string(),
	name: z.string(),
	mimeType: z.string(),
	size: z.number().int().nonnegative(),
	path: z.string(),
	postId: z.string(),
	conversationId: z.string(),
});
export const fileResultV1Schema = successResult("file", fileDataSchema);

const fileBatchSelectorSchema = z.union([
	z.object({
		kind: z.literal("file_ids"),
		fileIds: z.array(z.string()).min(1),
	}),
	z.object({
		kind: z.literal("post"),
		postId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("thread"),
		threadId: z.string().min(1),
	}),
]);

const fileBatchItemSchema = z.union([
	fileDataSchema.extend({
		status: z.literal("downloaded"),
	}),
	z.object({
		status: z.enum(["error", "skipped"]),
		id: z.string().optional(),
		name: z.string().optional(),
		error: z.object({
			kind: z.string(),
			message: z.string(),
		}),
	}),
]);

const filesDataSchema = z.object({
	outDir: z.string(),
	selector: fileBatchSelectorSchema,
	limits: z.object({
		maxFiles: z.number().int().positive(),
		maxTotalBytes: z.number().int().positive(),
	}),
	downloaded: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
	files: z.array(fileBatchItemSchema),
});
export const filesResultV1Schema = successResult("files", filesDataSchema);
export const failureResultV1Schema = z.object({
	command: z.string(),
	schemaVersion: z.literal(SCHEMA_VERSION),
	success: z.literal(false),
	error: z.object({
		source: z.enum([
			"cli",
			"config",
			"database",
			"mattermost",
			"routing",
			"sync",
		]),
		kind: z.string(),
		message: z.string(),
		details: z.record(z.string(), z.unknown()).optional(),
	}),
	warnings: z.array(warningSchema),
});

export const commandResultV1Schema = z.union([
	whoamiResultV1Schema,
	channelsResultV1Schema,
	channelsValidateResultV1Schema,
	doctorResultV1Schema,
	syncResultV1Schema,
	searchResultV1Schema,
	contextResultV1Schema,
	threadResultV1Schema,
	fileResultV1Schema,
	filesResultV1Schema,
	failureResultV1Schema,
]);

export type CommandResultV1 = z.output<typeof commandResultV1Schema>;
export type WhoamiResultV1 = z.output<typeof whoamiResultV1Schema>;
export type ChannelsResultV1 = z.output<typeof channelsResultV1Schema>;
export type ChannelsValidateResultV1 = z.output<
	typeof channelsValidateResultV1Schema
>;
export type DoctorResultV1 = z.output<typeof doctorResultV1Schema>;
export type SyncCommandResultV1 = z.output<typeof syncResultV1Schema>;
export type SearchCommandResultV1 = z.output<typeof searchResultV1Schema>;
export type ContextCommandResultV1 = z.output<typeof contextResultV1Schema>;
export type ThreadCommandResultV1 = z.output<typeof threadResultV1Schema>;
export type FileCommandResultV1 = z.output<typeof fileResultV1Schema>;
export type FilesCommandResultV1 = z.output<typeof filesResultV1Schema>;

export function parseCommandResultV1(value: unknown): CommandResultV1 {
	return commandResultV1Schema.parse(value);
}
