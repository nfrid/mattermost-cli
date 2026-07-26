/**
 * The advisory signal vocabulary: candidate spans, purpose hints, role hints,
 * the mechanical outcome window, and the lean thread brief built from them.
 *
 * Types and caps only — every value that decides what fires lives in
 * `./cues.ts`, and the logic in `./matching.ts`, `./spans.ts`, `./brief.ts`.
 */
import type { CueRecorder } from "../cue-telemetry.ts";

/** Advisory span kinds — names always contain `candidate` (never facts). */
export type CandidateSpanKind =
	| "decision_candidate"
	| "rejected_option_candidate"
	| "open_question_candidate";

/**
 * How strong a `decision_candidate`'s claim to being *settled* is. All three
 * are mechanical readings of the matched cue, never a verified outcome — but
 * conflating them is how "просто выпилю нафиг это" gets implemented as if the
 * team had agreed to it.
 *
 * - `approved_decision` — collective/approval phrasing («решили», «договорились»,
 *   «можно делать»), or a personal commitment another author affirmed.
 * - `discussion_outcome` — summary framing («обсудили…», «итого…») with no
 *   approval or commitment of its own. Someone is reporting where a discussion
 *   landed; «обсудили с продактом, пока ничего не понятно» is the same shape as
 *   «обсудили и утвердили», so this class must never be read as a go-ahead.
 * - `implementation_intent` — one author states what *they* will do, unhedged
 *   and unaffirmed inside this packet.
 * - `proposal` — the cue sentence hedges («наверное», «предлагаю», «может»), so
 *   it reads as an option on the table rather than a course taken.
 */
export type DecisionKind =
	| "approved_decision"
	| "discussion_outcome"
	| "implementation_intent"
	| "proposal";

/**
 * Whether an `open_question_candidate` is actually being *asked*, or is
 * deferred work stated as a fact («рано или поздно надо будет привести
 * модерацию в порядок» is not a question, and reporting it as one invites an
 * answer nobody was waiting for).
 */
export type QuestionKind = "question" | "follow_up";

export interface CandidateSpan {
	kind: CandidateSpanKind;
	postId: string;
	/** Verbatim truncated excerpt from the packed post only. */
	excerpt: string;
	cues: string[];
	confidence: number;
	/** Present only on `decision_candidate` spans. */
	decisionKind?: DecisionKind;
	/** Present only on `open_question_candidate` spans. */
	questionKind?: QuestionKind;
	/**
	 * Returned post that acknowledged this `decision_candidate` (short reply from
	 * a different author within two posts). Advisory pairing, not a verification.
	 */
	ackPostId?: string;
}

/**
 * Mechanical posts-after-last-subject-ticket-mention window inside the returned
 * set. Labeled as a window — not a verified decision.
 *
 * Truncation is tail-anchored: when more eligible posts follow the last subject
 * mention than the cap allows, the **last** ones are emitted and
 * {@link OutcomeWindow.precedingInWindow} counts the eligible posts that sit
 * ahead of the emitted slice. `startPostId` / `endPostId` always describe the
 * emitted slice, never the untruncated window.
 */
export interface OutcomeWindow {
	label: "outcome_window";
	subjectTicket: string;
	/** Last returned post that mentions the subject ticket. */
	afterPostId: string;
	startPostId: string;
	endPostId: string;
	postIds: string[];
	/**
	 * Eligible posts ahead of the emitted (tail) slice. These are **not** omitted
	 * from the packet — they are packed posts outside this tail window. Packet
	 * omissions travel in `omitted.posts` / `evidence.packing.omittedPosts`.
	 */
	precedingInWindow: number;
}

export type RoleHintLabel =
	| "testing"
	| "regression"
	| "implementation"
	| "coordination";

export interface RoleHint {
	label: RoleHintLabel;
	evidencePostIds: string[];
	cues: string[];
	confidence: number;
}

export interface ThreadSignals {
	candidateSpans: CandidateSpan[];
	outcomeWindow?: OutcomeWindow;
	roleHints: RoleHint[];
}

export type PurposeHintLabel =
	| "announce"
	| "decision"
	| "open_question"
	| "debugging"
	| "status"
	| "noise";

export interface PurposeHint {
	label: PurposeHintLabel;
	confidence: number;
	/** Up to {@link MAX_HINT_EVIDENCE_POST_IDS}, chronologically last. */
	evidencePostIds: string[];
}

