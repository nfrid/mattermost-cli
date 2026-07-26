import type { MattermostConfig } from "../config/config.ts";
import {
	type MattermostSubject,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingResult,
	searchThreads,
	widenedRouting,
} from "../search/index.ts";
import { normalizeSearchText, STOP_WORDS } from "../search/text.ts";
import type { MattermostStore, ThreadSearchFilters } from "../store/index.ts";
import { localEvidence, matchingProbeValues, postLink } from "./helpers.ts";
import type { BackgroundThread } from "./types.ts";

/** Background pointers returned per packet (full / `--json`). */
const BACKGROUND_LIMIT = 5;
/** Non-noise background pointers kept in the `--agent` projection. */
export const AGENT_BACKGROUND_NON_NOISE_LIMIT = 2;
/** Distinct excerpts kept per background pointer. */
const BACKGROUND_EXCERPTS = 2;
/**
 * Single-token probes at or below this length are treated as stop-ish noise
 * without a document-frequency index (e.g. «роль»).
 */
const SHORT_NOISE_TERM = 4;
/**
 * Single-token probes at or below this length without identifier shape are
 * also noise-prone (e.g. «фильтр», «магнит»).
 */
const SOFT_NOISE_TERM = 6;
/**
 * Fallback retrieval sources too loose to attribute a pointer to a probe: they
 * exist to rescue typos and truncations inside an already-relevant candidate
 * set, not to justify surfacing an unrelated thread as background.
 */
const WEAK_LEXICAL_SOURCES: ReadonlySet<string> = new Set([
	"trigram",
	"prefix_fts",
]);

/**
 * Thematically close threads *outside* ticket routing.
 *
 * A ticket subject routes only to conversations already linked to that ticket
 * (`routing.reason === "ticket_relationships"`), so `--query` probes can only
 * reorder what that link already found — the design discussion that predates
 * the ticket lives in a channel the routing never reaches. This runs those
 * explicit probes over the remaining configured conversations and returns
 * pointers only: nothing here is hydrated, packed, or counted against the
 * selection budget, so ranking of the real packet is unchanged.
 *
 * Returns nothing unless the caller passed explicit probes — an unattributable
 * widening would just be noise.
 */
export function findBackgroundThreads(input: {
	config: MattermostConfig;
	store: MattermostStore;
	subject: MattermostSubject;
	probes: readonly RetrievalProbe[];
	routing: RoutingResult;
	all: readonly RoutedConversation[];
	filters: ThreadSearchFilters;
	selectedThreadIds: ReadonlySet<string>;
	hasExplicitProbes: boolean;
	deadlineAt?: number;
	includeAutomation?: boolean;
}): BackgroundThread[] {
	if (!input.hasExplicitProbes || input.subject.kind !== "ticket") return [];
	const subjectTicket = input.subject.ticketKey;
	const probes = input.probes.filter(
		(probe) => probe.value.trim().toUpperCase() !== subjectTicket,
	);
	if (!probes.length) return [];

	const outside = widenedRouting(input.all, input.routing);
	if (!outside.conversations.length) return [];

	const candidates = searchThreads(
		input.store,
		{ kind: "text", text: subjectTicket, raw: subjectTicket },
		probes,
		outside,
		BACKGROUND_LIMIT * 4,
		input.filters,
		{
			...(input.deadlineAt !== undefined
				? { deadlineAt: input.deadlineAt }
				: {}),
			includeAutomation: Boolean(input.includeAutomation),
			suppressAuthors: input.config.suppressAuthors ?? [],
		},
	);

	const probesByValue = new Map(probes.map((probe) => [probe.value, probe]));
	const nonNoise: BackgroundThread[] = [];
	const noise: BackgroundThread[] = [];
	for (const candidate of candidates) {
		if (nonNoise.length + noise.length >= BACKGROUND_LIMIT) break;
		if (input.selectedThreadIds.has(candidate.threadId)) continue;
		// Attribution is only worth anything when the match is one a reader would
		// recognize. A trigram or prefix hit surfaces "rotating ssh keys" for the
		// probe «idempotency keys» — which reads as evidence the probe worked and
		// crowds out the pointers that earned their place.
		const qualifiedProbes = new Set(
			matchingProbeValues(
				localEvidence(input.store, input.store.getThread(candidate.threadId)),
				probes,
			),
		);
		const strongMatches = candidate.matches.filter(
			(match) =>
				qualifiedProbes.has(match.probe) &&
				(!match.lexicalSource ||
					!WEAK_LEXICAL_SOURCES.has(match.lexicalSource)),
		);
		if (!strongMatches.length) continue;
		const excerpts = [
			...new Set(
				strongMatches
					.map(({ excerpt }) => excerpt)
					.filter((excerpt) => excerpt.length > 0),
			),
		].slice(0, BACKGROUND_EXCERPTS);
		if (!excerpts.length) continue;
		const matchedProbes = [
			...new Set(strongMatches.map(({ probe }) => probe)),
		].sort();
		const matchedProbeDefs = matchedProbes
			.map((value) => probesByValue.get(value))
			.filter((probe): probe is RetrievalProbe => probe !== undefined);
		const noisy = matchedProbeDefs.every(isNoisyBackgroundProbe);
		const pointer: BackgroundThread = {
			threadId: candidate.threadId,
			conversationId: candidate.conversationId,
			conversationAlias: candidate.conversationAlias,
			conversationKind: candidate.conversationKind,
			url: postLink(input.config, candidate.rootPostId),
			latestActivityAt: candidate.latestActivityAt,
			reasons: [...candidate.reasons],
			matchedProbes,
			excerpts,
			whyBackground: whyBackgroundReason(matchedProbes, noisy),
			...(noisy ? { noise: true as const } : {}),
		};
		if (noisy) noise.push(pointer);
		else nonNoise.push(pointer);
	}
	// Prefer attributable pointers; keep a short noise tail for `--json` only.
	return [...nonNoise, ...noise].slice(0, BACKGROUND_LIMIT);
}

