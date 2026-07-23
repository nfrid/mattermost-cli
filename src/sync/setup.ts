import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ConfiguredChannel,
	ConfiguredDirectMessage,
	MattermostConfig,
} from "../config/config.ts";
import { requireMattermostToken } from "../config/config.ts";
import type { MattermostClient } from "../mattermost/client.ts";
import type { MattermostChannel } from "../mattermost/schemas.ts";
import type { Warning } from "../shared/command-result.ts";
import { databaseFilePaths, MattermostStore } from "../store/index.ts";
import {
	channelIdentityMatches,
	directMessageIdentityMatches,
} from "./identity.ts";

export type ConfiguredDirectMessageResult = Omit<
	ConfiguredDirectMessage,
	"participants"
> & {
	alias: string;
	participants?: string[];
};

export interface ConfiguredConversationsResult {
	channels: Array<ConfiguredChannel & { alias: string }>;
	directMessages: ConfiguredDirectMessageResult[];
}

export interface ValidationItem {
	alias: string;
	kind: "channel" | "direct_message";
	valid: boolean;
	configuredId?: string;
	resolvedId?: string;
	name?: string;
	type?: string;
	error?: string;
}

export interface ChannelValidationResult {
	valid: boolean;
	items: ValidationItem[];
	configUpdated: false;
}

export interface DoctorCheck {
	name: string;
	ok: boolean;
	message: string;
}

export interface DoctorResult {
	healthy: boolean;
	checks: DoctorCheck[];
}

export function listConfiguredConversations(
	config: MattermostConfig,
): ConfiguredConversationsResult {
	return {
		channels: Object.entries(config.channels)
			.map(([alias, channel]) => ({ alias, ...channel }))
			.sort(byAlias),
		directMessages: Object.entries(config.directMessages)
			.map(([alias, directMessage]) => {
				const { participants, ...conversation } = directMessage;
				return {
					alias,
					...conversation,
					...(participants.length > 1 ? { participants } : {}),
				};
			})
			.sort(byAlias),
	};
}

export async function validateConfiguredConversations(
	config: MattermostConfig,
	client: MattermostClient,
): Promise<{ data: ChannelValidationResult; warnings: Warning[] }> {
	const items = await Promise.all([
		...Object.entries(config.channels).map(([alias, channel]) =>
			validateChannel(alias, channel, config, client),
		),
		...Object.entries(config.directMessages).map(([alias, directMessage]) =>
			validateDirectMessage(alias, directMessage, client),
		),
	]);
	items.sort((left, right) =>
		`${left.kind}:${left.alias}`.localeCompare(`${right.kind}:${right.alias}`),
	);

	return {
		data: {
			valid: items.every((item) => item.valid),
			items,
			configUpdated: false,
		},
		warnings: [
			{
				kind: "config_not_updated",
				message:
					"Validation is read-only in Phase 0; copy resolved channel IDs into local config manually.",
			},
		],
	};
}

export async function runDoctor(
	config: MattermostConfig,
	createClient: () => MattermostClient,
): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [
		{
			name: "configuration",
			ok: true,
			message: `Loaded schema version ${config.schemaVersion} from ${config.configPath}.`,
		},
	];

	try {
		requireMattermostToken(config);
		checks.push({
			name: "token",
			ok: true,
			message: "Mattermost token is set.",
		});
	} catch (error) {
		checks.push({ name: "token", ok: false, message: errorMessage(error) });
		await addLocalChecks(config, checks);
		return { healthy: checks.every((check) => check.ok), checks };
	}

	const client = createClient();
	await addRemoteCheck(checks, "authentication", async () => {
		const user = await client.getCurrentUser();
		return `Authenticated as @${user.username}.`;
	});
	await addRemoteCheck(checks, "team", async () => {
		const team = await client.getTeam(config.teamId);
		return `Team ${team.display_name} (${team.id}) is accessible.`;
	});

	const validation = await validateConfiguredConversations(config, client);
	checks.push({
		name: "configured_conversations",
		ok: validation.data.valid,
		message: validation.data.valid
			? `${validation.data.items.length} configured conversations are accessible.`
			: `${validation.data.items.filter((item) => !item.valid).length} configured conversations failed validation.`,
	});

	await addLocalChecks(config, checks);
	return { healthy: checks.every((check) => check.ok), checks };
}

async function validateChannel(
	alias: string,
	channel: ConfiguredChannel,
	config: MattermostConfig,
	client: MattermostClient,
): Promise<ValidationItem> {
	try {
		const remote = channel.id
			? await client.getChannel(channel.id)
			: await client.getChannelByName(config.teamId, channel.name);
		const valid = channelIdentityMatches(remote, channel, config.teamId);
		return channelValidationItem(alias, "channel", channel.id, remote, valid);
	} catch (error) {
		return {
			alias,
			kind: "channel",
			valid: false,
			configuredId: channel.id,
			error: errorMessage(error),
		};
	}
}

