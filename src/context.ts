import { mapWithConcurrency } from "./concurrency.ts";
import type { MattermostConfig } from "./config.ts";
import { loadMattermostConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { freshenLockPath, withFileLock } from "./lock.ts";
import { MattermostClient } from "./mattermost/client.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostPostList,
	MattermostUser,
} from "./mattermost/schemas.ts";
import {
	type EvidenceAttachment,
	type EvidencePost,
	type PackedThread,
	packThread,
} from "./packing.ts";
import { matchesQueryExpansion } from "./query-expansion.ts";
import type { Warning } from "./results.ts";
import {
	type AgentProbeInput,
	classifySubject,
	configuredConversations,
	directCandidate,
	evaluateThreadEvidence,
	type MattermostSubject,
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
} from "./retrieval.ts";
import {
	deadlineReached,
	FRESHEN_LOCK_STALE_MS,
	FRESHEN_LOCK_TIMEOUT_MS,
	searchDeadlineAt,
} from "./runtime-limits.ts";
import {
	type ConversationRecord,
	type IndexedFile,
	type IndexedPost,
	type IndexedUser,
	MattermostStore,
	type ThreadSearchFilters,
} from "./storage.ts";
import {
	inspectFreshness,
	type SyncClient,
	syncConfiguredConversations,
} from "./sync.ts";
import { containsNormalizedExactText, containsNormalizedText } from "./text.ts";

const MAX_REMOTE_SEARCH_PROBES = 4;
const MAX_REMOTE_POSTS_PER_PROBE = 20;
const MAX_REMOTE_CANDIDATE_THREADS = 12;
/** Soft cap on conversations refreshed in one context call (unless --fresh). */
const MAX_CONTEXT_FRESHEN_CONVERSATIONS = 8;

export interface SearchFilterInput {
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
}

export interface SearchFilters {
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
}

export interface ContextInput extends SearchFilterInput {
	subject?: string;
	ticket?: string;
	queries?: readonly string[];
	probes?: readonly AgentProbeInput[];
	repositories?: readonly string[];
	scopes?: readonly string[];
	channels?: readonly string[];
	fresh?: boolean;
	local?: boolean;
	more?: boolean;
	noWiden?: boolean;
	remoteSearch?: boolean;
	includeAutomation?: boolean;
}

export interface SearchInput
	extends Pick<
		ContextInput,
		| "subject"
		| "ticket"
		| "queries"
		| "probes"
		| "repositories"
		| "scopes"
		| "channels"
		| "noWiden"
		| "includeAutomation"
		| "from"
		| "after"
		| "before"
		| "hasFile"
		| "file"
	> {}

export interface ThreadInput {
	target: string;
	local?: boolean;
	more?: boolean;
	full?: boolean;
	around?: string;
}

export interface ContextClient extends SyncClient {
	getPost(postId: string): ReturnType<MattermostClient["getPost"]>;
	getThread(postId: string): ReturnType<MattermostClient["getThread"]>;
	searchTeamPosts?: MattermostClient["searchTeamPosts"];
}

export interface ContextDependencies {
	config?: MattermostConfig;
	store?: MattermostStore;
	client?: ContextClient;
	now?: () => number;
}

export interface FreshnessEvidence {
	alias: string;
	conversationId: string;
	kind: ConversationRecord["kind"];
	observedAt: number;
	lastSuccessAt: number | null;
	ageSeconds: number | null;
	stale: boolean;
	coverageComplete: boolean;
}

export interface ContextThread extends PackedThread {
	conversationId: string;
	conversationAlias: string;
	conversationKind: ConversationRecord["kind"];
	reasons: ThreadCandidate["reasons"];
	matchingPostIds: string[];
	latestActivityAt: number;
	link: string;
	/** Prior root posts from the same DM conversation for short threads. */
	surround?: EvidencePost[];
}

export interface RemoteSearchEvidence {
	requested: boolean;
	performed: boolean;
	reason: "explicit" | "incomplete_local_coverage" | "stale_local_index" | null;
	queries: Array<{
		probe: string;
		probeKind?: AgentProbeInput["kind"];
		returnedPosts: number;
		acceptedPosts: number;
	}>;
	candidateThreads: number;
	failures: number;
}

export interface ContextResult {
	subject: MattermostSubject;
	probes: RetrievalProbe[];
	filters: SearchFilters;
	remoteSearch: RemoteSearchEvidence;
	freshnessMode: "local" | "network" | "forced";
	complete: boolean;
	searchCoverageComplete: boolean;
	selectedThreadsComplete: boolean;
	detailLevel: "compact" | "expanded";
	freshness: FreshnessEvidence[];
	unmatchedHints: RoutingResult["unmatchedHints"];
	searchedConversations: Array<{
		id: string;
		alias: string;
		kind: ConversationRecord["kind"];
		evidence: RoutedConversation["evidence"];
	}>;
	explicitChannelPolicy: "restrict";
	widening: { allowed: boolean; performed: boolean };
	threads: ContextThread[];
	budget: {
		measurement: "unicode_code_points_in_rendered_post";
		limit: number;
		used: number;
		maxThreads: number;
	};
	warnings: Warning[];
}

