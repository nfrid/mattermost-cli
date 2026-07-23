import { dirname } from "node:path";
import { z } from "zod";
import { ConfigError } from "../shared/errors.ts";
import { resolveLocalPaths } from "../shared/paths.ts";

const stringListSchema = z.array(z.string().trim().min(1)).default([]);
const searchSynonymsSchema = z
	.record(
		z.string().trim().min(2).max(64),
		z.array(z.string().trim().min(2).max(80)).max(8),
	)
	.default({});
const searchConceptsSchema = z
	.record(
		z
			.string()
			.trim()
			.regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
		z.array(z.string().trim().min(2).max(120)).min(2).max(8),
	)
	.default({});

const routeMetadataSchema = z.object({
	description: z.string().trim().min(1),
	tags: stringListSchema,
	repositories: stringListSchema,
	scopes: stringListSchema,
	priority: z.number().int().default(0),
});

const configuredChannelSchema = routeMetadataSchema.extend({
	id: z.string().trim().min(1).optional(),
	name: z.string().trim().min(1),
});

const configuredDirectMessageSchema = routeMetadataSchema.extend({
	channelId: z.string().trim().min(1),
	participants: stringListSchema,
});

const outputBudgetsSchema = z
	.object({
		defaultMaxCharacters: z.number().int().positive().default(16_000),
		defaultPerThreadCharacters: z.number().int().positive().default(6_000),
		defaultMaxThreads: z.number().int().positive().default(3),
		matchNeighborhoodRadius: z.number().int().positive().default(2),
		ticketNeighborhoodRadius: z.number().int().positive().default(8),
		clusterMergeGap: z.number().int().nonnegative().default(2),
		conversationSurroundRoots: z.number().int().nonnegative().default(5),
		shortThreadMaxReplies: z.number().int().nonnegative().default(2),
	})
	.default({
		defaultMaxCharacters: 16_000,
		defaultPerThreadCharacters: 6_000,
		defaultMaxThreads: 3,
		matchNeighborhoodRadius: 2,
		ticketNeighborhoodRadius: 8,
		clusterMergeGap: 2,
		conversationSurroundRoots: 5,
		shortThreadMaxReplies: 2,
	});

const localConfigSchema = z
	.object({
		schemaVersion: z.literal(1),
		url: z.url().optional(),
		teamId: z.string().trim().min(1),
		token: z.string().trim().min(1).optional(),
		databasePath: z.string().trim().min(1).optional(),
		freshnessSeconds: z.number().int().nonnegative().default(300),
		reconciliationOverlapMs: z.number().int().nonnegative().default(30_000),
		historyDays: z.number().int().positive().default(365),
		pageSize: z.number().int().min(1).max(200).default(100),
		synonyms: searchSynonymsSchema,
		concepts: searchConceptsSchema,
		suppressAuthors: stringListSchema,
		budgets: outputBudgetsSchema,
		channels: z
			.record(z.string().trim().min(1), configuredChannelSchema)
			.default({}),
		directMessages: z
			.record(z.string().trim().min(1), configuredDirectMessageSchema)
			.default({}),
	})
	.superRefine((config, context) => {
		if (Object.keys(config.synonyms).length > 32) {
			context.addIssue({
				code: "custom",
				message: "Search synonyms are limited to 32 configured groups.",
				path: ["synonyms"],
			});
		}
		if (Object.keys(config.concepts).length > 32) {
			context.addIssue({
				code: "custom",
				message: "Search concepts are limited to 32 configured groups.",
				path: ["concepts"],
			});
		}
		const conceptAliases = new Map<string, string>();
		for (const [conceptId, aliases] of Object.entries(config.concepts)) {
			const normalizedInGroup = new Set<string>();
			for (const alias of aliases) {
				const normalized = alias.toLowerCase().replaceAll("ё", "е");
				if (normalizedInGroup.has(normalized)) {
					context.addIssue({
						code: "custom",
						message: `Concept ${conceptId} contains duplicate alias ${alias}.`,
						path: ["concepts", conceptId],
					});
				}
				normalizedInGroup.add(normalized);
				const existing = conceptAliases.get(normalized);
				if (existing && existing !== conceptId) {
					context.addIssue({
						code: "custom",
						message: `Concept alias ${alias} is shared by ${existing} and ${conceptId}.`,
						path: ["concepts", conceptId],
					});
				}
				conceptAliases.set(normalized, conceptId);
			}
		}
		for (const alias of Object.keys(config.channels)) {
			if (alias in config.directMessages) {
				context.addIssue({
					code: "custom",
					message: `Alias ${alias} cannot identify both a channel and a direct message.`,
					path: ["directMessages", alias],
				});
			}
		}
	});

