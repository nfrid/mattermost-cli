import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { DatabaseError } from "./errors.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "./mattermost/schemas.ts";
import { normalizeSearchText } from "./text.ts";

export type ConversationKind = "channel" | "direct_message";

export interface ConversationRecord {
	id: string;
	alias: string;
	kind: ConversationKind;
	name: string;
	description: string;
}

export interface SyncCheckpoint {
	conversationId: string;
	newestPostId: string | null;
	newestPostAt: number | null;
	oldestCoveredAt: number | null;
	lastSuccessAt: number | null;
	coverageComplete: boolean;
}

export interface PageWrite {
	conversation: ConversationRecord;
	posts: readonly MattermostPost[];
	users?: readonly MattermostUser[];
	files?: readonly MattermostFileInfo[];
	checkpoint?: SyncCheckpoint;
}

export interface IndexedPost {
	id: string;
	rootId: string;
	threadId: string;
	conversationId: string;
	userId: string;
	createAt: number;
	updateAt: number;
	deleteAt: number;
	message: string;
	props: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface IndexedUser {
	id: string;
	username: string;
	firstName: string;
	lastName: string;
	nickname: string;
	deleteAt: number;
}

export interface IndexedFile {
	id: string;
	postId: string;
	name: string;
	extension: string;
	size: number;
	mimeType: string;
	deleteAt: number;
}

export interface TicketThreadRelationship {
	ticketKey: string;
	threadId: string;
	sourcePostId: string;
	origin: "discovered" | "explicit";
}

const migrations = [
	{
		version: 1,
		sql: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'direct_message')),
  name TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  delete_at INTEGER NOT NULL
);
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  create_at INTEGER NOT NULL,
  update_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  props_json TEXT NOT NULL,
  metadata_json TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX posts_conversation_chronology ON posts(conversation_id, create_at DESC, id);
