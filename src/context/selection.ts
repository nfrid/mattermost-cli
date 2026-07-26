import type { MattermostConfig } from "../config/config.ts";
import type {
	MattermostSubject,
	RankingReason,
	ThreadCandidate,
} from "../search/index.ts";
import { redactCredentialExcerpts, TICKET_PATTERN } from "../text/index.ts";
import { postLink } from "./helpers.ts";
import type { DroppedCandidate, DroppedCandidateReason } from "./types.ts";

const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;

const DROPPED_CANDIDATES_LIMIT = 5;

/** Prefer focused this-ticket threads over long related-mention neighborhoods. */
export function pickPrimaryThreadIndex(
	threads: readonly {
		reasons: readonly string[];
		totalPosts: number;
		omittedPosts: number;
		ticketDensity?: number;
		rootAnchoredFocused?: boolean;
		exclusiveSubjectKey?: boolean;
		otherTicketDominated?: boolean;
	}[],
): number {
	if (threads.length <= 1) return 0;
	let bestIndex = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const [index, thread] of threads.entries()) {
		const thin =
			thread.reasons.includes("thin_thread") ||
			thread.reasons.includes("multi_ticket_root");
		const substantive = thread.reasons.includes("substantive_thread_depth")
			? 20
			: 0;
		const focused =
			(thread.rootAnchoredFocused ? 50 : 0) +
			(thread.exclusiveSubjectKey ? 40 : 0) +
			(thread.otherTicketDominated ? -80 : 0) +
			Math.round((thread.ticketDensity ?? 0) * 10);
		const score =
			(thin ? -100 : 0) +
			focused +
			substantive +
			// Cap raw length so a long related-key thread cannot beat focus.
			Math.min(thread.totalPosts, 12) -
			thread.omittedPosts * 0.01;
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return bestIndex;
}

/**
 * For ticket subjects, keep at most maxThreads-1 substantive threads ahead of
 * the best thin ticket stub so a short DM signal is not crowded out.
 */
export function orderCandidatesForThinReserve(
	candidates: readonly ThreadCandidate[],
	subject: MattermostSubject,
	maxThreads: number,
): ThreadCandidate[] {
	if (subject.kind !== "ticket" || maxThreads < 2 || candidates.length <= 1) {
		return [...candidates];
	}
	const substantive: ThreadCandidate[] = [];
	const thin: ThreadCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.reasons.includes("thin_thread")) thin.push(candidate);
		else substantive.push(candidate);
	}
	if (!thin.length) return [...candidates];

	const reserved = thin[0];
	if (!reserved) return [...candidates];
	const head = substantive.slice(0, maxThreads - 1);
	const restSubstantive = substantive.slice(maxThreads - 1);
	const restThin = thin.slice(1);
	return [...head, reserved, ...restSubstantive, ...restThin];
}

/**
 * Reasons that mean the query actually matched thread content (lexical,
 * morphological, or structured). Ordering artifacts — `rank_fusion`,
 * `routing_*`, `conversation_priority`, `latest_activity` — are deliberately
 * absent: on their own they say only that the thread was ranked, not that it is
 * about the subject, and they used to fill the dropped-candidate cap with noise.
 */
const MATCH_REASONS: ReadonlySet<RankingReason> = new Set<RankingReason>([
	"direct_post",
	"remote_search",
	"structured_entity_match",
	"subject_in_root",
	"exact_phrase",
	"exact_phrase_in_root",
	"exact_phrase_in_reply",
	"all_terms_in_thread",
	"all_expanded_terms_in_thread",
	"exact_terms_near",
	"morph_terms_near",
	"exact_terms_same_post",
	"morph_terms_same_post",
	"expanded_terms_same_post",
	"terms_across_thread",
	"morphology_match",
	"concept_match",
	"keyboard_layout_match",
	"transliteration_match",
	"mixed_script_match",
	"prefix_match",
	"typo_match",
	"query_expansion",
	"multiple_probes_in_thread",
]);

/** Whether a candidate matched content rather than only being ranked/routed. */
function hasMatchReason(reasons: readonly RankingReason[]): boolean {
	return reasons.some((reason) => MATCH_REASONS.has(reason));
}

