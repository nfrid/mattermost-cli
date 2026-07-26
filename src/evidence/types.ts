/**
 * Evidence types: the coverage-trust vocabulary and the packet fields shaped by
 * it.
 *
 * These live below `context/` on purpose. `buildEvidence` reads the packet's
 * threads, freshness, and selection while the packet embeds the
 * {@link EvidenceStatus} it produces, so keeping both the status types *and*
 * the packet fields they describe here is what stops `evidence/` and
 * `context/` from importing each other. `context/types.ts` re-exports every
 * name below, so the public surface is unchanged.
 */
import type {
	AgentProbeInput,
	RankingReason,
	ThreadCandidate,
} from "../search/index.ts";
import type { ConversationRecord } from "../store/index.ts";
import type { EvidencePost, PackedThread } from "./packing.ts";
import type { TicketSegment } from "./ticket-segments.ts";

export type EvidenceAdequacy = "usable" | "thin" | "insufficient";
export type EvidenceCurrency = "current" | "possibly_stale" | "local_only";
/**
 * Posts inside the selected threads. `not_applicable` when nothing was
 * selected: with no thread there is no transcript to be complete *or*
 * truncated, and reporting truncation reads as withheld evidence.
 */
export type EvidenceThreadCompleteness =
	| "complete"
	| "truncated"
	| "not_applicable";
/**
 * Whether every ranked candidate was actually judged. `budget_bounded` means
 * candidates were left unexamined because thread or character room ran out, or
 * because the per-request hydration ceiling was reached — independent of
 * `selectedThreads`, which only describes posts inside the selected threads.
 */
export type EvidenceSelectionCompleteness = "complete" | "budget_bounded";
export type EvidenceIndexHistory = "full" | "cutoff_bounded";
export type EvidenceDiscoveryCurrency =
	| "current"
	| "possibly_stale"
	| "local_only";

export type EvidenceNextAction =
	| "thread_full"
	| "thread_around"
	| "sync"
	| "inspect_dropped"
	| "review_candidates"
	| "fresh_or_remote"
	| "read_attachments";

export type EvidenceNextPriority = "recommended" | "optional";

export type EvidenceNextImpact =
	| "may_recover_omitted_core"
	| "older_discovery_only"
	| "may_add_dropped_pointer"
	| "may_refresh_selected_or_discovery"
	| "may_contradict_visible_text"
	| "may_verify_quantitative_claim"
	/** Spreadsheet bytes on a decision post; mm cannot verify quantities. */
	| "cannot_verify_quantities"
	/**
	 * Image/workbook bytes: `file --inspect` downloads them but cannot interpret
	 * contents; an external reader is required.
	 */
	| "requires_external_reader";

/**
 * Why {@link EvidenceVerdict.mayHaveMissedOtherThreads} is true. Absent when
 * the flag is false. Prefer the most actionable cause when several apply.
 */
export type EvidenceMayHaveMissedReason =
	| "index_cutoff"
	| "stale_discovery"
	| "subject_matched_budget_drops"
	| "local_discovery";

export interface EvidenceNextStep {
	action: EvidenceNextAction;
	reason: string;
	priority: EvidenceNextPriority;
	impact: EvidenceNextImpact;
	/** Argv only — never a shell string. Omitted when no safe follow-up exists. */
	command?: string[];
	threadId?: string;
	conversationId?: string;
	/** Post carrying the evidence, for `read_attachments`. */
	postId?: string;
}

/**
 * Machine-readable roll-up of the detailed axes below it.
 *
 * The axes are all independently true and all worth auditing, but reading five
 * of them correctly on every packet — `selectedThreads: complete` alongside
 * `selection: budget_bounded`, `currency: current` alongside a stale discovery —
 * is a standing invitation to draw the wrong conclusion. This says the four
 * things a reader actually decides on. Every field is derived from the axes and
 * adds no new knowledge — with one deliberate softening, documented on
 * {@link EvidenceVerdict.mayHaveMissedOtherThreads}.
 */
