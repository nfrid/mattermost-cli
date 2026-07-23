import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MattermostConfig } from "./config.ts";
import { MattermostClient } from "./mattermost/client.ts";
import {
	listConfiguredConversations,
	runDoctor,
	validateConfiguredConversations,
} from "./setup.ts";

const config = {
	schemaVersion: 1,
	url: "https://chat.example.test",
	teamId: "team-id",
	token: "token",
	databasePath: "/tmp/index.sqlite3",
	configPath: "/tmp/config.json",
	projectRoot: "/tmp",
	freshnessSeconds: 300,
	reconciliationOverlapMs: 30_000,
	historyDays: 365,
	pageSize: 100,
	budgets: {
		defaultMaxCharacters: 16_000,
		defaultPerThreadCharacters: 6_000,
		defaultMaxThreads: 3,
		matchNeighborhoodRadius: 2,
		clusterMergeGap: 2,
		conversationSurroundRoots: 5,
		shortThreadMaxReplies: 2,
	},
	channels: {
		payments: {
			name: "payments",
			description: "Payments",
			tags: [],
			repositories: ["payment"],
			scopes: ["payments"],
			priority: 100,
		},
	},
	directMessages: {
		leads: {
			channelId: "dm-id",
			description: "Leads",
			participants: ["alice"],
			tags: [],
			repositories: [],
			scopes: [],
			priority: 10,
		},
	},
} satisfies MattermostConfig;

describe("configured conversations", () => {
	test("lists channels and direct messages without singleton participant arrays", () => {
		const result = listConfiguredConversations({
			...config,
			directMessages: {
				...config.directMessages,
				leadership: {
					...config.directMessages.leads,
					channelId: "group-id",
					participants: ["alice", "bob"],
				},
			},
		});
		expect(result.channels.map((channel) => channel.alias)).toEqual([
			"payments",
		]);
		expect(result.directMessages.map((dm) => dm.alias)).toEqual([
			"leadership",
			"leads",
		]);
		expect(
			result.directMessages.find((dm) => dm.alias === "leads"),
		).not.toHaveProperty("participants");
		expect(
			result.directMessages.find((dm) => dm.alias === "leadership")
				?.participants,
		).toEqual(["alice", "bob"]);
	});

	test("resolves channel names and validates explicit DM IDs without writing config", async () => {
		const requestedPaths: string[] = [];
		const client = new MattermostClient(config, {
			fetch: (async (input: string | URL | Request) => {
				const path = new URL(String(input)).pathname;
				requestedPaths.push(path);
				if (path.endsWith("/channels/name/payments")) {
					return Response.json(
						channel("channel-id", "O", "payments", "team-id"),
					);
				}
				return Response.json(channel("dm-id", "D", "alice__bob", ""));
			}) as typeof fetch,
		});

		const result = await validateConfiguredConversations(config, client);

		expect(result.data.valid).toBe(true);
		expect(result.data.configUpdated).toBe(false);
		expect(result.data.items).toHaveLength(2);
		expect(result.warnings.map((warning) => warning.kind)).toContain(
			"config_not_updated",
		);
		expect(requestedPaths).toEqual([
			"/api/v4/teams/team-id/channels/name/payments",
			"/api/v4/channels/dm-id",
		]);
	});

	test("doctor reports expired authentication without disclosing the token", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mattermost-doctor-auth-"));
		const configPath = join(directory, "config.json");
		const databasePath = join(directory, "index.sqlite3");
		await Bun.write(configPath, "{}");
		await chmod(configPath, 0o600);
		const doctorConfig = {
			...config,
			token: "expired-sensitive-value",
			configPath,
			databasePath,
		};
		const client = new MattermostClient(doctorConfig, {
			fetch: (async () =>
				new Response(`expired ${doctorConfig.token}`, {
					status: 401,
					statusText: "Unauthorized",
				})) as unknown as typeof fetch,
		});
		const result = await runDoctor(doctorConfig, () => client);
		expect(result.healthy).toBe(false);
		expect(
			result.checks.find(({ name }) => name === "authentication")?.ok,
		).toBe(false);
		expect(JSON.stringify(result)).not.toContain(doctorConfig.token);
	});

	test("doctor checks authentication, team, conversations, SQLite, and local paths", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mattermost-doctor-"));
		const configPath = join(directory, "config.json");
		const databasePath = join(directory, "index.sqlite3");
		await Bun.write(configPath, "{}");
		await chmod(configPath, 0o600);
		const doctorConfig = { ...config, configPath, databasePath };
		const fetchImplementation = (async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/users/me")) {
				return Response.json({
					id: "user-id",
					username: "alice",
					first_name: "Alice",
					last_name: "",
					nickname: "",
					delete_at: 0,
					is_bot: false,
				});
			}
			if (path.endsWith("/teams/team-id")) {
				return Response.json({
					id: "team-id",
					name: "example-team",
					display_name: "Example Team",
					type: "I",
					delete_at: 0,
				});
			}
			if (path.endsWith("/channels/name/payments")) {
				return Response.json(channel("channel-id", "O", "payments", "team-id"));
			}
			return Response.json(channel("dm-id", "D", "alice__bob", ""));
		}) as typeof fetch;
		const client = new MattermostClient(doctorConfig, {
			fetch: fetchImplementation,
		});

		const result = await runDoctor(doctorConfig, () => client);

		expect(result.healthy).toBe(true);
		expect(result.checks.map((check) => check.name)).toEqual([
			"configuration",
			"token",
			"authentication",
			"team",
			"configured_conversations",
			"sqlite_fts5",
			"database_index",
			"config_directory",
			"database_directory",
			"config_permissions",
			"environment_file_permissions",
			"database_permissions",
		]);
	});
});

function channel(id: string, type: string, name: string, teamId: string) {
	return {
		id,
		team_id: teamId,
		type,
		name,
		display_name: name,
		header: "",
		purpose: "",
		delete_at: 0,
	};
}