export function buildDroppedCandidates(input: {
	candidates: readonly ThreadCandidate[];
	selectedIds: ReadonlySet<string>;
	noMatchIds: ReadonlySet<string>;
	/** Candidates whose thread could not be retrieved this request. */
	unavailableIds?: ReadonlySet<string>;
	config: MattermostConfig;
	limit?: number;
}): DroppedCandidate[] {
	const limit = input.limit ?? DROPPED_CANDIDATES_LIMIT;
	const dropped: DroppedCandidate[] = [];
	for (const candidate of input.candidates) {
		if (input.selectedIds.has(candidate.threadId)) continue;
		const dropReason = resolveDropReason(
			candidate,
			input.noMatchIds.has(candidate.threadId),
			Boolean(input.unavailableIds?.has(candidate.threadId)),
		);
		const reasons = [...candidate.reasons];
		if (
			!isActionableDroppedCandidate({ dropReason, reasons }) &&
			!hasMatchReason(reasons)
		) {
			continue;
		}
		const excerpts = [
			...new Set(
				candidate.matches
					.map(({ excerpt }) => redactCredentialExcerpts(excerpt))
					.filter((excerpt) => excerpt.length > 0),
			),
		].slice(0, 2);
		const excerpt = excerpts[0];
		dropped.push({
			threadId: candidate.threadId,
			url: postLink(input.config, candidate.rootPostId),
			conversationId: candidate.conversationId,
			conversationAlias: candidate.conversationAlias,
			conversationKind: candidate.conversationKind,
			dropReason,
			reasons,
			...(excerpt ? { excerpt } : {}),
			...(excerpts.length ? { excerpts } : {}),
		});
	}
	dropped.sort(compareDroppedCandidates);
	return dropped.slice(0, limit);
}

/**
 * Reasons that make an unexamined candidate a *plausible* missing answer rather
 * than ranking tail: it names the subject ticket, or it carries the query as a
 * phrase or structured entity. Morphology, concepts, transliteration and typo
 * rescue are all absent — those routinely surface a thread that merely shares
 * vocabulary, and counting them made every probed packet look as though real
 * evidence had been left unexamined.
 */
const SUBJECT_EVIDENCE_REASONS: ReadonlySet<RankingReason> =
	new Set<RankingReason>([
		"direct_post",
		"explicit_ticket_relationship",
		"ticket_in_root",
		"ticket_in_reply",
		"structured_entity_match",
		"subject_in_root",
		"exact_phrase",
		"exact_phrase_in_root",
		"exact_phrase_in_reply",
		"all_terms_in_thread",
		// `remote_search` is deliberately absent: a remote candidate carries no
		// local lexical reason of its own, so counting it would mark every
		// stale-index request as having missed something regardless of content.
	]);

/**
 * Candidates the budget stopped the packer from examining that nonetheless
 * carried subject-level evidence. `droppedByBudget` alone conflates these with
 * the long weak tail, which is why a packet with 173 unexamined candidates
 * could not say whether any of them mattered.
 */
export function countSubjectMatchedBudgetDrops(input: {
	candidates: readonly ThreadCandidate[];
	/** Ids the packer actually dropped for lack of room — never re-derived. */
	budgetDroppedIds: ReadonlySet<string>;
}): number {
	let count = 0;
	for (const candidate of input.candidates) {
		if (!input.budgetDroppedIds.has(candidate.threadId)) continue;
		if (
			candidate.reasons.some((reason) => SUBJECT_EVIDENCE_REASONS.has(reason))
		) {
			count += 1;
		}
	}
	return count;
}

/**
 * Budget drop that still named the subject (same reason set as
 * {@link countSubjectMatchedBudgetDrops}). Used when the verdict already says
 * other threads may have been missed but no thin/ticket `inspect_dropped` fired.
 */
export function isSubjectMatchedBudgetDrop(
	candidate: Pick<DroppedCandidate, "dropReason" | "reasons">,
): boolean {
	return (
		candidate.dropReason === "budget" &&
		candidate.reasons.some((reason) => SUBJECT_EVIDENCE_REASONS.has(reason))
	);
}

/**
 * Candidates whose selection must survive `--query` probe re-evaluation: they
 * already carry subject-level ticket evidence or were caller-pinned via
 * permalink. Free-text subjects stay unpinned so stale hydrates that no longer
 * match the query can still drop as no_match.
 */
export function isProbePinnedCandidate(
	reasons: readonly RankingReason[],
	subjectKind: MattermostSubject["kind"],
): boolean {
	if (reasons.includes("direct_post")) return true;
	if (subjectKind !== "ticket") return false;
	return reasons.some(
		(reason) =>
			reason === "explicit_ticket_relationship" ||
			SUBJECT_EVIDENCE_REASONS.has(reason),
	);
}

