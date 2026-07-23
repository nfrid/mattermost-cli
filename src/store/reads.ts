import type { EngineeringEntityKind } from "../search/extract.ts";
import { extractEngineeringEntities } from "../search/extract.ts";
import { normalizeSearchText } from "../search/text.ts";
import { DatabaseError } from "../shared/errors.ts";
import type { StoreHandle } from "./handle.ts";
import { rowToPost, rowToUser } from "./mappers.ts";
import {
	buildFtsQuery,
	buildThreadFilterSql,
	matchCenteredSnippet,
} from "./search-sql.ts";
import {
	bestBoundedTokenTrigramSimilarity,
	stringTrigrams,
	trigramSearchPolicy,
} from "./trigram.ts";
import type {
	ConversationKind,
	ConversationRecord,
	IndexedFile,
	IndexedPost,
	IndexedUser,
	LexicalHit,
	LexicalSearchOptions,
	StructuredEntityHit,
	StructuredEntityRecord,
	SyncCheckpoint,
	ThreadSearchFilters,
	TicketThreadRelationship,
} from "./types.ts";

export function migrationVersions(store: StoreHandle): number[] {
	return store.database
		.query<{ version: number }, []>(
			"SELECT version FROM schema_migrations ORDER BY version",
		)
		.all()
		.map(({ version }) => version);
}

export function verifyIntegrity(store: StoreHandle): void {
	const result = store.database
		.query<{ quick_check: string }, []>("PRAGMA quick_check")
		.get();
	if (result?.quick_check !== "ok") {
		throw new DatabaseError(
			"The local Mattermost index failed SQLite integrity checks.",
			"database_corrupt",
		);
	}
	store.database.query("SELECT count(*) FROM posts_fts").get();
	store.database.query("SELECT count(*) FROM posts_morph_fts").get();
	store.database.query("SELECT count(*) FROM posts_concept_fts").get();
}

