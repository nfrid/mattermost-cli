import type { MattermostConfig } from "../config/config.ts";
import {
	type MattermostSubject,
	type RetrievalProbe,
	type RoutingResult,
	searchThreads,
	type ThreadCandidate,
} from "../search/index.ts";
import type {
	IndexedPost,
	MattermostStore,
	ThreadSearchFilters,
} from "../store/index.ts";

/** Ranked candidates kept per local search pass before selection narrows them. */
const LOCAL_SEARCH_LIMIT = 100;

/**
 * A reusable local search over one routing result. Context and search both run
 * the same query several times (initial routing, then widened routing), so the
 * per-request state — deadline, incompleteness flag, thread cache — lives here
 * instead of being rebuilt at each call site.
 */
export function createThreadSearcher(input: {
	config: MattermostConfig;
	store: MattermostStore;
	subject: MattermostSubject;
	probes: readonly RetrievalProbe[];
	filters: ThreadSearchFilters;
	deadlineAt: number;
	incomplete: { value: boolean };
	includeAutomation?: boolean;
}): {
	search: (routing: RoutingResult) => ThreadCandidate[];
	/** Drops cached threads after a freshen so the next pass re-reads the index. */
	invalidate: () => void;
} {
	const threadCache = new Map<string, IndexedPost[]>();
	return {
		search: (routing) =>
			searchThreads(
				input.store,
				input.subject,
				input.probes,
				routing,
				LOCAL_SEARCH_LIMIT,
				input.filters,
				{
					deadlineAt: input.deadlineAt,
					incomplete: input.incomplete,
					includeAutomation: Boolean(input.includeAutomation),
					suppressAuthors: input.config.suppressAuthors ?? [],
					threadCache,
				},
			),
		invalidate: () => threadCache.clear(),
	};
}
