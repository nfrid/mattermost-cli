import type { MattermostConfig } from "../config/config.ts";
import type { CoverageEvidence } from "../evidence/coverage.ts";
import type { EvidencePost, PackedThread } from "../evidence/packing.ts";
import type { TicketSegment } from "../evidence/ticket-segments.ts";
import type { MattermostClient } from "../mattermost/client.ts";
import type {
	AgentProbeInput,
	MattermostSubject,
	RetrievalProbe,
	RoutedConversation,
	RoutingResult,
	SearchResult,
	ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import type {
	ConversationRecord,
	IndexedPost,
	MattermostStore,
	ThreadSearchFilters,
} from "../store/index.ts";
import type { SyncClient } from "../sync/sync.ts";

export const DEFAULT_SEARCH_LIMIT = 10;

export interface SearchFilterInput {
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
}

export interface SearchFilters {
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
}

export interface ContextInput extends SearchFilterInput {
	subject?: string;
	ticket?: string;
	queries?: readonly string[];
	probes?: readonly AgentProbeInput[];
	repositories?: readonly string[];
	scopes?: readonly string[];
	channels?: readonly string[];
	fresh?: boolean;
	local?: boolean;
	noWiden?: boolean;
	remoteSearch?: boolean;
	includeAutomation?: boolean;
	/** Use the short evidence-card packing budget. */
	short?: boolean;
}

export interface SearchInput
	extends Pick<
		ContextInput,
		| "subject"
		| "ticket"
		| "queries"
		| "probes"
		| "repositories"
		| "scopes"
		| "channels"
		| "noWiden"
		| "includeAutomation"
		| "from"
		| "after"
		| "before"
		| "hasFile"
		| "file"
		| "local"
	> {
	/** Max ranked candidates to return (default {@link DEFAULT_SEARCH_LIMIT}). */
	limit?: number;
}

export interface ThreadInput {
	target: string;
	local?: boolean;
	fresh?: boolean;
	full?: boolean;
	around?: string;
}

export interface ContextClient extends SyncClient {
	getPost(postId: string): ReturnType<MattermostClient["getPost"]>;
	getThread(postId: string): ReturnType<MattermostClient["getThread"]>;
	searchTeamPosts?: MattermostClient["searchTeamPosts"];
}

export interface ContextDependencies {
	config?: MattermostConfig;
	store?: MattermostStore;
	client?: ContextClient;
	now?: () => number;
}

export interface FreshnessEvidence {
	alias: string;
	conversationId: string;
	kind: ConversationRecord["kind"];
	observedAt: number;
	lastSuccessAt: number | null;
	ageSeconds: number | null;
	stale: boolean;
	coverageComplete: boolean;
}

export interface ContextThread extends PackedThread {
	conversationId: string;
	conversationAlias: string;
	conversationKind: ConversationRecord["kind"];
	reasons: ThreadCandidate["reasons"];
	matchingPostIds: string[];
	latestActivityAt: number;
	link: string;
	/** Prior root posts from the same DM conversation for short threads. */
	surround?: EvidencePost[];
	ticketDensity?: number;
	nearestTicketDistance?: number | null;
	rootAnchoredFocused?: boolean;
	segments?: TicketSegment[];
}

export interface RemoteSearchEvidence {
	requested: boolean;
	performed: boolean;
	reason: "explicit" | "incomplete_local_coverage" | "stale_local_index" | null;
	queries: Array<{
		probe: string;
		probeKind?: AgentProbeInput["kind"];
		returnedPosts: number;
		acceptedPosts: number;
	}>;
	candidateThreads: number;
	failures: number;
}

export interface SelectionEvidence {
	candidateThreads: number;
	returnedThreads: number;
	droppedThin: number;
	droppedByBudget: number;
	droppedNoMatch: number;
}

/** One-hop related ticket pointer (not a full nested context). */
export interface RelatedTicketPointer {
	key: string;
	mentions: number;
	threadId?: string;
	url?: string;
	conversation?: string;
	latestAt?: number;
	excerpt?: string;
	/** Selected subject thread that contributed the strongest mention. */
	sourceThreadId?: string;
	hydrated: false;
}

export interface ContextResult {
	subject: MattermostSubject;
	probes: RetrievalProbe[];
	filters: SearchFilters;
	remoteSearch: RemoteSearchEvidence;
	freshnessMode: "local" | "network" | "forced";
	complete: boolean;
	searchCoverageComplete: boolean;
	selectedThreadsComplete: boolean;
	freshness: FreshnessEvidence[];
	unmatchedHints: RoutingResult["unmatchedHints"];
	searchedConversations: Array<{
		id: string;
		alias: string;
		kind: ConversationRecord["kind"];
		evidence: RoutedConversation["evidence"];
	}>;
	explicitChannelPolicy: "restrict";
	widening: { allowed: boolean; performed: boolean };
	selection: SelectionEvidence;
	relatedTickets: RelatedTicketPointer[];
	coverage: CoverageEvidence;
	threads: ContextThread[];
	budget: {
		measurement: "unicode_code_points_in_rendered_post";
		limit: number;
		used: number;
		maxThreads: number;
	};
	warnings: Warning[];
	/** True when context used the short evidence-card packing budget. */
	short?: boolean;
}

export interface SearchContextResult extends Omit<SearchResult, "candidates"> {
	filters: SearchFilters;
	candidates: Array<ThreadCandidate & { link: string }>;
	freshnessMode: "local";
	complete: boolean;
	searchCoverageComplete: boolean;
	freshness: FreshnessEvidence[];
	searchedConversations: ContextResult["searchedConversations"];
	widened: boolean;
	warnings: Warning[];
}

export interface ThreadResult {
	subject: MattermostSubject;
	freshnessMode: "local" | "network";
	complete: boolean;
	freshness: FreshnessEvidence;
	conversation: { id: string; alias: string; kind: ConversationRecord["kind"] };
	link: string;
	thread: PackedThread;
	warnings: Warning[];
}