export function getCheckpoint(
	store: StoreHandle,
	conversationId: string,
): SyncCheckpoint | null {
	const row = store.database
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

export function getThread(store: StoreHandle, threadId: string): IndexedPost[] {
	return store.database
		.query<Record<string, unknown>, [string]>(
			"SELECT * FROM posts WHERE thread_id = ? ORDER BY create_at, id",
		)
		.all(threadId)
		.map(rowToPost);
}

export function getPost(
	store: StoreHandle,
	postId: string,
): IndexedPost | null {
	const row = store.database
		.query<Record<string, unknown>, [string]>(
			"SELECT * FROM posts WHERE id = ?",
		)
		.get(postId);
	return row ? rowToPost(row) : null;
}

export function listConversations(store: StoreHandle): ConversationRecord[] {
	return store.database
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

export function getUsers(
	store: StoreHandle,
	userIds: readonly string[],
): IndexedUser[] {
	if (!userIds.length) return [];
	const placeholders = userIds.map(() => "?").join(", ");
	return store.database
		.query<Record<string, unknown>, string[]>(
			`SELECT * FROM users WHERE id IN (${placeholders})`,
		)
		.all(...userIds)
		.map(rowToUser);
}

export function getUser(
	store: StoreHandle,
	userId: string,
): IndexedUser | null {
	const row = store.database
		.query<Record<string, unknown>, [string]>(
			"SELECT * FROM users WHERE id = ?",
		)
		.get(userId);
	return row ? rowToUser(row) : null;
}

/** Non-deleted reply count for a thread (excludes the root post). */
export function threadReplyCount(store: StoreHandle, threadId: string): number {
	const row = store.database
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
export function getPrecedingRootPosts(
	store: StoreHandle,
	conversationId: string,
	beforeCreateAt: number,
	beforePostId: string,
	limit: number,
): IndexedPost[] {
	if (limit <= 0) return [];
	const rows = store.database
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

export function getFilesForPosts(
	store: StoreHandle,
	postIds: readonly string[],
): IndexedFile[] {
	if (!postIds.length) return [];
	const placeholders = postIds.map(() => "?").join(", ");
	return store.database
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

export function getFileById(
	store: StoreHandle,
	fileId: string,
): (IndexedFile & { conversationId: string }) | null {
	const row = store.database
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

export function getTicketRelationships(
	store: StoreHandle,
	ticketKey?: string,
): TicketThreadRelationship[] {
	const rows = ticketKey
		? store.database
				.query<Record<string, unknown>, [string]>(
					"SELECT * FROM ticket_threads WHERE ticket_key = ? ORDER BY thread_id, origin",
				)
				.all(ticketKey)
		: store.database
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

export function getConversationIdsForTicket(
	store: StoreHandle,
	ticketKey: string,
): string[] {
	return store.database
		.query<{ conversation_id: string }, [string]>(`
SELECT DISTINCT p.conversation_id FROM ticket_threads t
JOIN posts p ON p.thread_id = t.thread_id
WHERE t.ticket_key = ? ORDER BY p.conversation_id`)
		.all(ticketKey)
		.map(({ conversation_id }) => conversation_id);
}

export function threadMatchesFilters(
	store: StoreHandle,
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
		!store.database
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
		store.database
			.query<{ matched: number }, Record<string, string | number>>(`
SELECT 1 AS matched FROM posts p
JOIN post_files pf ON pf.post_id = p.id
JOIN files f ON f.id = pf.file_id
WHERE ${fileClauses.join(" AND ")} LIMIT 1`)
			.get(parameters),
	);
}

export function searchEntities(
	store: StoreHandle,
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
					normalizedValue: normalizeSearchText(probe.trim().replace(/^@/, "")),
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
		const rows = store.database
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

export function listEntities(
	store: StoreHandle,
	threadId?: string,
): StructuredEntityRecord[] {
	const rows = threadId
		? store.database
				.query<Record<string, unknown>, [string]>(
					"SELECT * FROM post_entities WHERE thread_id = ? ORDER BY post_id, kind, normalized_value",
				)
				.all(threadId)
		: store.database
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

export function search(
	store: StoreHandle,
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
		return searchTrigrams(
			store,
			normalizedProbe,
			conversationIds,
			limit,
			threadFilter,
		);
	}
	const rows =
		source === "morph_fts"
			? store.database
					.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.*, bm25(posts_morph_fts) AS lexical_bm25,
  p.message AS lexical_snippet
FROM posts_morph_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_morph_fts MATCH ? AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY lexical_bm25, p.create_at DESC, p.id LIMIT ?`)
					.all(match, ...conversationIds, ...threadFilter.parameters, limit)
			: source === "concept_fts"
				? store.database
						.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.*, bm25(posts_concept_fts) AS lexical_bm25,
  p.message AS lexical_snippet
FROM posts_concept_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_concept_fts MATCH ? AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY lexical_bm25, p.create_at DESC, p.id LIMIT ?`)
						.all(match, ...conversationIds, ...threadFilter.parameters, limit)
				: store.database
						.query<Record<string, unknown>, (string | number)[]>(`
SELECT p.*, bm25(posts_fts) AS lexical_bm25,
  snippet(posts_fts, 1, '', '', ' … ', 24) AS lexical_snippet
FROM posts_fts f JOIN posts p ON p.id = f.post_id
WHERE posts_fts MATCH ? AND p.conversation_id IN (${placeholders})${threadFilter.clause}
ORDER BY lexical_bm25, p.create_at DESC, p.id LIMIT ?`)
						.all(match, ...conversationIds, ...threadFilter.parameters, limit);
	return rows.map((row, index) => ({
		post: rowToPost(row),
		source,
		sourceQuery: normalizedProbe,
		rank: index + 1,
		bm25: Number(row.lexical_bm25),
		snippet: String(row.lexical_snippet).trim(),
	}));
}

function searchTrigrams(
	store: StoreHandle,
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
	const rows = store.database
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
