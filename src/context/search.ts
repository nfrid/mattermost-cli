import {
	directCandidate,
	type ThreadCandidate,
	widenedRouting,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { searchDeadlineAt } from "../shared/limits.ts";
import {
	freshnessEvidence,
	postLink,
	probeWarnings,
	routingHintWarnings,
} from "./helpers.ts";
import { prepareSearch } from "./prepare.ts";
import { withResources } from "./resources.ts";
import { createThreadSearcher } from "./thread-search.ts";
import {
	type ContextDependencies,
	DEFAULT_SEARCH_EXCERPTS,
	DEFAULT_SEARCH_LIMIT,
	type SearchContextResult,
	type SearchInput,
} from "./types.ts";
import {
	incompleteHistoryWarning,
	SEARCH_DEADLINE_WARNING,
	summarizeConversations,
} from "./warnings.ts";

export async function searchMattermost(
	input: SearchInput,
	dependencies: ContextDependencies = {},
): Promise<SearchContextResult> {
	return withResources(dependencies, async (config, store) => {
		const prepared = prepareSearch({
			config,
			store,
			subject: input.subject,
			ticket: input.ticket,
			queries: input.queries,
			probes: input.probes,
			channels: input.channels,
			scopes: input.scopes,
			repositories: input.repositories,
			noWiden: input.noWiden,
			from: input.from,
			after: input.after,
			before: input.before,
			hasFile: input.hasFile,
			file: input.file,
		});
		const { subject, probes, resolvedFilters, all } = prepared;
		let { routing } = prepared;
		const searched = new Map(
			routing.conversations.map((conversation) => [
				conversation.id,
				conversation,
			]),
		);
		const searchIncomplete = { value: false };
		const deadlineAt = searchDeadlineAt();
		const searcher = createThreadSearcher({
			config,
			store,
			subject,
			probes,
			filters: resolvedFilters.storage,
			deadlineAt,
			incomplete: searchIncomplete,
			includeAutomation: input.includeAutomation,
		});

		let candidates: ThreadCandidate[];
		if (subject.kind === "post") {
			const post = store.getPost(subject.postId);
			const configuredConversation = post
				? all.find(({ id }) => id === post.conversationId)
				: undefined;
			const restrictedConversation = post
				? routing.conversations.find(({ id }) => id === post.conversationId)
				: undefined;
			const conversation = input.channels?.length
				? restrictedConversation
				: configuredConversation;
			candidates =
				post &&
				conversation &&
				store.threadMatchesFilters(post.threadId, resolvedFilters.storage)
					? [directCandidate(post, conversation)]
					: [];
		} else {
			candidates = searcher.search(routing);
		}

		let widened = false;
		if (!candidates.length && routing.canWiden) {
			const fallback = widenedRouting(all, routing);
			if (fallback.conversations.length) {
				routing = fallback;
				for (const conversation of fallback.conversations) {
					searched.set(conversation.id, conversation);
				}
				candidates = searcher.search(routing);
				widened = true;
			}
		}

		const searchedConversations = [...searched.values()];
		const observedAt = dependencies.now?.() ?? Date.now();
		const freshness = freshnessEvidence(
			config,
			store,
			searchedConversations,
			observedAt,
		);
		const warnings: Warning[] = [];
		if (searchIncomplete.value) warnings.push(SEARCH_DEADLINE_WARNING);
		if (freshness.some(({ stale }) => stale)) {
			warnings.push({
				kind: "stale_local_index",
				message:
					"Local search used stale evidence without network reconciliation.",
			});
		}
		if (freshness.some(({ coverageComplete }) => !coverageComplete)) {
			warnings.push(incompleteHistoryWarning(freshness));
		}
		warnings.push(...routingHintWarnings(routing));
		if (input.queries?.length || input.probes?.length) {
			warnings.push(
				...probeWarnings(
					probes,
					new Set(
						candidates.flatMap(({ matches }) =>
							matches.map(({ probe }) => probe),
						),
					),
				),
			);
		}

		const searchCoverageComplete =
			!searchIncomplete.value &&
			freshness.every((item) => item.coverageComplete && !item.stale);
		return {
			subject,
			probes,
			filters: resolvedFilters.output,
			routing,
			candidates: candidates
				.slice(0, positiveLimit(input.limit, DEFAULT_SEARCH_LIMIT))
				.map((candidate) => ({
					...candidate,
					link: postLink(config, candidate.rootPostId),
				})),
			freshnessMode: "local",
			complete: searchCoverageComplete,
			searchCoverageComplete,
			freshness,
			searchedConversations: summarizeConversations(searchedConversations),
			widened,
			excerptLimit: positiveLimit(input.excerpts, DEFAULT_SEARCH_EXCERPTS),
			warnings,
		};
	});
}

/** A requested count clamped to a usable whole number, or the default. */
function positiveLimit(
	requested: number | undefined,
	fallback: number,
): number {
	const value = requested ?? fallback;
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}
