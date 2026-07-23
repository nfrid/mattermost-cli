import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMattermostConfig } from "./config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

describe("loadMattermostConfig", () => {
	test("resolves local paths from the project root and keeps channels and DMs separate", async () => {
		const projectRoot = await temporaryProject({
			schemaVersion: 1,
			url: "https://chat.example.test/",
			teamId: "team-id",
			synonyms: { репликация: ["replication", "data replication"] },
			channels: {
				payments: {
					name: "payments",
					description: "Payment discussion",
				},
			},
			directMessages: {
				leads: {
					channelId: "dm-id",
					description: "Leads DM",
					participants: ["alice", "bob"],
				},
			},
		});

		const config = await loadMattermostConfig({ projectRoot, env: {} });

		expect(config.url).toBe("https://chat.example.test");
		expect(config.configPath).toBe(
			join(projectRoot, ".mattermost/config.json"),
		);
		expect(config.databasePath).toBe(
			join(projectRoot, ".mattermost/mattermost.sqlite3"),
		);
		expect(Object.keys(config.channels)).toEqual(["payments"]);
		expect(Object.keys(config.directMessages)).toEqual(["leads"]);
		expect(config.channels.payments?.tags).toEqual([]);
		expect(config.synonyms).toEqual({
			репликация: ["replication", "data replication"],
		});
		expect(config.budgets.defaultMaxCharacters).toBe(16_000);
	});

	test("bounds configured search synonyms", async () => {
		const projectRoot = await temporaryProject({
			schemaVersion: 1,
			url: "https://chat.example.test",
			teamId: "team-id",
			synonyms: {
				репликация: Array.from({ length: 9 }, (_, index) => `alias-${index}`),
			},
			channels: {},
			directMessages: {},
		});
		await expect(
			loadMattermostConfig({ projectRoot, env: {} }),
		).rejects.toMatchObject({ kind: "invalid_config" });
	});

	test("rejects aliases shared by channels and direct messages", async () => {
		const projectRoot = await temporaryProject({
			schemaVersion: 1,
			url: "https://chat.example.test",
			teamId: "team-id",
			channels: {
				shared: { name: "shared", description: "Channel" },
			},
			directMessages: {
				shared: { channelId: "dm-id", description: "DM" },
			},
		});

		await expect(
			loadMattermostConfig({ projectRoot, env: {} }),
		).rejects.toThrow("cannot identify both a channel and a direct message");
	});

	test("rejects insecure remote URLs and credentials embedded in URLs", async () => {
		const projectRoot = await temporaryProject({
			schemaVersion: 1,
			url: "https://chat.example.test",
			teamId: "team-id",
			channels: {},
			directMessages: {},
		});
		await expect(
			loadMattermostConfig({
				projectRoot,
				env: { MATTERMOST_URL: "http://chat.example.test" },
			}),
		).rejects.toMatchObject({ kind: "insecure_url" });
		await expect(
			loadMattermostConfig({
				projectRoot,
				env: { MATTERMOST_URL: "https://token@chat.example.test" },
			}),
		).rejects.toMatchObject({ kind: "invalid_url" });
		await expect(
			loadMattermostConfig({
				projectRoot,
				env: { MATTERMOST_URL: "http://localhost:8065" },
			}),
		).resolves.toMatchObject({ url: "http://localhost:8065" });
	});

	test("environment overrides URL, token, config path, and database path", async () => {
		const projectRoot = await temporaryProject(
			{
				schemaVersion: 1,
				url: "https://file.example.test",
				teamId: "team-id",
				token: "file-token",
				channels: {},
				directMessages: {},
			},
			".mattermost/alternate.json",
		);

		const config = await loadMattermostConfig({
			projectRoot,
			env: {
				MATTERMOST_CONFIG: ".mattermost/alternate.json",
				MATTERMOST_DATABASE: ".mattermost/runtime/index.sqlite3",
				MATTERMOST_URL: "https://env.example.test/",
				MATTERMOST_TOKEN: "env-token",
			},
		});

		expect(config.url).toBe("https://env.example.test");
		expect(config.token).toBe("env-token");
		expect(config.databasePath).toBe(
			join(projectRoot, ".mattermost/runtime/index.sqlite3"),
		);
	});

	test("rejects runtime config and database paths outside .mattermost", async () => {
		const projectRoot = await temporaryProject({
			schemaVersion: 1,
			url: "https://chat.example.test",
			teamId: "team-id",
			channels: {},
			directMessages: {},
		});
		await expect(
			loadMattermostConfig({
				projectRoot,
				env: { MATTERMOST_CONFIG: "config.json" },
			}),
		).rejects.toMatchObject({
			kind: "runtime_path_outside_private_directory",
		});
		await expect(
			loadMattermostConfig({
				projectRoot,
				env: { MATTERMOST_DATABASE: "runtime/index.sqlite3" },
			}),
		).rejects.toMatchObject({
			kind: "runtime_path_outside_private_directory",
		});
	});
});

async function temporaryProject(
	config: unknown,
	configPath = ".mattermost/config.json",
): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "mattermost-cli-config-"));
	temporaryDirectories.push(projectRoot);
	const path = join(projectRoot, configPath);
	await Bun.write(path, JSON.stringify(config));
	return projectRoot;
}