export interface SearchContextResult extends Omit<SearchResult, "candidates"> {
	filters: SearchFilters;
	candidates: Array<ThreadCandidate & { link: string }>;
	freshnessMode: "local";
	complete: boolean;
	searchCoverageComplete: boolean;
	freshness: FreshnessEvidence[];
	searchedConversations: ContextResult["searchedConversations"];
	widened: boolean;
	warnings: Warning[];
}

export interface ThreadResult {
	subject: MattermostSubject;
	freshnessMode: "local" | "network";
	complete: boolean;
	freshness: FreshnessEvidence;
	conversation: { id: string; alias: string; kind: ConversationRecord["kind"] };
	link: string;
	thread: PackedThread;
	warnings: Warning[];
}

export async function getMattermostContext(
	input: ContextInput,
	dependencies: ContextDependencies = {},
): Promise<ContextResult> {
	return withResources(dependencies, async (config, store, providedClient) => {
		const subject = classifySubject(
			input.subject ?? input.queries?.[0] ?? input.probes?.[0]?.value,
			input.ticket,
		);
		const probes = resolveProbes(
			subject,
			input.queries,
			config.synonyms,
			input.probes,
			config.concepts,
		);
		const resolvedFilters = resolveSearchFilters(input);
		const client = input.local
			? undefined
			: (providedClient ?? new MattermostClient(config));
		if (input.local && input.remoteSearch) {
			throw new ConfigError(
				"Remote search cannot be combined with local-only mode.",
				"invalid_remote_search_mode",
			);
		}
		if (subject.kind === "post" && input.remoteSearch) {
			throw new ConfigError(
				"Remote search requires a textual or ticket subject.",
				"invalid_remote_search_subject",
			);
		}
		const all = resolveContextConversations(config, store, input.channels);
		let routing = routeConversations(config, store, all, {
			channels: input.channels,
			scopes: input.scopes,
			repositories: input.repositories,
			ticketKey: subject.kind === "ticket" ? subject.ticketKey : undefined,
			noWiden: input.noWiden,
		});
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

		const budgets = input.more
			? {
					maxCharacters: config.budgets.moreMaxCharacters,
					perThreadCharacters: config.budgets.morePerThreadCharacters,
					maxThreads: config.budgets.moreMaxThreads,
				}
			: {
					maxCharacters: config.budgets.defaultMaxCharacters,
					perThreadCharacters: config.budgets.defaultPerThreadCharacters,
					maxThreads: config.budgets.defaultMaxThreads,
				};
		let remaining = budgets.maxCharacters;
		const threads: ContextThread[] = [];
		const matchedProbeValues = new Set<string>();
		const hydrateCandidates = async (
			candidateList: readonly ThreadCandidate[],
		): Promise<void> => {
			for (const candidate of candidateList) {
				if (threads.length >= budgets.maxThreads || remaining <= 0) break;
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
					continue;
				}
				const currentRanking = reevaluateCandidate(
					candidate,
					evidence,
					subject,
					probes,
				);
				const packed = packThread(candidate.threadId, evidence, {
					matchingPostIds: currentMatchingPostIds,
					neighborhoodRadius: config.budgets.matchNeighborhoodRadius,
					limit: Math.min(budgets.perThreadCharacters, remaining),
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
		const warnings: Warning[] = [...freshenWarnings, ...remoteSearchWarnings];
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
		return {
			subject,
			probes,
			filters: resolvedFilters.output,
			remoteSearch,
			freshnessMode: input.local ? "local" : input.fresh ? "forced" : "network",
			complete: searchCoverageComplete,
			searchCoverageComplete,
			selectedThreadsComplete,
			detailLevel: input.more ? "expanded" : "compact",
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
			threads,
			budget: {
				measurement: "unicode_code_points_in_rendered_post",
				limit: budgets.maxCharacters,
				used: budgets.maxCharacters - remaining,
				maxThreads: budgets.maxThreads,
			},
			warnings,
		};
	});
}

export async function searchMattermost(
	input: SearchInput,
	dependencies: ContextDependencies = {},
): Promise<SearchContextResult> {
	return withResources(dependencies, async (config, store) => {
		const subject = classifySubject(
			input.subject ?? input.queries?.[0] ?? input.probes?.[0]?.value,
			input.ticket,
		);
		const probes = resolveProbes(
			subject,
			input.queries,
			config.synonyms,
			input.probes,
			config.concepts,
		);
		const resolvedFilters = resolveSearchFilters(input);
		const all = configuredConversations(config, store);
		let routing = routeConversations(config, store, all, {
			channels: input.channels,
			scopes: input.scopes,
			repositories: input.repositories,
			ticketKey: subject.kind === "ticket" ? subject.ticketKey : undefined,
			noWiden: input.noWiden,
		});
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
		return {
			subject,
			probes,
			filters: resolvedFilters.output,
			routing,
			candidates: candidates.map((candidate) => ({
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
		const target = await resolveDirectTarget(
			subject.postId,
			store,
			client,
			new Set(all.map(({ id }) => id)),
		);
		const conversation = all.find(({ id }) => id === target.conversationId);
		if (!conversation) {
			throw new ConfigError(
				"The thread is outside configured conversations.",
				"conversation_not_allowed",
			);
		}
		const evidence = await hydrateThread(
			target.rootId || target.id,
			conversation,
			store,
			client,
			target.id,
			{
				forceRemote: Boolean(!input.local),
				freshnessSeconds: config.freshnessSeconds,
				now: dependencies.now?.() ?? Date.now(),
			},
		);
		const limit = input.more
			? config.budgets.morePerThreadCharacters
			: config.budgets.defaultPerThreadCharacters;
		const packed = packThread(target.rootId || target.id, evidence, {
			matchingPostIds: [target.id],
			aroundPostId: input.around,
			neighborhoodRadius: config.budgets.matchNeighborhoodRadius,
			limit,
			full: input.full,
		});
		const warnings: Warning[] = [];
		const observedAt = dependencies.now?.() ?? Date.now();
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
		const freshness = input.local
			? localFreshness
			: {
					...localFreshness,
					observedAt,
					ageSeconds: 0,
					stale: false,
					coverageComplete: true,
				};
		if (input.local && freshness.stale) {
			warnings.push({
				kind: "stale_local_index",
				message: "Local thread evidence is stale.",
			});
		}
		if (input.local && !freshness.coverageComplete) {
			warnings.push({
				kind: "incomplete_history",
				message: "Local thread evidence comes from cutoff-bounded history.",
			});
		}
		return {
			subject,
			freshnessMode: input.local ? "local" : "network",
			complete:
				!input.local || (!freshness.stale && freshness.coverageComplete),
			freshness,
			conversation: {
				id: conversation.id,
				alias: conversation.alias,
				kind: conversation.kind,
			},
			link: postLink(config, target.rootId || target.id),
			thread: packed,
			warnings,
		};
	});
}

async function searchRemoteCandidates(
	teamId: string,
	searchTeamPosts: NonNullable<ContextClient["searchTeamPosts"]>,
	probes: readonly RetrievalProbe[],
	conversations: readonly RoutedConversation[],
	options: {
		deadlineAt?: number;
		incomplete?: { value: boolean };
	} = {},
): Promise<{
	candidates: ThreadCandidate[];
	queries: RemoteSearchEvidence["queries"];
	failures: number;
}> {
	const byConversationId = new Map(
		conversations.map((conversation) => [conversation.id, conversation]),
	);
	const byThreadId = new Map<string, ThreadCandidate>();
	const queries: RemoteSearchEvidence["queries"] = [];
	let failures = 0;
	for (const probe of probes.slice(0, MAX_REMOTE_SEARCH_PROBES)) {
		if (deadlineReached(options.deadlineAt)) {
			if (options.incomplete) options.incomplete.value = true;
			break;
		}
		let response: MattermostPostList;
		try {
			response = await searchTeamPosts(teamId, {
				terms: probe.value,
				isOrSearch: false,
				page: 0,
				perPage: MAX_REMOTE_POSTS_PER_PROBE,
			});
		} catch {
			failures += 1;
			queries.push({
				probe: probe.value,
				...(probe.kind ? { probeKind: probe.kind } : {}),
				returnedPosts: 0,
				acceptedPosts: 0,
			});
			continue;
		}
		let acceptedPosts = 0;
		for (const [index, postId] of response.order
			.slice(0, MAX_REMOTE_POSTS_PER_PROBE)
			.entries()) {
			const post = response.posts[postId];
			if (!post || post.delete_at) continue;
			const conversation = byConversationId.get(post.channel_id);
			if (!conversation) continue;
			const indexed = indexedPost(post);
			const existing = byThreadId.get(indexed.threadId);
			acceptedPosts += 1;
			const candidate = remoteSearchCandidate(
				indexed,
				conversation,
				probe.value,
				index + 1,
				probe.kind,
			);
			if (!existing) {
				byThreadId.set(candidate.threadId, candidate);
				continue;
			}
			existing.matchingPostIds = [
				...new Set([...existing.matchingPostIds, ...candidate.matchingPostIds]),
			].sort();
			existing.matches = [...existing.matches, ...candidate.matches];
			existing.latestActivityAt = Math.max(
				existing.latestActivityAt,
				candidate.latestActivityAt,
			);
			existing.fusionScore =
				(existing.fusionScore ?? 0) + (candidate.fusionScore ?? 0);
			existing.scoreVector[7] = new Set(
				existing.matches.map(({ probe }) => probe),
			).size;
			existing.scoreVector[10] = existing.fusionScore;
			existing.scoreVector[14] = Math.max(
				existing.scoreVector[14] ?? 0,
				candidate.latestActivityAt,
			);
			existing.scoreVector[15] = existing.latestActivityAt;
		}
		queries.push({
			probe: probe.value,
			...(probe.kind ? { probeKind: probe.kind } : {}),
			returnedPosts: response.order.length,
			acceptedPosts,
		});
	}
	return {
		candidates: mergeThreadCandidates([...byThreadId.values()]).slice(
			0,
			MAX_REMOTE_CANDIDATE_THREADS,
		),
		queries,
		failures,
	};
}

async function freshen(
	config: MattermostConfig,
	store: MattermostStore,
	client: ContextClient | undefined,
	conversations: readonly RoutedConversation[],
	force: boolean,
	warnings: Warning[] = [],
): Promise<void> {
	if (!client || !conversations.length) return;
	const aliases = force
		? conversations.map(({ alias }) => alias)
		: inspectFreshness(config, store, conversations)
				.filter(({ stale }) => stale)
				.map(({ alias }) => alias);
	if (!aliases.length) return;

	const run = async () => {
		await syncConfiguredConversations(config, client, store, { aliases });
	};
	const lockPath = freshenLockPath(config.databasePath);
	if (!lockPath) {
		await run();
		return;
	}
	const locked = await withFileLock(lockPath, run, {
		timeoutMs: FRESHEN_LOCK_TIMEOUT_MS,
		staleMs: FRESHEN_LOCK_STALE_MS,
	});
	if (!locked.acquired) {
		warnings.push({
			kind: "freshen_lock_busy",
			message:
				"Skipped network reconciliation because another mm process holds the freshen lock; using local evidence.",
		});
	}
}

function resolveContextConversations(
	config: MattermostConfig,
	store: MattermostStore,
	aliases?: readonly string[],
): RoutedConversation[] {
	const all = configuredConversations(config, store);
	if (!aliases?.length) return all;
	const allowed = new Set(aliases);
	const selected = all.filter(({ alias }) => allowed.has(alias));
	const missing = aliases.filter(
		(alias) => !selected.some((conversation) => conversation.alias === alias),
	);
	if (missing.length) {
		throw new ConfigError(
			`Unknown or unresolved configured conversation alias: ${missing.join(", ")}.`,
			"unknown_conversation",
		);
	}
	return selected;
}

/**
 * Freshen only what retrieval needs. When local search already found
 * candidates, skip channel sync — selected threads are refreshed via hydrate.
 * Otherwise refresh a capped stale set (or ticket-related conversations) so a
 * cold index can discover new hits, unless --fresh forces the scoped set.
 */
function selectFreshenConversations(
	config: MattermostConfig,
	store: MattermostStore,
	routing: RoutingResult,
	subject: MattermostSubject,
	candidates: readonly ThreadCandidate[],
	force: boolean,
	now: number,
): RoutedConversation[] {
	const limit = (conversations: readonly RoutedConversation[]) =>
		force
			? [...conversations]
			: conversations.slice(0, MAX_CONTEXT_FRESHEN_CONVERSATIONS);

	if (force) {
		return limit(narrowTicketConversations(store, routing, subject));
	}
	if (candidates.length) {
		return [];
	}
	const staleIds = new Set(
		inspectFreshness(config, store, routing.conversations, now)
			.filter(({ stale }) => stale)
			.map(({ conversationId }) => conversationId),
	);
	if (!staleIds.size) return [];

	const staleRouted = routing.conversations.filter(({ id }) =>
		staleIds.has(id),
	);
	if (subject.kind === "ticket") {
		const related = narrowTicketConversations(
			store,
			{ ...routing, conversations: staleRouted },
			subject,
		);
		if (related.length) return limit(related);
	}
	return limit(staleRouted);
}

function narrowTicketConversations(
	store: MattermostStore,
	routing: RoutingResult,
	subject: MattermostSubject,
): RoutedConversation[] {
	if (subject.kind !== "ticket") return [...routing.conversations];
	const relatedIds = new Set(
		store.getConversationIdsForTicket(subject.ticketKey),
	);
	if (!relatedIds.size) return [...routing.conversations];
	const narrowed = routing.conversations.filter(({ id }) => relatedIds.has(id));
	return narrowed.length ? narrowed : [...routing.conversations];
}

async function resolveDirectTarget(
	postId: string,
	store: MattermostStore,
	client?: ContextClient,
	allowedConversationIds?: ReadonlySet<string>,
): Promise<IndexedPost> {
	const local = store.getPost(postId);
	if (!client) {
		if (!local)
			throw new ConfigError(`Post ${postId} is not indexed.`, "post_not_found");
		return local;
	}
	if (
		local &&
		allowedConversationIds &&
		!allowedConversationIds.has(local.conversationId)
	) {
		throw new ConfigError(
			"The post is outside configured conversations.",
			"conversation_not_allowed",
		);
	}
	return indexedPost(await client.getPost(postId));
}

async function hydrateThread(
	rootPostId: string,
	conversation: RoutedConversation,
	store: MattermostStore,
	client?: ContextClient,
	requiredPostId?: string,
	options: {
		forceRemote?: boolean;
		freshnessSeconds?: number;
		now?: number;
	} = {},
): Promise<EvidencePost[]> {
	const localPosts = store.getThread(rootPostId);
	const localUsable = (() => {
		if (!localPosts.length) return false;
		if (
			requiredPostId &&
			!localPosts.some((post) => post.id === requiredPostId)
		) {
			return false;
		}
		try {
			assertThreadBoundary(
				localPosts.map((post) => ({
					id: post.id,
					rootId: post.rootId,
					conversationId: post.conversationId,
				})),
				conversation.id,
				rootPostId,
				requiredPostId,
			);
			return true;
		} catch {
			return false;
		}
	})();

	if (!client) {
		if (!localUsable) {
			throw new ConfigError(
				"Mattermost thread root is missing or inaccessible.",
				"thread_not_found",
			);
		}
		return localEvidence(store, localPosts);
	}

	const now = options.now ?? Date.now();
	const freshnessSeconds = options.freshnessSeconds ?? 300;
	const checkpoint = store.getCheckpoint(conversation.id);
	const ageSeconds = checkpoint?.lastSuccessAt
		? Math.max(0, (now - checkpoint.lastSuccessAt) / 1000)
		: null;
	const stale = ageSeconds === null || ageSeconds > freshnessSeconds;
	if (!options.forceRemote && localUsable && !stale) {
		return localEvidence(store, localPosts);
	}

	const response = await client.getThread(rootPostId);
	const posts = response.order
		.map((id) => response.posts[id])
		.filter((post): post is MattermostPost => post !== undefined);
	assertThreadBoundary(
		posts.map((post) => ({
			id: post.id,
			rootId: post.root_id,
			conversationId: post.channel_id,
		})),
		conversation.id,
		rootPostId,
		requiredPostId,
	);
	const userIds = [...new Set(posts.map(({ user_id }) => user_id))];
	const fileIds = [...new Set(posts.flatMap(({ file_ids }) => file_ids))];
	const knownFiles = new Set(
		store.getFilesForPosts(posts.map(({ id }) => id)).map(({ id }) => id),
	);
	const missingFileIds = fileIds.filter((fileId) => !knownFiles.has(fileId));
	const [users, files] = await Promise.all([
		client.getUsersByIds(userIds),
		mapWithConcurrency(missingFileIds, (fileId) => client.getFileInfo(fileId)),
	]);
	store.writePage({ conversation, posts, users, files });
	return remoteEvidence(posts, users, files);
}

function resolveConversationSurround(
	store: MattermostStore,
	conversation: ConversationRecord | RoutedConversation,
	threadEvidence: readonly EvidencePost[],
	shortThreadMaxReplies: number,
	surroundRoots: number,
): EvidencePost[] {
	if (conversation.kind !== "direct_message" || surroundRoots <= 0) return [];
	const root = threadEvidence[0];
	if (!root) return [];
	const replyCount = Math.max(0, threadEvidence.length - 1);
	if (replyCount > shortThreadMaxReplies) return [];
	const preceding = store.getPrecedingRootPosts(
		conversation.id,
		root.createAt,
		root.id,
		surroundRoots,
	);
	if (!preceding.length) return [];
	return localEvidence(store, preceding);
}

function assertThreadBoundary(
	posts: readonly { id: string; rootId: string; conversationId: string }[],
	expectedConversationId: string,
	expectedRootPostId: string,
	requiredPostId?: string,
): void {
	if (!posts.some(({ id }) => id === expectedRootPostId)) {
		throw new ConfigError(
			"Mattermost thread root is missing or inaccessible.",
			"thread_not_found",
		);
	}
	if (requiredPostId && !posts.some(({ id }) => id === requiredPostId)) {
		throw new ConfigError(
			"The directly requested post is missing from its current thread.",
			"post_not_found",
		);
	}
	if (
		posts.some(
			({ id, rootId, conversationId }) =>
				conversationId !== expectedConversationId ||
				(id !== expectedRootPostId && rootId !== expectedRootPostId),
		)
	) {
		throw new ConfigError(
			"Mattermost thread crossed the routed conversation or thread boundary.",
			"conversation_not_allowed",
		);
	}
}

function localEvidence(
	store: MattermostStore,
	posts: readonly IndexedPost[],
): EvidencePost[] {
	const users = new Map(
		store
			.getUsers([...new Set(posts.map(({ userId }) => userId))])
			.map((user) => [user.id, user]),
	);
	const files = store.getFilesForPosts(posts.map(({ id }) => id));
	return posts.map((post) => evidencePost(post, users.get(post.userId), files));
}

function remoteEvidence(
	posts: readonly MattermostPost[],
	users: readonly MattermostUser[],
	files: readonly MattermostFileInfo[],
): EvidencePost[] {
	const userMap = new Map(users.map((user) => [user.id, user]));
	return posts.map((post) => {
		const user = userMap.get(post.user_id);
		return {
			id: post.id,
			rootId: post.root_id,
			userId: post.user_id,
			authorUsername: user?.username ?? `unknown:${post.user_id}`,
			authorDisplayName: displayName(user),
			createAt: post.create_at,
			updateAt: post.update_at,
			deleteAt: post.delete_at,
			message: post.delete_at ? "" : post.message,
			attachments: files
				.filter((file) => file.post_id === post.id)
				.map(remoteAttachment),
		};
	});
}

function evidencePost(
	post: IndexedPost,
	user: IndexedUser | undefined,
	files: readonly IndexedFile[],
): EvidencePost {
	return {
		id: post.id,
		rootId: post.rootId,
		userId: post.userId,
		authorUsername: user?.username ?? `unknown:${post.userId}`,
		authorDisplayName: localDisplayName(user),
		createAt: post.createAt,
		updateAt: post.updateAt,
		deleteAt: post.deleteAt,
		message: post.deleteAt ? "" : post.message,
		attachments: files
			.filter((file) => file.postId === post.id)
			.map((file) => ({ ...file })),
	};
}

function indexedPost(post: MattermostPost): IndexedPost {
	return {
		id: post.id,
		rootId: post.root_id,
		threadId: post.root_id || post.id,
		conversationId: post.channel_id,
		userId: post.user_id,
		createAt: post.create_at,
		updateAt: post.update_at,
		deleteAt: post.delete_at,
		message: post.delete_at ? "" : post.message,
		props: post.props,
		metadata: post.metadata,
	};
}

function reevaluateCandidate(
	candidate: ThreadCandidate,
	posts: readonly EvidencePost[],
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
): { reasons: RankingReason[]; latestActivityAt: number } {
	const reasons: RankingReason[] = [];
	if (candidate.reasons.includes("direct_post")) reasons.push("direct_post");
	if (candidate.reasons.includes("remote_search"))
		reasons.push("remote_search");
	if (candidate.reasons.includes("explicit_ticket_relationship")) {
		reasons.push("explicit_ticket_relationship");
	}
	const root = posts.find(({ id }) => id === candidate.rootPostId);
	const ticketKey = subject.kind === "ticket" ? subject.ticketKey : undefined;
	if (ticketKey && root && containsExactText(root.message, ticketKey)) {
		reasons.push("ticket_in_root");
	}
	if (
		ticketKey &&
		posts.some(
			(post) =>
				post.id !== candidate.rootPostId &&
				containsExactText(post.message, ticketKey),
		)
	) {
		reasons.push("ticket_in_reply");
	}
	if (
		candidate.structuredMatches?.some((structured) => {
			const post = posts.find(({ id }) => id === structured.postId);
			return Boolean(
				post &&
					(containsText(post.message, structured.value) ||
						post.attachments.some(
							({ name, deleteAt }) =>
								!deleteAt && containsText(name, structured.value),
						)),
			);
		})
	) {
		reasons.push("structured_entity_match");
	}
	const rankingEvidence = evaluateThreadEvidence(
		posts,
		candidate.rootPostId,
		subject,
		probes,
	);
	if (rankingEvidence.subjectInRoot) reasons.push("subject_in_root");
	if (
		rankingEvidence.exactPhraseInRootCount > 0 ||
		rankingEvidence.exactPhraseInReplyCount > 0
	) {
		reasons.push("exact_phrase");
	}
	if (rankingEvidence.exactPhraseInRootCount > 0) {
		reasons.push("exact_phrase_in_root");
	}
	if (rankingEvidence.exactPhraseInReplyCount > 0) {
		reasons.push("exact_phrase_in_reply");
	}
	if ((rankingEvidence.exactFullyMatchedProbeCount ?? 0) > 0) {
		reasons.push("all_terms_in_thread");
	}
	if (
		rankingEvidence.fullyMatchedProbeCount >
		(rankingEvidence.exactFullyMatchedProbeCount ?? 0)
	) {
		reasons.push("all_expanded_terms_in_thread");
	}
	if ((rankingEvidence.expansionMatchCount ?? 0) > 0) {
		reasons.push("query_expansion");
	}
	if (rankingEvidence.matchedProbeCount > 1) {
		reasons.push("multiple_probes_in_thread");
	}
	if (candidate.fusionScore) reasons.push("rank_fusion");
	const routingReason = candidate.reasons.find((reason) =>
		reason.startsWith("routing_"),
	);
	if (routingReason) reasons.push(routingReason);
	if (candidate.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	return {
		reasons,
		latestActivityAt: Math.max(
			...posts.map((post) =>
				Math.max(post.createAt, post.updateAt, post.deleteAt),
			),
		),
	};
}

function postMatchesProbeTerm(
	message: string,
	probe: RetrievalProbe,
	term: string,
): boolean {
	return (
		containsExactText(message, term) ||
		(probe.expansions ?? []).some(
			(expansion) =>
				expansion.sourceTerm === term &&
				matchesQueryExpansion(message, expansion),
		)
	);
}

function matchingProbeValues(
	posts: readonly EvidencePost[],
	probes: readonly RetrievalProbe[],
): string[] {
	const live = posts.filter(({ deleteAt }) => !deleteAt);
	return probes
		.filter((probe) =>
			probe.terms.length
				? probe.terms.every((term) =>
						live.some((post) =>
							postMatchesProbeTerm(post.message, probe, term),
						),
					)
				: live.some((post) => containsExactText(post.message, probe.value)),
		)
		.map(({ value }) => value);
}

function currentMatches(
	posts: readonly EvidencePost[],
	probes: readonly RetrievalProbe[],
	originalMatches: readonly string[],
	structuredMatches: readonly StructuredSearchMatch[] = [],
): string[] {
	if (!probes.length && !structuredMatches.length) return [...originalMatches];
	const live = posts.filter(({ deleteAt }) => !deleteAt);
	const matches = new Set<string>();
	for (const probe of probes) {
		if (probe.terms.length) {
			const qualifies = probe.terms.every((term) =>
				live.some((post) => postMatchesProbeTerm(post.message, probe, term)),
			);
			if (qualifies) {
				for (const post of live) {
					if (
						probe.terms.some((term) =>
							postMatchesProbeTerm(post.message, probe, term),
						)
					) {
						matches.add(post.id);
					}
				}
			}
		} else {
			for (const post of live) {
				if (containsExactText(post.message, probe.value)) matches.add(post.id);
			}
		}
	}
	for (const structured of structuredMatches) {
		const post = live.find(({ id }) => id === structured.postId);
		if (
			post &&
			(containsText(post.message, structured.value) ||
				post.attachments.some(({ name, deleteAt }) =>
					!deleteAt ? containsText(name, structured.value) : false,
				))
		) {
			matches.add(post.id);
		}
	}
	return [...matches].sort();
}

function resolveSearchFilters(input: SearchFilterInput): {
	output: SearchFilters;
	storage: ThreadSearchFilters;
} {
	const from = input.from?.trim().replace(/^@/, "") || undefined;
	const after = parseFilterDate(input.after, "after");
	const before = parseFilterDate(input.before, "before");
	if (after !== undefined && before !== undefined && after >= before) {
		throw new ConfigError(
			"--after must be earlier than --before.",
			"invalid_search_filter",
		);
	}
	const file = input.file?.trim() || undefined;
	const hasFile = Boolean(input.hasFile || file);
	return {
		output: {
			...(from ? { from } : {}),
			...(after !== undefined ? { after: new Date(after).toISOString() } : {}),
			...(before !== undefined
				? { before: new Date(before).toISOString() }
				: {}),
			...(hasFile ? { hasFile: true } : {}),
			...(file ? { file } : {}),
		},
		storage: {
			...(from ? { username: from } : {}),
			...(after !== undefined ? { after } : {}),
			...(before !== undefined ? { before } : {}),
			...(hasFile ? { hasFile: true } : {}),
			...(file ? { filePattern: file } : {}),
		},
	};
}

function parseFilterDate(
	value: string | undefined,
	name: "after" | "before",
): number | undefined {
	if (!value) return undefined;
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
	const offsetDateTime =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
	if (!dateOnly.test(value) && !offsetDateTime.test(value)) {
		throw new ConfigError(
			`Invalid --${name} date: ${value}. Use YYYY-MM-DD or an ISO date-time with Z or an explicit UTC offset.`,
			"invalid_search_filter",
		);
	}
	const normalized = dateOnly.test(value) ? `${value}T00:00:00Z` : value;
	const timestamp = Date.parse(normalized);
	if (!Number.isFinite(timestamp)) {
		throw new ConfigError(
			`Invalid --${name} date: ${value}.`,
			"invalid_search_filter",
		);
	}
	return timestamp;
}

function evidenceMatchesFilters(
	posts: readonly EvidencePost[],
	filters: ThreadSearchFilters,
): boolean {
	const postMatches = posts.some(
		(post) =>
			!post.deleteAt &&
			(!filters.username ||
				post.authorUsername.toLowerCase() ===
					filters.username.replace(/^@/, "").toLowerCase()) &&
			(filters.after === undefined || post.createAt >= filters.after) &&
			(filters.before === undefined || post.createAt < filters.before),
	);
	if (!postMatches) return false;
	if (!filters.hasFile && !filters.filePattern) return true;
	return posts.some((post) =>
		post.attachments.some(
			(attachment) =>
				!attachment.deleteAt &&
				(!filters.filePattern ||
					containsText(attachment.name, filters.filePattern)),
		),
	);
}

function routingHintWarnings(routing: RoutingResult): Warning[] {
	const warnings: Warning[] = [];
	if (routing.unmatchedHints.repositories.length) {
		warnings.push({
			kind: "unmapped_routing_hint",
			message: `Repository routing hint(s) matched no configured conversation metadata: ${routing.unmatchedHints.repositories.join(", ")}.`,
		});
	}
	if (routing.unmatchedHints.scopes.length) {
		warnings.push({
			kind: "unmapped_routing_hint",
			message: `Scope routing hint(s) matched no configured conversation metadata: ${routing.unmatchedHints.scopes.join(", ")}.`,
		});
	}
	return warnings;
}

function probeWarnings(
	probes: readonly RetrievalProbe[],
	matchedValues: ReadonlySet<string>,
): Warning[] {
	const unmatched = probes
		.map(({ value }) => value)
		.filter((value) => !matchedValues.has(value));
	return unmatched.length
		? [
				{
					kind: "unmatched_retrieval_probe",
					message: `Retrieval probe(s) did not text-match selected evidence and were not treated as required filters: ${unmatched.join(", ")}.`,
				},
			]
		: [];
}

function freshnessEvidence(
	config: MattermostConfig,
	store: MattermostStore,
	conversations: readonly RoutedConversation[],
	now: number,
): FreshnessEvidence[] {
	const byId = new Map(
		conversations.map((conversation) => [conversation.id, conversation]),
	);
	return inspectFreshness(config, store, conversations, now).map(
		(freshness) => ({
			...freshness,
			kind: byId.get(freshness.conversationId)?.kind ?? "channel",
			observedAt: now,
		}),
	);
}

function containsText(message: string, value: string): boolean {
	return containsNormalizedText(message, value);
}

function containsExactText(message: string, value: string): boolean {
	return containsNormalizedExactText(message, value);
}

function displayName(user: MattermostUser | undefined): string {
	if (!user) return "Unknown user";
	return (
		[user.first_name, user.last_name].filter(Boolean).join(" ") ||
		user.nickname ||
		user.username
	);
}

function localDisplayName(user: IndexedUser | undefined): string {
	if (!user) return "Unknown user";
	return (
		[user.firstName, user.lastName].filter(Boolean).join(" ") ||
		user.nickname ||
		user.username
	);
}

function remoteAttachment(file: MattermostFileInfo): EvidenceAttachment {
	return {
		id: file.id,
		postId: file.post_id,
		name: file.name,
		extension: file.extension,
		size: file.size,
		mimeType: file.mime_type,
		deleteAt: file.delete_at,
	};
}

function postLink(config: MattermostConfig, postId: string): string {
	return `${config.url}/_redirect/pl/${encodeURIComponent(postId)}`;
}

async function withResources<T>(
	dependencies: ContextDependencies,
	operation: (
		config: MattermostConfig,
		store: MattermostStore,
		client: ContextClient | undefined,
	) => Promise<T>,
): Promise<T> {
	const config = dependencies.config ?? (await loadMattermostConfig());
	const ownedStore = dependencies.store
		? undefined
		: await MattermostStore.open(config.databasePath, {
				concepts: config.concepts,
			});
	const store = dependencies.store ?? ownedStore;
	if (!store) throw new Error("Mattermost store initialization failed.");
	try {
		return await operation(config, store, dependencies.client);
	} finally {
		ownedStore?.close();
	}
}
