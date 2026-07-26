import { buildEvidence } from "../evidence/evidence.ts";
import {
	connectionFromConfig,
	MattermostClient,
} from "../mattermost/client.ts";
import {
	directCandidate,
	mergeThreadCandidates,
	type RoutedConversation,
	type RoutingResult,
	type ThreadCandidate,
	widenedRouting,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import {
	ConfigError,
	conversationNotAllowedDetails,
} from "../shared/errors.ts";
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
	consolidateLocalFallbackWarnings,
	freshnessEvidence,
	matchingProbeValues,
	partialProbeEvidence,
	probeWarnings,
	routingHintWarnings,
} from "./helpers.ts";
import { resolveDirectTarget } from "./hydrate.ts";
import { ThreadPacker } from "./pack-threads.ts";
import { peopleInThreads } from "./people.ts";
import { resolvePermalinkTargets } from "./permalinks.ts";
import { assertRemoteSearchAllowed, prepareSearch } from "./prepare.ts";
import { resolveRelatedTicketPointers } from "./related-tickets.ts";
import { searchRemoteCandidates } from "./remote-search.ts";
import { withResources } from "./resources.ts";
import {
	buildDroppedCandidates,
	countSubjectMatchedBudgetDrops,
	orderCandidatesForThinReserve,
} from "./selection.ts";
import { createThreadSearcher } from "./thread-search.ts";
import type {
	ContextDependencies,
	ContextInput,
	ContextResult,
	RemoteSearchEvidence,
} from "./types.ts";
import {
	incompleteHistoryWarning,
	remoteSearchFailureWarning,
	SEARCH_DEADLINE_WARNING,
	summarizeConversations,
} from "./warnings.ts";

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

		let performedWidening = false;
		let fallbackRouting: RoutingResult | undefined;
		let freshenedConversationCount = 0;
		let candidates: ThreadCandidate[];

		if (subject.kind === "post") {
			// Resolved against every *configured* conversation, not the `--channel`
			// subset: a post excluded by the caller's own restriction must be
			// reported as that, not as missing from the config.
			const configured = resolveContextConversations(config, store);
			const direct = await resolveDirectTarget(
				subject.postId,
				store,
				client,
				new Set(configured.map(({ id }) => id)),
				{ preferLocal: !input.fresh, warnings: freshenWarnings },
			);
			const conversation = all.find(({ id }) => id === direct.conversationId);
			if (!conversation) {
				// Reachable only under an explicit restriction: without one, `all` is
				// the same set the post already resolved against.
				const restricted = input.channels?.length
					? {
							reason: "channel_restriction" as const,
							restrictedTo: input.channels,
						}
					: { reason: "not_configured" as const };
				throw new ConfigError(
					restricted.reason === "channel_restriction"
						? "The direct post is outside the explicit channel restriction."
						: "The direct post is outside configured conversations.",
					"conversation_not_allowed",
					undefined,
					conversationNotAllowedDetails({
						...restricted,
						postId: subject.postId,
						conversationId: direct.conversationId,
					}),
				);
			}
			routing = {
				conversations: [
					{
						...conversation,
						evidence: input.channels?.length
							? [{ type: "explicit_channel", value: conversation.alias }]
							: [{ type: "all_configured", value: "direct_post" }],
					},
				],
				explicitChannelPolicy: "restrict",
				unmatchedHints: routing.unmatchedHints,
				reason: input.channels?.length ? "explicit_channels" : "all_configured",
				canWiden: false,
			};
			await freshen(
				config,
				store,
				client,
				routing.conversations,
				Boolean(input.fresh),
				freshenWarnings,
			);
			const directConversation = routing.conversations[0];
			if (!directConversation) {
				throw new ConfigError("Direct post routing failed.", "routing_failed");
			}
			candidates = store.threadMatchesFilters(
				direct.threadId,
				resolvedFilters.storage,
			)
				? [directCandidate(direct, directConversation)]
				: [];
		} else {
			fallbackRouting = routing.canWiden ? routing : undefined;
			candidates = searcher.search(routing);
			if (!candidates.length && routing.canWiden) {
				const widened = widenedRouting(all, routing);
				if (widened.conversations.length) {
					performedWidening = true;
					for (const conversation of routing.conversations)
						searched.set(conversation.id, conversation);
					routing = widened;
					candidates = searcher.search(widened);
				}
			}
			const freshenTargets = selectFreshenConversations(
				config,
				store,
				routing,
				subject,
				candidates,
				Boolean(input.fresh),
				observedAt,
			);
			freshenedConversationCount = freshenTargets.length;
			await freshen(
				config,
				store,
				client,
				freshenTargets,
				Boolean(input.fresh),
				freshenWarnings,
			);
			if (freshenTargets.length) {
				searcher.invalidate();
				candidates = searcher.search(routing);
			}
		}
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
			const result = await searchRemoteCandidates(
				config.teamId,
				client.searchTeamPosts.bind(client),
				probes,
				[...searched.values()],
				{ deadlineAt, incomplete: searchIncomplete },
			);
			remoteSearch = {
				requested: true,
				performed: true,
				reason: "explicit",
				queries: result.queries,
				candidateThreads: result.candidates.length,
				failures: result.failures,
			};
			if (result.failures) {
				remoteSearchWarnings.push(remoteSearchFailureWarning(result.failures));
			}
			candidates = mergeThreadCandidates(candidates, result.candidates);
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
			const result = await searchRemoteCandidates(
				config.teamId,
				client.searchTeamPosts.bind(client),
				probes,
				searchedConversations,
				{ deadlineAt, incomplete: searchIncomplete },
			);
			remoteSearch = {
				requested: false,
				performed: true,
				reason: remoteReason,
				queries: result.queries,
				candidateThreads: result.candidates.length,
				failures: result.failures,
			};
			if (result.failures) {
				remoteSearchWarnings.push(remoteSearchFailureWarning(result.failures));
			}
			const selectedThreadIds = new Set(
				threads.map(({ threadId }) => threadId),
			);
			await packer.pack(
				result.candidates.filter(
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
		const warnings: Warning[] = consolidateLocalFallbackWarnings([
			...freshenWarnings,
			...remoteSearchWarnings,
			...packingWarnings,
		]);
		if (searchIncomplete.value) warnings.push(SEARCH_DEADLINE_WARNING);
		if (packer.hydrationFailures.length) {
			warnings.push({
				kind: "candidate_hydrate_failed",
				message: `${packer.hydrationFailures.length} candidate thread(s) could not be retrieved and were dropped from selection.`,
			});
		}
		if (packer.hydrationBudgetSpent) {
			warnings.push({
				kind: "hydration_budget",
				message:
					"The per-request thread hydration budget was spent; later candidates used locally indexed evidence only.",
			});
		}
		if (
			input.navigate &&
			packer.budgetDroppedIds.size > 0 &&
			threads.length < packer.budgets.maxThreads
		) {
			warnings.push({
				kind: "navigate_truncated_threads",
				message: `Navigate packing kept ${threads.length} of up to ${packer.budgets.maxThreads} thread slots; ${packer.budgetDroppedIds.size} candidate(s) were dropped by budget. Re-run without --navigate, or with fewer fat neighbors, to see the omitted threads.`,
			});
		}
		if (input.local && freshness.some(({ stale }) => stale)) {
			warnings.push({
				kind: "stale_local_index",
				message:
					"Local mode used stale conversation evidence without network reconciliation.",
			});
		}
		if (hasExplicitProbes && subject.kind !== "ticket") {
			// Ticket subjects keep probe hits in background[]; free-text/post
			// subjects let --query reshape ranking. Warn so agents do not treat a
			// probed packet as a superset of the unprobed one.
			warnings.push({
				kind: "probe_reranked_packet",
				severity: "informational",
				message:
					"--query probes can change which threads are selected and how they are packed; this packet is not a superset of the same request without --query.",
			});
		}
		if (freshness.some(({ coverageComplete }) => !coverageComplete)) {
			warnings.push(incompleteHistoryWarning(freshness));
		}
		if (!threads.length) {
			warnings.push({
				kind: "no_results",
				message: "No matching Mattermost thread was found.",
			});
		}
		warnings.push(...routingHintWarnings(routing, config));
		warnings.push(...probeWarnings(probeCoverage));

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

		const selection = packer.selection;
		const seenList = [...packer.seenCandidates.values()];
		selection.candidateThreads = Math.max(
			selection.candidateThreads,
			seenList.length,
			candidates.length,
		);
		selection.returnedThreads = threads.length;
		selection.droppedThin = seenList.filter(
			(candidate) =>
				!selectedIds.has(candidate.threadId) &&
				candidate.reasons.includes("thin_thread"),
		).length;
		selection.droppedByBudgetSubjectMatched = countSubjectMatchedBudgetDrops({
			candidates: seenList,
			budgetDroppedIds: packer.budgetDroppedIds,
		});
		selection.droppedCandidates = buildDroppedCandidates({
			candidates: seenList,
			selectedIds,
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
