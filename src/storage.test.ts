import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "./mattermost/schemas.ts";
import { conceptToken } from "./search-concepts.ts";
import {
	databaseFilePaths,
	MattermostStore,
	trigramSearchPolicy,
} from "./storage.ts";

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
		expect(first.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);
		first.close();
		const second = await MattermostStore.open(path);
		expect(second.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);
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
		expect(after.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);
		expect(
			after.search("ошибка api платеж подтвержден", [conversation.id]),
		).toHaveLength(1);
		expect(after.getPost("post-1")?.message).toBe(
			"Ошибка ＡＰＩ: платёж подтверждён",
		);
		after.close();
	});

	test("migration 3 backfills structured entities and attachment filenames", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "entity-upgrade.sqlite3");
		const before = await MattermostStore.open(path);
		before.writePage({
			conversation,
			files: [
				{
					...fileInfo(),
					name: "migration-trace.json",
				},
			],
			posts: [
				post({
					message: "Исправление в src/jobs/migrate.ts",
					file_ids: ["file-1"],
				}),
			],
		});
		before.database.run("DELETE FROM schema_migrations WHERE version = 3");
		before.database.run("DROP TABLE post_entities");
		before.close();

		const after = await MattermostStore.open(path);
		expect(after.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);
		expect(after.listEntities("post-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "file_path",
					value: "src/jobs/migrate.ts",
				}),
				expect.objectContaining({
					kind: "attachment_filename",
					value: "migration-trace.json",
				}),
			]),
		);
		after.close();
	});

	test("migration 5 builds a separate Russian morphology index", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "morph-upgrade.sqlite3");
		const before = await MattermostStore.open(path);
		before.writePage({
			conversation,
			posts: [post({ message: "Разобрались с зависшими платежами" })],
		});
		before.database.run("DELETE FROM schema_migrations WHERE version = 5");
		before.database.run("DROP TABLE posts_morph_fts");
		before.close();

		const after = await MattermostStore.open(path);
		expect(after.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);
		expect(
			after.search("зависш платеж", [conversation.id], 10, {
				source: "morph_fts",
			}),
		).toHaveLength(1);
		expect(after.getPost("post-1")?.message).toBe(
			"Разобрались с зависшими платежами",
		);
		after.close();
	});

	test("migration 6 backfills concepts and rebuilds them when config changes", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "concept-upgrade.sqlite3");
		const before = await MattermostStore.open(path);
		before.writePage({
			conversation,
			posts: [
				post({ message: "После ретрая получили повторное списание" }),
				post({ id: "post-2", message: "Investigating a duplicate charge" }),
			],
		});
		before.database.run("DELETE FROM schema_migrations WHERE version = 6");
		before.database.run("DROP TABLE posts_concept_fts");
		before.database.run("DROP TABLE search_index_config");
		before.close();

		const concepts = {
			"duplicate-charge": ["повторное списание", "списали дважды"],
		};
		const after = await MattermostStore.open(path, { concepts });
		expect(after.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);
		expect(
			after.search(conceptToken("duplicate-charge"), [conversation.id], 10, {
				source: "concept_fts",
			}),
		).toHaveLength(1);
		after.close();

		const changed = await MattermostStore.open(path, {
			concepts: {
				"duplicate-charge": ["списали дважды", "duplicate charge"],
			},
		});
		expect(
			changed
				.search(conceptToken("duplicate-charge"), [conversation.id], 10, {
					source: "concept_fts",
				})
				.map(({ post }) => post.id),
		).toEqual(["post-2"]);
		changed.close();
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

	test("detects a missing morphology index during integrity verification", async () => {
		const store = await MattermostStore.open(":memory:");
		store.database.run("DROP TABLE posts_morph_fts");
		expect(() => store.verifyIntegrity()).toThrow();
		store.close();
	});

	test("detects a missing concept index during integrity verification", async () => {
		const store = await MattermostStore.open(":memory:");
		store.database.run("DROP TABLE posts_concept_fts");
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

	test("matches exact stem tokens without prefix false positives", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation,
			posts: [
				post({
					id: "relevant",
					message: "Зависшими платежами занялась команда",
				}),
				post({
					id: "noise",
					message: "Зависимость платёжного календаря от праздников",
				}),
			],
		});
		const hits = store.search("зависш платеж", [conversation.id], 10, {
			source: "morph_fts",
		});
		expect(hits.map(({ post }) => post.id)).toEqual(["relevant"]);
		expect(hits[0]).toMatchObject({
			source: "morph_fts",
			sourceQuery: "зависш платеж",
		});
		store.writePage({
			conversation,
			posts: [
				post({
					id: "relevant",
					update_at: 2,
					message: "Команда закрыла обычную задачу",
				}),
			],
		});
		expect(
			store.search("зависш платеж", [conversation.id], 10, {
				source: "morph_fts",
			}),
		).toEqual([]);
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

	test("returns ranked lexical evidence and match-centered snippets", async () => {
		const store = await MattermostStore.open(":memory:");
		const longPrefix = Array.from(
			{ length: 40 },
			(_, index) => `prefix${index}`,
		).join(" ");
		store.writePage({
			conversation,
			posts: [
				post({
					id: "post-long",
					message: `${longPrefix} distinctive needle appears near the end`,
				}),
				post({
					id: "post-short",
					create_at: 2,
					update_at: 2,
					message: "needle",
				}),
			],
		});
		const hits = store.search("needle", [conversation.id]);
		expect(hits).toHaveLength(2);
		expect(hits.map(({ rank }) => rank)).toEqual([1, 2]);
		expect(hits.every(({ bm25 }) => Number.isFinite(bm25))).toBe(true);
		expect(hits.every(({ source }) => source === "strict_fts")).toBe(true);
		const longHit = hits.find(
			({ post: indexedPost }) => indexedPost.id === "post-long",
		);
		expect(longHit?.snippet).toContain("needle");
		expect(longHit?.snippet).toStartWith("…");
		expect(longHit?.snippet).not.toContain("prefix0 ");
		store.close();
	});

	test("indexes structured entities, attachment names, and thread filters", async () => {
		const store = await MattermostStore.open(":memory:");
		const root = post({
			id: "entity-root",
			create_at: 10,
			update_at: 10,
			message:
				"В repo payment-api файл src/jobs/dispatch.ts вызывает scheduleRetry() для E_QUEUE_42",
			file_ids: ["entity-file"],
		});
		const reply = post({
			id: "entity-reply",
			root_id: root.id,
			user_id: "user-2",
			create_at: 20,
			update_at: 20,
			message: "Проверила результат после деплоя",
		});
		store.writePage({
			conversation,
			users: [user, { ...user, id: "user-2", username: "bob" }],
			files: [
				{
					...fileInfo(),
					id: "entity-file",
					post_id: root.id,
					name: "trace.json",
				},
			],
			posts: [root, reply],
		});
		expect(store.listEntities(root.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "repository", value: "payment-api" }),
				expect.objectContaining({
					kind: "file_path",
					value: "src/jobs/dispatch.ts",
				}),
				expect.objectContaining({
					kind: "attachment_filename",
					value: "trace.json",
				}),
			]),
		);
		expect(
			store.searchEntities("src/jobs/dispatch.ts", [conversation.id]),
		).toEqual([
			expect.objectContaining({ threadId: root.id, kind: "file_path" }),
		]);
		expect(
			store.searchEntities("src/jobs/dispatch.ts", ["other-channel"]),
		).toEqual([]);
		expect(store.searchEntities("trace.json", [conversation.id])).toEqual([
			expect.objectContaining({
				threadId: root.id,
				kind: "attachment_filename",
			}),
		]);
		expect(
			store.searchEntities("alice", [conversation.id], 100, {}, "username"),
		).toHaveLength(1);
		store.upsertUser({ ...user, username: "alice-renamed" });
		expect(
			store.searchEntities("alice", [conversation.id], 100, {}, "username"),
		).toEqual([]);
		expect(
			store.searchEntities(
				"alice-renamed",
				[conversation.id],
				100,
				{},
				"username",
			),
		).toHaveLength(1);
		expect(store.threadMatchesFilters(root.id, { username: "bob" })).toBe(true);
		expect(store.threadMatchesFilters(root.id, { after: 15, before: 25 })).toBe(
			true,
		);
		expect(store.threadMatchesFilters(root.id, { after: 25 })).toBe(false);
		expect(store.threadMatchesFilters(root.id, { hasFile: true })).toBe(true);
		expect(store.threadMatchesFilters(root.id, { filePattern: "TRACE" })).toBe(
			true,
		);
		expect(
			store.threadMatchesFilters(root.id, { filePattern: "missing" }),
		).toBe(false);
		store.upsertFile({
			...fileInfo(),
			id: "entity-file",
			post_id: root.id,
			name: "trace.json",
			update_at: 25,
			delete_at: 25,
		});
		expect(store.searchEntities("trace.json", [conversation.id])).toEqual([]);
		store.writePage({
			conversation,
			posts: [{ ...root, update_at: 30, message: "resolved", file_ids: [] }],
		});
		expect(
			store.listEntities(root.id).filter(({ kind }) => kind !== "username"),
		).toEqual([]);
		store.close();
	});

	test("uses length- and script-aware bounded trigram policies", () => {
		expect(trigramSearchPolicy("плт")).toBeNull();
		expect(trigramSearchPolicy("платж")).toEqual({
			minimumSimilarity: 0.5,
			maximumEditDistance: 1,
		});
		expect(trigramSearchPolicy("реплкация")).toEqual({
			minimumSimilarity: 0.5,
			maximumEditDistance: 1,
		});
		expect(trigramSearchPolicy("retry")).toEqual({
			minimumSimilarity: 0.5,
			maximumEditDistance: 3,
		});
		expect(trigramSearchPolicy("scheduelRetry")).toEqual({
			minimumSimilarity: 0.6,
			maximumEditDistance: 2,
		});
		expect(trigramSearchPolicy("x".repeat(65))).toBeNull();
	});

	test("executes exact phrase, broad, and prefix searches independently", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation,
			posts: [
				post({ id: "post-exact", message: "payment timeout" }),
				post({
					id: "post-separated",
					create_at: 2,
					update_at: 2,
					message: "payment severe timeout",
				}),
			],
		});
		expect(
			store
				.search("payment timeout", [conversation.id], 10, {
					source: "exact_phrase",
				})
				.map(({ post: indexedPost }) => indexedPost.id),
		).toEqual(["post-exact"]);
		expect(
			store.search("payment timeout", [conversation.id], 10, {
				source: "broad_fts",
			}),
		).toHaveLength(2);
		const prefixes = store.search("paym", [conversation.id], 10, {
			source: "prefix_fts",
		});
		expect(prefixes).toHaveLength(2);
		expect(prefixes[0]).toMatchObject({
			source: "prefix_fts",
			sourceQuery: "paym",
			rank: 1,
		});
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
