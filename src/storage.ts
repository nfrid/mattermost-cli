import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { SearchConcepts } from "./config.ts";
import {
	type EngineeringEntity,
	type EngineeringEntityKind,
	extractEngineeringEntities,
} from "./entities.ts";
import { DatabaseError } from "./errors.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "./mattermost/schemas.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./runtime-limits.ts";
import {
	conceptIndexFingerprint,
	conceptTokensForText,
} from "./search-concepts.ts";
import { normalizeMorphText } from "./search-token-normalization.ts";
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
	isBot: boolean;
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

export type LexicalRetrievalSource =
	| "exact_phrase"
	| "strict_fts"
	| "broad_fts"
	| "term_fts"
	| "morph_fts"
	| "concept_fts"
	| "prefix_fts"
	| "trigram";

export interface LexicalHit {
	post: IndexedPost;
	source: LexicalRetrievalSource;
	sourceQuery: string;
	rank: number;
	bm25: number;
	snippet: string;
}

export interface LexicalSearchOptions {
	source?: LexicalRetrievalSource;
	filters?: ThreadSearchFilters;
}

export interface TrigramSearchPolicy {
	minimumSimilarity: number;
	maximumEditDistance: number;
}

export interface StructuredEntityRecord extends EngineeringEntity {
	postId: string;
	threadId: string;
	conversationId: string;
}

export interface StructuredEntityHit extends StructuredEntityRecord {
	query: string;
}

export interface ThreadSearchFilters {
	username?: string;
	after?: number;
	before?: number;
	hasFile?: boolean;
	filePattern?: string;
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
	{
		version: 3,
		sql: `
CREATE TABLE post_entities (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  PRIMARY KEY (post_id, kind, normalized_value)
);
CREATE INDEX post_entities_lookup ON post_entities(kind, normalized_value, conversation_id);
CREATE INDEX post_entities_thread ON post_entities(thread_id);
`,
		rebuildEntities: true,
	},
	{
		version: 4,
		sql: "DELETE FROM post_entities;",
		rebuildEntities: true,
	},
	{
		version: 5,
		sql: `
CREATE VIRTUAL TABLE posts_morph_fts USING fts5(post_id UNINDEXED, morph, tokenize='unicode61');
`,
		rebuildMorphFts: true,
	},
	{
		version: 6,
		sql: `
CREATE VIRTUAL TABLE posts_concept_fts USING fts5(post_id UNINDEXED, concepts, tokenize='unicode61');
CREATE TABLE search_index_config (
  kind TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);
`,
		rebuildConceptFts: true,
	},
	{
		version: 7,
		sql: `
ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
`,
	},
] as const;

export interface MattermostStoreOptions {
	concepts?: SearchConcepts;
}

export class MattermostStore {
	readonly database: Database;
	private readonly concepts: Readonly<SearchConcepts>;

