/**
 * The `context` and `thread` data schemas: permalinks, probe coverage,
 * background pointers, evidence status, related tickets, and the packet body.
 */
import { z } from "zod";
import {
	agentProbeKindSchema,
	attachmentSchema,
	budgetSchema,
	conversationKindSchema,
	freshnessSchema,
	packedThreadSchema,
	probeSchema,
	rankingReasonSchema,
	searchedConversationSchema,
	searchFiltersSchema,
	subjectSchema,
	warningSchema,
} from "./primitives.ts";

export const permalinkResolutionSchema = z.object({
	input: z.string(),
	status: z.enum([
		"resolved",
		"duplicate",
		"not_allowed",
		"unresolved",
		"invalid",
	]),
	packed: z.boolean().optional(),
	postId: z.string().optional(),
	threadId: z.string().optional(),
	conversationId: z.string().optional(),
	reason: z.string().optional(),
	// Closed on purpose: an open record here would carry whatever a future
	// error attaches, past any review of what a refusal may disclose.
	details: z
		.object({
			reason: z.enum(["not_configured", "channel_restriction"]),
			postId: z.string().optional(),
			conversationId: z.string().optional(),
			conversationAlias: z.string().optional(),
			conversationName: z.string().optional(),
			conversationKind: conversationKindSchema.optional(),
			restrictionSource: z.literal("cli").optional(),
			restrictedTo: z.array(z.string()).optional(),
			recommendedAction: z.string(),
		})
		.optional(),
});
export const probeCoverageSchema = z.object({
	probe: z.string(),
	kind: agentProbeKindSchema.optional(),
	matchedSelectedEvidence: z.boolean(),
	backgroundThreads: z.number().int().nonnegative(),
	status: z.enum(["matched_selected", "background_only", "no_match"]),
	matchMode: z.literal("normalized_terms_or_expansions").optional(),
	retrievalCriteria: z.array(z.string()).optional(),
	matchedTerms: z.array(z.string()).optional(),
	missingTerms: z.array(z.string()).optional(),
	partialEvidencePostIds: z.array(z.string()).max(8).optional(),
	hint: z.string().optional(),
});
export const backgroundThreadSchema = z.object({
	threadId: z.string(),
	conversationId: z.string(),
	conversationAlias: z.string(),
	conversationKind: conversationKindSchema,
	url: z.string(),
	latestActivityAt: z.number().int().nonnegative(),
	reasons: z.array(rankingReasonSchema),
	matchedProbes: z.array(z.string()),
	excerpts: z.array(z.string()),
	noise: z.literal(true).optional(),
	whyBackground: z.string(),
});
export const contextThreadSchema = packedThreadSchema.extend({
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
	exclusiveSubjectKey: z.boolean().optional(),
	otherTicketDominated: z.boolean().optional(),
	historicalNeighbor: z.literal(true).optional(),
	relatedTicketKey: z.string().optional(),
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
export const remoteSearchEvidenceSchema = z.object({
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
export const selectionEvidenceSchema = z.object({
	candidateThreads: z.number().int().nonnegative(),
	returnedThreads: z.number().int().nonnegative(),
	droppedThin: z.number().int().nonnegative(),
	droppedByBudget: z.number().int().nonnegative(),
	droppedByBudgetSubjectMatched: z.number().int().nonnegative().optional(),
	droppedNoMatch: z.number().int().nonnegative(),
	droppedCandidates: z.array(
		z.object({
			threadId: z.string(),
			url: z.string(),
			conversationId: z.string(),
			conversationAlias: z.string(),
			conversationKind: z.enum(["channel", "direct_message"]),
			dropReason: z.enum(["budget", "no_match", "thin", "unavailable"]),
			reasons: z.array(rankingReasonSchema),
			excerpt: z.string().optional(),
			excerpts: z.array(z.string()).max(2).optional(),
		}),
	),
});
export const relatedTicketPointerSchema = z.object({
	key: z.string(),
	mentions: z.number().int().positive(),
	threadId: z.string().optional(),
	url: z.string().optional(),
	trackerUrl: z.string().optional(),
	conversation: z.string().optional(),
	latestAt: z.number().int().nonnegative().optional(),
	excerpt: z.string().optional(),
	sourceThreadId: z.string().optional(),
	alreadyInPacket: z.literal(true).optional(),
	unresolvableTracker: z.literal(true).optional(),
});
export const evidenceStatusSchema = z.object({
	adequacy: z.enum(["usable", "thin", "insufficient"]),
	currency: z.enum(["current", "possibly_stale", "local_only"]),
	/** Additive since schema version 4; absent in older packets. */
	verdict: z
		.object({
			canAnswerFromSelectedEvidence: z.boolean(),
			mayHaveMissedOtherThreads: z.boolean(),
			mayHaveMissedReason: z
				.enum([
					"index_cutoff",
					"stale_discovery",
					"subject_matched_budget_drops",
					"local_discovery",
				])
				.optional(),
			selectedEvidenceMayBeStale: z.boolean(),
			recommendedActionRequired: z.boolean(),
			noActionAvailable: z.literal(true).optional(),
			noActionReason: z.string().optional(),
		})
		.optional(),
	completeness: z.object({
		selectedThreads: z.enum(["complete", "truncated", "not_applicable"]),
		selection: z.enum(["complete", "budget_bounded"]).optional(),
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
				"review_candidates",
				"fresh_or_remote",
				"read_attachments",
			]),
			reason: z.string(),
			priority: z.enum(["recommended", "optional"]),
			impact: z.enum([
				"may_recover_omitted_core",
				"older_discovery_only",
				"may_add_dropped_pointer",
				"may_refresh_selected_or_discovery",
				"may_contradict_visible_text",
				"may_verify_quantitative_claim",
				"cannot_verify_quantities",
				"requires_external_reader",
			]),
			/** Argv segments only — never a joined shell string. */
			command: z.array(z.string()).optional(),
			threadId: z.string().optional(),
			conversationId: z.string().optional(),
			postId: z.string().optional(),
		}),
	),
	selection: z.object({
		candidateThreads: z.number().int().nonnegative(),
		returnedThreads: z.number().int().nonnegative(),
		droppedThin: z.number().int().nonnegative(),
		droppedByBudget: z.number().int().nonnegative(),
		droppedByBudgetSubjectMatched: z.number().int().nonnegative().optional(),
		droppedNoMatch: z.number().int().nonnegative(),
		droppedCandidates: selectionEvidenceSchema.shape.droppedCandidates,
	}),
	packing: z.object({
		omittedPosts: z.number().int().nonnegative(),
		largestSkip: z.number().int().nonnegative(),
		recommendedHydrationThreadIds: z.array(z.string()).optional(),
		recommendFullThreadIds: z.array(z.string()),
	}),
	history: z
		.object({
			cutoffBounded: z.array(
				z.object({
					alias: z.string(),
					conversationId: z.string(),
					oldestIndexedAt: z.string().optional(),
					inSelectedThreads: z.boolean(),
				}),
			),
			additional: z.number().int().positive().optional(),
		})
		.optional(),
});
export const personRefSchema = z.object({
	username: z.string(),
	displayName: z.string().optional(),
	role: z.string().optional(),
	roleSource: z.enum(["profile", "config"]).optional(),
	isBot: z.literal(true).optional(),
});
export const contextDataSchema = z.object({
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
	background: z.array(backgroundThreadSchema).optional(),
	probeCoverage: z.array(probeCoverageSchema).optional(),
	permalinks: z.array(permalinkResolutionSchema).optional(),
	budget: budgetSchema.extend({ maxThreads: z.number().int().positive() }),
	warnings: z.array(warningSchema),
	short: z.boolean().optional(),
	navigate: z.boolean().optional(),
	brief: z.boolean().optional(),
	fullPosts: z.boolean().optional(),
	timeline: z.boolean().optional(),
	signals: z.boolean().optional(),
	people: z.array(personRefSchema).optional(),
	followLog: z
		.array(
			z.object({
				command: z.array(z.string()),
				action: z.enum([
					"thread_full",
					"thread_around",
					"sync",
					"inspect_dropped",
					"review_candidates",
					"fresh_or_remote",
					"read_attachments",
				]),
				status: z.enum([
					"ok",
					"error",
					"skipped_external_reader",
					"skipped_disallowed",
					"skipped_no_command",
				]),
				error: z.string().optional(),
				inspectionStatus: z.string().optional(),
			}),
		)
		.optional(),
	followExhausted: z.literal(true).optional(),
	followedAttachments: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				mimeType: z.string(),
				size: z.number(),
				path: z.string(),
				postId: z.string(),
				conversationId: z.string(),
				inspection: z.unknown().optional(),
			}),
		)
		.optional(),
});
export const threadDataSchema = z.object({
	subject: subjectSchema,
	freshnessMode: z.enum(["local", "network"]),
	complete: z.boolean(),
	freshness: freshnessSchema,
	conversation: searchedConversationSchema.omit({ evidence: true }),
	link: z.string(),
	thread: packedThreadSchema,
	retrieval: z
		.object({
			mode: z.literal("gap_window"),
			rootPostId: z.string(),
			anchorPostId: z.string(),
			requestedBefore: z.number().int().nonnegative(),
			requestedAfter: z.number().int().nonnegative(),
			requestedPosts: z.number().int().positive(),
			returnedPosts: z.number().int().nonnegative(),
			requestedRangeComplete: z.boolean(),
		})
		.optional(),
	warnings: z.array(warningSchema),
	brief: z.boolean().optional(),
	signals: z.boolean().optional(),
});
