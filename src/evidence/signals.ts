import { extractTicketKeys } from "../search/extract.ts";
import {
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../search/match-utils.ts";
import {
	containsNormalizedExactText,
	containsNormalizedText,
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
}

/**
 * Mechanical posts-after-last-subject-ticket-mention window inside the returned
 * set. Labeled as a window — not a verified decision.
 */
export interface OutcomeWindow {
	label: "outcome_window";
	subjectTicket: string;
	/** Last returned post that mentions the subject ticket. */
	afterPostId: string;
	startPostId: string;
	endPostId: string;
	postIds: string[];
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
	| "debugging"
	| "status"
	| "noise";

export interface PurposeHint {
	label: PurposeHintLabel;
	confidence: number;
	evidencePostIds: string[];
}

/**
 * Lean default-agent briefing derived from packed posts only.
 * Advisory hints and ids — never prose summaries or verified outcomes.
 */
export interface ThreadBrief {
	purposeHints: PurposeHint[];
	/** Up to {@link MAX_DECISION_POST_IDS} `decision_candidate` post ids. */
	decisionPostIds: string[];
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
/**
 * Minimum `decision_candidate` confidence to surface in lean brief
 * (matches the weakest {@link DECISION_CUES} weight).
 */
export const DECISION_CONFIDENCE_FLOOR = 0.5;
/** Short-thread ceiling for the `noise` purpose hint. */
const NOISE_MAX_POSTS = 3;
/** Short-message ceiling (code points) for a ticket-ping noise post. */
const NOISE_MAX_MESSAGE_CHARS = 160;

const PURPOSE_HINT_PRIORITY: Readonly<Record<PurposeHintLabel, number>> = {
	decision: 0,
	debugging: 1,
	announce: 2,
	status: 3,
	noise: 4,
};

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
	{ cue: "вопрос:", weight: 0.6 },
	{ cue: "нужно уточнить", weight: 0.65 },
	{ cue: "кто знает", weight: 0.55 },
	{ cue: "ждём ответа", weight: 0.55 },
	{ cue: "open question", weight: 0.7 },
	{ cue: "unclear", weight: 0.55 },
	{ cue: "tbd", exact: true, weight: 0.5 },
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

	const purposeHints = collectPurposeHints(posts, signals, {
		reasons: options.reasons,
		presentation: options.presentation,
		subjectTicket: options.subjectTicket,
		hasDecision: decisionPostIds.length > 0,
		decisionPostIds,
		decisionSpans: cappedDecisionSpans,
	}).slice(0, maxPurpose);

	return {
		purposeHints,
		decisionPostIds,
		...(signals.outcomeWindow ? { outcomeWindow: signals.outcomeWindow } : {}),
	};
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
	},
): PurposeHint[] {
	const chronological = [...posts]
		.filter((post) => !post.deleteAt)
		.sort(
			(left, right) =>
				left.createAt - right.createAt || left.id.localeCompare(right.id),
		);
	const hints: PurposeHint[] = [];

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
			evidencePostIds: [...options.decisionPostIds],
		});
	}

	const debugRoles = signals.roleHints.filter((hint) =>
		DEBUG_ROLE_LABELS.has(hint.label),
	);
	const openQuestions = signals.candidateSpans.filter(
		(span) => span.kind === "open_question_candidate",
	);
	if (debugRoles.length || openQuestions.length) {
		const evidencePostIds = [
			...new Set([
				...debugRoles.flatMap((hint) => hint.evidencePostIds),
				...openQuestions.map((span) => span.postId),
			]),
		];
		const confidence = Math.max(
			0,
			...debugRoles.map((hint) => hint.confidence),
			...openQuestions.map((span) => span.confidence),
		);
		hints.push({
			label: "debugging",
			confidence,
			evidencePostIds,
		});
	}

	const coordination = signals.roleHints.find(
		(hint) => hint.label === "coordination",
	);
	if (coordination && !options.hasDecision) {
		hints.push({
			label: "status",
			confidence: coordination.confidence,
			evidencePostIds: [...coordination.evidencePostIds],
		});
	}

	// Noise is exclusive: only when no higher-priority purpose already applies.
	if (!hints.length && isNoiseThread(chronological, options.subjectTicket)) {
		hints.push({
			label: "noise",
			confidence: 0.6,
			evidencePostIds: chronological.map((post) => post.id),
		});
	}

	return hints.sort(
		(left, right) =>
			PURPOSE_HINT_PRIORITY[left.label] - PURPOSE_HINT_PRIORITY[right.label] ||
			right.confidence - left.confidence ||
			left.label.localeCompare(right.label),
	);
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
	for (const post of posts) {
		if (!post.message.trim() || post.deleteAt) continue;
		for (const { kind, patterns } of SPAN_KIND_CUES) {
			if (kind === "decision_candidate" && isDecisionMetaNoise(post.message)) {
				continue;
			}
			const matched = matchCues(post.message, patterns);
			if (!matched.cues.length) continue;
			spans.push({
				kind,
				postId: post.id,
				excerpt: truncateExcerpt(post.message, options.excerptLimit),
				cues: matched.cues,
				confidence: matched.confidence,
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
	if (!subject || !posts.length) return undefined;

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

	const windowPosts = posts
		.slice(lastMentionIndex + 1)
		.filter((post) => !post.deleteAt && options.includedIds.has(post.id))
		.slice(0, options.maxOutcome);
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
): { cues: string[]; weights: number[]; confidence: number } {
	const matched: Array<{ cue: string; weight: number }> = [];
	for (const pattern of patterns) {
		if (cueMatches(message, pattern)) {
			matched.push({ cue: pattern.cue, weight: pattern.weight ?? 0.5 });
		}
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
	for (const span of signals.candidateSpans) ids.add(span.postId);
	for (const hint of signals.roleHints) {
		for (const id of hint.evidencePostIds) ids.add(id);
	}
	if (signals.outcomeWindow) {
		ids.add(signals.outcomeWindow.afterPostId);
		for (const id of signals.outcomeWindow.postIds) ids.add(id);
	}
	return [...ids];
}