CREATE INDEX posts_thread_chronology ON posts(thread_id, create_at, id);
CREATE INDEX posts_updates ON posts(conversation_id, update_at DESC);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  create_at INTEGER NOT NULL,
  update_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL
);
CREATE TABLE post_files (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, file_id)
);
CREATE TABLE conversation_sync_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  newest_post_id TEXT,
  newest_post_at INTEGER,
  oldest_covered_at INTEGER,
  last_success_at INTEGER,
  coverage_complete INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ticket_threads (
  ticket_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_post_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('discovered', 'explicit')),
  PRIMARY KEY (ticket_key, thread_id, source_post_id, origin)
);
CREATE INDEX ticket_threads_thread ON ticket_threads(thread_id);
CREATE VIRTUAL TABLE posts_fts USING fts5(post_id UNINDEXED, message, tokenize='unicode61');
`,
	},
	{
		version: 2,
		sql: "DELETE FROM posts_fts;",
		rebuildFts: true,
	},
] as const;

export class MattermostStore {
	readonly database: Database;

	static async open(path: string): Promise<MattermostStore> {
		let database: Database | undefined;
		try {
			if (path !== ":memory:") {
				const directory = dirname(path);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				if (basename(directory) === ".mattermost") {
					await chmod(directory, 0o700);
				}
			}
			database = new Database(path, { create: true });
			const store = new MattermostStore(database);
			if (path !== ":memory:") secureDatabaseFiles(path);
			return store;
		} catch (error) {
			try {
				database?.close();
			} catch {
				// Preserve the original open or migration failure.
			}
			throw new DatabaseError(
				"The local Mattermost index could not be opened or migrated.",
				"database_open_failed",
				{ cause: error },
			);
		}
	}

	constructor(database: Database) {
		this.database = database;
		this.database.run("PRAGMA foreign_keys = ON");
		this.database.run("PRAGMA journal_mode = WAL");
		this.migrate();
	}

	close(): void {
		this.database.close();
	}

	migrationVersions(): number[] {
		return this.database
			.query<{ version: number }, []>(
				"SELECT version FROM schema_migrations ORDER BY version",
			)
			.all()
			.map(({ version }) => version);
	}

	verifyIntegrity(): void {
		const result = this.database
			.query<{ quick_check: string }, []>("PRAGMA quick_check")
			.get();
		if (result?.quick_check !== "ok") {
			throw new DatabaseError(
				"The local Mattermost index failed SQLite integrity checks.",
				"database_corrupt",
			);
		}
		this.database.query("SELECT count(*) FROM posts_fts").get();
	}

	finalizeFullSync(
		conversation: ConversationRecord,
		retainedPostIds: readonly string[],
		checkpoint: SyncCheckpoint,
	): void {
		this.database.run(
			"CREATE TEMP TABLE IF NOT EXISTS full_sync_retained_posts (post_id TEXT PRIMARY KEY)",
		);
		this.database.run("DELETE FROM full_sync_retained_posts");
		const retain = this.database.query(
			"INSERT OR IGNORE INTO full_sync_retained_posts (post_id) VALUES (?)",
		);
		for (const postId of retainedPostIds) retain.run(postId);
		this.transaction(() => {
			this.upsertConversation(conversation);
			const stalePosts =
				"SELECT id FROM posts WHERE conversation_id = ? AND id NOT IN (SELECT post_id FROM full_sync_retained_posts)";
			this.database
				.query(`DELETE FROM posts_fts WHERE post_id IN (${stalePosts})`)
				.run(conversation.id);
			this.database
				.query(
					`DELETE FROM ticket_threads WHERE origin = 'discovered' AND source_post_id IN (${stalePosts})`,
				)
				.run(conversation.id);
			this.database
				.query(`DELETE FROM files WHERE post_id IN (${stalePosts})`)
				.run(conversation.id);
			this.database
				.query(`DELETE FROM posts WHERE id IN (${stalePosts})`)
				.run(conversation.id);
			this.writeCheckpoint(checkpoint);
		});
		this.database.run("DELETE FROM full_sync_retained_posts");
	}

	writePage(page: PageWrite): void {
		this.transaction(() => {
			this.upsertConversation(page.conversation);
			for (const user of page.users ?? []) this.upsertUser(user);
			for (const file of page.files ?? []) this.upsertFile(file);
			for (const post of page.posts) this.upsertPost(post);
			if (page.checkpoint) this.writeCheckpoint(page.checkpoint);
		});
	}

	upsertConversation(conversation: ConversationRecord): void {
		this.database
			.query(`
INSERT INTO conversations (id, alias, kind, name, description)
VALUES ($id, $alias, $kind, $name, $description)
ON CONFLICT(id) DO UPDATE SET alias=excluded.alias, kind=excluded.kind,
  name=excluded.name, description=excluded.description`)
			.run({
				$id: conversation.id,
				$alias: conversation.alias,
				$kind: conversation.kind,
				$name: conversation.name,
				$description: conversation.description,
			});
	}

	upsertUser(user: MattermostUser): void {
		this.database
			.query(`
INSERT INTO users (id, username, first_name, last_name, nickname, delete_at)
VALUES ($id, $username, $firstName, $lastName, $nickname, $deleteAt)
ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name,
  last_name=excluded.last_name, nickname=excluded.nickname, delete_at=excluded.delete_at`)
			.run({
				$id: user.id,
				$username: user.username,
				$firstName: user.first_name,
				$lastName: user.last_name,
				$nickname: user.nickname,
				$deleteAt: user.delete_at,
			});
	}

	upsertPost(post: MattermostPost): void {
		const existing = this.database
			.query<{ update_at: number; delete_at: number }, [string]>(
				"SELECT update_at, delete_at FROM posts WHERE id = ?",
			)
			.get(post.id);
		const incomingVersion = Math.max(post.update_at, post.delete_at);
		const existingVersion = existing
			? Math.max(existing.update_at, existing.delete_at)
			: -1;
		if (existingVersion > incomingVersion) return;

		const threadId = post.root_id || post.id;
		this.database
			.query(`
INSERT INTO posts (id, root_id, thread_id, conversation_id, user_id, create_at,
  update_at, delete_at, message, props_json, metadata_json, indexed_at)
