import type { MattermostConfig } from "../config/config.ts";
import type { EvidenceStatus } from "../evidence/evidence.ts";
import type { EvidencePost, PackedThread } from "../evidence/packing.ts";
import type { TicketSegment } from "../evidence/ticket-segments.ts";
import type { MattermostClient } from "../mattermost/client.ts";
import type {
	AgentProbeInput,
	MattermostSubject,
	RankingReason,
	RetrievalProbe,
	RoutedConversation,
	RoutingResult,
	SearchResult,
	ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import type { ConversationRecord, MattermostStore } from "../store/index.ts";
import type { SyncClient } from "../sync/sync.ts";

export const DEFAULT_SEARCH_LIMIT = 10;
/**
 * Excerpts per candidate in `--agent` search output. Triage needs enough text
 * to judge a thread, not the whole match list — the full set stays in `--json`.
 */
export const DEFAULT_SEARCH_EXCERPTS = 3;

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
	/** Lean navigate projection (uses short packing budget). */
	navigate?: boolean;
	/** Opt-in advisory `signals` / `technicalEntities` in `--agent` output. */
	signals?: boolean;
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
	/**
	 * Max excerpts per candidate in the agent projection (default
	 * {@link DEFAULT_SEARCH_EXCERPTS}).
	 */
	excerpts?: number;
}

export interface ThreadInput {
	target: string;
	local?: boolean;
	fresh?: boolean;
	full?: boolean;
	around?: string;
	/** Asymmetric `--around` window; requires {@link around}. */
	beforePosts?: number;
	/** Asymmetric `--around` window; requires {@link around}. */
	afterPosts?: number;
	/** Opt-in advisory `signals` / `technicalEntities` in `--agent` output. */
	signals?: boolean;
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
	/** Oldest indexed post; the cutoff bound when coverage is incomplete. */
	oldestCoveredAt: number | null;
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
	droppedCandidates: DroppedCandidate[];
}

/** `unavailable`: retrieval failed for that thread, so it was never judged. */
export type DroppedCandidateReason =
	| "budget"
	| "no_match"
	| "thin"
	| "unavailable";

/** Ranked candidate omitted from the context packet (no extra hydrate). */
export interface DroppedCandidate {
	threadId: string;
	url: string;
	conversationId: string;
	conversationAlias: string;
	conversationKind: ConversationRecord["kind"];
	dropReason: DroppedCandidateReason;
	reasons: RankingReason[];
	excerpt?: string;
	/** Up to two distinct match excerpts (first also mirrored in {@link excerpt}). */
	excerpts?: string[];
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
	/**
	 * True when the projected target is already in the selected packet:
	 * resolved {@link threadId} when present, otherwise the in-packet
	 * {@link sourceThreadId} mention (no out-of-packet best thread).
	 * Omit when the pointer resolves to an out-of-packet related thread.
	 */
	alreadyInPacket?: boolean;
}

/**
 * Pointer to a thematically close thread outside ticket routing. Never
 * hydrated, never packed, never part of thread selection — it exists so the
 * agent can decide whether a pre-ticket design discussion is worth a call.
 */
export interface BackgroundThread {
	threadId: string;
	conversationId: string;
	conversationAlias: string;
	conversationKind: ConversationRecord["kind"];
	url: string;
	latestActivityAt: number;
	reasons: RankingReason[];
	/** Probe values that matched, so the pointer is attributable. */
	matchedProbes: string[];
	excerpts: string[];
}

/**
 * Agent guidance for DM conversation surround posts. `low` means nothing links
 * the surround to the subject; `possible` means a link could not be ruled out
 * (subject mention or non-trivial token overlap with the thread root). There is
 * no positive-relevance verdict: the scorer only rules relevance out.
 */
export type SurroundRelevance = "low" | "possible";

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
	evidence: EvidenceStatus;
	threads: ContextThread[];
	/** Pointers outside ticket routing; only with explicit `--query` probes. */
	background?: BackgroundThread[];
	budget: {
		measurement: "unicode_code_points_in_rendered_post";
		limit: number;
		used: number;
		maxThreads: number;
	};
	warnings: Warning[];
	/** True when context used the short evidence-card packing budget. */
	short?: boolean;
	/** True when context used lean navigate packing/projection. */
	navigate?: boolean;
	/** True when advisory signals were requested for `--agent` projection. */
	signals?: boolean;
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
	/** Resolved excerpt cap applied by the agent projection only. */
	excerptLimit: number;
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
	/** True when advisory signals were requested for `--agent` projection. */
	signals?: boolean;
}