/**
 * Inlined `decision_candidate` pointer: enough to read the decision without
 * scanning the whole `posts` array. Advisory — mirrors a candidate span.
 */
export interface BriefDecision {
	postId: string;
	author: string;
	/** Epoch milliseconds; ISO projection belongs to the output layer. */
	createAt: number;
	/**
	 * Verbatim excerpt from the packed post, bounded by
	 * {@link DECISION_EXCERPT_LIMIT}. When {@link BriefDecision.excerptTruncated}
	 * is set the post carries more text — read the post before relying on the
	 * decision's conditions.
	 */
	excerpt: string;
	/** The excerpt is shorter than the post; the tail is not shown here. */
	excerptTruncated?: true;
	/**
	 * How settled this is. `decisions[]` is ordered strongest first, so an
	 * `implementation_intent` or `proposal` never displaces an
	 * `approved_decision` — but all three are cue readings, so weigh the author
	 * (`people[]`) before treating even an `approved_decision` as authority.
	 */
	kind: DecisionKind;
	cues: string[];
	confidence: number;
	/** Short acknowledgement from a different author, when paired. */
	ackPostId?: string;
	/** Inlined form of `ackPostId`, so the acknowledgement can be audited. */
	acknowledgement?: BriefAcknowledgement;
	/**
	 * Later packed posts that narrow the decision's scope ("нет, это только про
	 * координацию"). Mechanical cue matches, not a re-negotiated outcome — but a
	 * decision read without them is routinely implemented wider than agreed.
	 */
	refinements?: BriefScopeRefinement[];
	/**
	 * Preceding packed proposal/intent posts that supply the subject for a short
	 * settled cue («можно делать»). Verbatim excerpts only — never an LLM
	 * paraphrase.
	 */
	supportingPostIds?: string[];
	/** Short verbatim excerpt from the first supporting post, when present. */
	supportingExcerpt?: string;
	/**
	 * Soft marker: the decision text names an offline/voice approval
	 * («обсудили голосом», «на дейли»). Does **not** upgrade kind into a
	 * substantive in-channel `approved_decision` on its own.
	 */
	offlineOrVoiceApproval?: true;
}

/**
 * Explicit late-thread acknowledgement: a short ack among the final packed
 * posts confirms the strongest preceding decision candidate when adjacency
 * pairing ({@link DECISION_ACK_LOOKAHEAD}) did not catch it. Separate field and
 * lower confidence — never a silent widening of adjacency.
 */
export interface LateThreadAcknowledgement {
	kind: "late_thread_acknowledgement";
	decisionPostId: string;
	decisionKind: DecisionKind;
	ackPostId: string;
	author: string;
	createAt: number;
	excerpt: string;
	excerptTruncated?: true;
	confidence: number;
}

/** Verbatim short response mechanically paired with a decision candidate. */
export interface BriefAcknowledgement {
	postId: string;
	author: string;
	createAt: number;
	excerpt: string;
	excerptTruncated?: true;
}

/** One scope-narrowing follow-up to a decision candidate. */
export interface BriefScopeRefinement {
	postId: string;
	author: string;
	createAt: number;
	excerpt: string;
	/** The excerpt is shorter than the post; the tail is not shown here. */
	excerptTruncated?: true;
	cues: string[];
}

/**
 * Inlined `open_question_candidate` pointer, symmetric to {@link BriefDecision}:
 * "what is still hanging" deserves the same first-read treatment as
 * "what was decided".
 */
export interface BriefOpenQuestion {
	postId: string;
	author: string;
	createAt: number;
	excerpt: string;
	/** The excerpt is shorter than the post; the tail is not shown here. */
	excerptTruncated?: true;
	/**
	 * `question` is being asked; `follow_up` is deferred work stated as a fact
	 * («надо будет привести модерацию в порядок»). Both are worth carrying, but
	 * only the first is waiting on an answer.
	 */
	kind: QuestionKind;
	cues: string[];
	confidence: number;
	/** Packed posts by other authors after it; 0 means nobody answered here. */
	repliesAfter: number;
	/**
	 * Conservative packet-local state. `possibly_answered` only means another
	 * author replied later; consumers must read `responsePostIds` to verify it.
	 */
	resolution?: "answered" | "possibly_answered" | "unanswered" | "unknown";
	/** Capped later responses supporting `possibly_answered`. */
	responsePostIds?: string[];
	/** The question is the thread's last packed post. */
	isThreadTail?: true;
}

