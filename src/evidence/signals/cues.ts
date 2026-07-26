/**
 * Hand-calibrated cue tables.
 *
 * Split out from the matching logic deliberately: these are *data*, tuned
 * against real conversations and audited by `bun run cues`, and mixing them
 * into the 2000-line module that consumed them made both harder to review.
 * Nothing here executes — {@link cueInventory} only enumerates.
 */
import type { CueDescriptor } from "../cue-telemetry.ts";
import type {
	CandidateSpanKind,
	DecisionKind,
	PurposeHintLabel,
	RoleHintLabel,
} from "./types.ts";

/** Strongest first; drives both `decisions[]` order and which survive the cap. */
export const DECISION_KIND_PRIORITY: Readonly<Record<DecisionKind, number>> = {
	approved_decision: 0,
	discussion_outcome: 1,
	implementation_intent: 2,
	proposal: 3,
};

export const PURPOSE_HINT_PRIORITY: Readonly<Record<PurposeHintLabel, number>> =
	{
		decision: 0,
		open_question: 1,
		debugging: 2,
		announce: 3,
		status: 4,
		noise: 5,
	};

/** Leading tokens of a short acknowledgement reply. */
export const ACK_TOKENS: readonly string[] = [
	"ок",
	"окей",
	"хорошо",
	"да",
	"спасибо",
	"+",
	"ok",
	"sounds good",
];

/**
 * The subset of {@link ACK_TOKENS} that affirms the decision rather than merely
 * registering it. «спасибо» thanks the author and `+` is a presence marker;
 * neither is agreement, and promoting an intent to `approved_decision` on them
 * manufactures approval nobody gave. Both still count as acknowledgement for
 * `ackPostId` and the confidence bump.
 */
export const AFFIRMING_ACK_TOKENS: ReadonlySet<string> = new Set([
	"ок",
	"окей",
	"хорошо",
	"да",
	"ok",
	"sounds good",
]);

export const DEBUG_ROLE_LABELS = new Set<RoleHintLabel>([
	"testing",
	"regression",
	"implementation",
]);

export interface CuePattern {
	/** Surface form reported in `cues` (stable, human-readable). */
	cue: string;
	/** When true, require token boundaries (short tokens like `qa` / `mr`). */
	exact?: boolean;
	weight?: number;
	/**
	 * Decision cues only. `settled` phrasing reports approval or agreement;
	 * `personal` reports what one author intends to do; `summary` only reports
	 * that a discussion happened. The difference is what separates
	 * {@link DecisionKind} values.
	 */
	commitment?: "settled" | "personal" | "summary";
	/**
	 * Open-question cues only. `unresolved` marks something actually being asked
	 * or explicitly not settled; `pending` marks work deferred to later, which is
	 * a follow-up, not a question; `punctuation` is the bare `?`, which matches
	 * anywhere in a message (URLs included) and therefore cannot classify alone.
	 */
	shape?: "unresolved" | "pending" | "punctuation";
}

export const DECISION_CUES: readonly CuePattern[] = [
	{ cue: "решили", weight: 0.7, commitment: "settled" },
	// Summary framing, not approval: «обсудили» is "we talked", «итого» heads a
	// recap that may well list open items. They stay decision candidates because
	// a real outcome is usually stated exactly this way — but on their own they
	// report a discussion, not a go-ahead.
	{ cue: "итого", weight: 0.6, commitment: "summary" },
	{ cue: "фиксируем", weight: 0.65, commitment: "settled" },
	{ cue: "утвердили", weight: 0.7, commitment: "settled" },
	{ cue: "договорились", weight: 0.7, commitment: "settled" },
	{ cue: "обсудили", weight: 0.65, commitment: "summary" },
	{ cue: "можно делать", weight: 0.7, commitment: "settled" },
	{ cue: "ок, делаем", weight: 0.65, commitment: "settled" },
	{ cue: "ок делаем", weight: 0.65, commitment: "settled" },
	{ cue: "делаем так", weight: 0.6, commitment: "settled" },
	{ cue: "погнали делать", weight: 0.6, commitment: "settled" },
	{ cue: "так и сделаем", weight: 0.65, commitment: "settled" },
	{ cue: "approved", weight: 0.65, commitment: "settled" },
	{ cue: "going with", weight: 0.6, commitment: "settled" },
	{ cue: "we'll go with", weight: 0.65, commitment: "settled" },
	{ cue: "ship it", weight: 0.55, commitment: "settled" },
	{ cue: "final:", weight: 0.5, commitment: "settled" },
	// First-person forward commitments — the dominant decision shape in these
	// conversations. Single verbs match on token boundaries so third-person
	// inflections (`уберут`) do not read as a personal commitment.
	{ cue: "сделаю", exact: true, weight: 0.6, commitment: "personal" },
	{ cue: "так и сделаю", weight: 0.65, commitment: "personal" },
	{ cue: "выпилю", exact: true, weight: 0.6, commitment: "personal" },
	{ cue: "уберу", exact: true, weight: 0.55, commitment: "personal" },
	{ cue: "удалю", exact: true, weight: 0.55, commitment: "personal" },
	{ cue: "поправлю", exact: true, weight: 0.6, commitment: "personal" },
	{ cue: "перепишу", exact: true, weight: 0.6, commitment: "personal" },
	{ cue: "переделаю", exact: true, weight: 0.6, commitment: "personal" },
	{ cue: "буду делать", weight: 0.6, commitment: "personal" },
	{ cue: "будем делать", weight: 0.6, commitment: "personal" },
	// Bare future tense sits exactly at DECISION_CONFIDENCE_FLOOR: it is the shape
	// real commitments take here ("будем не запрещать…"), and the interrogative
	// guard already removes the common "что будем делать?" noise. Weaker than any
	// explicit cue, so acknowledged or phrased decisions still outrank it, and
	// `brief.decisions[]` inlines the text so a false positive is cheap to dismiss.
	{ cue: "буду", exact: true, weight: 0.5, commitment: "personal" },
	{ cue: "будем", exact: true, weight: 0.5, commitment: "personal" },
	{ cue: "i'll go with", weight: 0.65, commitment: "personal" },
	{ cue: "let's just", weight: 0.55, commitment: "personal" },
	{ cue: "going to remove", weight: 0.6, commitment: "personal" },
];

