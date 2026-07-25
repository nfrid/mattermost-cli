import type { MattermostConfig } from "../config/config.ts";
import {
	type MattermostSubject,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingResult,
	searchThreads,
	widenedRouting,
} from "../search/index.ts";
import type { MattermostStore, ThreadSearchFilters } from "../store/index.ts";
import { postLink } from "./helpers.ts";
import type { BackgroundThread } from "./types.ts";

/** Background pointers returned per packet. */
const BACKGROUND_LIMIT = 5;
/** Distinct excerpts kept per background pointer. */
const BACKGROUND_EXCERPTS = 2;

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

	const background: BackgroundThread[] = [];
	for (const candidate of candidates) {
		if (background.length >= BACKGROUND_LIMIT) break;
		if (input.selectedThreadIds.has(candidate.threadId)) continue;
		const excerpts = [
			...new Set(
				candidate.matches
					.map(({ excerpt }) => excerpt)
					.filter((excerpt) => excerpt.length > 0),
			),
		].slice(0, BACKGROUND_EXCERPTS);
		if (!excerpts.length) continue;
		background.push({
			threadId: candidate.threadId,
			conversationId: candidate.conversationId,
			conversationAlias: candidate.conversationAlias,
			conversationKind: candidate.conversationKind,
			url: postLink(input.config, candidate.rootPostId),
			latestActivityAt: candidate.latestActivityAt,
			reasons: [...candidate.reasons],
			matchedProbes: [
				...new Set(candidate.matches.map(({ probe }) => probe)),
			].sort(),
			excerpts,
		});
	}
	return background;
}
