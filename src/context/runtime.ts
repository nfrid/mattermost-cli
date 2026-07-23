import type { MattermostConfig } from "../config/config.ts";
import { loadMattermostConfig } from "../config/config.ts";
import { buildCoverage, type CoverageEvidence } from "../evidence/coverage.ts";
import {
	type EvidencePost,
	type PackedThread,
	packThread,
} from "../evidence/packing.ts";
import {
	segmentThreadByTicketProximity,
	type TicketSegment,
} from "../evidence/ticket-segments.ts";
import { MattermostApiError, MattermostClient } from "../mattermost/client.ts";
import type {
	MattermostPost,
	MattermostPostList,
} from "../mattermost/schemas.ts";
import { extractTicketKeys } from "../search/extract.ts";
import {
	type AgentProbeInput,
	classifySubject,
	configuredConversations,
	directCandidate,
	evaluateThreadEvidence,
	type MattermostSubject,
	mergeRemoteSearchCandidate,
	mergeThreadCandidates,
	type RankingReason,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingResult,
	remoteSearchCandidate,
	resolveProbes,
	routeConversations,
	type SearchResult,
	type StructuredSearchMatch,
	searchThreads,
	type ThreadCandidate,
	widenedRouting,
} from "../search/index.ts";
import { matchesQueryExpansion } from "../search/query-expansion.ts";
import {
	containsNormalizedExactText,
	containsNormalizedText,
} from "../search/text.ts";
import type { Warning } from "../shared/command-result.ts";
import { mapWithConcurrency } from "../shared/concurrency.ts";
import { AppError, ConfigError } from "../shared/errors.ts";
import {
	deadlineReached,
	FRESHEN_LOCK_STALE_MS,
	FRESHEN_LOCK_TIMEOUT_MS,
	searchDeadlineAt,
} from "../shared/limits.ts";
import { freshenLockPath, withFileLock } from "../shared/lock.ts";
import {
	type ConversationRecord,
	type IndexedFile,
	type IndexedPost,
	type IndexedUser,
	MattermostStore,
	type ThreadSearchFilters,
} from "../store/index.ts";
import {
	inspectFreshness,
	ReconciliationError,
	type SyncClient,
	syncConfiguredConversations,
} from "../sync/sync.ts";

const MAX_REMOTE_SEARCH_PROBES = 4;
const MAX_REMOTE_POSTS_PER_PROBE = 20;
const MAX_REMOTE_CANDIDATE_THREADS = 12;
/** Soft cap on conversations refreshed in one context call (unless --fresh). */
const MAX_CONTEXT_FRESHEN_CONVERSATIONS = 8;
/** Top-K related ticket keys for one-hop pointers. */
const RELATED_TICKET_HOP_LIMIT = 3;
/** Soft cap for short mode; root-anchored single threads may use more. */
const SHORT_MAX_CHARACTERS = 6_000;
const SHORT_PER_THREAD_CHARACTERS = 2_500;
/** Short packing budget for one root-anchored primary support thread. */
const SHORT_ROOT_ANCHORED_PER_THREAD = 4_500;

import { evidenceMatchesFilters, resolveSearchFilters } from "./filters.ts";
import {
	freshen,
	narrowTicketConversations,
	resolveContextConversations,
	selectFreshenConversations,
} from "./freshen.ts";
import {
	assertThreadBoundary,
	consolidateLocalFallbackWarnings,
	currentMatches,
	evidencePost,
	freshnessEvidence,
	indexedPost,
	isRecoverableRemoteError,
	localDisplayName,
	localEvidence,
	matchingProbeValues,
	postLink,
	probeWarnings,
	reevaluateCandidate,
	resolveConversationSurround,
	routingHintWarnings,
} from "./helpers.ts";
import { hydrateThread, resolveDirectTarget } from "./hydrate.ts";
import { assertRemoteSearchAllowed, prepareSearch } from "./prepare.ts";
import { resolveRelatedTicketPointers } from "./related-tickets.ts";
import { searchRemoteCandidates } from "./remote-search.ts";
import { withResources } from "./resources.ts";
import { selectionEvidence } from "./selection.ts";
import {
	type ContextClient,
	type ContextDependencies,
	type ContextInput,
	type ContextResult,
	type ContextThread,
	DEFAULT_SEARCH_LIMIT,
	type FreshnessEvidence,
	type RelatedTicketPointer,
	type RemoteSearchEvidence,
	type SearchContextResult,
	type SearchFilterInput,
	type SearchFilters,
	type SearchInput,
	type SelectionEvidence,
	type ThreadInput,
	type ThreadResult,
} from "./types.ts";