/**
 * Architectural approach statements. Always classified as {@link DecisionKind}
 * `proposal` — never silently as `approved_decision`. Matched separately so a
 * bare «отдельный роут» does not ride a settled cue into an approval.
 */
export const TECH_APPROACH_CUES: readonly CuePattern[] = [
	{ cue: "оставляем на стороне", weight: 0.55, commitment: "personal" },
	{ cue: "на стороне бэка", weight: 0.55, commitment: "personal" },
	{ cue: "на стороне фронта", weight: 0.55, commitment: "personal" },
	{ cue: "на стороне backend", weight: 0.55, commitment: "personal" },
	{ cue: "на стороне frontend", weight: 0.55, commitment: "personal" },
	{ cue: "отдельный роут", weight: 0.55, commitment: "personal" },
	{ cue: "отдельный endpoint", weight: 0.55, commitment: "personal" },
	{ cue: "отдельный сервис", weight: 0.55, commitment: "personal" },
	{ cue: "выносим на отдельный", weight: 0.55, commitment: "personal" },
	{ cue: "keep it on the backend", weight: 0.55, commitment: "personal" },
	{ cue: "keep it on the frontend", weight: 0.55, commitment: "personal" },
	{ cue: "separate route", weight: 0.55, commitment: "personal" },
	{ cue: "separate endpoint", weight: 0.55, commitment: "personal" },
	{ cue: "separate service", weight: 0.55, commitment: "personal" },
];

/**
 * Hedges that turn a matched commitment into a {@link DecisionKind} `proposal`:
 * the author is floating an option, not reporting a course taken. Matched in
 * the cue's own sentence, so a hedge elsewhere in a long post does not soften a
 * decision stated plainly.
 */
export const DECISION_HEDGE_CUES: readonly CuePattern[] = [
	{ cue: "наверное" },
	{ cue: "наверно" },
	{ cue: "может быть" },
	{ cue: "возможно" },
	{ cue: "думаю" },
	{ cue: "предлагаю" },
	{ cue: "предложение" },
	// «давайте» is deliberately absent: «давайте фиксируем вариант B» is how
	// agreement is ordinarily phrased here, not how it is hedged.
	{ cue: "имхо", exact: true },
	{ cue: "как вариант" },
	{ cue: "maybe" },
	{ cue: "i think" },
	{ cue: "probably" },
	{ cue: "wdyt", exact: true },
	{ cue: "proposal" },
];

/**
 * Messages that mention “решение” only as meta/questions — never decision
 * anchors even if a weak cue would otherwise match.
 */
