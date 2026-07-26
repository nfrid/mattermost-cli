/**
 * The lean thread brief: decisions, open questions, purpose hints,
 * acknowledgements, and scope refinements assembled from candidate spans.
 *
 * The top layer of the signals stack — it reads spans produced by `./spans.ts`
 * and never matches cues against raw text itself, except through the helpers
 * in `./matching.ts`.
 */
import {
	containsNormalizedText,
	DECISION_EXCERPT_LIMIT,
	excerptWithTruncation,
	extractTicketKeys,
} from "../../text/index.ts";
import type { CueRecorder } from "../cue-telemetry.ts";
import type { EvidencePost } from "../packing.ts";
import {
	AFFIRMING_ACK_TOKENS,
	DEBUG_ROLE_LABELS,
	DECISION_CUES,
	DECISION_KIND_PRIORITY,
	OFFLINE_OR_VOICE_MARKERS,
	PURPOSE_HINT_PRIORITY,
	SCOPE_REFINEMENT_CUES,
	TECH_APPROACH_CUES,
} from "./cues.ts";
import {
	acknowledgementToken,
	type BriefCueTelemetry,
	classifyDecision,
	cueTelemetryContext,
	hasInterrogativeSentence,
	isDecisionMetaNoise,
	matchCues,
	recordSurvivingCues,
	roundConfidence,
} from "./matching.ts";
import { buildSignalsWithPatterns, buildThreadSignals } from "./spans.ts";
import {
	type BriefDecision,
	type BriefOpenQuestion,
	type BriefScopeRefinement,
	type BuildThreadBriefOptions,
	type CandidateSpan,
	DECISION_ACK_LOOKAHEAD,
	DECISION_CONFIDENCE_FLOOR,
	type LateThreadAcknowledgement,
	MAX_BRIEF_OUTCOME_WINDOW_POSTS,
	MAX_DECISION_POST_IDS,
	MAX_HINT_EVIDENCE_POST_IDS,
	MAX_OPEN_QUESTIONS,
	MAX_PURPOSE_HINTS,
	MAX_REFINEMENTS_PER_DECISION,
	type PurposeHint,
	type ThreadBrief,
	type ThreadSignals,
} from "./types.ts";

/** Look back this many packed posts for a short settled decision's antecedent. */
const ANTECEDENT_LOOKBACK = 6;
/** Settled decision excerpts at or under this length get antecedent bundling. */
const SHORT_SETTLED_EXCERPT_LIMIT = 80;
/** Max supporting posts attached to one short settled decision. */
const MAX_SUPPORTING_POSTS = 2;
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
/** Short-thread ceiling for the `noise` purpose hint. */
const NOISE_MAX_POSTS = 3;
/** Short-message ceiling (code points) for a ticket-ping noise post. */
const NOISE_MAX_MESSAGE_CHARS = 160;
/** Minimum question-span confidence that alone justifies `open_question`. */
const OPEN_QUESTION_CONFIDENCE_FLOOR = 0.5;
/** Distinct question-carrying posts that justify `open_question` regardless. */
const OPEN_QUESTION_MIN_POSTS = 3;
/**
 * How many trailing packed posts may supply a late-thread acknowledgement.
 * Separate from {@link DECISION_ACK_LOOKAHEAD}.
 */
const LATE_ACK_TAIL_POSTS = 8;
/** Base confidence for a late-thread acknowledgement (below adjacency pairing). */
const LATE_ACK_BASE_CONFIDENCE = 0.45;

/**
 * Lean thread briefing for default `--agent`: capped purpose hints,
 * decision_candidate post ids, and the mechanical outcome window.
 * Reuses {@link buildThreadSignals}; does not invent omitted-post evidence.
 */
