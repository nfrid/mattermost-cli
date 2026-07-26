import { buildEvidence } from "../evidence/evidence.ts";
import {
	connectionFromConfig,
	MattermostClient,
} from "../mattermost/client.ts";
import {
	mergeThreadCandidates,
	type RoutedConversation,
	widenedRouting,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { searchDeadlineAt } from "../shared/limits.ts";
import { inspectFreshness } from "../sync/sync.ts";
import { findBackgroundThreads } from "./background.ts";
import {
	freshen,
	resolveContextConversations,
	selectFreshenConversations,
} from "./freshen.ts";
import {
	buildProbeCoverage,
	freshnessEvidence,
	matchingProbeValues,
	partialProbeEvidence,
} from "./helpers.ts";
import { ThreadPacker } from "./pack-threads.ts";
import { peopleInThreads } from "./people.ts";
import { resolvePermalinkTargets } from "./permalinks.ts";
import { assertRemoteSearchAllowed, prepareSearch } from "./prepare.ts";
import { resolveRelatedTicketPointers } from "./related-tickets.ts";
import { runRemoteSearchPass } from "./remote-search.ts";
import { withResources } from "./resources.ts";
import { retrieveCandidates } from "./retrieve.ts";
import {
	finalizeSelectionEvidence,
	orderCandidatesForThinReserve,
} from "./selection.ts";
import { createThreadSearcher } from "./thread-search.ts";
import type {
	ContextDependencies,
	ContextInput,
	ContextResult,
	RemoteSearchEvidence,
} from "./types.ts";
import { collectContextWarnings, summarizeConversations } from "./warnings.ts";

const NO_REMOTE_SEARCH: RemoteSearchEvidence = {
	requested: false,
	performed: false,
	reason: null,
	queries: [],
	candidateThreads: 0,
	failures: 0,
};

export async function getMattermostContext(
	input: ContextInput,
	dependencies: ContextDependencies = {},
): Promise<ContextResult> {
	return withResources(dependencies, async (config, store, providedClient) => {
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
			contextConversations: true,
		});
		const { subject, probes, resolvedFilters, all } = prepared;
		let { routing } = prepared;
		assertRemoteSearchAllowed({
			local: input.local,
			remoteSearch: input.remoteSearch,
			subject,
		});
		const client = input.local
			? undefined
			: (providedClient ?? new MattermostClient(connectionFromConfig(config)));
		const freshenWarnings: Warning[] = [];
		const remoteSearchWarnings: Warning[] = [];
		const packingWarnings: Warning[] = [];
		const searchIncomplete = { value: false };
		const deadlineAt = searchDeadlineAt();
		const observedAt = dependencies.now?.() ?? Date.now();
		const searched = new Map<string, RoutedConversation>();
		const initiallyFreshIds = new Set(
			inspectFreshness(config, store, all, observedAt)
				.filter(({ stale }) => !stale)
				.map(({ conversationId }) => conversationId),
		);
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

		const retrieved = await retrieveCandidates({
			config,
			store,
			client,
			input,
			subject,
			routing,
			all,
			storageFilters: resolvedFilters.storage,
			searcher,
			searched,
			warnings: freshenWarnings,
			observedAt,
		});
		routing = retrieved.routing;
		const { fallbackRouting, freshenedConversationCount } = retrieved;
		let { candidates, performedWidening } = retrieved;

		for (const conversation of routing.conversations)
			searched.set(conversation.id, conversation);

		let remoteSearch: RemoteSearchEvidence = {
			...NO_REMOTE_SEARCH,
			requested: Boolean(input.remoteSearch),
		};
		if (
			input.remoteSearch &&
			client?.searchTeamPosts &&
			subject.kind !== "post"
		) {
			const pass = await runRemoteSearchPass({
				config,
				client,
				probes,
				conversations: [...searched.values()],
				deadlineAt,
				incomplete: searchIncomplete,
				reason: "explicit",
				warnings: remoteSearchWarnings,
			});
			remoteSearch = pass.remoteSearch;
			candidates = mergeThreadCandidates(candidates, pass.candidates);
		} else if (input.remoteSearch && !client?.searchTeamPosts) {
			remoteSearchWarnings.push({
				kind: "remote_search_unavailable",
				message:
					"The configured context client does not support bounded Mattermost search.",
			});
		}

		const permalinkTargets = await resolvePermalinkTargets({
			permalinks: input.permalinks ?? [],
			store,
			client,
			conversations: all,
			configured: resolveContextConversations(config, store),
			...(input.channels?.length ? { restrictedTo: input.channels } : {}),
			fresh: Boolean(input.fresh),
			warnings: freshenWarnings,
		});
		const permalinkCandidates = permalinkTargets.candidates;
		const permalinkThreadIds = new Set(
			permalinkCandidates.map(({ threadId }) => threadId),
		);

		// `--navigate` changes only the projection shape, but packing must still
		// reserve a fair per-thread share of the default budget so one fat
		// candidate cannot silently drop the rest of selection. `--short` remains
		// the small-budget card mode.
		const packer = new ThreadPacker({
			config,
			store,
			client,
			subject,
			probes,
			filters: resolvedFilters.storage,
			conversations: all,
			initiallyFreshIds,
			fresh: Boolean(input.fresh),
			short: Boolean(input.short),
			navigate: Boolean(input.navigate),
			brief: Boolean(input.brief),
			observedAt,
			deadlineAt,
			warnings: freshenWarnings,
			candidateCount: new Set([
				...candidates.map((item) => item.threadId),
				...permalinkThreadIds,
			]).size,
		});
		const { threads } = packer;
		// Explicitly requested links are packed before ranked candidates: the
		// caller already decided these are evidence, so they must not lose the
		// budget to threads retrieval merely guessed at.
		await packer.pack(permalinkCandidates);
		const rankedCandidates = candidates.filter(
			({ threadId }) => !permalinkThreadIds.has(threadId),
		);
		await packer.pack(
			orderCandidatesForThinReserve(
				rankedCandidates,
				subject,
				// The thin reserve must aim at a slot that still exists: permalink
				// threads have already taken theirs.
				Math.max(0, packer.budgets.maxThreads - threads.length),
			),
		);
		// `maxThreads` is small (3 by default), so a ticket description with three
		// links can fill the packet entirely. That is the caller's own instruction
		// — but it must not look like the subject simply had no threads.
		const rankedPacked = threads.filter(
			({ threadId }) => !permalinkThreadIds.has(threadId),
		).length;
		if (
			permalinkCandidates.length &&
			rankedCandidates.length &&
			!rankedPacked
		) {
			packingWarnings.push({
				kind: "permalink_crowded_out_ranked",
				message: `${permalinkCandidates.length} explicit permalink thread(s) filled the packet; ${rankedCandidates.length} ranked candidate(s) for the subject were never packed. Re-run without --permalink, or with fewer.`,
			});
		}

		if (!threads.length && fallbackRouting && !performedWidening) {
			const widened = widenedRouting(all, fallbackRouting);
			if (widened.conversations.length) {
				performedWidening = true;
				routing = widened;
				await freshen(
					config,
					store,
					client,
					selectFreshenConversations(
						config,
						store,
						widened,
						subject,
						[],
						Boolean(input.fresh),
						observedAt,
					),
					Boolean(input.fresh),
					freshenWarnings,
				);
				for (const conversation of widened.conversations) {
					searched.set(conversation.id, conversation);
				}
				searcher.invalidate();
				await packer.pack(searcher.search(widened));
			}
		}

		const searchedConversations = [...searched.values()];
		const localFreshness = inspectFreshness(
			config,
			store,
			searchedConversations,
			observedAt,
		);
		const automaticRemoteReason = localFreshness.some(
			({ coverageComplete }) => !coverageComplete,
		)
			? "incomplete_local_coverage"
			: localFreshness.some(({ stale }) => stale)
				? "stale_local_index"
				: null;
		const remoteReason = input.remoteSearch ? null : automaticRemoteReason;
		if (
			remoteReason &&
			packer.hasRoom &&
			client?.searchTeamPosts &&
			subject.kind !== "post"
		) {
			const pass = await runRemoteSearchPass({
				config,
				client,
				probes,
				conversations: searchedConversations,
				deadlineAt,
				incomplete: searchIncomplete,
				reason: remoteReason,
				warnings: remoteSearchWarnings,
			});
			remoteSearch = pass.remoteSearch;
			const selectedThreadIds = new Set(
				threads.map(({ threadId }) => threadId),
			);
			await packer.pack(
				pass.candidates.filter(
					({ threadId }) => !selectedThreadIds.has(threadId),
				),
			);
		}
		// Reclaim / brief-secondary shrink after every packing pass so leftover
		// budget is not spent before remote candidates get a chance to pack.
		packer.finalizeBudget();

		const selectedIds = new Set(threads.map(({ threadId }) => threadId));
		const hasExplicitProbes = Boolean(
			input.queries?.length || input.probes?.length,
		);
		// Built before the warnings: a probe that only reached the non-routed
		// conversations must be reported as `background_only`, not as unmatched.
		const background = findBackgroundThreads({
			config,
			store,
			subject,
			probes,
			routing,
			all,
			filters: resolvedFilters.storage,
			selectedThreadIds: selectedIds,
			hasExplicitProbes,
			deadlineAt,
			includeAutomation: input.includeAutomation,
		});
		// Derived from the packed threads, never from `packer.matchedProbeValues`:
		// that set records every candidate the packer examined, including ones a
		// hard filter or a hydration failure removed afterwards, so an empty packet
		// could otherwise report a probe as having matched selected evidence.
		const selectedProbeValues = new Set(
			threads.flatMap((thread) => matchingProbeValues(thread.posts, probes)),
		);
		const probeCoverage = hasExplicitProbes
			? buildProbeCoverage(
					probes,
					selectedProbeValues,
					background,
					partialProbeEvidence(
						threads.flatMap(({ posts }) => posts),
						probes,
					),
				)
			: [];

		const freshness = freshnessEvidence(
			config,
			store,
			searchedConversations,
			observedAt,
		);
		const warnings = collectContextWarnings({
			freshenWarnings,
			remoteSearchWarnings,
			packingWarnings,
			searchIncomplete: searchIncomplete.value,
			hydrationFailures: packer.hydrationFailures.length,
			hydrationBudgetSpent: packer.hydrationBudgetSpent,
			navigate: Boolean(input.navigate),
			navigateBudgetDropped: packer.budgetDroppedIds.size,
			packedThreads: threads.length,
			maxThreads: packer.budgets.maxThreads,
			local: Boolean(input.local),
			freshness,
			hasExplicitProbes,
			subjectKind: subject.kind,
			routing,
			config,
			probeCoverage,
		});

		const searchCoverageComplete =
			!searchIncomplete.value &&
			freshness.every(
				(item) => item.coverageComplete && (!input.local || !item.stale),
			);
		const selectedThreadsComplete =
			threads.length > 0 &&
			threads.every(
				(thread) =>
					thread.omittedPosts === 0 && thread.totalOmittedAttachments === 0,
			);

		const selection = finalizeSelectionEvidence({
			selection: packer.selection,
			seenCandidates: [...packer.seenCandidates.values()],
			offeredCandidates: candidates,
			selectedIds,
			returnedThreads: threads.length,
			budgetDroppedIds: packer.budgetDroppedIds,
			noMatchIds: packer.noMatchIds,
			unavailableIds: new Set(packer.hydrationFailures),
			config,
		});

		const freshConversationIds = new Set(
			freshness
				.filter(({ stale }) => !stale)
				.map(({ conversationId }) => conversationId),
		);
		const selectedEvidenceCurrent =
			threads.length > 0 &&
			threads.every(
				(thread) =>
					packer.networkHydratedThreadIds.has(thread.threadId) ||
					freshConversationIds.has(thread.conversationId),
			);
		const freshnessMode = input.local
			? "local"
			: input.fresh
				? "forced"
				: "network";
		const people = peopleInThreads(config, store, threads);
		return {
			subject,
			probes,
			filters: resolvedFilters.output,
			remoteSearch,
			freshnessMode,
			complete: searchCoverageComplete,
			searchCoverageComplete,
			selectedThreadsComplete,
			freshness,
			unmatchedHints: routing.unmatchedHints,
			searchedConversations: summarizeConversations(searchedConversations),
			explicitChannelPolicy: "restrict",
			widening: {
				allowed: !input.channels?.length && !input.noWiden,
				performed: performedWidening,
			},
			selection,
			relatedTickets: resolveRelatedTicketPointers({
				config,
				store,
				threads,
				subjectTicket:
					subject.kind === "ticket" ? subject.ticketKey : undefined,
				allowlist: new Set(searchedConversations.map(({ id }) => id)),
			}),
			evidence: buildEvidence({
				searchCoverageComplete,
				selectedThreadsComplete,
				selectionBudgetBounded: packer.hydrationBudgetSpent,
				freshnessMode,
				freshness,
				searchedConversations,
				threads,
				remoteSearch,
				selection,
				warnings,
				freshenedConversationCount,
				selectedEvidenceCurrent,
				subject:
					subject.kind === "ticket"
						? subject.ticketKey
						: subject.kind === "post"
							? subject.postId
							: subject.text,
				...(subject.kind === "ticket"
					? { subjectTicket: subject.ticketKey }
					: {}),
			}),
			threads,
			...(background.length ? { background } : {}),
			...(probeCoverage.length ? { probeCoverage } : {}),
			...(permalinkTargets.resolutions.length
				? {
						permalinks: permalinkTargets.resolutions.map((resolution) =>
							resolution.threadId
								? {
										...resolution,
										packed: selectedIds.has(resolution.threadId),
									}
								: resolution,
						),
					}
				: {}),
			budget: {
				measurement: "unicode_code_points_in_rendered_post",
				limit: packer.budgets.maxCharacters,
				// Clamp: floating reclaim / permalink reserve can leave
				// `remaining > maxCharacters` briefly; Zod rejects negatives.
				used: Math.max(0, packer.budgets.maxCharacters - packer.remaining),
				maxThreads: packer.budgets.maxThreads,
			},
			warnings,
			...(input.short ? { short: true } : {}),
			...(input.navigate ? { navigate: true } : {}),
			...(input.brief ? { brief: true } : {}),
			...(input.fullPosts ? { fullPosts: true } : {}),
			...(input.timeline ? { timeline: true } : {}),
			...(people.length ? { people } : {}),
			...(input.signals ? { signals: true } : {}),
		};
	});
}
