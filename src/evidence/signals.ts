import { extractTicketKeys } from "../search/extract.ts";
import {
	DECISION_EXCERPT_LIMIT,
	excerptWithTruncation,
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../search/match-utils.ts";
import {
	containsNormalizedExactText,
	containsNormalizedText,
	normalizeSearchText,
} from "../search/text.ts";
import type { EvidencePost } from "./packing.ts";

/** Advisory span kinds — names always contain `candidate` (never facts). */
export type CandidateSpanKind =
	| "decision_candidate"
	| "rejected_option_candidate"
	| "open_question_candidate";

export interface CandidateSpan {
	kind: CandidateSpanKind;
	postId: string;
	/** Verbatim truncated excerpt from the packed post only. */
	excerpt: string;
	cues: string[];
	confidence: number;
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
	cues: string[];
	confidence: number;
	/** Short acknowledgement from a different author, when paired. */
	ackPostId?: string;
	/**
	 * Later packed posts that narrow the decision's scope ("нет, это только про
	 * координацию"). Mechanical cue matches, not a re-negotiated outcome — but a
	 * decision read without them is routinely implemented wider than agreed.
	 */
	refinements?: BriefScopeRefinement[];
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
	cues: string[];
	confidence: number;
	/** Packed posts by other authors after it; 0 means nobody answered here. */
	repliesAfter: number;
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
	outcomeWindow?: OutcomeWindow;
}

export interface BuildThreadSignalsOptions {
	subjectTicket?: string;
	/** Hard cap on candidate spans emitted (default {@link MAX_CANDIDATE_SPANS}). */
	maxCandidateSpans?: number;
	/** Hard cap on posts listed in an outcome window. */
	maxOutcomePosts?: number;
	excerptLimit?: number;
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
/** Packed posts scanned after a decision for a scope refinement. */
const REFINEMENT_LOOKAHEAD = 6;
/**
 * Minimum confidence for an inlined open question. Bare `?` (0.4) qualifies:
 * unlike a decision, a question that turns out to be rhetorical costs one line,
 * while a missed one is exactly how an unresolved fork gets implemented blind.
 */
const OPEN_QUESTION_INLINE_FLOOR = 0.4;
/** Confidence floor for a question standing as the thread's last packed post. */
const TAIL_QUESTION_CONFIDENCE = 0.55;
/**
 * Minimum `decision_candidate` confidence to surface in lean brief
 * (matches the weakest {@link DECISION_CUES} weight).
 */
export const DECISION_CONFIDENCE_FLOOR = 0.5;
/** Short-thread ceiling for the `noise` purpose hint. */
const NOISE_MAX_POSTS = 3;
/** Short-message ceiling (code points) for a ticket-ping noise post. */
const NOISE_MAX_MESSAGE_CHARS = 160;
/** Minimum question-span confidence that alone justifies `open_question`. */
const OPEN_QUESTION_CONFIDENCE_FLOOR = 0.5;
/** Distinct question-carrying posts that justify `open_question` regardless. */
const OPEN_QUESTION_MIN_POSTS = 3;
/** Confidence added to a `decision_candidate` paired with a short ack. */
const DECISION_ACK_BONUS = 0.15;
/** Posts scanned after a decision for a short acknowledgement. */
const DECISION_ACK_LOOKAHEAD = 2;
/** Short-message ceiling (code points) for an acknowledgement reply. */
const ACK_MAX_MESSAGE_CHARS = 30;

const PURPOSE_HINT_PRIORITY: Readonly<Record<PurposeHintLabel, number>> = {
	decision: 0,
	open_question: 1,
	debugging: 2,
	announce: 3,
	status: 4,
	noise: 5,
};

/** Leading tokens of a short acknowledgement reply. */
const ACK_TOKENS: readonly string[] = [
	"ок",
	"окей",
	"хорошо",
	"да",
	"спасибо",
	"+",
	"ok",
	"sounds good",
];

const DEBUG_ROLE_LABELS = new Set<RoleHintLabel>([
	"testing",
	"regression",
	"implementation",
]);

interface CuePattern {
	/** Surface form reported in `cues` (stable, human-readable). */
	cue: string;
	/** When true, require token boundaries (short tokens like `qa` / `mr`). */
	exact?: boolean;
	weight?: number;
}

const DECISION_CUES: readonly CuePattern[] = [
	{ cue: "решили", weight: 0.7 },
	{ cue: "итого", weight: 0.6 },
	{ cue: "фиксируем", weight: 0.65 },
	{ cue: "утвердили", weight: 0.7 },
	{ cue: "договорились", weight: 0.7 },
	{ cue: "обсудили", weight: 0.65 },
	{ cue: "можно делать", weight: 0.7 },
	{ cue: "ок, делаем", weight: 0.65 },
	{ cue: "ок делаем", weight: 0.65 },
	{ cue: "делаем так", weight: 0.6 },
	{ cue: "погнали делать", weight: 0.6 },
	{ cue: "так и сделаем", weight: 0.65 },
	{ cue: "approved", weight: 0.65 },
	{ cue: "going with", weight: 0.6 },
	{ cue: "we'll go with", weight: 0.65 },
	{ cue: "ship it", weight: 0.55 },
	{ cue: "final:", weight: 0.5 },
	// First-person forward commitments — the dominant decision shape in these
	// conversations. Single verbs match on token boundaries so third-person
	// inflections (`уберут`) do not read as a personal commitment.
	{ cue: "сделаю", exact: true, weight: 0.6 },
	{ cue: "так и сделаю", weight: 0.65 },
	{ cue: "выпилю", exact: true, weight: 0.6 },
	{ cue: "уберу", exact: true, weight: 0.55 },
	{ cue: "удалю", exact: true, weight: 0.55 },
	{ cue: "поправлю", exact: true, weight: 0.6 },
	{ cue: "перепишу", exact: true, weight: 0.6 },
	{ cue: "переделаю", exact: true, weight: 0.6 },
	{ cue: "буду делать", weight: 0.6 },
	{ cue: "будем делать", weight: 0.6 },
	// Bare future tense sits exactly at DECISION_CONFIDENCE_FLOOR: it is the shape
	// real commitments take here ("будем не запрещать…"), and the interrogative
	// guard already removes the common "что будем делать?" noise. Weaker than any
	// explicit cue, so acknowledged or phrased decisions still outrank it, and
	// `brief.decisions[]` inlines the text so a false positive is cheap to dismiss.
	{ cue: "буду", exact: true, weight: 0.5 },
	{ cue: "будем", exact: true, weight: 0.5 },
	{ cue: "i'll go with", weight: 0.65 },
	{ cue: "let's just", weight: 0.55 },
	{ cue: "going to remove", weight: 0.6 },
];

/**
 * Messages that mention “решение” only as meta/questions — never decision
 * anchors even if a weak cue would otherwise match.
 */
const DECISION_META_REJECT: readonly string[] = [
	"какое решение",
	"какое сейчас решение",
	"какое решение сейчас",
	"финальное решение было",
	"решение было создано",
	"есть решение?",
	"есть решение ?",
	"what decision",
	"which decision",
];

const REJECTED_CUES: readonly CuePattern[] = [
	{ cue: "не будем", weight: 0.7 },
	{ cue: "отклонили", weight: 0.7 },
	{ cue: "отказались", weight: 0.65 },
	{ cue: "не подходит", weight: 0.55 },
	{ cue: "вместо этого", weight: 0.55 },
	{ cue: "лучше не", weight: 0.5 },
	{ cue: "rejected", weight: 0.7 },
	{ cue: "won't", weight: 0.5 },
	{ cue: "not going with", weight: 0.65 },
	{ cue: "rather than", weight: 0.45 },
	{ cue: "discarded", weight: 0.55 },
];

const OPEN_QUESTION_CUES: readonly CuePattern[] = [
	{ cue: "?", weight: 0.4 },
	{ cue: "не ясно", weight: 0.65 },
	{ cue: "неясно", weight: 0.65 },
	{ cue: "вопрос:", weight: 0.6 },
	{ cue: "нужно уточнить", weight: 0.65 },
	{ cue: "кто знает", weight: 0.55 },
	{ cue: "ждём ответа", weight: 0.55 },
	{ cue: "open question", weight: 0.7 },
	{ cue: "unclear", weight: 0.55 },
	{ cue: "tbd", exact: true, weight: 0.5 },
	// Deferral and fork phrasing: the shape an unresolved architectural choice
	// actually takes here ("надо будет с Аней обсудить", "capabilities или
	// отдельный роут?"). Without these a design fork scores like a stray `?`.
	// Pending-work phrasing. A bare infinitive (`обсудить`) is not enough: it
	// fires on `успели всё обсудить`, which is the opposite of an open question.
	{ cue: "надо будет", weight: 0.55 },
	{ cue: "нужно будет", weight: 0.55 },
	{ cue: "предстоит", weight: 0.55 },
	{ cue: "надо обсудить", weight: 0.65 },
	{ cue: "надо будет обсудить", weight: 0.65 },
	{ cue: "нужно обсудить", weight: 0.65 },
	{ cue: "надо решить", weight: 0.65 },
	{ cue: "нужно решить", weight: 0.65 },
	{ cue: "не решили", weight: 0.65 },
	{ cue: "не определились", weight: 0.65 },
	{ cue: "не договорились", weight: 0.6 },
	{ cue: "как лучше", weight: 0.6 },
	{ cue: "какой вариант", weight: 0.6 },
	{ cue: "что выбрать", weight: 0.6 },
	{ cue: "стоит ли", weight: 0.55 },
	{ cue: "имеет ли смысл", weight: 0.55 },
	{ cue: "нужно ли", weight: 0.55 },
	{ cue: "непонятно", weight: 0.6 },
	{ cue: "need to decide", weight: 0.65 },
	{ cue: "still open", weight: 0.6 },
	{ cue: "which one", weight: 0.55 },
];

/**
 * Cues that narrow an already-taken decision ("нет, это только про
 * координацию"). Matched only in packed posts that follow a decision candidate.
 */
const SCOPE_REFINEMENT_CUES: readonly CuePattern[] = [
	// Deliberately narrow: generic discourse markers (`только в`, `точнее`) also
	// open unrelated small talk, and a false "scope:" line reads as an
	// authoritative narrowing of what was agreed.
	{ cue: "только про", weight: 0.65 },
	{ cue: "только для", weight: 0.65 },
	{ cue: "не про", weight: 0.55 },
	{ cue: "не для", weight: 0.5 },
	{ cue: "имеется в виду", weight: 0.65 },
	{ cue: "то бишь", weight: 0.55 },
	{ cue: "речь про", weight: 0.6 },
	{ cue: "речь идёт", weight: 0.6 },
	{ cue: "уточню", weight: 0.6 },
	{ cue: "уточнение", weight: 0.6 },
	{ cue: "only for", weight: 0.6 },
	{ cue: "only about", weight: 0.6 },
	{ cue: "to be clear", weight: 0.6 },
	{ cue: "i mean", weight: 0.55 },
];

const ROLE_HINT_CUES: Readonly<Record<RoleHintLabel, readonly CuePattern[]>> = {
	testing: [
		{ cue: "тест", weight: 0.55 },
		{ cue: "testing", weight: 0.6 },
		{ cue: "qa", exact: true, weight: 0.65 },
		{ cue: "reproduce", weight: 0.6 },
		{ cue: "репро", weight: 0.6 },
		{ cue: "pytest", exact: true, weight: 0.55 },
		{ cue: "e2e", exact: true, weight: 0.55 },
		{ cue: "проверяю", weight: 0.5 },
	],
	regression: [
		{ cue: "регресс", weight: 0.7 },
		{ cue: "regression", weight: 0.7 },
		{ cue: "сломалось снова", weight: 0.65 },
		{ cue: "after deploy", weight: 0.55 },
		{ cue: "после релиза", weight: 0.55 },
	],
	implementation: [
		{ cue: "залил", weight: 0.55 },
		{ cue: "merged", weight: 0.6 },
		{ cue: "mr", exact: true, weight: 0.5 },
		{ cue: "pr", exact: true, weight: 0.5 },
		{ cue: "implement", weight: 0.55 },
		{ cue: "фикс", weight: 0.5 },
		{ cue: "fix:", weight: 0.55 },
		{ cue: "commit", exact: true, weight: 0.45 },
		{ cue: "deploy", exact: true, weight: 0.45 },
	],
	coordination: [
		{ cue: "кто возьмёт", weight: 0.65 },
		{ cue: "созвон", weight: 0.6 },
		{ cue: "sync", exact: true, weight: 0.45 },
		{ cue: "ping", exact: true, weight: 0.45 },
		{ cue: "assign", weight: 0.5 },
		{ cue: "назначаю", weight: 0.6 },
		{ cue: "статус", weight: 0.4 },
		{ cue: "катим", weight: 0.55 },
		{ cue: "катим в", weight: 0.55 },
		{ cue: "в проде", weight: 0.45 },
		{ cue: "закатили", weight: 0.55 },
		{ cue: "rolling out", weight: 0.5 },
	],
};

const SPAN_KIND_CUES: ReadonlyArray<{
	kind: CandidateSpanKind;
	patterns: readonly CuePattern[];
}> = [
	{ kind: "decision_candidate", patterns: DECISION_CUES },
	{ kind: "rejected_option_candidate", patterns: REJECTED_CUES },
	{ kind: "open_question_candidate", patterns: OPEN_QUESTION_CUES },
];

/**
 * Build advisory candidate spans, mechanical outcome window, and multi-label
 * role hints from already-returned packed posts only. Does not score ranking
 * or adequacy; never invents evidence from omitted posts.
 */
export function buildThreadSignals(
	posts: readonly EvidencePost[],
	options: BuildThreadSignalsOptions = {},
): ThreadSignals {
	const chronological = [...posts].sort(
		(left, right) =>
			left.createAt - right.createAt || left.id.localeCompare(right.id),
	);
	const includedIds = new Set(chronological.map((post) => post.id));
	const maxSpans = options.maxCandidateSpans ?? MAX_CANDIDATE_SPANS;
	const maxOutcome = options.maxOutcomePosts ?? MAX_OUTCOME_WINDOW_POSTS;
	const excerptLimit = options.excerptLimit ?? POINTER_EXCERPT_LIMIT;

	const candidateSpans = collectCandidateSpans(chronological, {
		maxSpans,
		excerptLimit,
	}).filter((span) => includedIds.has(span.postId));

	const outcomeWindow = buildOutcomeWindow(chronological, {
		subjectTicket: options.subjectTicket,
		maxOutcome,
		includedIds,
	});

	const roleHints = collectRoleHints(chronological).filter((hint) =>
		hint.evidencePostIds.every((id) => includedIds.has(id)),
	);

	return {
		candidateSpans,
		...(outcomeWindow ? { outcomeWindow } : {}),
		roleHints,
	};
}

/**
 * Lean thread briefing for default `--agent`: capped purpose hints,
 * decision_candidate post ids, and the mechanical outcome window.
 * Reuses {@link buildThreadSignals}; does not invent omitted-post evidence.
 */
export function buildThreadBrief(
	posts: readonly EvidencePost[],
	options: BuildThreadBriefOptions = {},
): ThreadBrief {
	const signals = buildThreadSignals(posts, {
		...options,
		maxOutcomePosts: options.maxOutcomePosts ?? MAX_BRIEF_OUTCOME_WINDOW_POSTS,
	});
	const maxPurpose = options.maxPurposeHints ?? MAX_PURPOSE_HINTS;
	const maxDecisions = options.maxDecisionPostIds ?? MAX_DECISION_POST_IDS;

	const decisionSpans = signals.candidateSpans
		.filter(
			(span) =>
				span.kind === "decision_candidate" &&
				span.confidence >= DECISION_CONFIDENCE_FLOOR,
		)
		.sort(
			(left, right) =>
				right.confidence - left.confidence ||
				left.postId.localeCompare(right.postId),
		);

	const decisionPostIds: string[] = [];
	const seenDecisions = new Set<string>();
	for (const span of decisionSpans) {
		if (seenDecisions.has(span.postId)) continue;
		seenDecisions.add(span.postId);
		decisionPostIds.push(span.postId);
		if (decisionPostIds.length >= maxDecisions) break;
	}

	const cappedDecisionIds = new Set(decisionPostIds);
	const cappedDecisionSpans = decisionSpans.filter((span) =>
		cappedDecisionIds.has(span.postId),
	);

	const briefExcerptLimit = options.briefExcerptLimit ?? DECISION_EXCERPT_LIMIT;
	const chronological = chronologicalPosts(posts);
	const openQuestions = buildOpenQuestions(
		chronological,
		signals.candidateSpans,
		{
			briefExcerptLimit,
			// A post already inlined as a decision must not reappear as an open
			// question: the same excerpt framed both ways contradicts itself.
			excludePostIds: cappedDecisionIds,
			// A truncated packet has no standing to say which post the thread ended
			// on — the same rule the `tail` field follows.
			packingComplete: (options.omittedPosts ?? 0) === 0,
		},
	);

	const purposeHints = collectPurposeHints(posts, signals, {
		reasons: options.reasons,
		presentation: options.presentation,
		subjectTicket: options.subjectTicket,
		hasDecision: decisionPostIds.length > 0,
		decisionPostIds,
		decisionSpans: cappedDecisionSpans,
		openQuestions,
	}).slice(0, maxPurpose);

	const decisions = buildBriefDecisions(
		chronological,
		cappedDecisionSpans,
		briefExcerptLimit,
	);

	return {
		purposeHints,
		decisionPostIds,
		...(decisions.length ? { decisions } : {}),
		...(openQuestions.length ? { openQuestions } : {}),
		...(signals.outcomeWindow ? { outcomeWindow: signals.outcomeWindow } : {}),
	};
}

function chronologicalPosts(
	posts: readonly EvidencePost[],
): readonly EvidencePost[] {
	return [...posts].sort(
		(left, right) =>
			left.createAt - right.createAt || left.id.localeCompare(right.id),
	);
}

/**
 * Inline the questions a reader would otherwise have to find by tailing the
 * transcript. `repliesAfter` and `isThreadTail` stay mechanical: they describe
 * position, never whether anyone actually answered.
 */
function buildOpenQuestions(
	chronological: readonly EvidencePost[],
	spans: readonly CandidateSpan[],
	options: {
		excludePostIds: ReadonlySet<string>;
		packingComplete: boolean;
		briefExcerptLimit: number;
	},
): BriefOpenQuestion[] {
	const byId = new Map(chronological.map((post) => [post.id, post]));
	const live = chronological.filter(
		(post) => !post.deleteAt && post.message.trim(),
	);
	const lastId = options.packingComplete
		? live[live.length - 1]?.id
		: undefined;
	const questions: BriefOpenQuestion[] = [];
	const seen = new Set<string>();
	for (const span of spans) {
		if (span.kind !== "open_question_candidate") continue;
		if (span.confidence < OPEN_QUESTION_INLINE_FLOOR) continue;
		if (options.excludePostIds.has(span.postId)) continue;
		if (seen.has(span.postId)) continue;
		const post = byId.get(span.postId);
		if (!post) continue;
		seen.add(span.postId);
		const index = live.findIndex((candidate) => candidate.id === post.id);
		const repliesAfter =
			index < 0
				? 0
				: live.slice(index + 1).filter((later) => later.userId !== post.userId)
						.length;
		const excerpt = excerptWithTruncation(
			post.message,
			options.briefExcerptLimit,
		);
		questions.push({
			postId: post.id,
			author: post.authorUsername,
			createAt: post.createAt,
			excerpt: excerpt.text,
			...(excerpt.truncated ? { excerptTruncated: true as const } : {}),
			cues: [...span.cues],
			confidence: span.confidence,
			repliesAfter,
			...(post.id === lastId ? { isThreadTail: true as const } : {}),
		});
	}
	// Dangling questions first, then the strongest cue; a question nobody
	// answered inside the packet is the one worth carrying.
	return questions
		.sort(
			(left, right) =>
				Number(right.isThreadTail ?? false) -
					Number(left.isThreadTail ?? false) ||
				left.repliesAfter - right.repliesAfter ||
				right.confidence - left.confidence ||
				right.createAt - left.createAt,
		)
		.slice(0, MAX_OPEN_QUESTIONS);
}

/**
 * Inline the already-capped decision spans so a consumer can read the decision
 * without scanning `posts`. `createAt` stays numeric — ISO formatting is the
 * output layer's concern.
 */
function buildBriefDecisions(
	chronological: readonly EvidencePost[],
	cappedDecisionSpans: readonly CandidateSpan[],
	excerptLimit: number,
): BriefDecision[] {
	const byId = new Map(chronological.map((post) => [post.id, post]));
	const decisionIds = new Set(cappedDecisionSpans.map(({ postId }) => postId));
	const decisions: BriefDecision[] = [];
	for (const span of cappedDecisionSpans) {
		const post = byId.get(span.postId);
		if (!post) continue;
		const refinements = collectScopeRefinements(
			chronological,
			post,
			decisionIds,
			excerptLimit,
		);
		const excerpt = excerptWithTruncation(post.message, excerptLimit);
		decisions.push({
			postId: span.postId,
			author: post.authorUsername,
			createAt: post.createAt,
			excerpt: excerpt.text,
			...(excerpt.truncated ? { excerptTruncated: true as const } : {}),
			cues: [...span.cues],
			confidence: span.confidence,
			...(span.ackPostId ? { ackPostId: span.ackPostId } : {}),
			...(refinements.length ? { refinements } : {}),
		});
	}
	return decisions;
}

/**
 * Packed posts shortly after a decision that narrow its scope. Bounded by
 * {@link REFINEMENT_LOOKAHEAD} and stopped by the next decision candidate, so a
 * refinement is never attributed across two separate decisions.
 */
function collectScopeRefinements(
	chronological: readonly EvidencePost[],
	decision: EvidencePost,
	decisionIds: ReadonlySet<string>,
	excerptLimit: number,
): BriefScopeRefinement[] {
	const start = chronological.findIndex((post) => post.id === decision.id);
	if (start < 0) return [];
	const refinements: BriefScopeRefinement[] = [];
	let scanned = 0;
	for (const post of chronological.slice(start + 1)) {
		scanned += 1;
		if (scanned > REFINEMENT_LOOKAHEAD) break;
		if (post.deleteAt || !post.message.trim()) continue;
		if (decisionIds.has(post.id)) break;
		const matched = matchCues(post.message, SCOPE_REFINEMENT_CUES);
		if (!matched.cues.length) continue;
		const excerpt = excerptWithTruncation(post.message, excerptLimit);
		refinements.push({
			postId: post.id,
			author: post.authorUsername,
			createAt: post.createAt,
			excerpt: excerpt.text,
			...(excerpt.truncated ? { excerptTruncated: true as const } : {}),
			cues: matched.cues,
		});
		if (refinements.length >= MAX_REFINEMENTS_PER_DECISION) break;
	}
	return refinements;
}

/**
 * Post ids a decision-only projection keeps: the outcome window, the decision
 * candidates with their acknowledgements, and the requested anchor. Shared by
 * every `--brief` renderer so prose and `--agent` withhold the same posts.
 *
 * A thread that yielded no brief at all still keeps its last packed post: a
 * projection that shows nothing but a withheld count is indistinguishable from
 * an empty thread.
 */
export function briefRetainedPostIds(
	brief: Pick<
		ThreadBrief,
		"decisionPostIds" | "decisions" | "openQuestions" | "outcomeWindow"
	>,
	posts: readonly EvidencePost[],
	anchorPostId?: string,
): Set<string> {
	const retained = new Set<string>([
		...(brief.outcomeWindow?.postIds ?? []),
		...brief.decisionPostIds,
	]);
	for (const decision of brief.decisions ?? []) {
		retained.add(decision.postId);
		if (decision.ackPostId) retained.add(decision.ackPostId);
		// A decision shown without the post that narrowed it invites building
		// wider than what was agreed.
		for (const refinement of decision.refinements ?? []) {
			retained.add(refinement.postId);
		}
	}
	for (const question of brief.openQuestions ?? [])
		retained.add(question.postId);
	if (anchorPostId) retained.add(anchorPostId);
	if (!retained.size) {
		let latest: EvidencePost | undefined;
		for (const post of posts) {
			if (!latest || post.createAt > latest.createAt) latest = post;
		}
		if (latest) retained.add(latest.id);
	}
	return retained;
}

function collectPurposeHints(
	posts: readonly EvidencePost[],
	signals: ThreadSignals,
	options: {
		reasons?: readonly string[];
		presentation?: "announce";
		subjectTicket?: string;
		hasDecision: boolean;
		/** Already capped to {@link MAX_DECISION_POST_IDS}. */
		decisionPostIds: readonly string[];
		decisionSpans: readonly CandidateSpan[];
		openQuestions: readonly BriefOpenQuestion[];
	},
): PurposeHint[] {
	const chronological = [...posts]
		.filter((post) => !post.deleteAt)
		.sort(
			(left, right) =>
				left.createAt - right.createAt || left.id.localeCompare(right.id),
		);
	const hints: PurposeHint[] = [];
	const chronologicalRank = new Map(
		chronological.map((post, index) => [post.id, index]),
	);
	const capEvidence = (ids: readonly string[]): string[] =>
		capEvidencePostIds(ids, chronologicalRank);

	const isAnnounce =
		options.presentation === "announce" ||
		Boolean(options.reasons?.includes("multi_ticket_root"));
	if (isAnnounce) {
		const root = chronological[0];
		hints.push({
			label: "announce",
			confidence: options.presentation === "announce" ? 0.85 : 0.7,
			evidencePostIds: root ? [root.id] : [],
		});
	}

	if (options.decisionPostIds.length) {
		hints.push({
			label: "decision",
			confidence: options.decisionSpans.length
				? Math.max(...options.decisionSpans.map((span) => span.confidence))
				: DECISION_CONFIDENCE_FLOOR,
			evidencePostIds: capEvidence(options.decisionPostIds),
		});
	}

	// Questions are their own purpose: folding them into `debugging` labeled every
	// thread containing a `?` as debugging.
	const questionSpans = signals.candidateSpans.filter(
		(span) => span.kind === "open_question_candidate",
	);
	const questionPostIds = [
		...new Set(questionSpans.map((span) => span.postId)),
	];
	const strongestQuestion = Math.max(
		0,
		...questionSpans.map((span) => span.confidence),
	);
	// A thread whose last packed post is a question stopped on that question.
	// Without this, the single unresolved fork in an architecture thread scored
	// like a stray `?` and the thread reported no purpose at all.
	const tailQuestion = options.openQuestions.find(
		(question) => question.isThreadTail,
	);
	// Bare `?` alone is noise; require a real cue, a recurring pattern, or a tail.
	if (
		strongestQuestion >= OPEN_QUESTION_CONFIDENCE_FLOOR ||
		questionPostIds.length >= OPEN_QUESTION_MIN_POSTS ||
		tailQuestion
	) {
		hints.push({
			label: "open_question",
			confidence: tailQuestion
				? Math.max(strongestQuestion, TAIL_QUESTION_CONFIDENCE)
				: strongestQuestion,
			evidencePostIds: capEvidence(questionPostIds),
		});
	}

	const debugRoles = signals.roleHints.filter((hint) =>
		DEBUG_ROLE_LABELS.has(hint.label),
	);
	if (debugRoles.length) {
		hints.push({
			label: "debugging",
			confidence: Math.max(...debugRoles.map((hint) => hint.confidence)),
			evidencePostIds: capEvidence([
				...new Set(debugRoles.flatMap((hint) => hint.evidencePostIds)),
			]),
		});
	}

	const coordination = signals.roleHints.find(
		(hint) => hint.label === "coordination",
	);
	if (coordination && !options.hasDecision) {
		hints.push({
			label: "status",
			confidence: coordination.confidence,
			evidencePostIds: capEvidence(coordination.evidencePostIds),
		});
	}

	// Noise is exclusive: only when no higher-priority purpose already applies.
	if (!hints.length && isNoiseThread(chronological, options.subjectTicket)) {
		hints.push({
			label: "noise",
			confidence: 0.6,
			evidencePostIds: capEvidence(chronological.map((post) => post.id)),
		});
	}

	return hints.sort(
		(left, right) =>
			PURPOSE_HINT_PRIORITY[left.label] - PURPOSE_HINT_PRIORITY[right.label] ||
			right.confidence - left.confidence ||
			left.label.localeCompare(right.label),
	);
}

/**
 * Order hint evidence chronologically and cap it at
 * {@link MAX_HINT_EVIDENCE_POST_IDS}, keeping the last ids — the tail is where
 * unresolved work lives, and an uncapped array bloats the packet on long
 * threads.
 */
function capEvidencePostIds(
	ids: readonly string[],
	chronologicalRank: ReadonlyMap<string, number>,
): string[] {
	return [...ids]
		.sort(
			(left, right) =>
				(chronologicalRank.get(left) ?? 0) -
					(chronologicalRank.get(right) ?? 0) || left.localeCompare(right),
		)
		.slice(-MAX_HINT_EVIDENCE_POST_IDS);
}

function isNoiseThread(
	posts: readonly EvidencePost[],
	subjectTicket?: string,
): boolean {
	if (!posts.length || posts.length > NOISE_MAX_POSTS) return false;
	const subject = subjectTicket?.toUpperCase();
	let ticketMentions = 0;
	for (const post of posts) {
		const message = post.message.trim();
		if (!message) continue;
		if ([...message].length > NOISE_MAX_MESSAGE_CHARS) return false;
		const keys = extractTicketKeys(message);
		if (subject) {
			if (keys.includes(subject)) ticketMentions += 1;
		} else if (keys.length) {
			ticketMentions += 1;
		}
		// Extra non-subject tickets look like a real bulletin, not a DM ping.
		if (subject && keys.some((key) => key !== subject)) return false;
	}
	return ticketMentions >= 1;
}

function collectCandidateSpans(
	posts: readonly EvidencePost[],
	options: { maxSpans: number; excerptLimit: number },
): CandidateSpan[] {
	const spans: CandidateSpan[] = [];
	for (const [index, post] of posts.entries()) {
		if (!post.message.trim() || post.deleteAt) continue;
		for (const { kind, patterns } of SPAN_KIND_CUES) {
			const isDecision = kind === "decision_candidate";
			if (isDecision && isDecisionMetaNoise(post.message)) continue;
			const matched = matchCues(post.message, patterns, {
				// Sentence-level, so a long decision post ending in an unrelated
				// question still scores; only the cue's own sentence is checked.
				rejectInterrogativeCueSentence: isDecision,
				rejectNegatedCue: isDecision,
			});
			if (!matched.cues.length) continue;
			const ackPostId = isDecision ? findAckPostId(posts, index) : undefined;
			// Ack pairing is a post-scoring bump — never a synthetic cue weight.
			const confidence = ackPostId
				? roundConfidence(
						Math.min(0.95, matched.confidence + DECISION_ACK_BONUS),
					)
				: matched.confidence;
			spans.push({
				kind,
				postId: post.id,
				excerpt: truncateExcerpt(post.message, options.excerptLimit),
				cues: matched.cues,
				confidence,
				...(ackPostId ? { ackPostId } : {}),
			});
		}
	}
	return spans
		.sort(
			(left, right) =>
				right.confidence - left.confidence ||
				left.postId.localeCompare(right.postId) ||
				left.kind.localeCompare(right.kind),
		)
		.slice(0, options.maxSpans);
}

function buildOutcomeWindow(
	posts: readonly EvidencePost[],
	options: {
		subjectTicket?: string;
		maxOutcome: number;
		includedIds: ReadonlySet<string>;
	},
): OutcomeWindow | undefined {
	const subject = options.subjectTicket?.toUpperCase();
	if (!subject || !posts.length || options.maxOutcome <= 0) return undefined;

	let lastMentionIndex = -1;
	for (let index = 0; index < posts.length; index += 1) {
		const post = posts[index];
		if (!post || post.deleteAt) continue;
		if (extractTicketKeys(post.message).includes(subject)) {
			lastMentionIndex = index;
		}
	}
	if (lastMentionIndex < 0 || lastMentionIndex >= posts.length - 1) {
		return undefined;
	}

	const afterPost = posts[lastMentionIndex];
	if (!afterPost || !options.includedIds.has(afterPost.id)) return undefined;

	const eligible = posts
		.slice(lastMentionIndex + 1)
		.filter((post) => !post.deleteAt && options.includedIds.has(post.id));
	// Tail-anchored: an `outcome_window` truncated at the head would show the
	// thread's opening posts under a field named for its outcome.
	const windowPosts = eligible.slice(-options.maxOutcome);
	const first = windowPosts[0];
	const last = windowPosts[windowPosts.length - 1];
	if (!first || !last) return undefined;

	return {
		label: "outcome_window",
		subjectTicket: subject,
		afterPostId: afterPost.id,
		startPostId: first.id,
		endPostId: last.id,
		postIds: windowPosts.map((post) => post.id),
		precedingInWindow: eligible.length - windowPosts.length,
	};
}

function collectRoleHints(posts: readonly EvidencePost[]): RoleHint[] {
	const labels = Object.keys(ROLE_HINT_CUES) as RoleHintLabel[];
	const hints: RoleHint[] = [];
	for (const label of labels) {
		const patterns = ROLE_HINT_CUES[label];
		const evidencePostIds: string[] = [];
		const cueSet = new Map<string, number>();
		for (const post of posts) {
			if (!post.message.trim() || post.deleteAt) continue;
			const matched = matchCues(post.message, patterns);
			if (!matched.cues.length) continue;
			evidencePostIds.push(post.id);
			for (const [index, cue] of matched.cues.entries()) {
				const weight = matched.weights[index] ?? 0.5;
				cueSet.set(cue, Math.max(cueSet.get(cue) ?? 0, weight));
			}
		}
		if (!evidencePostIds.length) continue;
		const cues = [...cueSet.entries()]
			.sort(
				(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
			)
			.slice(0, MAX_CUES_PER_SIGNAL)
			.map(([cue]) => cue);
		const weights = cues.map((cue) => cueSet.get(cue) ?? 0.5);
		hints.push({
			label,
			evidencePostIds: [...new Set(evidencePostIds)],
			cues,
			confidence: scoreConfidence(weights),
		});
	}
	return hints.sort(
		(left, right) =>
			right.confidence - left.confidence ||
			left.label.localeCompare(right.label),
	);
}

function isDecisionMetaNoise(message: string): boolean {
	const normalized = message.toLowerCase();
	return DECISION_META_REJECT.some((phrase) =>
		containsNormalizedText(normalized, phrase),
	);
}

function matchCues(
	message: string,
	patterns: readonly CuePattern[],
	options: {
		rejectInterrogativeCueSentence?: boolean;
		rejectNegatedCue?: boolean;
	} = {},
): { cues: string[]; weights: number[]; confidence: number } {
	const sentences =
		options.rejectInterrogativeCueSentence || options.rejectNegatedCue
			? splitSentences(message)
			: undefined;
	const matched: Array<{ cue: string; weight: number }> = [];
	for (const pattern of patterns) {
		if (!cueMatches(message, pattern)) continue;
		if (sentences && !cueSurvivesSentenceGuards(sentences, pattern, options)) {
			continue;
		}
		matched.push({ cue: pattern.cue, weight: pattern.weight ?? 0.5 });
	}
	matched.sort(
		(left, right) =>
			right.weight - left.weight || left.cue.localeCompare(right.cue),
	);
	const limited = matched.slice(0, MAX_CUES_PER_SIGNAL);
	const weights = limited.map((item) => item.weight);
	return {
		cues: limited.map((item) => item.cue),
		weights,
		confidence: scoreConfidence(weights),
	};
}

interface CueSentence {
	text: string;
	/** Terminating punctuation, empty for a trailing fragment. */
	terminator: string;
}

/** Split a message into sentences on `[.!?\n]`, keeping each terminator. */
function splitSentences(message: string): CueSentence[] {
	const sentences: CueSentence[] = [];
	let current = "";
	for (const character of message) {
		if (SENTENCE_TERMINATORS.has(character)) {
			sentences.push({ text: current, terminator: character });
			current = "";
			continue;
		}
		current += character;
	}
	if (current.trim()) sentences.push({ text: current, terminator: "" });
	return sentences;
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "\n"]);

/**
 * Keep a cue only when at least one sentence carrying it is neither a question
 * nor a negation. A cue that spans a sentence boundary is kept (conservative).
 */
function cueSurvivesSentenceGuards(
	sentences: readonly CueSentence[],
	pattern: CuePattern,
	options: {
		rejectInterrogativeCueSentence?: boolean;
		rejectNegatedCue?: boolean;
	},
): boolean {
	let located = false;
	for (const sentence of sentences) {
		if (!cueMatches(sentence.text, pattern)) continue;
		located = true;
		if (options.rejectInterrogativeCueSentence && sentence.terminator === "?") {
			continue;
		}
		if (
			options.rejectNegatedCue &&
			containsNormalizedText(sentence.text, `не ${pattern.cue}`)
		) {
			continue;
		}
		return true;
	}
	return !located;
}

/**
 * Short acknowledgement from a different author within the next
 * {@link DECISION_ACK_LOOKAHEAD} posts *by other authors*. The decider's own
 * follow-up posts are skipped without consuming the window: the bound exists to
 * limit how late another party may answer, not how verbosely the decider
 * elaborates their own commitment.
 */
function findAckPostId(
	posts: readonly EvidencePost[],
	decisionIndex: number,
): string | undefined {
	const decision = posts[decisionIndex];
	if (!decision) return undefined;
	let scanned = 0;
	for (let index = decisionIndex + 1; index < posts.length; index += 1) {
		const candidate = posts[index];
		if (!candidate || candidate.deleteAt || !candidate.message.trim()) continue;
		if (candidate.userId === decision.userId) continue;
		scanned += 1;
		if (scanned > DECISION_ACK_LOOKAHEAD) break;
		if (isShortAcknowledgement(candidate.message)) return candidate.id;
	}
	return undefined;
}

function isShortAcknowledgement(message: string): boolean {
	const trimmed = message.trim();
	if (!trimmed || [...trimmed].length > ACK_MAX_MESSAGE_CHARS) return false;
	const normalized = normalizeSearchText(trimmed);
	return ACK_TOKENS.some((token) => {
		if (!normalized.startsWith(token)) return false;
		const next = [...normalized][[...token].length];
		return next === undefined || !/[\p{L}\p{N}_]/u.test(next);
	});
}

function cueMatches(message: string, pattern: CuePattern): boolean {
	if (pattern.cue === "?") return message.includes("?");
	if (pattern.exact) {
		return containsNormalizedExactText(message, pattern.cue);
	}
	return containsNormalizedText(message, pattern.cue);
}

function scoreConfidence(weights: readonly number[]): number {
	if (!weights.length) return 0;
	const strongest = Math.max(...weights);
	const bonus = Math.min(0.25, (weights.length - 1) * 0.08);
	return roundConfidence(Math.min(0.95, strongest + bonus));
}

function roundConfidence(value: number): number {
	return Math.round(value * 100) / 100;
}

/** True when a span kind name is advisory (`*candidate*`). */
export function isCandidateSpanKind(kind: string): boolean {
	return kind.includes("candidate");
}

/** Collect every post id cited by a signals payload (for citation checks). */
export function citedSignalPostIds(signals: ThreadSignals): string[] {
	const ids = new Set<string>();
	for (const span of signals.candidateSpans) {
		ids.add(span.postId);
		if (span.ackPostId) ids.add(span.ackPostId);
	}
	for (const hint of signals.roleHints) {
		for (const id of hint.evidencePostIds) ids.add(id);
	}
	if (signals.outcomeWindow) {
		ids.add(signals.outcomeWindow.afterPostId);
		for (const id of signals.outcomeWindow.postIds) ids.add(id);
	}
	return [...ids];
}
