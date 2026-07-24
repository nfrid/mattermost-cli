import type { SearchConcepts } from "../config/config.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "../mattermost/schemas.ts";
import {
	extractEngineeringEntities,
	extractTicketKeys,
} from "../search/extract.ts";
import {
	conceptIndexFingerprint,
	conceptTokensForText,
} from "../search/search-concepts.ts";
import { normalizeMorphText } from "../search/search-token-normalization.ts";
import { normalizeSearchText } from "../search/text.ts";
import type { StoreHandle } from "./handle.ts";
import { rowToPost } from "./mappers.ts";
import { getPost, migrationVersions } from "./reads.ts";
import { migrations } from "./schema.ts";
import type {
	ConversationRecord,
	IndexedPost,
	PageWrite,
	SyncCheckpoint,
} from "./types.ts";

export function finalizeFullSync(
	store: StoreHandle,
	conversation: ConversationRecord,
	retainedPostIds: readonly string[],
	checkpoint: SyncCheckpoint,
): void {
	store.database.run(
		"CREATE TEMP TABLE IF NOT EXISTS full_sync_retained_posts (post_id TEXT PRIMARY KEY)",
	);
	store.database.run("DELETE FROM full_sync_retained_posts");
	const retain = store.database.query(
		"INSERT OR IGNORE INTO full_sync_retained_posts (post_id) VALUES (?)",
	);
	for (const postId of retainedPostIds) retain.run(postId);
	runTransaction(store, () => {
		upsertConversation(store, conversation);
		const stalePosts =
			"SELECT id FROM posts WHERE conversation_id = ? AND id NOT IN (SELECT post_id FROM full_sync_retained_posts)";
		store.database
			.query(`DELETE FROM posts_fts WHERE post_id IN (${stalePosts})`)
			.run(conversation.id);
		store.database
			.query(`DELETE FROM posts_morph_fts WHERE post_id IN (${stalePosts})`)
			.run(conversation.id);
		store.database
			.query(`DELETE FROM posts_concept_fts WHERE post_id IN (${stalePosts})`)
			.run(conversation.id);
		store.database
			.query(
				`DELETE FROM ticket_threads WHERE origin = 'discovered' AND source_post_id IN (${stalePosts})`,
			)
			.run(conversation.id);
		store.database
			.query(`DELETE FROM files WHERE post_id IN (${stalePosts})`)
			.run(conversation.id);
		store.database
			.query(`DELETE FROM posts WHERE id IN (${stalePosts})`)
			.run(conversation.id);
		writeCheckpoint(store, checkpoint);
	});
	store.database.run("DELETE FROM full_sync_retained_posts");
}

export function writePage(store: StoreHandle, page: PageWrite): void {
	runTransaction(store, () => {
		upsertConversation(store, page.conversation);
		for (const user of page.users ?? []) upsertUser(store, user);
		for (const file of page.files ?? []) upsertFile(store, file);
		for (const post of page.posts) upsertPost(store, post);
		if (page.checkpoint) writeCheckpoint(store, page.checkpoint);
	});
}

export function upsertConversation(
	store: StoreHandle,
	conversation: ConversationRecord,
): void {
	store.database
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

export function upsertUser(store: StoreHandle, user: MattermostUser): void {
	const existing = store.database
		.query<{ username: string; delete_at: number }, [string]>(
			"SELECT username, delete_at FROM users WHERE id = ?",
		)
		.get(user.id);
	store.database
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
		const postIds = store.database
			.query<{ id: string }, [string]>(
				"SELECT id FROM posts WHERE user_id = ? ORDER BY id",
			)
			.all(user.id);
		for (const { id } of postIds) reindexStoredPostEntities(store, id);
	}
}

export function upsertPost(store: StoreHandle, post: MattermostPost): void {
	const existing = store.database
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
	store.database
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
	store.database.query("DELETE FROM posts_fts WHERE post_id = ?").run(post.id);
	store.database
		.query("DELETE FROM posts_morph_fts WHERE post_id = ?")
		.run(post.id);
	store.database
		.query("DELETE FROM posts_concept_fts WHERE post_id = ?")
		.run(post.id);
	store.database
		.query("DELETE FROM post_entities WHERE post_id = ?")
		.run(post.id);
	store.database.query("DELETE FROM post_files WHERE post_id = ?").run(post.id);
	if (!post.delete_at && post.message) {
		store.database
			.query("INSERT INTO posts_fts (post_id, message) VALUES (?, ?)")
			.run(post.id, normalizeSearchText(post.message));
		store.database
			.query("INSERT INTO posts_morph_fts (post_id, morph) VALUES (?, ?)")
			.run(post.id, normalizeMorphText(post.message));
		const conceptTokens = conceptTokensForText(post.message, store.concepts);
		if (conceptTokens.length) {
			store.database
				.query(
					"INSERT INTO posts_concept_fts (post_id, concepts) VALUES (?, ?)",
				)
				.run(post.id, conceptTokens.join(" "));
		}
	}
	for (const fileId of post.file_ids) {
		store.database
			.query(
				"INSERT OR IGNORE INTO post_files (post_id, file_id) VALUES (?, ?)",
			)
			.run(post.id, fileId);
	}
	store.database
		.query(
			"DELETE FROM ticket_threads WHERE source_post_id = ? AND origin = 'discovered'",
		)
		.run(post.id);
	if (!post.delete_at) {
		for (const key of extractTicketKeys(post.message)) {
			store.database
				.query(
					"INSERT OR IGNORE INTO ticket_threads (ticket_key, thread_id, source_post_id, origin) VALUES (?, ?, ?, 'discovered')",
				)
				.run(key, threadId, post.id);
		}
		indexPostEntities(store, post, threadId);
	}
}

