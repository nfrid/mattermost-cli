export { databaseFilePaths } from "./paths.ts";
export { buildFtsQuery, buildThreadFilterSql } from "./search-sql.ts";
export { MattermostStore, type MattermostStoreOptions } from "./store.ts";
export { trigramSearchPolicy } from "./trigram.ts";
export type {
	ConversationKind,
	ConversationRecord,
	IndexedFile,
	IndexedPost,
	IndexedUser,
	LexicalHit,
	LexicalRetrievalSource,
	LexicalSearchOptions,
	PageWrite,
	StructuredEntityHit,
	StructuredEntityRecord,
	SyncCheckpoint,
	ThreadSearchFilters,
	TicketThreadRelationship,
	TrigramSearchPolicy,
} from "./types.ts";