/**
 * Lean default-agent briefing derived from packed posts only.
 * Advisory hints and ids — never prose summaries or verified outcomes.
 */
export interface ThreadBrief {
	purposeHints: PurposeHint[];
	/** Up to {@link MAX_DECISION_POST_IDS} `decision_candidate` post ids. */
	decisionPostIds: string[];
	/**
	 * Same capped set as {@link ThreadBrief.decisionPostIds}, inlined.
	 * Emitted only when non-empty, so projections may drop it.
	 */
	decisions?: BriefDecision[];
	/**
	 * Up to {@link MAX_OPEN_QUESTIONS} unresolved-looking questions, inlined.
	 * Emitted only when non-empty.
	 */
	openQuestions?: BriefOpenQuestion[];
	/**
	 * Late-thread acknowledgement when a short ack in the final posts confirms
	 * an earlier decision outside the adjacency window. Emitted only when found.
	 */
	lateAcknowledgement?: LateThreadAcknowledgement;
	outcomeWindow?: OutcomeWindow;
}

export interface BuildThreadSignalsOptions {
	subjectTicket?: string;
	/** Hard cap on candidate spans emitted (default {@link MAX_CANDIDATE_SPANS}). */
	maxCandidateSpans?: number;
	/** Hard cap on posts listed in an outcome window. */
	maxOutcomePosts?: number;
	excerptLimit?: number;
	/**
	 * Opt-in per-cue firing recorder for calibration tooling. Absent in every
	 * production path: signals must not depend on being observed, and telemetry
	 * must never reach a packet.
	 */
	cueTelemetry?: CueRecorder;
}

export interface BuildThreadBriefOptions extends BuildThreadSignalsOptions {
	/** Ranking reasons from selection (e.g. `multi_ticket_root`). */
	reasons?: readonly string[];
	/** Existing agent presentation hint (`announce` bulletin). */
	presentation?: "announce";
	/** Hard cap on purpose hints (default {@link MAX_PURPOSE_HINTS}). */
	maxPurposeHints?: number;
	/** Hard cap on decision post ids (default {@link MAX_DECISION_POST_IDS}). */
	maxDecisionPostIds?: number;
	/**
	 * Posts packing left out. Non-zero suppresses `isThreadTail`: the last
	 * *packed* post is not the last post of the thread.
	 */
	omittedPosts?: number;
	/**
	 * Character budget for inlined decision-layer texts (default
	 * {@link DECISION_EXCERPT_LIMIT}). Separate from `excerptLimit`, which sizes
	 * pointer excerpts in `signals`.
	 */
	briefExcerptLimit?: number;
}

/** Max advisory candidate spans per thread. */
export const MAX_CANDIDATE_SPANS = 12;
/** Max post ids listed in an outcome window (full `--signals`). */
export const MAX_OUTCOME_WINDOW_POSTS = 20;
/**
 * Tighter outcome-window cap for lean `brief` — enough to point at the
 * post-ticket tail without dumping dozens of ids.
 */
export const MAX_BRIEF_OUTCOME_WINDOW_POSTS = 5;
/** Max distinct cues retained per span/hint. */
export const MAX_CUES_PER_SIGNAL = 5;
/** Max lean purpose hints per thread. */
export const MAX_PURPOSE_HINTS = 3;
/** Max decision_candidate post ids in a lean brief. */
export const MAX_DECISION_POST_IDS = 5;
/** Max evidence post ids per purpose hint (chronologically last). */
export const MAX_HINT_EVIDENCE_POST_IDS = 5;
/** Max inlined open questions in a lean brief. */
export const MAX_OPEN_QUESTIONS = 3;
/** Max scope refinements inlined per decision candidate. */
export const MAX_REFINEMENTS_PER_DECISION = 2;

/**
 * Minimum `decision_candidate` confidence to surface in lean brief
 * (matches the weakest {@link DECISION_CUES} weight).
 */
export const DECISION_CONFIDENCE_FLOOR = 0.5;

/** Confidence added to a `decision_candidate` paired with a short ack. */
export const DECISION_ACK_BONUS = 0.15;

/** Posts scanned after a decision for a short acknowledgement. */
export const DECISION_ACK_LOOKAHEAD = 2;

/** Short-message ceiling (code points) for an acknowledgement reply. */
export const ACK_MAX_MESSAGE_CHARS = 30;
