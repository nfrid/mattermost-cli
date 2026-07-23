import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { SearchConcepts } from "../config/config.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "../mattermost/schemas.ts";
import type { EngineeringEntityKind } from "../search/extract.ts";
import { DatabaseError } from "../shared/errors.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "../shared/limits.ts";
import type { StoreHandle } from "./handle.ts";
import { databaseFilePaths } from "./paths.ts";
import * as reads from "./reads.ts";
import type {
	ConversationRecord,
	IndexedFile,
	IndexedPost,
	IndexedUser,
	LexicalHit,
	LexicalSearchOptions,
	PageWrite,
	StructuredEntityHit,
	StructuredEntityRecord,
	SyncCheckpoint,
	ThreadSearchFilters,
	TicketThreadRelationship,
} from "./types.ts";
import * as writes from "./writes.ts";

export interface MattermostStoreOptions {
	concepts?: SearchConcepts;
}

export class MattermostStore implements StoreHandle {
	readonly database: Database;
	readonly concepts: Readonly<SearchConcepts>;

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
		writes.migrate(this);
		writes.synchronizeConceptIndexConfig(this);
	}

	close(): void {
		this.database.close();
	}

	migrationVersions(): number[] {
		return reads.migrationVersions(this);
	}

	verifyIntegrity(): void {
		reads.verifyIntegrity(this);
	}

	finalizeFullSync(
		conversation: ConversationRecord,
		retainedPostIds: readonly string[],
		checkpoint: SyncCheckpoint,
	): void {
		writes.finalizeFullSync(this, conversation, retainedPostIds, checkpoint);
	}

	writePage(page: PageWrite): void {
		writes.writePage(this, page);
	}

	upsertConversation(conversation: ConversationRecord): void {
		writes.upsertConversation(this, conversation);
	}

	upsertUser(user: MattermostUser): void {
		writes.upsertUser(this, user);
	}

	upsertPost(post: MattermostPost): void {
		writes.upsertPost(this, post);
	}

	linkTicketThread(
		ticketKey: string,
		threadId: string,
		sourcePostId: string,
		origin: "discovered" | "explicit",
	): void {
		writes.linkTicketThread(this, ticketKey, threadId, sourcePostId, origin);
	}

	upsertFile(file: MattermostFileInfo): void {
		writes.upsertFile(this, file);
	}

	getCheckpoint(conversationId: string): SyncCheckpoint | null {
		return reads.getCheckpoint(this, conversationId);
	}

	writeCheckpoint(checkpoint: SyncCheckpoint): void {
		writes.writeCheckpoint(this, checkpoint);
	}

	getThread(threadId: string): IndexedPost[] {
		return reads.getThread(this, threadId);
	}

	getPost(postId: string): IndexedPost | null {
		return reads.getPost(this, postId);
	}

	listConversations(): ConversationRecord[] {
		return reads.listConversations(this);
	}

	getUsers(userIds: readonly string[]): IndexedUser[] {
		return reads.getUsers(this, userIds);
	}

	getUser(userId: string): IndexedUser | null {
		return reads.getUser(this, userId);
	}

	threadReplyCount(threadId: string): number {
		return reads.threadReplyCount(this, threadId);
	}

	getPrecedingRootPosts(
		conversationId: string,
		beforeCreateAt: number,
		beforePostId: string,
		limit: number,
	): IndexedPost[] {
		return reads.getPrecedingRootPosts(
			this,
			conversationId,
			beforeCreateAt,
			beforePostId,
			limit,
		);
	}

	getFilesForPosts(postIds: readonly string[]): IndexedFile[] {
		return reads.getFilesForPosts(this, postIds);
	}

	getFileById(
		fileId: string,
	): (IndexedFile & { conversationId: string }) | null {
		return reads.getFileById(this, fileId);
	}

	getTicketRelationships(ticketKey?: string): TicketThreadRelationship[] {
		return reads.getTicketRelationships(this, ticketKey);
	}

	getConversationIdsForTicket(ticketKey: string): string[] {
		return reads.getConversationIdsForTicket(this, ticketKey);
	}

	threadMatchesFilters(
		threadId: string,
		filters: ThreadSearchFilters = {},
	): boolean {
		return reads.threadMatchesFilters(this, threadId, filters);
	}

	searchEntities(
		probe: string,
		conversationIds: readonly string[],
		limit = 100,
		filters: ThreadSearchFilters = {},
		kindHint?: EngineeringEntityKind,
	): StructuredEntityHit[] {
		return reads.searchEntities(
			this,
			probe,
			conversationIds,
			limit,
			filters,
			kindHint,
		);
	}

	listEntities(threadId?: string): StructuredEntityRecord[] {
		return reads.listEntities(this, threadId);
	}

	search(
		probe: string,
		conversationIds: readonly string[],
		limit = 50,
		options: LexicalSearchOptions = {},
	): LexicalHit[] {
		return reads.search(this, probe, conversationIds, limit, options);
	}
}

function secureDatabaseFiles(path: string): void {
	for (const file of databaseFilePaths(path)) {
		if (existsSync(file)) chmodSync(file, 0o600);
	}
}
