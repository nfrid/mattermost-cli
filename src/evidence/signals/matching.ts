/**
 * The cue matching engine: surface matching, sentence-level guards, cue
 * telemetry recording, and the classification of a matched cue into a decision
 * or question kind.
 *
 * Everything here answers "did this cue fire, and what does it mean" for a
 * single message. Assembling fired cues into spans is `./spans.ts`; assembling
 * spans into a brief is `./brief.ts`.
 */

import {
	containsNormalizedExactText,
	containsNormalizedText,
	normalizeSearchText,
} from "../../text/index.ts";
import type { CueRecorder, CueStage } from "../cue-telemetry.ts";
import {
	ACK_TOKENS,
	CUE_FAMILY_BY_PATTERN,
	type CuePattern,
	DECISION_HEDGE_CUES,
	DECISION_META_REJECT,
	NEGATIONS,
	QUESTION_URL_PATTERN,
	SENTENCE_TERMINATORS,
	TECH_APPROACH_CUE_SET,
} from "./cues.ts";
import type {
	BriefScopeRefinement,
	DecisionKind,
	QuestionKind,
} from "./types.ts";
import { ACK_MAX_MESSAGE_CHARS, MAX_CUES_PER_SIGNAL } from "./types.ts";

/**
 * Read a matched decision as settled, intended, or merely floated.
 *
 * Order matters: a hedge demotes anything, because "наверное, так и сделаю" is
 * not a commitment however strong the verb; an acknowledgement from another
 * author promotes a personal commitment, because someone else signing off is
 * the closest mechanical evidence of agreement this layer can observe.
 */
export function classifyDecision(
	message: string,
	patterns: readonly CuePattern[],
	affirmed: boolean,
): DecisionKind {
	if (isFullyHedged(message, patterns)) return "proposal";
	// Architectural approach cues are never approvals, even when affirmed.
	if (
		patterns.length > 0 &&
		patterns.every((pattern) => TECH_APPROACH_CUE_SET.has(pattern.cue))
	) {
		return "proposal";
	}
	if (patterns.some((pattern) => pattern.commitment === "settled")) {
		return "approved_decision";
	}
	if (
		patterns.some((pattern) => TECH_APPROACH_CUE_SET.has(pattern.cue)) &&
		!patterns.some((pattern) => pattern.commitment === "settled")
	) {
		return "proposal";
	}
	if (patterns.some((pattern) => pattern.commitment === "personal")) {
		return affirmed ? "approved_decision" : "implementation_intent";
	}
	// Summary framing alone. An affirmation does not upgrade it: agreeing with
	// "we discussed it" agrees that a discussion happened.
	return "discussion_outcome";
}

/**
 * True when *every* sentence carrying a matched cue also carries a hedge. One
 * plainly stated sentence is enough to keep a decision: "решили фиксируем B.
 * наверное, поздновато" is a decision followed by a musing, and the same cue
 * word recurring in the musing must not retroactively soften it.
 */
export function isFullyHedged(
	message: string,
	patterns: readonly CuePattern[],
): boolean {
	const carrying = splitSentences(message).filter((sentence) =>
		patterns.some((pattern) => cueMatches(sentence.text, pattern)),
	);
	if (!carrying.length) return false;
	return carrying.every((sentence) =>
		DECISION_HEDGE_CUES.some((hedge) => cueMatches(sentence.text, hedge)),
	);
}

/**
 * Deferred work stated as a fact is a `follow_up`; anything actually being asked
 * — a question mark, or a cue that names something explicitly unsettled — stays
 * a `question`.
 */
export function classifyQuestion(
	message: string,
	patterns: readonly CuePattern[],
): QuestionKind {
	// Unannotated cues are unresolved by default; only `pending` and the bare `?`
	// are excluded, so a new cue is never silently demoted to a follow-up.
	if (
		patterns.some(
			(pattern) =>
				pattern.shape !== "pending" && pattern.shape !== "punctuation",
		)
	) {
		return "question";
	}
	// A bare `?` matches anywhere, including a Grafana link's query string, so it
	// only counts when it actually terminates a sentence of prose.
	return hasInterrogativeSentence(message) ? "question" : "follow_up";
}

export function hasInterrogativeSentence(message: string): boolean {
	return splitSentences(message.replace(QUESTION_URL_PATTERN, " ")).some(
		(sentence) => sentence.terminator === "?",
	);
}

/**
 * How much a cue determines the reported class. `settled` decides
 * `approved_decision` outright and the bare `?` decides nothing, so they sit at
 * the two ends; everything else keeps weight order.
 */
export function cueClassificationRank(pattern: CuePattern): number {
	if (pattern.commitment === "settled") return 0;
	if (pattern.shape === "punctuation") return 2;
	return 1;
}

export function isDecisionMetaNoise(message: string): boolean {
	const normalized = message.toLowerCase();
	return DECISION_META_REJECT.some((phrase) =>
		containsNormalizedText(normalized, phrase),
	);
}

/**
 * Brief-scoped telemetry state. Scope refinements are matched inside
 * `buildBriefDecisions`, below the point where {@link buildSignalsWithPatterns}
 * can see them, so their patterns are collected here instead.
 */
export interface BriefCueTelemetry {
	recorder: CueRecorder;
	refinementPatterns: Map<
		BriefScopeRefinement,
		{ postId: string; patterns: readonly CuePattern[] }
	>;
}