export {
	type ContextClient,
	type ContextDependencies,
	type ContextInput,
	type ContextResult,
	type ContextThread,
	DEFAULT_SEARCH_LIMIT,
	type FreshnessEvidence,
	type RelatedTicketPointer,
	type RemoteSearchEvidence,
	type SearchContextResult,
	type SearchFilterInput,
	type SearchFilters,
	type SearchInput,
	type SelectionEvidence,
	type ThreadInput,
	type ThreadResult,
} from "./types.ts";

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
			: (providedClient ?? new MattermostClient(config));
		let performedWidening = false;
		let fallbackRouting: RoutingResult | undefined;
		const searched = new Map<string, RoutedConversation>();
		let candidates: ThreadCandidate[];
		let remoteSearch: RemoteSearchEvidence = {
			requested: Boolean(input.remoteSearch),
			performed: false,
			reason: null,
			queries: [],
			candidateThreads: 0,
			failures: 0,
		};
		const remoteSearchWarnings: Warning[] = [];
		const freshenWarnings: Warning[] = [];
		const searchIncomplete = { value: false };
		const threadCache = new Map<string, IndexedPost[]>();
		const deadlineAt = searchDeadlineAt();
		const observedAt = dependencies.now?.() ?? Date.now();
		let freshenedConversationCount = 0;
		const initiallyFreshIds = new Set(
			inspectFreshness(config, store, all, observedAt)
				.filter(({ stale }) => !stale)
				.map(({ conversationId }) => conversationId),
		);
		const searchRoutedThreads = (currentRouting: RoutingResult) =>
			searchThreads(
				store,
				subject,
				probes,
				currentRouting,
				100,
				resolvedFilters.storage,
				{
					deadlineAt,
					incomplete: searchIncomplete,
					includeAutomation: Boolean(input.includeAutomation),
					suppressAuthors: config.suppressAuthors ?? [],
					threadCache,
				},
			);

		if (subject.kind === "post") {
			const direct = await resolveDirectTarget(
				subject.postId,
				store,
				client,
				new Set(all.map(({ id }) => id)),
				{
					preferLocal: !input.fresh,
					warnings: freshenWarnings,
				},
			);
			const conversation = all.find(({ id }) => id === direct.conversationId);
			if (!conversation) {
				throw new ConfigError(
					"The direct post is outside configured conversations.",
					"conversation_not_allowed",
				);
			}
			if (
				input.channels?.length &&
				!input.channels.includes(conversation.alias)
			) {
				throw new ConfigError(
					"The direct post is outside the explicit channel restriction.",
					"conversation_not_allowed",
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
			candidates = searchRoutedThreads(routing);
			if (!candidates.length && routing.canWiden) {
				const widened = widenedRouting(all, routing);
				if (widened.conversations.length) {
					performedWidening = true;
					for (const conversation of routing.conversations)
						searched.set(conversation.id, conversation);
					routing = widened;
					candidates = searchRoutedThreads(widened);
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
				threadCache.clear();
				candidates = searchRoutedThreads(routing);
			}
		}
		for (const conversation of routing.conversations)
			searched.set(conversation.id, conversation);

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
				remoteSearchWarnings.push({
					kind: "remote_search_failed",
					message: `${result.failures} bounded Mattermost search request(s) failed; local evidence remains available.`,
				});
			}
			candidates = mergeThreadCandidates(candidates, result.candidates);
		} else if (input.remoteSearch && !client?.searchTeamPosts) {
			remoteSearchWarnings.push({
				kind: "remote_search_unavailable",
				message:
					"The configured context client does not support bounded Mattermost search.",
			});
		}

		const budgets = {
			maxCharacters: input.short
				? Math.min(config.budgets.defaultMaxCharacters, SHORT_MAX_CHARACTERS)
				: config.budgets.defaultMaxCharacters,
			perThreadCharacters: input.short
				? Math.min(
						config.budgets.defaultPerThreadCharacters,
						SHORT_PER_THREAD_CHARACTERS,
					)
				: config.budgets.defaultPerThreadCharacters,
			maxThreads: config.budgets.defaultMaxThreads,
		};
		// When only one or two strong threads fit, give each a larger share so
		// long decision middles are less likely to collapse into a single skip.
		const expectedThreadCount = Math.min(
			Math.max(1, candidates.length),
			budgets.maxThreads,
		);
		const perThreadCharacters =
			!input.short && expectedThreadCount <= 2
				? Math.max(
						budgets.perThreadCharacters,
						Math.floor(budgets.maxCharacters / expectedThreadCount),
					)
				: budgets.perThreadCharacters;
		let remaining = budgets.maxCharacters;
		const threads: ContextThread[] = [];
		const matchedProbeValues = new Set<string>();
		const selection: SelectionEvidence = {
			candidateThreads: candidates.length,
			returnedThreads: 0,
			droppedThin: 0,
			droppedByBudget: 0,
			droppedNoMatch: 0,
		};
		const hydrateCandidates = async (
			candidateList: readonly ThreadCandidate[],
		): Promise<void> => {
			for (const candidate of candidateList) {
				if (threads.length >= budgets.maxThreads) {
					selection.droppedByBudget += 1;
					continue;
				}
				if (remaining <= 0) {
					selection.droppedByBudget += 1;
					continue;
				}
				const conversation = all.find(
					({ id }) => id === candidate.conversationId,
				);
				if (!conversation) continue;
				const evidence = await hydrateThread(
					candidate.rootPostId,
					conversation,
					store,
					client,
					subject.kind === "post" ? subject.postId : undefined,
					{
						forceRemote:
							Boolean(input.fresh) ||
							!initiallyFreshIds.has(candidate.conversationId),
						freshnessSeconds: config.freshnessSeconds,
						now: observedAt,
						warnings: freshenWarnings,
					},
				);
				for (const value of matchingProbeValues(evidence, probes)) {
					matchedProbeValues.add(value);
				}
				if (!evidenceMatchesFilters(evidence, resolvedFilters.storage))
					continue;
				const currentMatchingPostIds = currentMatches(
					evidence,
					probes,
					candidate.matchingPostIds,
					candidate.structuredMatches,
				);
				for (const structured of candidate.structuredMatches ?? []) {
					if (currentMatchingPostIds.includes(structured.postId)) {
						matchedProbeValues.add(structured.probe);
					}
				}
				if (
					subject.kind !== "post" &&
					!currentMatchingPostIds.length &&
					!candidate.reasons.includes("explicit_ticket_relationship")
				) {
					selection.droppedNoMatch += 1;
					continue;
				}
				const currentRanking = reevaluateCandidate(
					candidate,
					evidence,
					subject,
					probes,
				);
				const subjectTicketKey =
					subject.kind === "ticket" ? subject.ticketKey : undefined;
				const ticketMetrics = subjectTicketKey
					? segmentThreadByTicketProximity(evidence, {
							subjectTicket: subjectTicketKey,
							matchingPostIds: currentMatchingPostIds,
							ticketRadius: config.budgets.ticketNeighborhoodRadius,
							matchRadius: config.budgets.matchNeighborhoodRadius,
							clusterMergeGap: config.budgets.clusterMergeGap,
						})
					: undefined;
				const packed = packThread(candidate.threadId, evidence, {
					matchingPostIds: currentMatchingPostIds,
					neighborhoodRadius: config.budgets.matchNeighborhoodRadius,
					ticketNeighborhoodRadius: config.budgets.ticketNeighborhoodRadius,
					subjectTicketKey,
					clusterMergeGap: config.budgets.clusterMergeGap,
					mode: input.short ? "short" : "default",
					gapFill: !input.short,
					limit: Math.min(
						input.short && ticketMetrics?.rootAnchoredFocused
							? Math.max(perThreadCharacters, SHORT_ROOT_ANCHORED_PER_THREAD)
							: perThreadCharacters,
						remaining,
					),
				});
				remaining -= packed.budget.used;
				const surround = resolveConversationSurround(
					store,
					conversation,
					evidence,
					config.budgets.shortThreadMaxReplies,
					config.budgets.conversationSurroundRoots,
				);
				threads.push({
					...packed,
					conversationId: candidate.conversationId,
					conversationAlias: candidate.conversationAlias,
					conversationKind: candidate.conversationKind,
					reasons: currentRanking.reasons,
					matchingPostIds: currentMatchingPostIds,
					latestActivityAt: currentRanking.latestActivityAt,
					link: postLink(config, candidate.rootPostId),
					...(surround.length ? { surround } : {}),
					...(ticketMetrics
						? {
								ticketDensity: ticketMetrics.ticketDensity,
								nearestTicketDistance: ticketMetrics.nearestTicketDistance,
								rootAnchoredFocused: ticketMetrics.rootAnchoredFocused,
								segments: ticketMetrics.segments,
							}
						: {}),
				});
			}
		};
		await hydrateCandidates(candidates);
		if (!threads.length && fallbackRouting && !performedWidening) {
			const widened = widenedRouting(all, fallbackRouting);
			if (widened.conversations.length) {
				performedWidening = true;
				routing = widened;
				const freshenTargets = selectFreshenConversations(
					config,
					store,
					widened,
					subject,
					[],
					Boolean(input.fresh),
					observedAt,
				);
				await freshen(
					config,
					store,
					client,
					freshenTargets,
					Boolean(input.fresh),
					freshenWarnings,
				);
				for (const conversation of widened.conversations) {
					searched.set(conversation.id, conversation);
				}
				threadCache.clear();
				await hydrateCandidates(searchRoutedThreads(widened));
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
			threads.length < budgets.maxThreads &&
			remaining > 0 &&
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
				remoteSearchWarnings.push({
					kind: "remote_search_failed",
					message: `${result.failures} bounded Mattermost search request(s) failed; local evidence remains available.`,
				});
			}
			const selectedThreadIds = new Set(
				threads.map(({ threadId }) => threadId),
			);
			await hydrateCandidates(
				result.candidates.filter(
					({ threadId }) => !selectedThreadIds.has(threadId),
				),
			);
		}

		const freshness = freshnessEvidence(
			config,
			store,
			searchedConversations,
			observedAt,
		);
		const warnings: Warning[] = consolidateLocalFallbackWarnings([
			...freshenWarnings,
			...remoteSearchWarnings,
		]);
		if (searchIncomplete.value) {
			warnings.push({
				kind: "search_deadline",
				message:
					"Local search stopped early after the soft deadline; returned evidence may be incomplete.",
			});
		}
		if (input.local && freshness.some(({ stale }) => stale)) {
			warnings.push({
				kind: "stale_local_index",
				message:
					"Local mode used stale conversation evidence without network reconciliation.",
			});
		}
		if (freshness.some(({ coverageComplete }) => !coverageComplete)) {
			warnings.push({
				kind: "incomplete_history",
				message:
					"At least one searched conversation has cutoff-bounded history.",
			});
		}
		if (!threads.length) {
			warnings.push({
				kind: "no_results",
				message: "No matching Mattermost thread was found.",
			});
		}
		warnings.push(...routingHintWarnings(routing));
		if (input.queries?.length || input.probes?.length) {
			warnings.push(...probeWarnings(probes, matchedProbeValues));
		}
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
		selection.candidateThreads = Math.max(
			selection.candidateThreads,
			candidates.length,
		);
		selection.returnedThreads = threads.length;
		const selectedIds = new Set(threads.map(({ threadId }) => threadId));
		selection.droppedThin = candidates.filter(
			(candidate) =>
				!selectedIds.has(candidate.threadId) &&
				candidate.reasons.includes("thin_thread"),
		).length;
		const relatedTickets = resolveRelatedTicketPointers({
			config,
			store,
			threads,
			subjectTicket: subject.kind === "ticket" ? subject.ticketKey : undefined,
			allowlist: new Set(searchedConversations.map(({ id }) => id)),
		});
		const coverage = buildCoverage({
			searchCoverageComplete,
			selectedThreadsComplete,
			freshnessMode: input.local ? "local" : input.fresh ? "forced" : "network",
			freshness,
			searchedConversations,
			threads,
			remoteSearch,
			selection,
			warnings,
			freshenedConversationCount,
		});
		return {
			subject,
			probes,
			filters: resolvedFilters.output,
			remoteSearch,
			freshnessMode: input.local ? "local" : input.fresh ? "forced" : "network",
			complete: searchCoverageComplete,
			searchCoverageComplete,
			selectedThreadsComplete,
			freshness,
			unmatchedHints: routing.unmatchedHints,
			searchedConversations: searchedConversations.map((conversation) => ({
				id: conversation.id,
				alias: conversation.alias,
				kind: conversation.kind,
				evidence: conversation.evidence,
			})),
			explicitChannelPolicy: "restrict",
			widening: {
				allowed: !input.channels?.length && !input.noWiden,
				performed: performedWidening,
			},
			selection,
			relatedTickets,
			coverage,
			threads,
			budget: {
				measurement: "unicode_code_points_in_rendered_post",
				limit: budgets.maxCharacters,
				used: budgets.maxCharacters - remaining,
				maxThreads: budgets.maxThreads,
			},
			warnings,
			...(input.short ? { short: true } : {}),
		};
	});
}

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
		let candidates: ThreadCandidate[];
		const searchIncomplete = { value: false };
		const threadCache = new Map<string, IndexedPost[]>();
		const deadlineAt = searchDeadlineAt();
		const searchRoutedThreads = (currentRouting: RoutingResult) =>
			searchThreads(
				store,
				subject,
				probes,
				currentRouting,
				100,
				resolvedFilters.storage,
				{
					deadlineAt,
					incomplete: searchIncomplete,
					includeAutomation: Boolean(input.includeAutomation),
					suppressAuthors: config.suppressAuthors ?? [],
					threadCache,
				},
			);
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
			candidates = searchRoutedThreads(routing);
		}
		let widened = false;
		if (!candidates.length && routing.canWiden) {
			const fallback = widenedRouting(all, routing);
			if (fallback.conversations.length) {
				routing = fallback;
				for (const conversation of fallback.conversations) {
					searched.set(conversation.id, conversation);
				}
				candidates = searchRoutedThreads(routing);
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
		if (searchIncomplete.value) {
			warnings.push({
				kind: "search_deadline",
				message:
					"Local search stopped early after the soft deadline; returned evidence may be incomplete.",
			});
		}
		if (freshness.some(({ stale }) => stale)) {
			warnings.push({
				kind: "stale_local_index",
				message:
					"Local search used stale evidence without network reconciliation.",
			});
		}
		if (freshness.some(({ coverageComplete }) => !coverageComplete)) {
			warnings.push({
				kind: "incomplete_history",
				message:
					"At least one searched conversation has cutoff-bounded history.",
			});
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
		const requestedLimit = input.limit ?? DEFAULT_SEARCH_LIMIT;
		const limit = Number.isFinite(requestedLimit)
			? Math.max(1, Math.floor(requestedLimit))
			: DEFAULT_SEARCH_LIMIT;
		return {
			subject,
			probes,
			filters: resolvedFilters.output,
			routing,
			candidates: candidates.slice(0, limit).map((candidate) => ({
				...candidate,
				link: postLink(config, candidate.rootPostId),
			})),
			freshnessMode: "local",
			complete: searchCoverageComplete,
			searchCoverageComplete,
			freshness,
			searchedConversations: searchedConversations.map((conversation) => ({
				id: conversation.id,
				alias: conversation.alias,
				kind: conversation.kind,
				evidence: conversation.evidence,
			})),
			widened,
			warnings,
		};
	});
}