VALUES ($id, $rootId, $threadId, $conversationId, $userId, $createAt,
  $updateAt, $deleteAt, $message, $props, $metadata, $indexedAt)
ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id, thread_id=excluded.thread_id,
  conversation_id=excluded.conversation_id, user_id=excluded.user_id,
  create_at=excluded.create_at, update_at=excluded.update_at,
  delete_at=excluded.delete_at, message=excluded.message,
  props_json=excluded.props_json, metadata_json=excluded.metadata_json,
  indexed_at=excluded.indexed_at`)
			.run({
				$id: post.id,
				$rootId: post.root_id,
				$threadId: threadId,
				$conversationId: post.channel_id,
				$userId: post.user_id,
				$createAt: post.create_at,
				$updateAt: post.update_at,
				$deleteAt: post.delete_at,
				$message: post.delete_at ? "" : post.message,
				$props: JSON.stringify(post.props),
				$metadata: post.metadata ? JSON.stringify(post.metadata) : null,
				$indexedAt: Date.now(),
			});
		this.database.query("DELETE FROM posts_fts WHERE post_id = ?").run(post.id);
		this.database
			.query("DELETE FROM post_files WHERE post_id = ?")
			.run(post.id);
		if (!post.delete_at && post.message) {
			this.database
				.query("INSERT INTO posts_fts (post_id, message) VALUES (?, ?)")
				.run(post.id, normalizeSearchText(post.message));
		}
		for (const fileId of post.file_ids) {
			this.database
				.query(
					"INSERT OR IGNORE INTO post_files (post_id, file_id) VALUES (?, ?)",
				)
				.run(post.id, fileId);
		}
		this.database
			.query(
				"DELETE FROM ticket_threads WHERE source_post_id = ? AND origin = 'discovered'",
			)
			.run(post.id);
		if (!post.delete_at) {
			for (const key of discoveredTicketKeys(post.message)) {
				this.database
					.query(
						"INSERT OR IGNORE INTO ticket_threads (ticket_key, thread_id, source_post_id, origin) VALUES (?, ?, ?, 'discovered')",
					)
					.run(key, threadId, post.id);
			}
		}
	}

	applyTombstone(post: MattermostPost): void {
		if (!post.delete_at) {
			throw new Error("A tombstone must have a non-zero delete_at timestamp.");
		}
		this.upsertPost(post);
	}

	linkTicketThread(
		ticketKey: string,
		threadId: string,
		sourcePostId: string,
		origin: "discovered" | "explicit",
	): void {
		this.database
			.query(
				"INSERT OR IGNORE INTO ticket_threads (ticket_key, thread_id, source_post_id, origin) VALUES (?, ?, ?, ?)",
			)
			.run(ticketKey, threadId, sourcePostId, origin);
	}

	upsertFile(file: MattermostFileInfo): void {
		this.database
			.query(`
INSERT INTO files (id, user_id, post_id, create_at, update_at, delete_at,
  name, extension, size, mime_type)
VALUES ($id, $userId, $postId, $createAt, $updateAt, $deleteAt,
  $name, $extension, $size, $mimeType)
ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, post_id=excluded.post_id,
  create_at=excluded.create_at, update_at=excluded.update_at,
  delete_at=excluded.delete_at, name=excluded.name, extension=excluded.extension,
  size=excluded.size, mime_type=excluded.mime_type`)
			.run({
				$id: file.id,
				$userId: file.user_id,
				$postId: file.post_id,
				$createAt: file.create_at,
				$updateAt: file.update_at,
				$deleteAt: file.delete_at,
				$name: file.name,
				$extension: file.extension,
				$size: file.size,
				$mimeType: file.mime_type,
			});
	}

	getCheckpoint(conversationId: string): SyncCheckpoint | null {
		const row = this.database
			.query<
				{
					conversation_id: string;
					newest_post_id: string | null;
					newest_post_at: number | null;
					oldest_covered_at: number | null;
					last_success_at: number | null;
					coverage_complete: number;
				},
				[string]
			>("SELECT * FROM conversation_sync_state WHERE conversation_id = ?")
			.get(conversationId);
		return row
			? {
					conversationId: row.conversation_id,
					newestPostId: row.newest_post_id,
					newestPostAt: row.newest_post_at,
					oldestCoveredAt: row.oldest_covered_at,
					lastSuccessAt: row.last_success_at,
					coverageComplete: Boolean(row.coverage_complete),
				}
			: null;
	}

	writeCheckpoint(checkpoint: SyncCheckpoint): void {
		this.database
			.query(`