/** Recorder plus the post the observation belongs to. */
export interface CueTelemetryContext {
	recorder: CueRecorder;
	postId: string;
}

export function cueTelemetryContext(
	recorder: CueRecorder | undefined,
	postId: string,
): CueTelemetryContext | undefined {
	return recorder ? { recorder, postId } : undefined;
}

export function recordCue(
	context: CueTelemetryContext | undefined,
	pattern: CuePattern,
	stage: CueStage,
): void {
	if (!context) return;
	const family = CUE_FAMILY_BY_PATTERN.get(pattern);
	if (!family) return;
	context.recorder.record(family, pattern.cue, stage, context.postId);
}

/**
 * Credit the cues of a signal that reached output. Called after every cap and
 * confidence gate, so `survived` / `brief` counts describe what a consumer
 * actually saw rather than what the matcher produced.
 */
export function recordSurvivingCues(
	recorder: CueRecorder | undefined,
	stage: Extract<CueStage, "survived" | "brief">,
	entries: Iterable<{ postId: string; patterns: readonly CuePattern[] }>,
): void {
	if (!recorder) return;
	for (const { postId, patterns } of entries) {
		const context = { recorder, postId };
		for (const pattern of patterns) recordCue(context, pattern, stage);
	}
}

export function matchCues(
	message: string,
	patterns: readonly CuePattern[],
	options: {
		rejectInterrogativeCueSentence?: boolean;
		rejectNegatedCue?: boolean;
		telemetry?: CueTelemetryContext;
	} = {},
): {
	cues: string[];
	weights: number[];
	confidence: number;
	patterns: CuePattern[];
} {
	const sentences =
		options.rejectInterrogativeCueSentence || options.rejectNegatedCue
			? splitSentences(message)
			: undefined;
	const matched: Array<{ cue: string; weight: number; pattern: CuePattern }> =
		[];
	for (const pattern of patterns) {
		if (!cueMatches(message, pattern)) continue;
		recordCue(options.telemetry, pattern, "matched");
		if (sentences && !cueSurvivesSentenceGuards(sentences, pattern, options)) {
			recordCue(options.telemetry, pattern, "guardRejected");
			continue;
		}
		matched.push({ cue: pattern.cue, weight: pattern.weight ?? 0.5, pattern });
	}
	// Classifying cues first: `cues[]` is capped, and a reported
	// `approved_decision` whose settled cue fell off the list is a verdict the
	// reader cannot check against the text.
	matched.sort(
		(left, right) =>
			cueClassificationRank(left.pattern) -
				cueClassificationRank(right.pattern) ||
			right.weight - left.weight ||
			left.cue.localeCompare(right.cue),
	);
	const limited = matched.slice(0, MAX_CUES_PER_SIGNAL);
	if (options.telemetry) {
		for (const [index, item] of matched.entries()) {
			recordCue(
				options.telemetry,
				item.pattern,
				index < limited.length ? "reported" : "capped",
			);
		}
		if (limited.length === 1 && limited[0]) {
			recordCue(options.telemetry, limited[0].pattern, "sole");
		}
	}
	const weights = limited.map((item) => item.weight);
	return {
		cues: limited.map((item) => item.cue),
		weights,
		confidence: scoreConfidence(weights),
		// Every match, not just the reported top cues: classification must see a
		// weak `settled` cue that the cue cap would otherwise hide.
		patterns: matched.map((item) => item.pattern),
	};
}

export interface CueSentence {
	text: string;
	/** Terminating punctuation, empty for a trailing fragment. */
	terminator: string;
}

/** Split a message into sentences on `[.!?\n]`, keeping each terminator. */
export function splitSentences(message: string): CueSentence[] {
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

/**
 * Keep a cue only when at least one sentence carrying it is neither a question
 * nor a negation. A cue that spans a sentence boundary is kept (conservative).
 */
export function cueSurvivesSentenceGuards(
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
			NEGATIONS.some((negation) =>
				containsNormalizedText(sentence.text, `${negation} ${pattern.cue}`),
			)
		) {
			continue;
		}
		return true;
	}
	return !located;
}

/** The leading ack token, or undefined when the message is not an ack at all. */
export function acknowledgementToken(message: string): string | undefined {
	const trimmed = message.trim();
	if (!trimmed || [...trimmed].length > ACK_MAX_MESSAGE_CHARS) return undefined;
	const normalized = normalizeSearchText(trimmed);
	return ACK_TOKENS.find((token) => {
		if (!normalized.startsWith(token)) return false;
		const next = [...normalized][[...token].length];
		return next === undefined || !/[\p{L}\p{N}_]/u.test(next);
	});
}

export function cueMatches(message: string, pattern: CuePattern): boolean {
	if (pattern.cue === "?") return message.includes("?");
	if (pattern.exact) {
		return containsNormalizedExactText(message, pattern.cue);
	}
	return containsNormalizedText(message, pattern.cue);
}

export function scoreConfidence(weights: readonly number[]): number {
	if (!weights.length) return 0;
	const strongest = Math.max(...weights);
	const bonus = Math.min(0.25, (weights.length - 1) * 0.08);
	return roundConfidence(Math.min(0.95, strongest + bonus));
}

export function roundConfidence(value: number): number {
	return Math.round(value * 100) / 100;
}