/**
 * Soft / stop-ish probes that match too broadly to justify a background
 * pointer. Multi-term or longer identifier-shaped terms stay eligible.
 */
export function isNoisyBackgroundProbe(probe: RetrievalProbe): boolean {
	if (probe.phrases.some((phrase) => nontrivialPhrase(phrase))) return false;
	const terms = probe.terms;
	if (!terms.length) {
		const normalized = normalizeSearchText(probe.value).trim();
		return !normalized || normalized.length <= SHORT_NOISE_TERM;
	}
	if (terms.length >= 2) {
		return terms.every((term) => term.length <= SHORT_NOISE_TERM);
	}
	const [term] = terms;
	if (!term) return true;
	if (STOP_WORDS.has(term) || isStopWordAdjacentProbe(probe)) return true;
	if (term.length <= SHORT_NOISE_TERM) return true;
	if (term.length <= SOFT_NOISE_TERM && !hasIdentifierShape(term)) return true;
	return false;
}

function nontrivialPhrase(phrase: string): boolean {
	const tokens = (phrase.match(/[\p{L}\p{N}_-]+/gu) ?? [])
		.map(normalizeSearchText)
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
	return (
		tokens.length >= 2 ||
		tokens.some((token) => token.length > SHORT_NOISE_TERM)
	);
}

function hasIdentifierShape(term: string): boolean {
	return /[-_\d]/u.test(term);
}

/**
 * Raw probe text still contains a stop word beside a kept short token — the
 * content word alone is usually too broad for background attribution.
 */
function isStopWordAdjacentProbe(probe: RetrievalProbe): boolean {
	const rawTokens = (probe.value.match(/[\p{L}\p{N}_-]+/gu) ?? []).map(
		normalizeSearchText,
	);
	for (let index = 0; index < rawTokens.length; index += 1) {
		const token = rawTokens[index];
		if (!token || !STOP_WORDS.has(token)) continue;
		for (const neighbor of [rawTokens[index - 1], rawTokens[index + 1]]) {
			if (
				neighbor &&
				!STOP_WORDS.has(neighbor) &&
				neighbor.length <= SHORT_NOISE_TERM
			) {
				return true;
			}
		}
	}
	return false;
}

function whyBackgroundReason(
	matchedProbes: readonly string[],
	noisy: boolean,
): string {
	const labeled = matchedProbes.map((probe) => `«${probe}»`).join(", ");
	if (noisy) {
		return `Weak/short probe ${labeled} matched outside ticket routing; treat as noise — do not hydrate without an independent reason.`;
	}
	return `Matched probe ${labeled} outside ticket routing; hydrate only if the excerpt earns it.`;
}