export type ConfiguredChannel = z.output<typeof configuredChannelSchema>;
export type ConfiguredDirectMessage = z.output<
	typeof configuredDirectMessageSchema
>;
export type OutputBudgets = z.output<typeof outputBudgetsSchema>;
export type SearchConcepts = z.output<typeof searchConceptsSchema>;
export type LocalMattermostConfig = z.output<typeof localConfigSchema>;

export interface MattermostConfig
	extends Omit<
		LocalMattermostConfig,
		"synonyms" | "concepts" | "suppressAuthors"
	> {
	synonyms?: LocalMattermostConfig["synonyms"];
	concepts?: SearchConcepts;
	suppressAuthors?: LocalMattermostConfig["suppressAuthors"];
	url: string;
	configPath: string;
	databasePath: string;
	projectRoot: string;
}

export interface LoadConfigOptions {
	env?: Record<string, string | undefined>;
	projectRoot?: string;
	configPath?: string;
	databasePath?: string;
}

export async function loadMattermostConfig(
	options: LoadConfigOptions = {},
): Promise<MattermostConfig> {
	const env = options.env ?? Bun.env;
	const initialPaths = resolveLocalPaths(env, options);
	const localConfig = await readLocalConfig(initialPaths.configPath);
	const urlSetting = nonEmpty(env.MATTERMOST_URL) ?? localConfig.url;

	if (!urlSetting) {
		throw new ConfigError(
			"Mattermost URL is required in MATTERMOST_URL or local config.",
			"missing_url",
		);
	}

	const databaseSetting =
		options.databasePath ??
		nonEmpty(env.MATTERMOST_DATABASE) ??
		localConfig.databasePath;
	const databasePath = databaseSetting
		? resolveLocalPaths(
				{},
				{
					projectRoot: initialPaths.projectRoot,
					configPath: initialPaths.configPath,
					databasePath: databaseSetting,
				},
			).databasePath
		: initialPaths.databasePath;

	return {
		...localConfig,
		url: normalizeMattermostUrl(urlSetting),
		token: nonEmpty(env.MATTERMOST_TOKEN) ?? localConfig.token,
		projectRoot: initialPaths.projectRoot,
		configPath: initialPaths.configPath,
		databasePath,
	};
}

export function requireMattermostToken(config: MattermostConfig): string {
	if (!config.token) {
		throw new ConfigError(
			"Mattermost token is required in MATTERMOST_TOKEN or local config.",
			"missing_token",
		);
	}

	return config.token;
}

async function readLocalConfig(path: string): Promise<LocalMattermostConfig> {
	const file = Bun.file(path);

	if (!(await file.exists())) {
		throw new ConfigError(
			`Mattermost config not found at ${path}.`,
			"config_not_found",
		);
	}

	try {
		return localConfigSchema.parse(await file.json());
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new ConfigError(
				`Mattermost config is invalid: ${z.prettifyError(error)}`,
				"invalid_config",
				{ cause: error },
			);
		}

		throw new ConfigError(
			`Could not read Mattermost config at ${path}.`,
			"config_unreadable",
			{ cause: error },
		);
	}
}

export function normalizeMattermostUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new ConfigError("Mattermost URL is invalid.", "invalid_url", {
			cause: error,
		});
	}
	const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new ConfigError(
			"Mattermost URL must use HTTPS (HTTP is allowed only for loopback development).",
			"insecure_url",
		);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConfigError(
			"Mattermost URL cannot contain credentials, query parameters, or a fragment.",
			"invalid_url",
		);
	}
	return url.toString().replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