export const DECISION_META_REJECT: readonly string[] = [
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

export const REJECTED_CUES: readonly CuePattern[] = [
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

export const OPEN_QUESTION_CUES: readonly CuePattern[] = [
	{ cue: "?", weight: 0.4, shape: "punctuation" },
	{ cue: "не ясно", weight: 0.65 },
	{ cue: "неясно", weight: 0.65 },
	{ cue: "вопрос:", weight: 0.6 },
	{ cue: "нужно уточнить", weight: 0.65 },
	{ cue: "кто знает", weight: 0.55 },
	{ cue: "ждём ответа", weight: 0.55 },
	{ cue: "open question", weight: 0.7 },
	{ cue: "unclear", weight: 0.55 },
	{ cue: "tbd", exact: true, weight: 0.5, shape: "pending" },
	// Deferral and fork phrasing: the shape an unresolved architectural choice
	// actually takes here ("надо будет с Аней обсудить", "capabilities или
	// отдельный роут?"). Without these a design fork scores like a stray `?`.
	// Pending-work phrasing. A bare infinitive (`обсудить`) is not enough: it
	// fires on `успели всё обсудить`, which is the opposite of an open question.
	// These are `pending`, not `unresolved`: alone they describe deferred work,
	// so they surface as a `follow_up` rather than as a question being asked.
	{ cue: "надо будет", weight: 0.55, shape: "pending" },
	{ cue: "нужно будет", weight: 0.55, shape: "pending" },
	{ cue: "предстоит", weight: 0.55, shape: "pending" },
	{ cue: "надо обсудить", weight: 0.65, shape: "pending" },
	{ cue: "надо будет обсудить", weight: 0.65, shape: "pending" },
	{ cue: "нужно обсудить", weight: 0.65, shape: "pending" },
	{ cue: "надо решить", weight: 0.65, shape: "pending" },
	{ cue: "нужно решить", weight: 0.65, shape: "pending" },
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
export const SCOPE_REFINEMENT_CUES: readonly CuePattern[] = [
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

export const ROLE_HINT_CUES: Readonly<
	Record<RoleHintLabel, readonly CuePattern[]>
> = {
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

/**
 * Every cue table, named. Two uses: attributing a matched pattern to its table
 * for telemetry (by object identity, so a merged array like
 * `[...DECISION_CUES, ...TECH_APPROACH_CUES]` still attributes correctly), and
 * enumerating the full inventory so a cue that never fires is visible as such.
 *
 * `instrumented: false` marks a table consulted outside {@link matchCues} —
 * those rows report zero counts, which means "not measured", not "never fired".
 */
export const CUE_TABLES: ReadonlyArray<{
	family: string;
	patterns: readonly CuePattern[];
	instrumented: boolean;
}> = [
	{ family: "decision", patterns: DECISION_CUES, instrumented: true },
	{ family: "tech_approach", patterns: TECH_APPROACH_CUES, instrumented: true },
	{ family: "rejected", patterns: REJECTED_CUES, instrumented: true },
	{ family: "open_question", patterns: OPEN_QUESTION_CUES, instrumented: true },
	{
		family: "scope_refinement",
		patterns: SCOPE_REFINEMENT_CUES,
		instrumented: true,
	},
	...(Object.keys(ROLE_HINT_CUES) as RoleHintLabel[]).map((label) => ({
		family: `role:${label}`,
		patterns: ROLE_HINT_CUES[label],
		instrumented: true,
	})),
	// Consulted through `cueMatches` from `isFullyHedged`, which classifies a
	// message without a post id to attribute the observation to.
	{ family: "hedge", patterns: DECISION_HEDGE_CUES, instrumented: false },
];

export const CUE_FAMILY_BY_PATTERN: ReadonlyMap<CuePattern, string> = new Map(
	CUE_TABLES.flatMap(({ family, patterns }) =>
		patterns.map((pattern) => [pattern, family] as const),
	),
);

/** Every cue table entry, whether or not it has ever fired. */
export function cueInventory(): CueDescriptor[] {
	const descriptors = CUE_TABLES.flatMap(({ family, patterns, instrumented }) =>
		patterns.map((pattern) => ({
			family,
			cue: pattern.cue,
			weight: pattern.weight ?? 0.5,
			exact: pattern.exact ?? false,
			...(pattern.commitment ? { commitment: pattern.commitment } : {}),
			...(pattern.shape ? { shape: pattern.shape } : {}),
			instrumented,
		})),
	);
	descriptors.push(
		...DECISION_META_REJECT.map((cue) => ({
			family: "decision_meta_reject",
			cue,
			weight: 0,
			exact: false,
			instrumented: false,
		})),
	);
	return descriptors;
}

export const SPAN_KIND_CUES: ReadonlyArray<{
	kind: CandidateSpanKind;
	patterns: readonly CuePattern[];
}> = [
	{
		kind: "decision_candidate",
		patterns: [...DECISION_CUES, ...TECH_APPROACH_CUES],
	},
	{ kind: "rejected_option_candidate", patterns: REJECTED_CUES },
	{ kind: "open_question_candidate", patterns: OPEN_QUESTION_CUES },
];

export const OFFLINE_OR_VOICE_MARKERS = [
	"обсудили голосом",
	"голосом обсудили",
	"на дейли",
	"на daily",
	"offline",
	"созвоне",
	"на созвоне",
] as const;

export const TECH_APPROACH_CUE_SET = new Set(
	TECH_APPROACH_CUES.map((pattern) => pattern.cue),
);

/** URLs are addresses: a `?` inside one asks nobody anything. */
export const QUESTION_URL_PATTERN = /https?:\/\/\S+/giu;

export const SENTENCE_TERMINATORS = new Set([".", "!", "?", "\n"]);

/**
 * Negations that void a decision cue immediately following them. English is
 * covered too: "we're not going with capabilities" and "this was never
 * approved" are rejections, and reading either as an approval is worse than
 * missing a decision outright.
 */
export const NEGATIONS: readonly string[] = ["не", "not", "never", "no"];
