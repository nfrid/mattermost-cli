import { mapWithConcurrency } from "./concurrency.ts";
import type { MattermostConfig } from "./config.ts";
import { loadMattermostConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { MattermostClient } from "./mattermost/client.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostUser,
} from "./mattermost/schemas.ts";
import {
	type EvidenceAttachment,
	type EvidencePost,
	type PackedThread,
	packThread,
} from "./packing.ts";
import type { Warning } from "./results.ts";
import {
	classifySubject,
	configuredConversations,
	directCandidate,
	type MattermostSubject,
	type RankingReason,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingResult,
	resolveProbes,
	routeConversations,
	type SearchResult,
	searchThreads,
	type ThreadCandidate,
	widenedRouting,
} from "./retrieval.ts";
import {
	type ConversationRecord,
	type IndexedFile,
	type IndexedPost,
	type IndexedUser,
	MattermostStore,
} from "./storage.ts";
import {
	inspectFreshness,
	resolveConversations,
	type SyncClient,
	syncConfiguredConversations,
} from "./sync.ts";
import { containsNormalizedText } from "./text.ts";

export interface ContextInput {
	subject?: string;
	ticket?: string;
	queries?: readonly string[];
	repositories?: readonly string[];
	scopes?: readonly string[];
	channels?: readonly string[];
	fresh?: boolean;
	local?: boolean;
	more?: boolean;
	noWiden?: boolean;
}

export interface SearchInput
	extends Pick<
		ContextInput,
		| "subject"
		| "ticket"
		| "queries"
		| "repositories"
		| "scopes"
		| "channels"
		| "noWiden"
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
}