async function validateDirectMessage(
	alias: string,
	directMessage: ConfiguredDirectMessage,
	client: MattermostClient,
): Promise<ValidationItem> {
	try {
		const remote = await client.getChannel(directMessage.channelId);
		const valid = directMessageIdentityMatches(remote, directMessage);
		return channelValidationItem(
			alias,
			"direct_message",
			directMessage.channelId,
			remote,
			valid,
		);
	} catch (error) {
		return {
			alias,
			kind: "direct_message",
			valid: false,
			configuredId: directMessage.channelId,
			error: errorMessage(error),
		};
	}
}

function channelValidationItem(
	alias: string,
	kind: ValidationItem["kind"],
	configuredId: string | undefined,
	remote: MattermostChannel,
	valid: boolean,
): ValidationItem {
	return {
		alias,
		kind,
		valid,
		configuredId,
		resolvedId: remote.id,
		name: remote.name,
		type: remote.type,
		...(!valid
			? { error: `Resolved conversation has unexpected identity or type.` }
			: {}),
	};
}

async function addLocalChecks(
	config: MattermostConfig,
	checks: DoctorCheck[],
): Promise<void> {
	checks.push(await sqliteCheck());
	checks.push(await databaseIndexCheck(config.databasePath, config.concepts));
	checks.push(
		await writablePathCheck("config_directory", dirname(config.configPath)),
	);
	checks.push(
		await writablePathCheck("database_directory", dirname(config.databasePath)),
	);
	checks.push(
		await secureFilePermissionCheck("config_permissions", config.configPath),
	);
	checks.push(
		await secureOptionalFilePermissionCheck(
			"environment_file_permissions",
			join(config.projectRoot, ".env"),
		),
	);
	checks.push(await databasePermissionsCheck(config.databasePath));
}

async function sqliteCheck(): Promise<DoctorCheck> {
	try {
		const database = new Database(":memory:");
		database.exec("CREATE VIRTUAL TABLE probe USING fts5(message)");
		database.close();
		return {
			name: "sqlite_fts5",
			ok: true,
			message: "SQLite FTS5 is available.",
		};
	} catch (error) {
		return { name: "sqlite_fts5", ok: false, message: errorMessage(error) };
	}
}

async function databaseIndexCheck(
	path: string,
	concepts: MattermostConfig["concepts"],
): Promise<DoctorCheck> {
	let store: MattermostStore | undefined;
	try {
		store = await MattermostStore.open(path, { concepts });
		store.verifyIntegrity();
		const versions = store.migrationVersions();
		store.close();
		store = undefined;
		return {
			name: "database_index",
			ok: true,
			message: `Local index opened successfully (migrations: ${versions.join(", ") || "none"}).`,
		};
	} catch (error) {
		store?.close();
		return {
			name: "database_index",
			ok: false,
			message: `${errorMessage(error)} Remove the disposable database and run mm sync to rebuild it.`,
		};
	}
}

async function databasePermissionsCheck(path: string): Promise<DoctorCheck> {
	const existing: Array<{ path: string; mode: number }> = [];
	for (const candidate of databaseFilePaths(path)) {
		try {
			existing.push({
				path: candidate,
				mode: (await stat(candidate)).mode & 0o777,
			});
		} catch {
			// Sidecars are optional and may disappear after checkpointing.
		}
	}
	const insecure = existing.filter(({ mode }) => (mode & 0o077) !== 0);
	return {
		name: "database_permissions",
		ok: existing.length > 0 && insecure.length === 0,
		message:
			existing.length === 0
				? `No database files were found at ${path}.`
				: insecure.length
					? `Database files are accessible by group or other users: ${insecure.map((file) => `${file.path} (${file.mode.toString(8)})`).join(", ")}.`
					: `${existing.length} database file(s), including active sidecars, are private.`,
	};
}

async function secureOptionalFilePermissionCheck(
	name: string,
	path: string,
): Promise<DoctorCheck> {
	try {
		await stat(path);
		return secureFilePermissionCheck(name, path);
	} catch {
		return { name, ok: true, message: `${path} is not present.` };
	}
}

async function secureFilePermissionCheck(
	name: string,
	path: string,
): Promise<DoctorCheck> {
	try {
		const mode = (await stat(path)).mode & 0o777;
		const secure = (mode & 0o077) === 0;
		return {
			name,
			ok: secure,
			message: secure
				? `${path} is private (${mode.toString(8)}).`
				: `${path} is accessible by group or other users (${mode.toString(8)}); run chmod 600 ${path}.`,
		};
	} catch (error) {
		return { name, ok: false, message: errorMessage(error) };
	}
}

async function writablePathCheck(
	name: string,
	path: string,
): Promise<DoctorCheck> {
	try {
		await access(path, constants.W_OK);
		return { name, ok: true, message: `${path} is writable.` };
	} catch {
		return {
			name,
			ok: false,
			message: `${path} does not exist or is not writable.`,
		};
	}
}

async function addRemoteCheck(
	checks: DoctorCheck[],
	name: string,
	operation: () => Promise<string>,
): Promise<void> {
	try {
		checks.push({ name, ok: true, message: await operation() });
	} catch (error) {
		checks.push({ name, ok: false, message: errorMessage(error) });
	}
}

function byAlias(left: { alias: string }, right: { alias: string }): number {
	return left.alias.localeCompare(right.alias);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
