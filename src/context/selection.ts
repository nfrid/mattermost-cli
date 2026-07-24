import type { MattermostConfig } from "../config/config.ts";
import { TICKET_PATTERN } from "../search/extract.ts";
import type { MattermostSubject, ThreadCandidate } from "../search/index.ts";
import { postLink } from "./helpers.ts";
import type {
	DroppedCandidate,
	DroppedCandidateReason,
	SelectionEvidence,
} from "./types.ts";

const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;

export const DROPPED_CANDIDATES_LIMIT = 5;

/** Prefer substantive / deeper threads over thin announce stubs. */
export function pickPrimaryThreadIndex(
	threads: readonly {
		reasons: readonly string[];
		totalPosts: number;
		omittedPosts: number;
		ticketDensity?: number;
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
		const score =
			(thin ? -100 : 0) +
			substantive +
			thread.totalPosts +
			Math.round((thread.ticketDensity ?? 0) * 5) -
			thread.omittedPosts * 0.01;
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return bestIndex;
}

export function selectionEvidence(input: {
	candidateThreads: number;
	returnedThreads: number;
	droppedThin: number;
	droppedByBudget: number;
	droppedNoMatch: number;
	droppedCandidates?: readonly DroppedCandidate[];
}): SelectionEvidence {
	return {
		candidateThreads: input.candidateThreads,
		returnedThreads: input.returnedThreads,
		droppedThin: input.droppedThin,
		droppedByBudget: input.droppedByBudget,
		droppedNoMatch: input.droppedNoMatch,
		droppedCandidates: [...(input.droppedCandidates ?? [])],
	};
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

export function buildDroppedCandidates(input: {
	candidates: readonly ThreadCandidate[];
	selectedIds: ReadonlySet<string>;
	noMatchIds: ReadonlySet<string>;
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
		);
		const excerpts = [
			...new Set(
				candidate.matches
					.map(({ excerpt }) => excerpt)
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
			reasons: [...candidate.reasons],
			...(excerpt ? { excerpt } : {}),
			...(excerpts.length ? { excerpts } : {}),
		});
	}
	dropped.sort(compareDroppedCandidates);
	return dropped.slice(0, limit);
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
): DroppedCandidateReason {
	if (noMatch) return "no_match";
	if (candidate.reasons.includes("thin_thread")) return "thin";
	return "budget";
}
