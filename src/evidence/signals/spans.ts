/**
 * Candidate spans, the mechanical outcome window, and role hints — everything
 * {@link buildThreadSignals} emits from already-packed posts.
 */
import {
	extractTicketKeys,
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../../text/index.ts";
import type { CueRecorder } from "../cue-telemetry.ts";
import type { EvidencePost } from "../packing.ts";
import {
	AFFIRMING_ACK_TOKENS,
	type CuePattern,
	ROLE_HINT_CUES,
	SPAN_KIND_CUES,
} from "./cues.ts";
import {
	acknowledgementToken,
	classifyDecision,
	classifyQuestion,
	cueTelemetryContext,
	isDecisionMetaNoise,
	matchCues,
	recordSurvivingCues,
	roundConfidence,
	scoreConfidence,
} from "./matching.ts";
import {
	type BuildThreadSignalsOptions,
	type CandidateSpan,
	DECISION_ACK_BONUS,
	DECISION_ACK_LOOKAHEAD,
	MAX_CANDIDATE_SPANS,
	MAX_CUES_PER_SIGNAL,
	MAX_OUTCOME_WINDOW_POSTS,
	type OutcomeWindow,
	type RoleHint,
	type RoleHintLabel,
	type ThreadSignals,
} from "./types.ts";

/**
 * Build advisory candidate spans, mechanical outcome window, and multi-label
 * role hints from already-returned packed posts only. Does not score ranking
 * or adequacy; never invents evidence from omitted posts.
 */
export function buildThreadSignals(
	posts: readonly EvidencePost[],
	options: BuildThreadSignalsOptions = {},
): ThreadSignals {
	return buildSignalsWithPatterns(posts, options).signals;
}

/**
 * {@link buildThreadSignals} plus the cue patterns behind each emitted signal,
 * so `buildThreadBrief` can credit `brief` telemetry against the patterns that
 * produced a span rather than re-resolving cue strings back to a table. The
 * maps are populated only when a recorder is present.
 */
export function buildSignalsWithPatterns(
	posts: readonly EvidencePost[],
	options: BuildThreadSignalsOptions = {},
): {
	signals: ThreadSignals;
	spanPatterns?: Map<CandidateSpan, readonly CuePattern[]>;
} {
	const chronological = [...posts].sort(
		(left, right) =>
			left.createAt - right.createAt || left.id.localeCompare(right.id),
	);
	const includedIds = new Set(chronological.map((post) => post.id));
	const maxSpans = options.maxCandidateSpans ?? MAX_CANDIDATE_SPANS;
	const maxOutcome = options.maxOutcomePosts ?? MAX_OUTCOME_WINDOW_POSTS;
	const excerptLimit = options.excerptLimit ?? POINTER_EXCERPT_LIMIT;

	const recorder = options.cueTelemetry;
	const spanPatterns = recorder
		? new Map<CandidateSpan, readonly CuePattern[]>()
		: undefined;
	const hintPatterns = recorder
		? new Map<RoleHint, Array<{ postId: string; pattern: CuePattern }>>()
		: undefined;

	const candidateSpans = collectCandidateSpans(chronological, {
		maxSpans,
		excerptLimit,
		...(recorder ? { cueTelemetry: recorder } : {}),
		...(spanPatterns ? { spanPatterns } : {}),
	}).filter((span) => includedIds.has(span.postId));

	const outcomeWindow = buildOutcomeWindow(chronological, {
		subjectTicket: options.subjectTicket,
		maxOutcome,
		includedIds,
	});

	const roleHints = collectRoleHints(chronological, {
		...(recorder ? { cueTelemetry: recorder } : {}),
		...(hintPatterns ? { hintPatterns } : {}),
	}).filter((hint) => hint.evidencePostIds.every((id) => includedIds.has(id)));

	// Credit only what survived the span cap and the role-hint containment filter
	// above: `survived` must describe the emitted signal, not the matcher.
	recordSurvivingCues(
		recorder,
		"survived",
		candidateSpans.map((span) => ({
			postId: span.postId,
			patterns: spanPatterns?.get(span) ?? [],
		})),
	);
	for (const hint of roleHints) {
		recordSurvivingCues(
			recorder,
			"survived",
			(hintPatterns?.get(hint) ?? []).map(({ postId, pattern }) => ({
				postId,
				patterns: [pattern],
			})),
		);
	}

	return {
		signals: {
			candidateSpans,
			...(outcomeWindow ? { outcomeWindow } : {}),
			roleHints,
		},
		...(spanPatterns ? { spanPatterns } : {}),
	};
}

function collectCandidateSpans(
	posts: readonly EvidencePost[],
	options: {
		maxSpans: number;
		excerptLimit: number;
		cueTelemetry?: CueRecorder;
		/** Populated with the patterns behind each span, for `survived` crediting. */
		spanPatterns?: Map<CandidateSpan, readonly CuePattern[]>;
	},
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
				telemetry: cueTelemetryContext(options.cueTelemetry, post.id),
			});
			if (!matched.cues.length) continue;
			const ack = isDecision ? findAckPostId(posts, index) : undefined;
			// Ack pairing is a post-scoring bump — never a synthetic cue weight.
			const confidence = ack
				? roundConfidence(
						Math.min(0.95, matched.confidence + DECISION_ACK_BONUS),
					)
				: matched.confidence;
			const span: CandidateSpan = {
				kind,
				postId: post.id,
				excerpt: truncateExcerpt(post.message, options.excerptLimit),
				cues: matched.cues,
				confidence,
				...(isDecision
					? {
							decisionKind: classifyDecision(
								post.message,
								matched.patterns,
								Boolean(ack?.affirming),
							),
						}
					: {}),
				...(kind === "open_question_candidate"
					? { questionKind: classifyQuestion(post.message, matched.patterns) }
					: {}),
				...(ack ? { ackPostId: ack.postId } : {}),
			};
			spans.push(span);
			options.spanPatterns?.set(span, matched.patterns);
		}
	}
	// An acknowledged agreement must survive the span cap. Sorting on confidence
	// alone let a dozen loud 0.89 questions evict the one 0.86 «можно делать»
	// before the brief — which orders by kind — ever saw it.
	return spans
		.sort(
			(left, right) =>
				Number(left.decisionKind !== "approved_decision") -
					Number(right.decisionKind !== "approved_decision") ||
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

function collectRoleHints(
	posts: readonly EvidencePost[],
	options: {
		cueTelemetry?: CueRecorder;
		/** Populated with the patterns behind each hint, for `survived` crediting. */
		hintPatterns?: Map<
			RoleHint,
			Array<{ postId: string; pattern: CuePattern }>
		>;
	} = {},
): RoleHint[] {
	const labels = Object.keys(ROLE_HINT_CUES) as RoleHintLabel[];
	const hints: RoleHint[] = [];
	for (const label of labels) {
		const patterns = ROLE_HINT_CUES[label];
		const evidencePostIds: string[] = [];
		const cueSet = new Map<string, number>();
		const contributions: Array<{ postId: string; pattern: CuePattern }> = [];
		for (const post of posts) {
			if (!post.message.trim() || post.deleteAt) continue;
			const matched = matchCues(post.message, patterns, {
				telemetry: cueTelemetryContext(options.cueTelemetry, post.id),
			});
			if (!matched.cues.length) continue;
			evidencePostIds.push(post.id);
			for (const pattern of matched.patterns) {
				contributions.push({ postId: post.id, pattern });
			}
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
		const hint: RoleHint = {
			label,
			evidencePostIds: [...new Set(evidencePostIds)],
			cues,
			confidence: scoreConfidence(weights),
		};
		hints.push(hint);
		options.hintPatterns?.set(hint, contributions);
	}
	return hints.sort(
		(left, right) =>
			right.confidence - left.confidence ||
			left.label.localeCompare(right.label),
	);
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
): { postId: string; affirming: boolean } | undefined {
	const decision = posts[decisionIndex];
	if (!decision) return undefined;
	let scanned = 0;
	for (let index = decisionIndex + 1; index < posts.length; index += 1) {
		const candidate = posts[index];
		if (!candidate || candidate.deleteAt || !candidate.message.trim()) continue;
		if (candidate.userId === decision.userId) continue;
		scanned += 1;
		if (scanned > DECISION_ACK_LOOKAHEAD) break;
		const token = acknowledgementToken(candidate.message);
		if (token !== undefined) {
			return {
				postId: candidate.id,
				affirming: AFFIRMING_ACK_TOKENS.has(token),
			};
		}
	}
	return undefined;
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