export interface EvidenceVerdict {
	/**
	 * The returned threads are usable and nothing was cut inside them. It does
	 * not promise the answer is *in* them: a `recommended` `read_attachments`
	 * step can still point at a file that contradicts the visible text.
	 */
	canAnswerFromSelectedEvidence: boolean;
	/**
	 * Discovery could not see everything: search reach was stale, or candidates
	 * carrying subject-level evidence went unexamined. A merely budget-bounded
	 * weak tail does **not** set this — that was the point of splitting
	 * `droppedByBudgetSubjectMatched` out.
	 *
	 * The one place this is softer than the axes: cutoff-bounded history sets it
	 * only on a packet that is not otherwise trusted. Nearly every conversation
	 * is bounded by `historyDays`, so counting it unconditionally would pin the
	 * flag to `true` forever. `completeness.indexHistory` and
	 * {@link EvidenceHistory} always report the bound in full.
	 */
	mayHaveMissedOtherThreads: boolean;
	/**
	 * Additive cause for {@link mayHaveMissedOtherThreads}. Absent when the flag
	 * is false.
	 */
	mayHaveMissedReason?: EvidenceMayHaveMissedReason;
	/** The returned threads themselves may be behind the server. */
	selectedEvidenceMayBeStale: boolean;
	/** At least one `next` step is `recommended`. */
	recommendedActionRequired: boolean;
	/**
	 * A true verdict flag has no safe follow-up in `next[]`. Agents must not
	 * invent one; the reason explains the bound.
	 */
	noActionAvailable?: true;
	noActionReason?: string;
}

export interface EvidenceStatus {
	adequacy: EvidenceAdequacy;
	currency: EvidenceCurrency;
	/** Roll-up of the axes below; always consistent with them. */
	verdict: EvidenceVerdict;
	completeness: {
		selectedThreads: EvidenceThreadCompleteness;
		/** Additive since schema version 3; absent in older packets. */
		selection?: EvidenceSelectionCompleteness;
		indexHistory: EvidenceIndexHistory;
		/** Additive since schema version 2; absent in older packets. */
		discovery?: EvidenceDiscoveryCurrency;
	};
	next: EvidenceNextStep[];
	selection: {
		candidateThreads: number;
		returnedThreads: number;
		droppedThin: number;
		droppedByBudget: number;
		/** Unexamined candidates that still carried subject-level evidence. */
		droppedByBudgetSubjectMatched: number;
		/**
		 * Candidates that survived ranking but carried no current content match
		 * once hydrated. A non-zero count with an empty `droppedCandidates` means
		 * the drops were ranking noise, not withheld evidence.
		 */
		droppedNoMatch: number;
		droppedCandidates: DroppedCandidate[];
	};
	packing: {
		omittedPosts: number;
		largestSkip: number;
		/** Threads for which a bounded or full hydration step is available. */
		recommendedHydrationThreadIds?: string[];
		/** Legacy alias retained for V1 compatibility. */
		recommendFullThreadIds: string[];
	};
	/** Present only when some searched conversation has cutoff-bounded history. */
	history?: EvidenceHistory;
}

/**
 * Which conversations are cutoff-bounded and how far back they reach, so the
 * `incomplete_history` warning can be judged instead of guessed. Compare
 * `oldestIndexedAt` with the thread's `latestAt`, and weigh
 * `inSelectedThreads` — a bounded channel nobody selected rarely matters.
 */
export interface EvidenceHistory {
	cutoffBounded: Array<{
		alias: string;
		conversationId: string;
		/** ISO timestamp of the oldest indexed post; absent when never synced. */
		oldestIndexedAt?: string;
		inSelectedThreads: boolean;
	}>;
	/** Cutoff-bounded conversations beyond the reported cap. */
	additional?: number;
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
	exclusiveSubjectKey?: boolean;
	otherTicketDominated?: boolean;
	/**
	 * Secondary (or any) thread that is a related/historical neighbor rather than
	 * focused on the subject ticket. Brief packing shrinks these harder.
	 */
	historicalNeighbor?: true;
	/** Dominant non-subject tracker key when {@link historicalNeighbor} is set. */
	relatedTicketKey?: string;
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
	/**
	 * The subset of {@link droppedByBudget} that named the subject ticket or
	 * matched it as a phrase / structured entity. Zero means the unexamined
	 * candidates were the weak lexical tail, so `budget_bounded` is bookkeeping
	 * rather than a visible gap.
	 */
	droppedByBudgetSubjectMatched: number;
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