/** Thin or ticket-related drops worth an `inspect_dropped` next action. */
export function isActionableDroppedCandidate(
	candidate: Pick<DroppedCandidate, "dropReason" | "reasons">,
): boolean {
	if (candidate.dropReason === "thin") return true;
	return candidate.reasons.some(
		(reason) =>
			reason === "ticket_in_root" ||
			reason === "ticket_in_reply" ||
			reason === "explicit_ticket_relationship",
	);
}

/** Max length for ticket/URL/status-only excerpts treated as self-contained. */
const THIN_SELF_CONTAINED_EXCERPT_MAX = 120;

/**
 * Short status / ping remnants after ticket+URL strip that do not justify
 * hydrating a dropped DM (excerpt already says everything useful).
 */
const THIN_STATUS_LEXICON: readonly string[] = [
	"не работает",
	"неработает",
	"сломалось",
	"сломано",
	"баг",
	"bug",
	"broken",
	"doesn't work",
	"doesnt work",
	"does not work",
	"глянь",
	"гляньте",
	"посмотри",
	"посмотрите",
	"look",
	"check",
	"pls",
	"please",
];

/**
 * Whether an actionable drop still merits `inspect_dropped`: excerpt must add a
 * symptom not already visible in selected packed messages.
 */
export function shouldRecommendInspectDropped(
	candidate: Pick<DroppedCandidate, "excerpt" | "excerpts">,
	selectedMessages: readonly string[],
): boolean {
	const excerpts = droppedExcerpts(candidate);
	if (!excerpts.length) return false;
	return excerpts.some(
		(excerpt) =>
			!isThinSelfContainedExcerpt(excerpt) &&
			!isNearSubstringOfSelected(excerpt, selectedMessages),
	);
}

function droppedExcerpts(
	candidate: Pick<DroppedCandidate, "excerpt" | "excerpts">,
): string[] {
	const fromList = (candidate.excerpts ?? [])
		.map((excerpt) => excerpt.trim())
		.filter((excerpt) => excerpt.length > 0);
	if (fromList.length) return fromList;
	const single = candidate.excerpt?.trim();
	return single ? [single] : [];
}

/**
 * Ticket keys / URLs / short status lexicon / punctuation only, and short
 * enough to be self-contained (e.g. `BTB-2080 не работает`).
 */
function isThinSelfContainedExcerpt(excerpt: string): boolean {
	const trimmed = excerpt.trim();
	if (!trimmed) return true;
	if (trimmed.length > THIN_SELF_CONTAINED_EXCERPT_MAX) return false;
	TICKET_PATTERN.lastIndex = 0;
	URL_PATTERN.lastIndex = 0;
	let remainder = trimmed
		.replace(TICKET_PATTERN, " ")
		.replace(URL_PATTERN, " ");
	for (const phrase of THIN_STATUS_LEXICON) {
		remainder = remainder.replace(new RegExp(escapeRegExp(phrase), "gi"), " ");
	}
	const withoutNoise = remainder.replace(/[\s\p{P}\p{S}]+/gu, "");
	return withoutNoise.length === 0;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNearSubstringOfSelected(
	excerpt: string,
	selectedMessages: readonly string[],
): boolean {
	const needle = normalizeWhitespace(excerpt);
	if (!needle) return true;
	for (const message of selectedMessages) {
		const haystack = normalizeWhitespace(message);
		if (haystack.includes(needle)) return true;
	}
	return false;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function compareDroppedCandidates(
	left: DroppedCandidate,
	right: DroppedCandidate,
): number {
	const leftActionable = isActionableDroppedCandidate(left) ? 0 : 1;
	const rightActionable = isActionableDroppedCandidate(right) ? 0 : 1;
	if (leftActionable !== rightActionable) {
		return leftActionable - rightActionable;
	}
	const leftThin = left.dropReason === "thin" ? 0 : 1;
	const rightThin = right.dropReason === "thin" ? 0 : 1;
	return leftThin - rightThin;
}

function resolveDropReason(
	candidate: ThreadCandidate,
	noMatch: boolean,
	unavailable: boolean,
): DroppedCandidateReason {
	if (unavailable) return "unavailable";
	if (noMatch) return "no_match";
	if (candidate.reasons.includes("thin_thread")) return "thin";
	return "budget";
}