export async function getMattermostThread(
	input: ThreadInput,
	dependencies: ContextDependencies = {},
): Promise<ThreadResult> {
	return withResources(dependencies, async (config, store, providedClient) => {
		const subject = classifySubject(input.target);
		if (subject.kind !== "post") {
			throw new ConfigError(
				"Thread target must be a post ID or permalink.",
				"invalid_post_target",
			);
		}
		const client = input.local
			? undefined
			: (providedClient ?? new MattermostClient(config));
		const all = resolveContextConversations(config, store);
		const warnings: Warning[] = [];
		const observedAt = dependencies.now?.() ?? Date.now();
		const target = await resolveDirectTarget(
			subject.postId,
			store,
			client,
			new Set(all.map(({ id }) => id)),
			{
				preferLocal: !input.fresh,
				warnings,
			},
		);
		const conversation = all.find(({ id }) => id === target.conversationId);
		if (!conversation) {
			throw new ConfigError(
				"The thread is outside configured conversations.",
				"conversation_not_allowed",
			);
		}
		const initiallyFresh = !inspectFreshness(
			config,
			store,
			[conversation],
			observedAt,
		).some(({ stale }) => stale);
		const usedRemote =
			Boolean(client) && (Boolean(input.fresh) || !initiallyFresh);
		const evidence = await hydrateThread(
			target.rootId || target.id,
			conversation,
			store,
			client,
			target.id,
			{
				forceRemote: Boolean(input.fresh) || !initiallyFresh,
				freshnessSeconds: config.freshnessSeconds,
				now: observedAt,
				warnings,
			},
		);
		const packed = packThread(target.rootId || target.id, evidence, {
			matchingPostIds: [target.id],
			aroundPostId: input.around,
			neighborhoodRadius: config.budgets.matchNeighborhoodRadius,
			clusterMergeGap: config.budgets.clusterMergeGap,
			limit: config.budgets.defaultPerThreadCharacters,
			full: input.full,
		});
		const localFreshness = freshnessEvidence(
			config,
			store,
			[conversation],
			observedAt,
		)[0];
		if (!localFreshness) {
			throw new ConfigError(
				"Thread freshness could not be evaluated.",
				"routing_failed",
			);
		}
		const degradedToLocal = warnings.some(
			({ kind }) =>
				kind === "remote_hydrate_failed" ||
				kind === "remote_resolve_failed" ||
				kind === "local_index_fallback",
		);
		const freshness =
			input.local || !usedRemote || degradedToLocal
				? localFreshness
				: {
						...localFreshness,
						observedAt,
						ageSeconds: 0,
						stale: false,
						coverageComplete: true,
					};
		const stayedLocal = input.local || !usedRemote || degradedToLocal;
		if (stayedLocal && freshness.stale) {
			warnings.push({
				kind: "stale_local_index",
				message: "Local thread evidence is stale.",
			});
		}
		if (stayedLocal && !freshness.coverageComplete) {
			warnings.push({
				kind: "incomplete_history",
				message: "Local thread evidence comes from cutoff-bounded history.",
			});
		}
		return {
			subject,
			freshnessMode: stayedLocal ? "local" : "network",
			complete: stayedLocal
				? !freshness.stale && freshness.coverageComplete
				: true,
			freshness,
			conversation: {
				id: conversation.id,
				alias: conversation.alias,
				kind: conversation.kind,
			},
			link: postLink(config, target.rootId || target.id),
			thread: packed,
			warnings: consolidateLocalFallbackWarnings(warnings),
		};
	});
}
