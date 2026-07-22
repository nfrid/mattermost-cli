import { z } from "zod";
import { SCHEMA_VERSION } from "./results.ts";

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
const probeSchema = z.object({
	value: z.string(),
	phrases: z.array(z.string()),
	terms: z.array(z.string()),
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
});
const rankingReasonSchema = z.enum([
	"direct_post",
	"explicit_ticket_relationship",
	"ticket_in_root",
	"ticket_in_reply",
	"exact_phrase",
	"all_terms_in_thread",
	"routing_explicit_channel",
	"routing_scope",
	"routing_repository",
	"routing_ticket_relationship",
	"routing_all_configured",
	"routing_widened",
	"conversation_priority",
	"latest_activity",
]);
const matchSchema = z.object({
	postId: z.string(),
	probe: z.string(),
	excerpt: z.string(),
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
});
const contextDataSchema = z.object({
	subject: subjectSchema,
	probes: z.array(probeSchema),
	freshnessMode: z.enum(["local", "network", "forced"]),
	complete: z.boolean(),
	searchCoverageComplete: z.boolean().optional(),
	selectedThreadsComplete: z.boolean().optional(),
	detailLevel: z.enum(["compact", "expanded"]).optional(),
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
	threads: z.array(contextThreadSchema),
	budget: budgetSchema.extend({ maxThreads: z.number().int().positive() }),
	warnings: z.array(warningSchema),
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

export function parseCommandResultV1(value: unknown): CommandResultV1 {
	return commandResultV1Schema.parse(value);
}