INSERT INTO conversation_sync_state (conversation_id, newest_post_id, newest_post_at,
  oldest_covered_at, last_success_at, coverage_complete)
VALUES ($conversationId, $newestPostId, $newestPostAt, $oldestCoveredAt,
  $lastSuccessAt, $coverageComplete)
ON CONFLICT(conversation_id) DO UPDATE SET newest_post_id=excluded.newest_post_id,
  newest_post_at=excluded.newest_post_at, oldest_covered_at=excluded.oldest_covered_at,
  last_success_at=excluded.last_success_at, coverage_complete=excluded.coverage_complete`)
			.run({
				$conversationId: checkpoint.conversationId,
				$newestPostId: checkpoint.newestPostId,
				$newestPostAt: checkpoint.newestPostAt,
				$oldestCoveredAt: checkpoint.oldestCoveredAt,
				$lastSuccessAt: checkpoint.lastSuccessAt,
				$coverageComplete: checkpoint.coverageComplete ? 1 : 0,
			});
	}

	getThread(threadId: string): IndexedPost[] {
		return this.database
			.query<Record<string, unknown>, [string]>(
				"SELECT * FROM posts WHERE thread_id = ? ORDER BY create_at, id",
			)
			.all(threadId)
			.map(rowToPost);
	}

	getPost(postId: string): IndexedPost | null {
		const row = this.database
			.query<Record<string, unknown>, [string]>(
				"SELECT * FROM posts WHERE id = ?",
			)
			.get(postId);
		return row ? rowToPost(row) : null;
	}

	getRoot(postId: string): IndexedPost | null {
		const post = this.getPost(postId);
		return post ? this.getPost(post.rootId || post.id) : null;
	}

	listConversations(): ConversationRecord[] {
		return this.database
			.query<
				{
					id: string;
					alias: string;
					kind: ConversationKind;
					name: string;
					description: string;
				},
				[]
			>(
				"SELECT id, alias, kind, name, description FROM conversations ORDER BY alias",
			)
			.all();
	}

	getConversationByAlias(alias: string): ConversationRecord | null {
		return (
			this.database
				.query<
					{
						id: string;
						alias: string;
						kind: ConversationKind;
						name: string;
						description: string;
					},
					[string]
				>(
					"SELECT id, alias, kind, name, description FROM conversations WHERE alias = ?",
				)
				.get(alias) ?? null
		);
	}

	getUsers(userIds: readonly string[]): IndexedUser[] {
		if (!userIds.length) return [];
		const placeholders = userIds.map(() => "?").join(", ");
		return this.database
			.query<Record<string, unknown>, string[]>(
				`SELECT * FROM users WHERE id IN (${placeholders})`,
			)
			.all(...userIds)
			.map((row) => ({
				id: String(row.id),
				username: String(row.username),
				firstName: String(row.first_name),
				lastName: String(row.last_name),
				nickname: String(row.nickname),
				deleteAt: Number(row.delete_at),
			}));
	}

	getFilesForPosts(postIds: readonly string[]): IndexedFile[] {
		if (!postIds.length) return [];
		const placeholders = postIds.map(() => "?").join(", ");
		return this.database
			.query<Record<string, unknown>, string[]>(`
