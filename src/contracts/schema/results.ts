/**
 * Command envelopes: the per-command data schemas, the `successResult` wrapper,
 * and the discriminated union every `--json` document is parsed against.
 */
import { z } from "zod";
import { SCHEMA_VERSION } from "../../shared/command-result.ts";
import {
	contextDataSchema,
	personRefSchema,
	threadDataSchema,
} from "./context.ts";
import {
	candidateSchema,
	conversationKindSchema,
	freshnessSchema,
	probeSchema,
	routingSchema,
	searchedConversationSchema,
	searchFiltersSchema,
	subjectSchema,
	warningSchema,
} from "./primitives.ts";

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
	/** Agent-projection excerpt cap; the full match list stays in this document. */
	excerptLimit: z.number().int().positive(),
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
const peopleDataSchema = z.object({
	people: z.array(
		personRefSchema.extend({
			messages: z.number().int().nonnegative(),
			latestAt: z.number().int().nonnegative(),
		}),
	),
	total: z.number().int().nonnegative(),
	conversations: z.array(z.string()),
});
export const peopleResultV1Schema = successResult("people", peopleDataSchema);
const fileInspectionSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("preview"),
		format: z.enum(["text", "csv", "json", "xml", "spreadsheet"]),
		decoded: z.literal(true),
		syntaxValidated: z.literal(false),
		preview: z.string(),
		bytesExamined: z.number().int().nonnegative(),
		lines: z.number().int().nonnegative(),
		sensitiveFieldsDetected: z.array(z.string()).optional(),
		redactionApplied: z.literal(true).optional(),
		truncated: z.literal(true).optional(),
		downloaded: z.literal(true).optional(),
		inspected: z.literal(true).optional(),
		sheets: z.array(z.string()).optional(),
		activeSheet: z.string().optional(),
		headers: z.array(z.string()).optional(),
		rowCount: z.number().int().nonnegative().optional(),
	}),
	z.object({
		status: z.literal("text_extracted"),
		format: z.literal("image"),
		trust: z.literal("low"),
		source: z.literal("ocr"),
		text: z.string(),
		downloaded: z.literal(true),
		inspected: z.literal(true),
		engine: z.string().optional(),
		truncated: z.literal(true).optional(),
	}),
	z.object({
		status: z.literal("not_interpreted"),
		format: z.enum(["image", "spreadsheet", "binary"]),
		interpreted: z.literal(false),
		downloaded: z.literal(true).optional(),
		inspected: z.literal(false).optional(),
		reason: z.enum([
			"external_image_reader_required",
			"external_spreadsheet_parser_required",
			"unsupported_binary_format",
		]),
		recommendedAction: z.string(),
	}),
]);
const fileDataSchema = z.object({
	id: z.string(),
	name: z.string(),
	mimeType: z.string(),
	size: z.number().int().nonnegative(),
	path: z.string(),
	postId: z.string(),
	conversationId: z.string(),
	inspection: fileInspectionSchema.optional(),
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
	peopleResultV1Schema,
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
export type PeopleCommandResultV1 = z.output<typeof peopleResultV1Schema>;
export type FileCommandResultV1 = z.output<typeof fileResultV1Schema>;
export type FilesCommandResultV1 = z.output<typeof filesResultV1Schema>;

export function parseCommandResultV1(value: unknown): CommandResultV1 {
	return commandResultV1Schema.parse(value);
}
