import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "./mattermost/schemas.ts";
import { databaseFilePaths, MattermostStore } from "./storage.ts";

const temporaryDirectories: string[] = [];
const conversation = {
	id: "channel-1",
	alias: "payments",
	kind: "channel" as const,
	name: "payments",
	description: "Payments",
};
const user: MattermostUser = {
	id: "user-1",
	username: "alice",
	first_name: "Alice",
	last_name: "Example",
	nickname: "",
	delete_at: 0,
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

describe("MattermostStore", () => {
	test("applies migrations once and survives reopening", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "index.sqlite3");
		const first = await MattermostStore.open(path);
		expect(first.migrationVersions()).toEqual([1, 2]);
		first.close();
		const second = await MattermostStore.open(path);
		expect(second.migrationVersions()).toEqual([1, 2]);
		second.close();
	});

	test("keeps the database and active SQLite sidecars private", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "private.sqlite3");
		const store = await MattermostStore.open(path);
		store.writePage({ conversation, posts: [post()] });
		const modes: number[] = [];
		for (const file of databaseFilePaths(path)) {
			try {
				modes.push((await stat(file)).mode & 0o777);
			} catch {
				// A journal sidecar is optional for an idle WAL database.
			}
		}
		expect(modes.length).toBeGreaterThan(0);
		expect(modes.every((mode) => mode === 0o600)).toBe(true);
		store.close();
	});

	test("migration 2 rebuilds an existing Russian FTS index without changing source text", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "russian-upgrade.sqlite3");
		const before = await MattermostStore.open(path);
		before.writePage({
			conversation,
			posts: [post({ message: "Ошибка ＡＰＩ: платёж подтверждён" })],
		});
		before.database.run("DELETE FROM schema_migrations WHERE version = 2");
		before.database.run("DELETE FROM posts_fts");
		before.database
			.query("INSERT INTO posts_fts (post_id, message) VALUES (?, ?)")
			.run("post-1", "Ошибка ＡＰＩ: платёж подтверждён");
		before.close();

		const after = await MattermostStore.open(path);
		expect(after.migrationVersions()).toEqual([1, 2]);
		expect(
			after.search("ошибка api платеж подтвержден", [conversation.id]),
		).toHaveLength(1);
		expect(after.getPost("post-1")?.message).toBe(
			"Ошибка ＡＰＩ: платёж подтверждён",
		);
		after.close();
	});

	test("reports corrupt disposable indexes with guided rebuild metadata", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "corrupt.sqlite3");
		await Bun.write(path, "not a sqlite database");
		await expect(MattermostStore.open(path)).rejects.toMatchObject({
			source: "database",
			kind: "database_open_failed",
			details: {
				recommendedAction: "remove the disposable database and run mm sync",
			},
		});
	});

	test("detects a missing FTS index during integrity verification", async () => {
		const store = await MattermostStore.open(":memory:");
		store.database.run("DROP TABLE posts_fts");
		expect(() => store.verifyIntegrity()).toThrow();
		store.close();
	});

	test("atomically indexes inserts, edits, deletions, replies, files, and tickets", async () => {
		const store = await MattermostStore.open(":memory:");
		const root = post({
			id: "post-1",
			message: "Investigate PROJ-1777 payment timeout",
			file_ids: ["file-1"],
		});
		const reply = post({
			id: "post-2",
			root_id: "post-1",
			message: "timeout reproduced",
			create_at: 2,
		});
		store.writePage({
			conversation,
			users: [user],
			files: [fileInfo()],
			posts: [root, reply],
		});

		expect(store.search("payment timeout", [conversation.id])).toHaveLength(1);
		expect(store.getThread("post-1").map(({ id }) => id)).toEqual([
			"post-1",
			"post-2",
		]);
		expect(
			store.database
				.query("SELECT file_id FROM post_files WHERE post_id = ?")
				.get("post-1"),
		).toEqual({ file_id: "file-1" });
		expect(
			store.database
				.query("SELECT ticket_key, origin FROM ticket_threads")
				.get(),
		).toEqual({ ticket_key: "PROJ-1777", origin: "discovered" });

		store.writePage({
			conversation,
			posts: [{ ...root, update_at: 3, message: "resolved billing issue" }],
		});
		expect(store.search("timeout", [conversation.id])).toHaveLength(1);
		expect(store.search("billing", [conversation.id])).toHaveLength(1);
		store.writePage({
			conversation,
			posts: [{ ...root, update_at: 4, delete_at: 4 }],
		});
		expect(store.getPost("post-1")?.message).toBe("");
		expect(store.search("billing", [conversation.id])).toEqual([]);
		store.close();
	});

	test("rolls back a page and checkpoint together on failure", async () => {
		const store = await MattermostStore.open(":memory:");
		expect(() =>
			store.writePage({
				conversation,
				posts: [post({ file_ids: ["missing-file"] })],
				checkpoint: {
					conversationId: conversation.id,
					newestPostId: "post-1",
					newestPostAt: 1,
					oldestCoveredAt: 1,
					lastSuccessAt: 10,
					coverageComplete: false,
				},
			}),
		).toThrow();
		expect(store.getCheckpoint(conversation.id)).toBeNull();
		expect(store.getPost("post-1")).toBeNull();
		store.close();
	});

	test("normalizes Russian ё/е for search while preserving exact messages", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation,
			posts: [post({ message: "Платёж не прошёл, повторите ещё раз" })],
		});
		expect(store.search("платеж прошел", [conversation.id])).toHaveLength(1);
		expect(store.search("ПЛАТЁЖ", [conversation.id])).toHaveLength(1);
		expect(store.getPost("post-1")?.message).toBe(
			"Платёж не прошёл, повторите ещё раз",
		);
		store.close();
	});

	test("escapes FTS probes and scopes every search to conversations", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation,
			posts: [post({ message: 'payment OR "secret"' })],
		});
		expect(store.search('payment OR "secret"', [conversation.id])).toHaveLength(
			1,
		);
		expect(store.search("payment", ["other-channel"])).toEqual([]);
		store.close();
	});
});

function post(overrides: Partial<MattermostPost> = {}): MattermostPost {
	return {
		id: "post-1",
		create_at: 1,
		update_at: 1,
		delete_at: 0,
		user_id: "user-1",
		channel_id: conversation.id,
		root_id: "",
		message: "message",
		type: "",
		props: {},
		file_ids: [],
		...overrides,
	};
}

function fileInfo(): MattermostFileInfo {
	return {
		id: "file-1",
		user_id: "user-1",
		post_id: "post-1",
		create_at: 1,
		update_at: 1,
		delete_at: 0,
		name: "evidence.txt",
		extension: "txt",
		size: 10,
		mime_type: "text/plain",
	};
}

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mattermost-store-"));
	temporaryDirectories.push(path);
	return path;
}