SELECT f.* FROM files f JOIN post_files pf ON pf.file_id = f.id
WHERE pf.post_id IN (${placeholders}) ORDER BY f.post_id, f.id`)
			.all(...postIds)
			.map((row) => ({
				id: String(row.id),
				postId: String(row.post_id),
				name: String(row.name),
				extension: String(row.extension),
				size: Number(row.size),
				mimeType: String(row.mime_type),
				deleteAt: Number(row.delete_at),
			}));
	}

	getTicketRelationships(ticketKey?: string): TicketThreadRelationship[] {
		const rows = ticketKey
			? this.database
					.query<Record<string, unknown>, [string]>(
						"SELECT * FROM ticket_threads WHERE ticket_key = ? ORDER BY thread_id, origin",
					)
					.all(ticketKey)
			: this.database
					.query<Record<string, unknown>, []>(
						"SELECT * FROM ticket_threads ORDER BY ticket_key, thread_id, origin",
					)
					.all();
		return rows.map((row) => ({
			ticketKey: String(row.ticket_key),
			threadId: String(row.thread_id),
			sourcePostId: String(row.source_post_id),
			origin: String(row.origin) as "discovered" | "explicit",
		}));
	}

	getConversationIdsForTicket(ticketKey: string): string[] {
		return this.database
			.query<{ conversation_id: string }, [string]>(`
SELECT DISTINCT p.conversation_id FROM ticket_threads t
JOIN posts p ON p.thread_id = t.thread_id
WHERE t.ticket_key = ? ORDER BY p.conversation_id`)
			.all(ticketKey)
			.map(({ conversation_id }) => conversation_id);
	}

	search(
		probe: string,
		conversationIds: readonly string[],
		limit = 50,
	): IndexedPost[] {
		const match = buildFtsProbe(probe);
		if (!match || conversationIds.length === 0) return [];
		const placeholders = conversationIds.map(() => "?").join(", ");
		return this.database
			.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.* FROM posts_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_fts MATCH ? AND p.conversation_id IN (${placeholders})
ORDER BY bm25(posts_fts), p.create_at DESC LIMIT ?`)
			.all(match, ...conversationIds, limit)
			.map(rowToPost);
	}

	private migrate(): void {
		this.database.run(
			"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
		);
		const applied = new Set(this.migrationVersions());
		for (const migration of migrations) {
			if (applied.has(migration.version)) continue;
			this.transaction(() => {
				this.database.run(migration.sql);
				if ("rebuildFts" in migration && migration.rebuildFts) {
					const posts = this.database
						.query<{ id: string; message: string }, []>(
							"SELECT id, message FROM posts WHERE delete_at = 0 AND message <> '' ORDER BY id",
						)
						.all();
					const insert = this.database.query(
						"INSERT INTO posts_fts (post_id, message) VALUES (?, ?)",
					);
					for (const post of posts) {
						insert.run(post.id, normalizeSearchText(post.message));
					}
				}
				this.database
					.query(
						"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
					)
					.run(migration.version, Date.now());
			});
		}
	}

	private transaction(action: () => void): void {
		this.database.run("BEGIN IMMEDIATE");
		try {
			action();
			this.database.run("COMMIT");
		} catch (error) {
			this.database.run("ROLLBACK");
			throw error;
		}
	}
}

export function databaseFilePaths(path: string): string[] {
	return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function secureDatabaseFiles(path: string): void {
	for (const file of databaseFilePaths(path)) {
		if (existsSync(file)) chmodSync(file, 0o600);
	}
}

export function buildFtsProbe(value: string): string | null {
	const terms = normalizeSearchText(value).match(/[\p{L}\p{N}_-]+/gu);
	if (!terms?.length) return null;
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function discoveredTicketKeys(message: string): string[] {
	return [...new Set(message.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
}

function rowToPost(row: Record<string, unknown>): IndexedPost {
	return {
		id: String(row.id),
		rootId: String(row.root_id),
		threadId: String(row.thread_id),
		conversationId: String(row.conversation_id),
		userId: String(row.user_id),
		createAt: Number(row.create_at),
		updateAt: Number(row.update_at),
		deleteAt: Number(row.delete_at),
		message: String(row.message),
		props: JSON.parse(String(row.props_json)),
		metadata: row.metadata_json
			? JSON.parse(String(row.metadata_json))
			: undefined,
	};
}
