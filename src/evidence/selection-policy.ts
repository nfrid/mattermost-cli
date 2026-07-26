/**
 * Selection judgments shared by the packer and by `buildEvidence`.
 *
 * These are pure predicates over candidate and dropped-candidate shapes — no
 * config, no store, no packet assembly. They live here rather than in
 * `context/selection.ts` because `buildEvidence` needs them to decide what to
 * recommend, and `evidence/` must not import orchestration. `context/` builds
 * the dropped-candidate list on top of them.
 */
import type { RankingReason } from "../search/index.ts";
import { TICKET_PATTERN } from "../text/index.ts";
import type { DroppedCandidate } from "./types.ts";

const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;

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
 * Reasons that make an unexamined candidate a *plausible* missing answer rather
 * than ranking tail: it names the subject ticket, or it carries the query as a
 * phrase or structured entity. Morphology, concepts, transliteration and typo
 * rescue are all absent — those routinely surface a thread that merely shares
 * vocabulary, and counting them made every probed packet look as though real
 * evidence had been left unexamined.
 */
export const SUBJECT_EVIDENCE_REASONS: ReadonlySet<RankingReason> =
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
 * Budget drop that still named the subject (same reason set as
 * `countSubjectMatchedBudgetDrops`). Used when the verdict already says
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