export function buildThreadBrief(
	posts: readonly EvidencePost[],
	options: BuildThreadBriefOptions = {},
): ThreadBrief {
	const { signals, spanPatterns } = buildSignalsWithPatterns(posts, {
		...options,
		maxOutcomePosts: options.maxOutcomePosts ?? MAX_BRIEF_OUTCOME_WINDOW_POSTS,
	});
	const recorder = options.cueTelemetry;
	const briefTelemetry: BriefCueTelemetry | undefined = recorder
		? { recorder, refinementPatterns: new Map() }
		: undefined;
	const maxPurpose = options.maxPurposeHints ?? MAX_PURPOSE_HINTS;
	const maxDecisions = options.maxDecisionPostIds ?? MAX_DECISION_POST_IDS;

	const decisionSpans = signals.candidateSpans
		.filter(
			(span) =>
				span.kind === "decision_candidate" &&
				span.confidence >= DECISION_CONFIDENCE_FLOOR,
		)
		// Settledness outranks confidence: the cap must never spend its five slots
		// on loud personal intents while an acknowledged agreement falls off.
		.sort(
			(left, right) =>
				DECISION_KIND_PRIORITY[left.decisionKind ?? "implementation_intent"] -
					DECISION_KIND_PRIORITY[
						right.decisionKind ?? "implementation_intent"
					] ||
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
			...(options.subjectTicket
				? { subjectTicket: options.subjectTicket }
				: {}),
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
		collectDecisionBoundaryIds(chronological, recorder),
		briefExcerptLimit,
		briefTelemetry,
	);

	if (recorder) {
		const spanByPostId = new Map(
			signals.candidateSpans.map((span) => [
				`${span.kind} ${span.postId}`,
				span,
			]),
		);
		const briefSpans = [
			...decisions.map((decision) => `decision_candidate ${decision.postId}`),
			...openQuestions.map(
				(question) => `open_question_candidate ${question.postId}`,
			),
		];
		recordSurvivingCues(
			recorder,
			"brief",
			briefSpans.flatMap((key) => {
				const span = spanByPostId.get(key);
				const patterns = span ? spanPatterns?.get(span) : undefined;
				return patterns ? [{ postId: span?.postId ?? "", patterns }] : [];
			}),
		);
		recordSurvivingCues(
			recorder,
			"brief",
			decisions.flatMap((decision) =>
				(decision.refinements ?? []).flatMap((refinement) => {
					const entry = briefTelemetry?.refinementPatterns.get(refinement);
					return entry ? [entry] : [];
				}),
			),
		);
	}

	const lateAcknowledgement = findLateThreadAcknowledgement(
		chronological,
		cappedDecisionSpans,
		briefExcerptLimit,
	);

	return {
		purposeHints,
		decisionPostIds,
		...(decisions.length ? { decisions } : {}),
		...(openQuestions.length ? { openQuestions } : {}),
		...(lateAcknowledgement ? { lateAcknowledgement } : {}),
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
/**
 * A span whose only evidence is the bare `?`. Measured over a real index, this
 * is 94% of `open_question_candidate` spans and 95% of inlined questions: the
 * cue is precise at detecting *a question* and carries almost no information
 * about whether that question is *open*. «заведёшь баг?» and «получилось
 * черкануть ?» score exactly like a live architectural fork.
 */
function isBareQuestionMark(span: CandidateSpan): boolean {
	return span.cues.length === 1 && span.cues[0] === "?";
}

/**
 * Whether a question candidate may be reported as an open question rather than
 * merely offered as an advisory span.
 *
 * The bare `?` corroborates; it does not decide. It qualifies only when the
 * post also names the subject ticket, which is the one mechanical signal that
 * the question is about the thing the caller asked about. Every other cue in
 * `OPEN_QUESTION_CUES` states unresolvedness in words and qualifies on its own.
 *
 * `signals.candidateSpans` is deliberately unaffected — that layer is documented
 * as advisory candidates, and an agent that asks for it should still see every
 * question mark. This narrows the lean `brief`, which is what agents act on.
 */
function qualifiesAsOpenQuestion(
	span: CandidateSpan,
	post: EvidencePost | undefined,
	subjectTicket: string | undefined,
): boolean {
	if (!isBareQuestionMark(span)) return true;
	if (!post) return false;
	// A `?` inside a Kibana or Grafana query string is not a question at all.
	// `classifyQuestion` already discounts it for `kind`, but the span still
	// scored, so a link-dump naming the ticket was inlined as a follow-up.
	if (!hasInterrogativeSentence(post.message)) return false;
	if (!subjectTicket) return false;
	return extractTicketKeys(post.message).includes(subjectTicket.toUpperCase());
}

function buildOpenQuestions(
	chronological: readonly EvidencePost[],
	spans: readonly CandidateSpan[],
	options: {
		excludePostIds: ReadonlySet<string>;
		packingComplete: boolean;
		briefExcerptLimit: number;
		subjectTicket?: string;
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
		if (!qualifiesAsOpenQuestion(span, post, options.subjectTicket)) continue;
		seen.add(span.postId);
		const index = live.findIndex((candidate) => candidate.id === post.id);
		const responses =
			index < 0
				? []
				: live.slice(index + 1).filter((later) => later.userId !== post.userId);
		const repliesAfter = responses.length;
		const isThreadTail = post.id === lastId;
		const resolution =
			span.questionKind !== "question"
				? "unknown"
				: repliesAfter > 0
					? "possibly_answered"
					: isThreadTail
						? "unanswered"
						: "unknown";
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
			// Unreachable in practice; `follow_up` is the under-claiming default.
			kind: span.questionKind ?? "follow_up",
			cues: [...span.cues],
			confidence: span.confidence,
			repliesAfter,
			resolution,
			...(responses.length
				? { responsePostIds: responses.slice(0, 3).map(({ id }) => id) }
				: {}),
			...(isThreadTail ? { isThreadTail: true as const } : {}),
		});
	}
	// Dangling questions first, then things actually being asked, then the
	// strongest cue; a question nobody answered inside the packet is the one
	// worth carrying, and a deferred follow-up must not displace it.
	return questions
		.sort(
			(left, right) =>
				Number(right.isThreadTail ?? false) -
					Number(left.isThreadTail ?? false) ||
				Number(left.kind === "follow_up") -
					Number(right.kind === "follow_up") ||
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
/**
 * Every packed post that mechanically looks like a decision, independent of
 * candidate and brief presentation caps. A hidden decision must still stop a
 * later scope cue from being attributed to an earlier displayed decision.
 */
function collectDecisionBoundaryIds(
	chronological: readonly EvidencePost[],
	cueTelemetry?: CueRecorder,
): Set<string> {
	const ids = new Set<string>();
	for (const post of chronological) {
		if (
			post.deleteAt ||
			!post.message.trim() ||
			isDecisionMetaNoise(post.message)
		) {
			continue;
		}
		const matched = matchCues(
			post.message,
			[...DECISION_CUES, ...TECH_APPROACH_CUES],
			{
				rejectInterrogativeCueSentence: true,
				rejectNegatedCue: true,
				telemetry: cueTelemetryContext(cueTelemetry, post.id),
			},
		);
		if (matched.cues.length) ids.add(post.id);
	}
	return ids;
}

function buildBriefDecisions(
	chronological: readonly EvidencePost[],
	cappedDecisionSpans: readonly CandidateSpan[],
	decisionIds: ReadonlySet<string>,
	excerptLimit: number,
	telemetry?: BriefCueTelemetry,
): BriefDecision[] {
	const byId = new Map(chronological.map((post) => [post.id, post]));
	const decisions: BriefDecision[] = [];
	for (const span of cappedDecisionSpans) {
		const post = byId.get(span.postId);
		if (!post) continue;
		const refinements = collectScopeRefinements(
			chronological,
			post,
			decisionIds,
			excerptLimit,
			telemetry,
		);
		const excerpt = excerptWithTruncation(post.message, excerptLimit);
		const ack = span.ackPostId ? byId.get(span.ackPostId) : undefined;
		const ackExcerpt = ack
			? excerptWithTruncation(ack.message, excerptLimit)
			: undefined;
		const kind = span.decisionKind ?? "implementation_intent";
		const antecedent =
			kind === "approved_decision" || kind === "discussion_outcome"
				? collectDecisionAntecedent(chronological, post, excerptLimit)
				: undefined;
		const offlineOrVoiceApproval = hasOfflineOrVoiceApprovalMarker(
			post.message,
		);
		decisions.push({
			postId: span.postId,
			author: post.authorUsername,
			createAt: post.createAt,
			excerpt: excerpt.text,
			...(excerpt.truncated ? { excerptTruncated: true as const } : {}),
			kind,
			cues: [...span.cues],
			confidence: span.confidence,
			...(span.ackPostId ? { ackPostId: span.ackPostId } : {}),
			...(ack && ackExcerpt
				? {
						acknowledgement: {
							postId: ack.id,
							author: ack.authorUsername,
							createAt: ack.createAt,
							excerpt: ackExcerpt.text,
							...(ackExcerpt.truncated
								? { excerptTruncated: true as const }
								: {}),
						},
					}
				: {}),
			...(refinements.length ? { refinements } : {}),
			...(antecedent?.supportingPostIds.length
				? {
						supportingPostIds: antecedent.supportingPostIds,
						...(antecedent.supportingExcerpt
							? { supportingExcerpt: antecedent.supportingExcerpt }
							: {}),
					}
				: {}),
			...(offlineOrVoiceApproval
				? { offlineOrVoiceApproval: true as const }
				: {}),
		});
	}
	return decisions;
}

function hasOfflineOrVoiceApprovalMarker(message: string): boolean {
	return OFFLINE_OR_VOICE_MARKERS.some((marker) =>
		containsNormalizedText(message, marker),
	);
}

/**
 * For short settled cues («можно делать»), attach the nearest preceding packed
 * proposal/intent so the decision names *what* was approved. Mechanical only.
 */
function collectDecisionAntecedent(
	chronological: readonly EvidencePost[],
	decision: EvidencePost,
	excerptLimit: number,
): { supportingPostIds: string[]; supportingExcerpt?: string } | undefined {
	const excerpt = excerptWithTruncation(decision.message, excerptLimit);
	if (excerpt.text.length > SHORT_SETTLED_EXCERPT_LIMIT) return undefined;
	const index = chronological.findIndex((post) => post.id === decision.id);
	if (index <= 0) return undefined;
	const supportingPostIds: string[] = [];
	let supportingExcerpt: string | undefined;
	const window = chronological.slice(
		Math.max(0, index - ANTECEDENT_LOOKBACK),
		index,
	);
	for (const post of [...window].reverse()) {
		if (post.deleteAt || !post.message.trim()) continue;
		const matched = matchCues(post.message, DECISION_CUES, {
			rejectInterrogativeCueSentence: true,
			rejectNegatedCue: true,
		});
		if (!matched.cues.length) continue;
		const kind = classifyDecision(post.message, matched.patterns, false);
		if (kind !== "proposal" && kind !== "implementation_intent") continue;
		supportingPostIds.push(post.id);
		if (!supportingExcerpt) {
			supportingExcerpt = excerptWithTruncation(
				post.message,
				excerptLimit,
			).text;
		}
		if (supportingPostIds.length >= MAX_SUPPORTING_POSTS) break;
	}
	if (!supportingPostIds.length) return undefined;
	return {
		supportingPostIds: supportingPostIds.reverse(),
		...(supportingExcerpt ? { supportingExcerpt } : {}),
	};
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
	telemetry?: BriefCueTelemetry,
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
		const matched = matchCues(post.message, SCOPE_REFINEMENT_CUES, {
			rejectInterrogativeCueSentence: true,
			telemetry: cueTelemetryContext(telemetry?.recorder, post.id),
		});
		if (!matched.cues.length) continue;
		const excerpt = excerptWithTruncation(post.message, excerptLimit);
		const refinement: BriefScopeRefinement = {
			postId: post.id,
			author: post.authorUsername,
			createAt: post.createAt,
			excerpt: excerpt.text,
			...(excerpt.truncated ? { excerptTruncated: true as const } : {}),
			cues: matched.cues,
		};
		refinements.push(refinement);
		telemetry?.refinementPatterns.set(refinement, {
			postId: post.id,
			patterns: matched.patterns,
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
	for (const question of brief.openQuestions ?? []) {
		retained.add(question.postId);
		for (const responsePostId of question.responsePostIds ?? []) {
			retained.add(responsePostId);
		}
	}
	if (anchorPostId) retained.add(anchorPostId);
	// File-bearing posts are often the only place a screenshot or spreadsheet
	// is anchored; collapsing them into brief_projection skips hid the evidence
	// agents needed to decide on inspect.
	for (const post of posts) {
		if (post.deleteAt) continue;
		if (post.attachments.some((attachment) => !attachment.deleteAt)) {
			retained.add(post.id);
		}
	}
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
	//
	// Only qualifying spans count. Three posts containing a question mark is
	// near-certain in any thread of nine or more, so counting bare `?` toward
	// OPEN_QUESTION_MIN_POSTS gave 77% of such threads an `open_question` purpose
	// — a label that fires on almost everything cannot order anything.
	const byPostId = new Map(chronological.map((post) => [post.id, post]));
	const questionSpans = signals.candidateSpans.filter(
		(span) =>
			span.kind === "open_question_candidate" &&
			qualifiesAsOpenQuestion(
				span,
				byPostId.get(span.postId),
				options.subjectTicket,
			),
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

/**
 * When adjacency pairing missed an acknowledgement, look for a short affirming
 * ack in the final packed posts that confirms the strongest preceding decision
 * candidate. Explicitly named and lower-confidence — not a widened lookahead.
 */
function findLateThreadAcknowledgement(
	chronological: readonly EvidencePost[],
	decisionSpans: readonly CandidateSpan[],
	excerptLimit: number,
): LateThreadAcknowledgement | undefined {
	if (!chronological.length || !decisionSpans.length) return undefined;
	const byId = new Map(chronological.map((post) => [post.id, post]));
	const indexById = new Map(
		chronological.map((post, index) => [post.id, index] as const),
	);

	const alreadyPaired = new Set(
		decisionSpans
			.map((span) => span.ackPostId)
			.filter((id): id is string => Boolean(id)),
	);

	const tail = chronological.slice(-LATE_ACK_TAIL_POSTS);
	type Candidate = {
		decision: CandidateSpan;
		ack: EvidencePost;
		decisionIndex: number;
		ackIndex: number;
	};
	let best: Candidate | undefined;

	for (const [tailOffset, ack] of tail.entries()) {
		const ackIndex = chronological.length - tail.length + tailOffset;
		if (!ack || ack.deleteAt || !ack.message.trim()) continue;
		if (alreadyPaired.has(ack.id)) continue;
		const token = acknowledgementToken(ack.message);
		if (token === undefined || !AFFIRMING_ACK_TOKENS.has(token)) continue;

		for (const span of decisionSpans) {
			const decision = byId.get(span.postId);
			const decisionIndex = indexById.get(span.postId);
			if (!decision || decisionIndex === undefined) continue;
			if (decisionIndex >= ackIndex) continue;
			if (decision.userId === ack.userId) continue;
			// Only fire when adjacency would have already given up: more than
			// DECISION_ACK_LOOKAHEAD other-author posts between decision and ack.
			let otherAuthors = 0;
			for (let index = decisionIndex + 1; index < ackIndex; index += 1) {
				const between = chronological[index];
				if (!between || between.deleteAt) continue;
				if (between.userId === decision.userId) continue;
				otherAuthors += 1;
			}
			if (otherAuthors <= DECISION_ACK_LOOKAHEAD) continue;

			const kind = span.decisionKind ?? "implementation_intent";
			const better =
				!best ||
				DECISION_KIND_PRIORITY[kind] <
					DECISION_KIND_PRIORITY[
						best.decision.decisionKind ?? "implementation_intent"
					] ||
				(DECISION_KIND_PRIORITY[kind] ===
					DECISION_KIND_PRIORITY[
						best.decision.decisionKind ?? "implementation_intent"
					] &&
					span.confidence > best.decision.confidence) ||
				(span.postId === best.decision.postId && ackIndex > best.ackIndex);
			if (better) {
				best = { decision: span, ack, decisionIndex, ackIndex };
			}
		}
	}

	if (!best) return undefined;
	const excerpt = excerptWithTruncation(best.ack.message, excerptLimit);
	return {
		kind: "late_thread_acknowledgement",
		decisionPostId: best.decision.postId,
		decisionKind: best.decision.decisionKind ?? "implementation_intent",
		ackPostId: best.ack.id,
		author: best.ack.authorUsername,
		createAt: best.ack.createAt,
		excerpt: excerpt.text,
		...(excerpt.truncated ? { excerptTruncated: true as const } : {}),
		confidence: roundConfidence(
			Math.min(
				0.7,
				LATE_ACK_BASE_CONFIDENCE +
					Math.min(0.15, best.decision.confidence * 0.2),
			),
		),
	};
}
