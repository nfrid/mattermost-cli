import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OutputWriter, runCli } from "./cli.ts";
import { MattermostStore } from "./storage.ts";
import {
	conversationFixture,
	postFixture,
	userFixture,
} from "./test-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

describe("CLI output", () => {
	test("emits exactly one JSON document for a successful command", async () => {
		const projectRoot = await projectWithConfig();
		const stdout = capture();
		const stderr = capture();
		const exitCode = await runCli(["channels", "--json"], {
			projectRoot,
			env: {},
			stdout,
			stderr,
		});

		expect(exitCode).toBe(0);
		const document = JSON.parse(stdout.text);
		expect(document).toMatchObject({
			command: "channels",
			schemaVersion: 1,
			success: true,
		});
		expect(document.data.directMessages).toEqual([
			{
				alias: "alice",
				channelId: "dm-id",
				description: "Alice",
				tags: [],
				repositories: [],
				scopes: [],
				priority: 0,
			},
			{
				alias: "leadership",
				channelId: "group-id",
				description: "Leadership",
				participants: ["alice", "bob"],
				tags: [],
				repositories: [],
				scopes: [],
				priority: 0,
			},
		]);
		expect(stderr.text).toBe("");
		expect(stdout.text).toBe(`${JSON.stringify(document)}\n`);
		expect(JSON.stringify(document)).not.toContain("token-from-file");
	});

	test("pretty-prints JSON output with --pretty", async () => {
		const projectRoot = await projectWithConfig();
		const stdout = capture();
		const stderr = capture();
		const exitCode = await runCli(["channels", "--pretty"], {
			projectRoot,
			env: {},
			stdout,
			stderr,
		});

		expect(exitCode).toBe(0);
		const document = JSON.parse(stdout.text);
		expect(document).toMatchObject({
			command: "channels",
			schemaVersion: 1,
			success: true,
		});
		expect(stdout.text).toBe(`${JSON.stringify(document, null, 2)}\n`);
		expect(stderr.text).toBe("");
	});

	test("emits a flattened agent projection with --agent", async () => {
		const projectRoot = await projectWithConfig();
		const stdout = capture();
		const stderr = capture();
		const exitCode = await runCli(["channels", "--agent"], {
			projectRoot,
			env: {},
			stdout,
			stderr,
		});

		expect(exitCode).toBe(0);
		const document = JSON.parse(stdout.text);
		expect(stdout.text).toBe(`${JSON.stringify(document)}\n`);
		expect(document).toMatchObject({
			command: "channels",
			schemaVersion: 1,
			success: true,
			channels: expect.any(Array),
			directMessages: expect.any(Array),
			warnings: [],
		});
		expect(document.data).toBeUndefined();
		expect(stderr.text).toBe("");
	});

	test("emits exactly one JSON error document for configuration failure", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "mattermost-cli-empty-"));
		temporaryDirectories.push(projectRoot);
		const stdout = capture();
		const stderr = capture();
		const exitCode = await runCli(["channels", "--json"], {
			projectRoot,
			env: {},
			stdout,
			stderr,
		});

		expect(exitCode).toBe(1);
		expect(JSON.parse(stdout.text)).toMatchObject({
			command: "channels",
			schemaVersion: 1,
			success: false,
			error: { source: "config", kind: "config_not_found" },
		});
		expect(stderr.text).toBe("");
	});

	test("rejects remote search combined with local-only mode", async () => {
		const stdout = capture();
		const exitCode = await runCli(
			["context", "payment", "--local", "--remote-search", "--json"],
			{ stdout, stderr: capture(), env: {} },
		);
		expect(exitCode).toBe(1);
		expect(JSON.parse(stdout.text)).toMatchObject({ success: false });
	});

	test("keeps sync progress off JSON stdout and honors restrictive channels", async () => {
		const projectRoot = await projectWithConfig();
		const stdout = capture();
		const stderr = capture();
		const requested: string[] = [];
		const exitCode = await runCli(["sync", "--channel", "payments", "--json"], {
			projectRoot,
			env: {},
			stdout,
			stderr,
			fetch: (async (input) => {
				const url = String(input);
				requested.push(url);
				if (url.includes("/channels/name/payments")) {
					return Response.json({
						id: "channel-payments",
						team_id: "team-id",
						type: "O",
						name: "payments",
						display_name: "Payments",
					});
				}
				if (url.includes("/channels/channel-payments/posts")) {
					return Response.json({
						order: ["post-1"],
						posts: {
							"post-1": {
								id: "post-1",
								create_at: Date.now(),
								update_at: Date.now(),
								delete_at: 0,
								user_id: "user-id",
								channel_id: "channel-payments",
								root_id: "",
								message: "payment update",
							},
						},
					});
				}
				if (url.includes("/users/user-id")) {
					return Response.json({ id: "user-id", username: "alice" });
				}
				return new Response("unexpected", { status: 404 });
			}) as typeof fetch,
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.text)).toMatchObject({
			command: "sync",
			success: true,
			data: { conversations: [{ alias: "payments", postsProcessed: 1 }] },
		});
		expect(stderr.text).toBe("");
		expect(requested.some((url) => url.includes("dm-id"))).toBe(false);
	});

	test("emits one bounded context JSON document and compact human search output", async () => {
		const projectRoot = await projectWithConfig();
		const store = await MattermostStore.open(
			join(projectRoot, ".mattermost/mattermost.sqlite3"),
		);
		const rootId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			files: [
				{
					id: "evidence-file",
					user_id: "user-1",
					post_id: rootId,
					create_at: 1,
					update_at: 1,
					delete_at: 0,
					name: "evidence.txt",
					extension: "txt",
					size: 10,
					mime_type: "text/plain",
				},
			],
			posts: [
				postFixture({
					id: rootId,
					channel_id: "channel-payments",
					message: "payment timeout exact evidence",
					file_ids: ["evidence-file"],
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: rootId,
				newestPostAt: 1,
				oldestCoveredAt: 1,
				lastSuccessAt: 1,
				coverageComplete: true,
			},
		});
		store.close();

		const stdout = capture();
		const stderr = capture();
		const exitCode = await runCli(
			[
				"context",
				"payment timeout",
				"--channel",
				"payments",
				"--local",
				"--json",
			],
			{ projectRoot, env: {}, stdout, stderr },
		);
		expect(exitCode).toBe(0);
		const document = JSON.parse(stdout.text);
		expect(document).toMatchObject({
			command: "context",
			schemaVersion: 1,
			success: true,
			data: {
				explicitChannelPolicy: "restrict",
				searchCoverageComplete: false,
				selectedThreadsComplete: true,
				threads: [
					{
						threadId: rootId,
						conversationAlias: "payments",
						posts: [{ message: "payment timeout exact evidence" }],
					},
				],
				budget: { measurement: "unicode_code_points_in_rendered_post" },
			},
		});
		expect(stderr.text).toBe("");

		const searchOutput = capture();
		await runCli(["search", "payment timeout", "--channel", "payments"], {
			projectRoot,
			env: {},
			stdout: searchOutput,
			stderr: capture(),
		});
		expect(searchOutput.text).toContain(
			`#payments · https://chat.example.test/_redirect/pl/${rootId} · subject_in_root, exact_phrase, exact_phrase_in_root, all_terms_in_thread, exact_terms_near, rank_fusion, routing_explicit_channel, latest_activity`,
		);
		expect(searchOutput.text).toContain(
			"ranking signals, not required filters",
		);
		expect(searchOutput.text).not.toContain("Alice Example");

		const filteredOutput = capture();
		await runCli(
			[
				"search",
				"payment timeout",
				"--channel",
				"payments",
				"--from",
				"alice",
				"--after",
				"1970-01-01T00:00:00.000Z",
				"--before",
				"1970-01-01T00:00:01.000Z",
				"--has-file",
				"--file",
				"evidence",
				"--json",
			],
			{ projectRoot, env: {}, stdout: filteredOutput, stderr: capture() },
		);
		expect(JSON.parse(filteredOutput.text)).toMatchObject({
			data: {
				filters: {
					from: "alice",
					after: "1970-01-01T00:00:00.000Z",
					before: "1970-01-01T00:00:01.000Z",
					hasFile: true,
					file: "evidence",
				},
				candidates: [{ threadId: rootId }],
			},
		});
	});

	test("formats the same whoami result for human output", async () => {
		const projectRoot = await projectWithConfig();
		const stdout = capture();
		const exitCode = await runCli(["whoami"], {
			projectRoot,
			env: {},
			stdout,
			stderr: capture(),
			fetch: (async () =>
				Response.json({
					id: "user-id",
					username: "alice",
					first_name: "Alice",
					last_name: "Example",
					nickname: "",
					delete_at: 0,
					is_bot: false,
				})) as unknown as typeof fetch,
		});

		expect(exitCode).toBe(0);
		expect(stdout.text).toBe("Alice Example (@alice) · user-id\n");
		expect(stdout.text).not.toContain("token-from-file");
	});

	test("supports forcing and disabling color for human output", async () => {
		const colored = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "bin.ts"),
				"--color",
				"unknown-command",
			],
			{
				cwd: join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const coloredError = await new Response(colored.stderr).text();
		expect(await colored.exited).toBe(1);
		expect(coloredError).toContain("\u001b[31mError");

		const plain = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "bin.ts"),
				"--no-color",
				"unknown-command",
			],
			{
				cwd: join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const plainError = await new Response(plain.stderr).text();
		expect(await plain.exited).toBe(1);
		expect(plainError).not.toContain("\u001b[");
		expect(plainError).toContain("Error [cli/commander.unknownCommand]");
	});
});

async function projectWithConfig(): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "mattermost-cli-cli-"));
	temporaryDirectories.push(projectRoot);
	await Bun.write(
		join(projectRoot, ".mattermost/config.json"),
		JSON.stringify({
			schemaVersion: 1,
			url: "https://chat.example.test",
			teamId: "team-id",
			token: "token-from-file",
			channels: {
				payments: {
					name: "payments",
					description: "Payments",
				},
			},
			directMessages: {
				alice: {
					channelId: "dm-id",
					description: "Alice",
					participants: ["alice"],
				},
				leadership: {
					channelId: "group-id",
					description: "Leadership",
					participants: ["alice", "bob"],
				},
			},
		}),
	);
	return projectRoot;
}

function capture(): OutputWriter & { text: string } {
	return {
		text: "",
		write(text: string) {
			this.text += text;
		},
	};
}
