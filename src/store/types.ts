import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "../mattermost/schemas.ts";
import type { EngineeringEntity } from "../search/extract.ts";

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