	static async open(
		path: string,
		options: MattermostStoreOptions = {},
	): Promise<MattermostStore> {
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
			const store = new MattermostStore(database, options);
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

	constructor(database: Database, options: MattermostStoreOptions = {}) {
		this.database = database;
		this.concepts = options.concepts ?? {};
		this.database.run("PRAGMA foreign_keys = ON");
		this.database.run("PRAGMA journal_mode = WAL");
		this.database.run("PRAGMA synchronous = NORMAL");
		this.database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
		this.migrate();
		this.synchronizeConceptIndexConfig();
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
		this.database.query("SELECT count(*) FROM posts_morph_fts").get();
		this.database.query("SELECT count(*) FROM posts_concept_fts").get();
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
				.query(`DELETE FROM posts_morph_fts WHERE post_id IN (${stalePosts})`)
				.run(conversation.id);
			this.database
				.query(`DELETE FROM posts_concept_fts WHERE post_id IN (${stalePosts})`)
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
		const existing = this.database
			.query<{ username: string; delete_at: number }, [string]>(
				"SELECT username, delete_at FROM users WHERE id = ?",
			)
			.get(user.id);
		this.database
			.query(`
INSERT INTO users (id, username, first_name, last_name, nickname, delete_at, is_bot)
VALUES ($id, $username, $firstName, $lastName, $nickname, $deleteAt, $isBot)
ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name,
  last_name=excluded.last_name, nickname=excluded.nickname, delete_at=excluded.delete_at,
  is_bot=excluded.is_bot`)
			.run({
				$id: user.id,
				$username: user.username,
				$firstName: user.first_name,
				$lastName: user.last_name,
				$nickname: user.nickname,
				$deleteAt: user.delete_at,
				$isBot: user.is_bot ? 1 : 0,
			});
		if (
			existing &&
			(existing.username !== user.username ||
				existing.delete_at !== user.delete_at)
		) {
			const postIds = this.database
				.query<{ id: string }, [string]>(
					"SELECT id FROM posts WHERE user_id = ? ORDER BY id",
				)
				.all(user.id);
			for (const { id } of postIds) this.reindexStoredPostEntities(id);
		}
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
			.query("DELETE FROM posts_morph_fts WHERE post_id = ?")
			.run(post.id);
		this.database
			.query("DELETE FROM posts_concept_fts WHERE post_id = ?")
			.run(post.id);
		this.database
			.query("DELETE FROM post_entities WHERE post_id = ?")
			.run(post.id);
		this.database
			.query("DELETE FROM post_files WHERE post_id = ?")
			.run(post.id);
		if (!post.delete_at && post.message) {
			this.database
				.query("INSERT INTO posts_fts (post_id, message) VALUES (?, ?)")
				.run(post.id, normalizeSearchText(post.message));
			this.database
				.query("INSERT INTO posts_morph_fts (post_id, morph) VALUES (?, ?)")
				.run(post.id, normalizeMorphText(post.message));
			const conceptTokens = conceptTokensForText(post.message, this.concepts);
			if (conceptTokens.length) {
				this.database
					.query(
						"INSERT INTO posts_concept_fts (post_id, concepts) VALUES (?, ?)",
					)
					.run(post.id, conceptTokens.join(" "));
			}
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
			this.indexPostEntities(post, threadId);
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
		this.reindexStoredPostEntities(file.post_id);
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
			.map(rowToUser);
	}

	getUser(userId: string): IndexedUser | null {
		const row = this.database
			.query<Record<string, unknown>, [string]>(
				"SELECT * FROM users WHERE id = ?",
			)
			.get(userId);
		return row ? rowToUser(row) : null;
	}

	/** Non-deleted reply count for a thread (excludes the root post). */
	threadReplyCount(threadId: string): number {
		const row = this.database
			.query<{ count: number }, [string, string]>(
				`SELECT COUNT(*) AS count FROM posts
WHERE thread_id = ? AND id <> ? AND delete_at = 0`,
			)
			.get(threadId, threadId);
		return row?.count ?? 0;
	}

	/**
	 * Preceding root posts in the same conversation (exclusive of the anchor),
	 * newest-first then reversed to chronological for callers.
	 */
	getPrecedingRootPosts(
		conversationId: string,
		beforeCreateAt: number,
		beforePostId: string,
		limit: number,
	): IndexedPost[] {
		if (limit <= 0) return [];
		const rows = this.database
			.query<Record<string, unknown>, [string, number, number, string, number]>(
				`SELECT * FROM posts
WHERE conversation_id = ?
  AND (root_id = '' OR root_id = id)
  AND delete_at = 0
  AND (create_at < ? OR (create_at = ? AND id < ?))
ORDER BY create_at DESC, id DESC
LIMIT ?`,
			)
			.all(conversationId, beforeCreateAt, beforeCreateAt, beforePostId, limit);
		return rows.map(rowToPost).reverse();
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

	getFileById(
		fileId: string,
	): (IndexedFile & { conversationId: string }) | null {
		const row = this.database
			.query<Record<string, unknown>, [string]>(`
SELECT f.*, p.conversation_id AS conversation_id
FROM files f
JOIN posts p ON p.id = f.post_id
WHERE f.id = ?
LIMIT 1`)
			.get(fileId);
		if (!row) return null;
		return {
			id: String(row.id),
			postId: String(row.post_id),
			name: String(row.name),
			extension: String(row.extension),
			size: Number(row.size),
			mimeType: String(row.mime_type),
			deleteAt: Number(row.delete_at),
			conversationId: String(row.conversation_id),
		};
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

	threadMatchesFilters(
		threadId: string,
		filters: ThreadSearchFilters = {},
	): boolean {
		const postClauses = ["p.thread_id = $threadId", "p.delete_at = 0"];
		const parameters: Record<string, string | number> = {
			$threadId: threadId,
		};
		if (filters.username) {
			postClauses.push("lower(u.username) = lower($username)");
			parameters.$username = filters.username.replace(/^@/, "");
		}
		if (filters.after !== undefined) {
			postClauses.push("p.create_at >= $after");
			parameters.$after = filters.after;
		}
		if (filters.before !== undefined) {
			postClauses.push("p.create_at < $before");
			parameters.$before = filters.before;
		}
		if (
			!this.database
				.query<{ matched: number }, Record<string, string | number>>(`
SELECT 1 AS matched FROM posts p LEFT JOIN users u ON u.id = p.user_id
WHERE ${postClauses.join(" AND ")} LIMIT 1`)
				.get(parameters)
		) {
			return false;
		}
		if (!filters.hasFile && !filters.filePattern) return true;
		const fileClauses = [
			"p.thread_id = $threadId",
			"p.delete_at = 0",
			"f.delete_at = 0",
		];
		if (filters.filePattern) {
			fileClauses.push("instr(lower(f.name), lower($filePattern)) > 0");
			parameters.$filePattern = filters.filePattern;
		}
		return Boolean(
			this.database
				.query<{ matched: number }, Record<string, string | number>>(`
SELECT 1 AS matched FROM posts p
JOIN post_files pf ON pf.post_id = p.id
JOIN files f ON f.id = pf.file_id
WHERE ${fileClauses.join(" AND ")} LIMIT 1`)
				.get(parameters),
		);
	}

	searchEntities(
		probe: string,
		conversationIds: readonly string[],
		limit = 100,
		filters: ThreadSearchFilters = {},
		kindHint?: EngineeringEntityKind,
	): StructuredEntityHit[] {
		if (!conversationIds.length) return [];
		const queryEntities = kindHint
			? [
					{
						kind: kindHint,
						value: probe.trim().replace(/^@/, ""),
						normalizedValue: normalizeSearchText(
							probe.trim().replace(/^@/, ""),
						),
					},
				]
			: extractEngineeringEntities(probe);
		if (!queryEntities.length) return [];
		const conversationPlaceholders = conversationIds.map(() => "?").join(", ");
		const threadFilter = buildThreadFilterSql("pe", filters);
		const hits = new Map<string, StructuredEntityHit>();
		for (const entity of queryEntities) {
			const kinds: EngineeringEntityKind[] =
				entity.kind === "file_path"
					? ["file_path", "attachment_filename"]
					: [entity.kind];
			const kindPlaceholders = kinds.map(() => "?").join(", ");
			const rows = this.database
				.query<Record<string, unknown>, (string | number)[]>(`
SELECT pe.* FROM post_entities pe
WHERE kind IN (${kindPlaceholders}) AND normalized_value = ?
  AND conversation_id IN (${conversationPlaceholders})${threadFilter.clause}
ORDER BY thread_id, post_id, kind LIMIT ?`)
				.all(
					...kinds,
					entity.normalizedValue,
					...conversationIds,
					...threadFilter.parameters,
					limit,
				);
			for (const row of rows) {
				const hit: StructuredEntityHit = {
					postId: String(row.post_id),
					threadId: String(row.thread_id),
					conversationId: String(row.conversation_id),
					kind: String(row.kind) as EngineeringEntityKind,
					value: String(row.value),
					normalizedValue: String(row.normalized_value),
					query: entity.value,
				};
				hits.set(`${hit.postId}\0${hit.kind}\0${hit.normalizedValue}`, hit);
			}
		}
		return [...hits.values()].slice(0, limit);
	}

	listEntities(threadId?: string): StructuredEntityRecord[] {
		const rows = threadId
			? this.database
					.query<Record<string, unknown>, [string]>(
						"SELECT * FROM post_entities WHERE thread_id = ? ORDER BY post_id, kind, normalized_value",
					)
					.all(threadId)
			: this.database
					.query<Record<string, unknown>, []>(
						"SELECT * FROM post_entities ORDER BY thread_id, post_id, kind, normalized_value",
					)
					.all();
		return rows.map((row) => ({
			postId: String(row.post_id),
			threadId: String(row.thread_id),
			conversationId: String(row.conversation_id),
			kind: String(row.kind) as EngineeringEntityKind,
			value: String(row.value),
			normalizedValue: String(row.normalized_value),
		}));
	}

	search(
		probe: string,
		conversationIds: readonly string[],
		limit = 50,
		options: LexicalSearchOptions = {},
	): LexicalHit[] {
		const source = options.source ?? "strict_fts";
		const normalizedProbe = normalizeSearchText(probe).trim();
		const match = buildFtsQuery(probe, source);
		if (!match || conversationIds.length === 0) return [];
		const placeholders = conversationIds.map(() => "?").join(", ");
		const threadFilter = buildThreadFilterSql("p", options.filters ?? {});
		if (source === "trigram") {
			return this.searchTrigrams(
				normalizedProbe,
				conversationIds,
				limit,
				threadFilter,
			);
		}
		const rows =
			source === "morph_fts"
				? this.database
						.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.*, bm25(posts_morph_fts) AS lexical_bm25,
  p.message AS lexical_snippet
FROM posts_morph_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_morph_fts MATCH ? AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY lexical_bm25, p.create_at DESC, p.id LIMIT ?`)
						.all(match, ...conversationIds, ...threadFilter.parameters, limit)
				: source === "concept_fts"
					? this.database
							.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.*, bm25(posts_concept_fts) AS lexical_bm25,
  p.message AS lexical_snippet
FROM posts_concept_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_concept_fts MATCH ? AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY lexical_bm25, p.create_at DESC, p.id LIMIT ?`)
							.all(match, ...conversationIds, ...threadFilter.parameters, limit)
					: this.database
							.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.*, bm25(posts_fts) AS lexical_bm25,
  snippet(posts_fts, 1, '', '', ' … ', 24) AS lexical_snippet
FROM posts_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_fts MATCH ? AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY lexical_bm25, p.create_at DESC, p.id LIMIT ?`)
							.all(
								match,
								...conversationIds,
								...threadFilter.parameters,
								limit,
							);
		return rows.map((row, index) => ({
			post: rowToPost(row),
			source,
			sourceQuery: normalizedProbe,
			rank: index + 1,
			bm25: Number(row.lexical_bm25),
			snippet: String(row.lexical_snippet).trim(),
		}));
	}

	private searchTrigrams(
		probe: string,
		conversationIds: readonly string[],
		limit: number,
		threadFilter: { clause: string; parameters: Array<string | number> },
	): LexicalHit[] {
		const policy = trigramSearchPolicy(probe);
		const trigrams = stringTrigrams(probe).slice(0, 12);
		if (!policy || !trigrams.length) return [];
		const placeholders = conversationIds.map(() => "?").join(", ");
		const trigramClauses = trigrams.map(() => "instr(f.message, ?) > 0");
		const rows = this.database
			.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.* FROM posts_fts f JOIN posts p ON p.id = f.post_id
WHERE (${trigramClauses.join(" OR ")})
  AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY p.create_at DESC, p.id LIMIT ?`)
			.all(
				...trigrams,
				...conversationIds,
				...threadFilter.parameters,
				Math.max(limit * 5, 200),
			);
		return rows
			.map((row) => {
				const message = String(row.message);
				const similarity = bestBoundedTokenTrigramSimilarity(
					message,
					probe,
					policy,
				);
				return { row, message, similarity };
			})
			.filter(({ similarity }) => similarity >= policy.minimumSimilarity)
			.sort(
				(left, right) =>
					right.similarity - left.similarity ||
					Number(right.row.create_at) - Number(left.row.create_at) ||
					String(left.row.id).localeCompare(String(right.row.id)),
			)
			.slice(0, limit)
			.map(({ row, message, similarity }, index) => ({
				post: rowToPost(row),
				source: "trigram",
				sourceQuery: probe,
				rank: index + 1,
				bm25: -similarity,
				snippet: matchCenteredSnippet(message, trigrams[0] ?? probe),
			}));
	}

	private reindexStoredPostEntities(postId: string): void {
		const post = this.getPost(postId);
		if (!post || post.deleteAt) return;
		this.database
			.query("DELETE FROM post_entities WHERE post_id = ?")
			.run(postId);
		this.indexPostEntities(
			{
				id: post.id,
				root_id: post.rootId,
				channel_id: post.conversationId,
				user_id: post.userId,
				create_at: post.createAt,
				update_at: post.updateAt,
				delete_at: post.deleteAt,
				message: post.message,
				type: "",
				props: post.props,
				file_ids: [],
				metadata: post.metadata,
			},
			post.threadId,
		);
	}

	private indexPostEntities(post: MattermostPost, threadId: string): void {
		const entities = extractEngineeringEntities(post.message);
		const author = this.database
			.query<{ username: string }, [string]>(
				"SELECT username FROM users WHERE id = ? AND delete_at = 0",
			)
			.get(post.user_id);
		if (author?.username) {
			entities.push({
				kind: "username",
				value: author.username,
				normalizedValue: normalizeSearchText(author.username),
			});
		}
		const attachmentNames = this.database
			.query<{ name: string }, [string]>(
				`SELECT f.name FROM files f JOIN post_files pf ON pf.file_id = f.id
WHERE pf.post_id = ? AND f.delete_at = 0 ORDER BY f.id`,
			)
			.all(post.id)
			.map(({ name }) => ({
				kind: "attachment_filename" as const,
				value: name,
				normalizedValue: normalizeSearchText(name),
			}));
		const insert = this.database.query(`
INSERT OR IGNORE INTO post_entities
  (post_id, thread_id, conversation_id, kind, value, normalized_value)
VALUES (?, ?, ?, ?, ?, ?)`);
		for (const entity of [...entities, ...attachmentNames]) {
			insert.run(
				post.id,
				threadId,
				post.channel_id,
				entity.kind,
				entity.value,
				entity.normalizedValue,
			);
		}
	}

	private rebuildConceptFts(): void {
		this.database.run("DELETE FROM posts_concept_fts");
		const posts = this.database
			.query<{ id: string; message: string }, []>(
				"SELECT id, message FROM posts WHERE delete_at = 0 AND message <> '' ORDER BY id",
			)
			.all();
		const insert = this.database.query(
			"INSERT INTO posts_concept_fts (post_id, concepts) VALUES (?, ?)",
		);
		for (const post of posts) {
			const tokens = conceptTokensForText(post.message, this.concepts);
			if (tokens.length) insert.run(post.id, tokens.join(" "));
		}
	}

	private synchronizeConceptIndexConfig(): void {
		const fingerprint = conceptIndexFingerprint(this.concepts);
		const current = this.database
			.query<{ fingerprint: string }, [string]>(
				"SELECT fingerprint FROM search_index_config WHERE kind = ?",
			)
			.get("concepts")?.fingerprint;
		if (current === fingerprint) return;
		this.transaction(() => {
			this.rebuildConceptFts();
			this.database
				.query(
					"INSERT INTO search_index_config (kind, fingerprint) VALUES ('concepts', ?) ON CONFLICT(kind) DO UPDATE SET fingerprint = excluded.fingerprint",
				)
				.run(fingerprint);
		});
	}

	private rebuildMorphFts(): void {
		this.database.run("DELETE FROM posts_morph_fts");
		const posts = this.database
			.query<{ id: string; message: string }, []>(
				"SELECT id, message FROM posts WHERE delete_at = 0 AND message <> '' ORDER BY id",
			)
			.all();
		const insert = this.database.query(
			"INSERT INTO posts_morph_fts (post_id, morph) VALUES (?, ?)",
		);
		for (const post of posts) {
			insert.run(post.id, normalizeMorphText(post.message));
		}
	}

	private rebuildEntities(): void {
		this.database.run("DELETE FROM post_entities");
		const posts = this.database
			.query<Record<string, unknown>, []>(
				"SELECT * FROM posts WHERE delete_at = 0 ORDER BY id",
			)
			.all()
			.map(rowToPost);
		for (const post of posts) {
			this.indexPostEntities(
				{
					id: post.id,
					root_id: post.rootId,
					channel_id: post.conversationId,
					user_id: post.userId,
					create_at: post.createAt,
					update_at: post.updateAt,
					delete_at: post.deleteAt,
					message: post.message,
					type: "",
					props: post.props,
					file_ids: [],
					metadata: post.metadata,
				},
				post.threadId,
			);
		}
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
				if ("rebuildEntities" in migration && migration.rebuildEntities) {
					this.rebuildEntities();
				}
				if ("rebuildMorphFts" in migration && migration.rebuildMorphFts) {
					this.rebuildMorphFts();
				}
				if ("rebuildConceptFts" in migration && migration.rebuildConceptFts) {
					this.rebuildConceptFts();
					this.database
						.query(
							"INSERT INTO search_index_config (kind, fingerprint) VALUES ('concepts', ?)",
						)
						.run(conceptIndexFingerprint(this.concepts));
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

function buildThreadFilterSql(
	threadAlias: string,
	filters: ThreadSearchFilters,
): { clause: string; parameters: Array<string | number> } {
	if (
		!filters.username &&
		filters.after === undefined &&
		filters.before === undefined &&
		!filters.hasFile &&
		!filters.filePattern
	) {
		return { clause: "", parameters: [] };
	}
	const parameters: Array<string | number> = [];
	const postClauses = [
		`fp.thread_id = ${threadAlias}.thread_id`,
		"fp.delete_at = 0",
	];
	if (filters.username) {
		postClauses.push("lower(fu.username) = lower(?)");
		parameters.push(filters.username.replace(/^@/, ""));
	}
	if (filters.after !== undefined) {
		postClauses.push("fp.create_at >= ?");
		parameters.push(filters.after);
	}
	if (filters.before !== undefined) {
		postClauses.push("fp.create_at < ?");
		parameters.push(filters.before);
	}
	let clause = ` AND EXISTS (
SELECT 1 FROM posts fp LEFT JOIN users fu ON fu.id = fp.user_id
WHERE ${postClauses.join(" AND ")})`;
	if (filters.hasFile || filters.filePattern) {
		const fileClauses = [
			`ffp.thread_id = ${threadAlias}.thread_id`,
			"ffp.delete_at = 0",
			"ff.delete_at = 0",
		];
		if (filters.filePattern) {
			fileClauses.push("instr(lower(ff.name), lower(?)) > 0");
			parameters.push(filters.filePattern);
		}
		clause += ` AND EXISTS (
SELECT 1 FROM posts ffp
JOIN post_files fpf ON fpf.post_id = ffp.id
JOIN files ff ON ff.id = fpf.file_id
WHERE ${fileClauses.join(" AND ")})`;
	}
	return { clause, parameters };
}

function matchCenteredSnippet(
	message: string,
	normalizedProbe: string,
): string {
	const normalized = normalizeSearchText(message);
	const index = normalized.indexOf(normalizedProbe);
	if (index < 0 || message.length <= 240) return message;
	const start = Math.max(0, index - 100);
	const end = Math.min(message.length, index + normalizedProbe.length + 100);
	return `${start ? "… " : ""}${message.slice(start, end)}${end < message.length ? " …" : ""}`;
}

function stringTrigrams(value: string): string[] {
	const normalized = normalizeSearchText(value).trim();
	if (normalized.length < 3) return [];
	return [
		...new Set(
			Array.from({ length: normalized.length - 2 }, (_, index) =>
				normalized.slice(index, index + 3),
			),
		),
	];
}

export function trigramSearchPolicy(probe: string): TrigramSearchPolicy | null {
	const tokens = normalizeSearchText(probe).match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const length = Array.from(tokens[0] ?? "").length;
	if (tokens.length !== 1 || length < 5 || length > 64) return null;
	const token = tokens[0] ?? "";
	const latin = /^[a-z]+$/u.test(token);
	return {
		minimumSimilarity: !latin && length <= 9 ? 0.5 : length <= 6 ? 0.5 : 0.6,
		maximumEditDistance: latin && length <= 6 ? 3 : length >= 10 ? 2 : 1,
	};
}

function bestBoundedTokenTrigramSimilarity(
	message: string,
	probe: string,
	policy: TrigramSearchPolicy,
): number {
	const queryValues = new Set([normalizeSearchText(probe)]);
	const queryMorph = normalizeMorphText(probe);
	if (queryMorph) queryValues.add(queryMorph);
	const tokens = normalizeSearchText(message).match(/[\p{L}\p{N}_-]+/gu) ?? [];
	let best = 0;
	for (const token of tokens) {
		const candidateValues = new Set([token]);
		const morph = normalizeMorphText(token);
		if (morph) candidateValues.add(morph);
		for (const query of queryValues) {
			const expected = new Set(stringTrigrams(query));
			if (!expected.size) continue;
			for (const candidate of candidateValues) {
				if (
					boundedEditDistance(query, candidate, policy.maximumEditDistance) ===
					null
				) {
					continue;
				}
				const actual = new Set(stringTrigrams(candidate));
				if (!actual.size) continue;
				let overlap = 0;
				for (const trigram of expected) {
					if (actual.has(trigram)) overlap += 1;
				}
				best = Math.max(best, (2 * overlap) / (expected.size + actual.size));
			}
		}
	}
	return best;
}

function boundedEditDistance(
	leftValue: string,
	rightValue: string,
	maximum: number,
): number | null {
	const left = Array.from(normalizeSearchText(leftValue));
	const right = Array.from(normalizeSearchText(rightValue));
	if (Math.abs(left.length - right.length) > maximum) return null;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		let rowMinimum = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const value = Math.min(
				(previous[rightIndex] ?? maximum + 1) + 1,
				(current[rightIndex - 1] ?? maximum + 1) + 1,
				(previous[rightIndex - 1] ?? maximum + 1) +
					(left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			current.push(value);
			rowMinimum = Math.min(rowMinimum, value);
		}
		if (rowMinimum > maximum) return null;
		previous = current;
	}
	const distance = previous[right.length] ?? maximum + 1;
	return distance <= maximum ? distance : null;
}

export function buildFtsProbe(value: string): string | null {
	return buildFtsQuery(value, "strict_fts");
}

export function buildFtsQuery(
	value: string,
	source: LexicalRetrievalSource,
): string | null {
	const terms = normalizeSearchText(value).match(/[\p{L}\p{N}_-]+/gu);
	if (!terms?.length) return null;
	const escaped = terms.map((term) => term.replaceAll('"', '""'));
	switch (source) {
		case "exact_phrase":
			return `"${escaped.join(" ")}"`;
		case "broad_fts":
			return escaped.map((term) => `"${term}"`).join(" OR ");
		case "prefix_fts":
			return escaped.map((term) => `"${term}"*`).join(" AND ");
		case "trigram":
			return terms.join(" ");
		case "strict_fts":
		case "term_fts":
		case "morph_fts":
		case "concept_fts":
			return escaped.map((term) => `"${term}"`).join(" AND ");
	}
}

function discoveredTicketKeys(message: string): string[] {
	return [
		...new Set(
			(message.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) ?? []).map((key) =>
				key.toUpperCase(),
			),
		),
	];
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

function rowToUser(row: Record<string, unknown>): IndexedUser {
	return {
		id: String(row.id),
		username: String(row.username),
		firstName: String(row.first_name),
		lastName: String(row.last_name),
		nickname: String(row.nickname),
		deleteAt: Number(row.delete_at),
		isBot: Number(row.is_bot ?? 0) !== 0,
	};
}