export function linkTicketThread(
	store: StoreHandle,
	ticketKey: string,
	threadId: string,
	sourcePostId: string,
	origin: "discovered" | "explicit",
): void {
	store.database
		.query(
			"INSERT OR IGNORE INTO ticket_threads (ticket_key, thread_id, source_post_id, origin) VALUES (?, ?, ?, ?)",
		)
		.run(ticketKey, threadId, sourcePostId, origin);
}

export function upsertFile(store: StoreHandle, file: MattermostFileInfo): void {
	store.database
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
	reindexStoredPostEntities(store, file.post_id);
}

export function writeCheckpoint(
	store: StoreHandle,
	checkpoint: SyncCheckpoint,
): void {
	store.database
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

function reindexStoredPostEntities(store: StoreHandle, postId: string): void {
	const post = getPost(store, postId);
	if (!post || post.deleteAt) return;
	store.database
		.query("DELETE FROM post_entities WHERE post_id = ?")
		.run(postId);
	indexPostEntities(
		store,
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

function indexPostEntities(
	store: StoreHandle,
	post: MattermostPost,
	threadId: string,
): void {
	const entities = extractEngineeringEntities(post.message);
	const author = store.database
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
	const attachmentNames = store.database
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
	const insert = store.database.query(`
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

function rebuildConceptFts(store: StoreHandle): void {
	store.database.run("DELETE FROM posts_concept_fts");
	const posts = store.database
		.query<{ id: string; message: string }, []>(
			"SELECT id, message FROM posts WHERE delete_at = 0 AND message <> '' ORDER BY id",
		)
		.all();
	const insert = store.database.query(
		"INSERT INTO posts_concept_fts (post_id, concepts) VALUES (?, ?)",
	);
	for (const post of posts) {
		const tokens = conceptTokensForText(post.message, store.concepts);
		if (tokens.length) insert.run(post.id, tokens.join(" "));
	}
}

export function synchronizeConceptIndexConfig(store: StoreHandle): void {
	const fingerprint = conceptIndexFingerprint(store.concepts);
	const current = store.database
		.query<{ fingerprint: string }, [string]>(
			"SELECT fingerprint FROM search_index_config WHERE kind = ?",
		)
		.get("concepts")?.fingerprint;
	if (current === fingerprint) return;
	runTransaction(store, () => {
		rebuildConceptFts(store);
		store.database
			.query(
				"INSERT INTO search_index_config (kind, fingerprint) VALUES ('concepts', ?) ON CONFLICT(kind) DO UPDATE SET fingerprint = excluded.fingerprint",
			)
			.run(fingerprint);
	});
}

function rebuildMorphFts(store: StoreHandle): void {
	store.database.run("DELETE FROM posts_morph_fts");
	const posts = store.database
		.query<{ id: string; message: string }, []>(
			"SELECT id, message FROM posts WHERE delete_at = 0 AND message <> '' ORDER BY id",
		)
		.all();
	const insert = store.database.query(
		"INSERT INTO posts_morph_fts (post_id, morph) VALUES (?, ?)",
	);
	for (const post of posts) {
		insert.run(post.id, normalizeMorphText(post.message));
	}
}

function rebuildEntities(store: StoreHandle): void {
	store.database.run("DELETE FROM post_entities");
	const posts = store.database
		.query<Record<string, unknown>, []>(
			"SELECT * FROM posts WHERE delete_at = 0 ORDER BY id",
		)
		.all()
		.map(rowToPost);
	for (const post of posts) {
		indexPostEntities(
			store,
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

export function migrate(store: StoreHandle): void {
	store.database.run(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
	);
	const applied = new Set(migrationVersions(store));
	for (const migration of migrations) {
		if (applied.has(migration.version)) continue;
		runTransaction(store, () => {
			store.database.run(migration.sql);
			if ("rebuildFts" in migration && migration.rebuildFts) {
				const posts = store.database
					.query<{ id: string; message: string }, []>(
						"SELECT id, message FROM posts WHERE delete_at = 0 AND message <> '' ORDER BY id",
					)
					.all();
				const insert = store.database.query(
					"INSERT INTO posts_fts (post_id, message) VALUES (?, ?)",
				);
				for (const post of posts) {
					insert.run(post.id, normalizeSearchText(post.message));
				}
			}
			if ("rebuildEntities" in migration && migration.rebuildEntities) {
				rebuildEntities(store);
			}
			if ("rebuildMorphFts" in migration && migration.rebuildMorphFts) {
				rebuildMorphFts(store);
			}
			if ("rebuildConceptFts" in migration && migration.rebuildConceptFts) {
				rebuildConceptFts(store);
				store.database
					.query(
						"INSERT INTO search_index_config (kind, fingerprint) VALUES ('concepts', ?)",
					)
					.run(conceptIndexFingerprint(store.concepts));
			}
			store.database
				.query(
					"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
				)
				.run(migration.version, Date.now());
		});
	}
}

function runTransaction(store: StoreHandle, action: () => void): void {
	store.database.run("BEGIN IMMEDIATE");
	try {
		action();
		store.database.run("COMMIT");
	} catch (error) {
		try {
			store.database.run("ROLLBACK");
		} catch {
			// Prefer the original write failure over rollback noise.
		}
		throw error;
	}
}