export interface ContextResult {
	subject: MattermostSubject;
	probes: RetrievalProbe[];
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
			input.subject ?? input.queries?.[0],
			input.ticket,
		);
		const probes = resolveProbes(subject, input.queries);
		const client = input.local
			? undefined
			: (providedClient ?? new MattermostClient(config));
		const all = client
			? await resolveNetworkConversations(config, client, input.channels)
			: configuredConversations(config, store);
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

		if (subject.kind === "post") {
			const direct = await resolveDirectTarget(subject.postId, store, client);
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
			);
			const directConversation = routing.conversations[0];
			if (!directConversation) {
				throw new ConfigError("Direct post routing failed.", "routing_failed");
			}
			candidates = [directCandidate(direct, directConversation)];
		} else {
			fallbackRouting = routing.canWiden ? routing : undefined;
			await freshen(
				config,
				store,
				client,
				routing.conversations,
				Boolean(input.fresh),
			);
			candidates = searchThreads(store, subject, probes, routing);
			if (!candidates.length && routing.canWiden) {
				const widened = widenedRouting(all, routing);
				if (widened.conversations.length) {
					performedWidening = true;
					await freshen(
						config,
						store,
						client,
						widened.conversations,
						Boolean(input.fresh),
					);
					candidates = searchThreads(store, subject, probes, widened);
					for (const conversation of routing.conversations)
						searched.set(conversation.id, conversation);
					routing = widened;
				}
			}
		}
		for (const conversation of routing.conversations)
			searched.set(conversation.id, conversation);

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
				);
				for (const value of matchingProbeValues(evidence, probes)) {
					matchedProbeValues.add(value);
				}
				const currentMatchingPostIds = currentMatches(
					evidence,
					probes,
					candidate.matchingPostIds,
				);
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
					limit: Math.min(budgets.perThreadCharacters, remaining),
				});
				remaining -= packed.budget.used;
				threads.push({
					...packed,
					conversationId: candidate.conversationId,
					conversationAlias: candidate.conversationAlias,
					conversationKind: candidate.conversationKind,
					reasons: currentRanking.reasons,
					matchingPostIds: currentMatchingPostIds,
					latestActivityAt: currentRanking.latestActivityAt,
					link: postLink(config, candidate.rootPostId),
				});
			}
		};
		await hydrateCandidates(candidates);
		if (!threads.length && fallbackRouting && !performedWidening) {
			const widened = widenedRouting(all, fallbackRouting);
			if (widened.conversations.length) {
				performedWidening = true;
				await freshen(
					config,
					store,
					client,
					widened.conversations,
					Boolean(input.fresh),
				);
				for (const conversation of widened.conversations) {
					searched.set(conversation.id, conversation);
				}
				await hydrateCandidates(searchThreads(store, subject, probes, widened));
			}
		}

		const searchedConversations = [...searched.values()];
		const freshness = freshnessEvidence(
			config,
			store,
			searchedConversations,
			dependencies.now?.() ?? Date.now(),
		);
		const warnings: Warning[] = [];
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
		if (input.queries?.length) {
			warnings.push(...probeWarnings(probes, matchedProbeValues));
		}
		const searchCoverageComplete = freshness.every(
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
			input.subject ?? input.queries?.[0],
			input.ticket,
		);
		const probes = resolveProbes(subject, input.queries);
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
				post && conversation ? [directCandidate(post, conversation)] : [];
		} else {
			candidates = searchThreads(store, subject, probes, routing);
		}
		let widened = false;
		if (!candidates.length && routing.canWiden) {
			const fallback = widenedRouting(all, routing);
			if (fallback.conversations.length) {
				routing = fallback;
				for (const conversation of fallback.conversations) {
					searched.set(conversation.id, conversation);
				}
				candidates = searchThreads(store, subject, probes, routing);
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
		if (input.queries?.length) {
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
		const searchCoverageComplete = freshness.every(
			(item) => item.coverageComplete && !item.stale,
		);
		return {
			subject,
			probes,
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
		const all = client
			? await resolveNetworkConversations(config, client)
			: configuredConversations(config, store);
		const target = await resolveDirectTarget(subject.postId, store, client);
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
		);
		const limit = input.more
			? config.budgets.morePerThreadCharacters
			: config.budgets.defaultPerThreadCharacters;
		const packed = packThread(target.rootId || target.id, evidence, {
			matchingPostIds: [target.id],
			aroundPostId: input.around,
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

async function freshen(
	config: MattermostConfig,
	store: MattermostStore,
	client: ContextClient | undefined,
	conversations: readonly RoutedConversation[],
	force: boolean,
): Promise<void> {
	if (!client || !conversations.length) return;
	const aliases = force
		? conversations.map(({ alias }) => alias)
		: inspectFreshness(config, store, conversations)
				.filter(({ stale }) => stale)
				.map(({ alias }) => alias);
	if (aliases.length) {
		await syncConfiguredConversations(config, client, store, { aliases });
	}
}

async function resolveNetworkConversations(
	config: MattermostConfig,
	client: ContextClient,
	aliases?: readonly string[],
): Promise<RoutedConversation[]> {
	return (await resolveConversations(config, client, aliases)).map(
		(conversation) => {
			const metadata =
				conversation.kind === "channel"
					? config.channels[conversation.alias]
					: config.directMessages[conversation.alias];
			return {
				...conversation,
				priority: metadata?.priority ?? 0,
				evidence: [],
			};
		},
	);
}

async function resolveDirectTarget(
	postId: string,
	store: MattermostStore,
	client?: ContextClient,
): Promise<IndexedPost> {
	if (!client) {
		const local = store.getPost(postId);
		if (!local)
			throw new ConfigError(`Post ${postId} is not indexed.`, "post_not_found");
		return local;
	}
	return indexedPost(await client.getPost(postId));
}

async function hydrateThread(
	rootPostId: string,
	conversation: RoutedConversation,
	store: MattermostStore,
	client?: ContextClient,
	requiredPostId?: string,
): Promise<EvidencePost[]> {
	if (!client) {
		const posts = store.getThread(rootPostId);
		assertThreadBoundary(
			posts.map((post) => ({
				id: post.id,
				rootId: post.rootId,
				conversationId: post.conversationId,
			})),
			conversation.id,
			rootPostId,
			requiredPostId,
		);
		return localEvidence(store, posts);
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
	const [users, files] = await Promise.all([
		client.getUsersByIds(userIds),
		mapWithConcurrency(fileIds, (fileId) => client.getFileInfo(fileId)),
	]);
	store.writePage({ conversation, posts, users, files });
	return remoteEvidence(posts, users, files);
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
	if (candidate.reasons.includes("explicit_ticket_relationship")) {
		reasons.push("explicit_ticket_relationship");
	}
	const root = posts.find(({ id }) => id === candidate.rootPostId);
	const ticketKey = subject.kind === "ticket" ? subject.ticketKey : undefined;
	if (ticketKey && root && containsText(root.message, ticketKey)) {
		reasons.push("ticket_in_root");
	}
	if (
		ticketKey &&
		posts.some(
			(post) =>
				post.id !== candidate.rootPostId &&
				containsText(post.message, ticketKey),
		)
	) {
		reasons.push("ticket_in_reply");
	}
	if (
		probes.some((probe) => {
			const phrases = probe.phrases.length ? probe.phrases : [probe.value];
			return phrases.some((phrase) =>
				posts.some((post) => containsText(post.message, phrase)),
			);
		})
	) {
		reasons.push("exact_phrase");
	}
	if (
		probes.some(
			(probe) =>
				probe.terms.length > 0 &&
				probe.terms.every((term) =>
					posts.some((post) => containsText(post.message, term)),
				),
		)
	) {
		reasons.push("all_terms_in_thread");
	}
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

function matchingProbeValues(
	posts: readonly EvidencePost[],
	probes: readonly RetrievalProbe[],
): string[] {
	const live = posts.filter(({ deleteAt }) => !deleteAt);
	return probes
		.filter((probe) =>
			probe.terms.length
				? probe.terms.every((term) =>
						live.some((post) => containsText(post.message, term)),
					)
				: live.some((post) => containsText(post.message, probe.value)),
		)
		.map(({ value }) => value);
}

function currentMatches(
	posts: readonly EvidencePost[],
	probes: readonly RetrievalProbe[],
	originalMatches: readonly string[],
): string[] {
	if (!probes.length) return [...originalMatches];
	const live = posts.filter(({ deleteAt }) => !deleteAt);
	const matches = new Set<string>();
	for (const probe of probes) {
		if (probe.terms.length) {
			const qualifies = probe.terms.every((term) =>
				live.some((post) => containsText(post.message, term)),
			);
			if (qualifies) {
				for (const post of live) {
					if (probe.terms.some((term) => containsText(post.message, term))) {
						matches.add(post.id);
					}
				}
			}
		} else {
			for (const post of live) {
				if (containsText(post.message, probe.value)) matches.add(post.id);
			}
		}
	}
	return [...matches].sort();
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
		: await MattermostStore.open(config.databasePath);
	const store = dependencies.store ?? ownedStore;
	if (!store) throw new Error("Mattermost store initialization failed.");
	try {
		return await operation(config, store, dependencies.client);
	} finally {
		ownedStore?.close();
	}
}
