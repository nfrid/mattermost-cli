import type { MattermostConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import type {
	ConversationRecord,
	IndexedPost,
	MattermostStore,
	TicketThreadRelationship,
} from "./storage.ts";
import {
	containsNormalizedText,
	normalizeSearchText,
	STOP_WORDS,
} from "./text.ts";

const POST_ID_PATTERN = /^[a-z0-9]{26}$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/i;
const PERMALINK_PATTERN = /\/pl\/([a-z0-9]{26})(?:[/?#]|$)/i;

export type MattermostSubject =
	| { kind: "ticket"; ticketKey: string; raw: string }
	| { kind: "post"; postId: string; raw: string; source: "permalink" | "id" }
	| { kind: "text"; text: string; raw: string };

export interface RetrievalProbe {
	value: string;
	phrases: string[];
	terms: string[];
}

export type RoutingEvidenceType =
	| "explicit_channel"
	| "scope"
	| "repository"
	| "ticket_relationship"
	| "all_configured"
	| "widened";

export interface RoutedConversation extends ConversationRecord {
	priority: number;
	evidence: Array<{ type: RoutingEvidenceType; value: string }>;
}

export interface RoutingResult {
	conversations: RoutedConversation[];
	explicitChannelPolicy: "restrict";
	unmatchedHints: { scopes: string[]; repositories: string[] };
	reason:
		| "explicit_channels"
		| "scopes"
		| "repositories"
		| "ticket_relationships"
		| "all_configured";
	canWiden: boolean;
}

export interface SearchMatch {
	postId: string;
	probe: string;
	excerpt: string;
}

export type RankingReason =
	| "direct_post"
	| "explicit_ticket_relationship"
	| "ticket_in_root"
	| "ticket_in_reply"
	| "exact_phrase"
	| "all_terms_in_thread"
	| "routing_explicit_channel"
	| "routing_scope"
	| "routing_repository"
	| "routing_ticket_relationship"
	| "routing_all_configured"
	| "routing_widened"
	| "conversation_priority"
	| "latest_activity";

export interface ThreadCandidate {
	threadId: string;
	rootPostId: string;
	conversationId: string;
	conversationAlias: string;
	conversationKind: ConversationRecord["kind"];
	matchingPostIds: string[];
	matches: SearchMatch[];
	reasons: RankingReason[];
	latestActivityAt: number;
	priority: number;
	scoreVector: number[];
}

export interface SearchResult {
	subject: MattermostSubject;
	probes: RetrievalProbe[];
	routing: RoutingResult;
	candidates: ThreadCandidate[];
}

export function classifySubject(
	positional: string | undefined,
	explicitTicket?: string,
): MattermostSubject {
	if (explicitTicket !== undefined) {
		const ticketKey = explicitTicket.trim().toUpperCase();
		if (!TICKET_PATTERN.test(ticketKey)) {
			throw new ConfigError(
				`Invalid ticket key: ${explicitTicket}.`,
				"invalid_ticket",
			);
		}
		return { kind: "ticket", ticketKey, raw: explicitTicket };
	}
	const raw = positional?.trim() ?? "";
	const permalink = raw.match(PERMALINK_PATTERN)?.[1];
	if (permalink) {
		return {
			kind: "post",
			postId: permalink.toLowerCase(),
			raw,
			source: "permalink",
		};
	}
	if (POST_ID_PATTERN.test(raw)) {
		return { kind: "post", postId: raw, raw, source: "id" };
	}
	if (TICKET_PATTERN.test(raw)) {
		return { kind: "ticket", ticketKey: raw.toUpperCase(), raw };
	}
	if (!raw) {
		throw new ConfigError(
			"A subject, query, or --ticket is required.",
			"missing_subject",
		);
	}
	return { kind: "text", text: raw, raw };
}

export function resolveProbes(
	subject: MattermostSubject,
	queries: readonly string[] = [],
): RetrievalProbe[] {
	const subjectValues =
		subject.kind === "ticket"
			? [subject.ticketKey]
			: subject.kind === "text"
				? [subject.text]
				: [];
	const values = [...subjectValues, ...queries]
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set(values)].map((value) => {
		const phrases = [...value.matchAll(/"([^"]+)"/g)]
			.map((match) => match[1]?.trim())
			.filter((phrase): phrase is string => Boolean(phrase));
		const terms = (value.match(/[\p{L}\p{N}_-]+/gu) ?? [])
			.map(normalizeSearchText)
			.filter((term) => term.length > 1 && !STOP_WORDS.has(term));
		return { value, phrases, terms: [...new Set(terms)] };
	});
}

export function configuredConversations(
	config: MattermostConfig,
	store: MattermostStore,
): RoutedConversation[] {
	const indexed = new Map(
		store
			.listConversations()
			.map((conversation) => [conversation.alias, conversation]),
	);
	const result: RoutedConversation[] = [];
	for (const [alias, channel] of Object.entries(config.channels)) {
		const indexedConversation = indexed.get(alias);
		const local =
			indexedConversation?.kind === "channel" &&
			indexedConversation.name === channel.name &&
			(!channel.id || indexedConversation.id === channel.id)
				? indexedConversation
				: undefined;
		const id = channel.id ?? local?.id;
		if (!id) continue;
		result.push({
			id,
			alias,
			kind: "channel",
			name: channel.name,
			description: channel.description,
			priority: channel.priority,
			evidence: [],
		});
	}
	for (const [alias, directMessage] of Object.entries(config.directMessages)) {
		const indexedConversation = indexed.get(alias);
		const local =
			indexedConversation?.kind === "direct_message" &&
			indexedConversation.id === directMessage.channelId
				? indexedConversation
				: undefined;
		result.push({
			id: directMessage.channelId,
			alias,
			kind: "direct_message",
			name: local?.name ?? alias,
			description: directMessage.description,
			priority: directMessage.priority,
			evidence: [],
		});
	}
	return result.sort(routeTieBreak);
}

export function routeConversations(
	config: MattermostConfig,
	store: MattermostStore,
	conversations: readonly RoutedConversation[],
	input: {
		channels?: readonly string[];
		scopes?: readonly string[];
		repositories?: readonly string[];
		ticketKey?: string;
		noWiden?: boolean;
	},
): RoutingResult {
	const unmatchedHints = unmatchedRoutingHints(config, input);
	const explicit = new Set(input.channels ?? []);
	if (explicit.size) {
		const known = new Set(conversations.map(({ alias }) => alias));
		const unknown = [...explicit].filter((alias) => !known.has(alias));
		if (unknown.length) {
			throw new ConfigError(
				`Unknown or unindexed conversation alias: ${unknown.join(", ")}.`,
				"unknown_conversation",
			);
		}
		return routingResult(
			conversations
				.filter(({ alias }) => explicit.has(alias))
				.map((conversation) =>
					withEvidence(conversation, "explicit_channel", conversation.alias),
				),
			"explicit_channels",
			false,
			unmatchedHints,
		);
	}

	const scopes = new Set(input.scopes ?? []);
	const scoped = conversations.flatMap((conversation) => {
		const metadata = routeMetadata(
			config,
			conversation.alias,
			conversation.kind,
		);
		const matches = metadata.scopes.filter((scope) => scopes.has(scope));
		return matches.length
			? [
					{
						...conversation,
						evidence: matches.map((value) => ({
							type: "scope" as const,
							value,
						})),
					},
				]
			: [];
	});
	if (scoped.length) {
		return routingResult(scoped, "scopes", !input.noWiden, unmatchedHints);
	}

	const repositories = new Set(input.repositories ?? []);
	const repositoryMatches = conversations.flatMap((conversation) => {
		const metadata = routeMetadata(
			config,
			conversation.alias,
			conversation.kind,
		);
		const matches = metadata.repositories.filter((repository) =>
			repositories.has(repository),
		);
		return matches.length
			? [
					{
						...conversation,
						evidence: matches.map((value) => ({
							type: "repository" as const,
							value,
						})),
					},
				]
			: [];
	});
	if (repositoryMatches.length) {
		return routingResult(
			repositoryMatches,
			"repositories",
			!input.noWiden,
			unmatchedHints,
		);
	}

	if (input.ticketKey) {
		const related = new Set(store.getConversationIdsForTicket(input.ticketKey));
		const ticketMatches = conversations
			.filter(({ id }) => related.has(id))
			.map((conversation) =>
				withEvidence(
					conversation,
					"ticket_relationship",
					input.ticketKey ?? "",
				),
			);
		if (ticketMatches.length) {
			return routingResult(
				ticketMatches,
				"ticket_relationships",
				!input.noWiden,
				unmatchedHints,
			);
		}
	}

	return routingResult(
		conversations.map((conversation) =>
			withEvidence(conversation, "all_configured", "configured"),
		),
		"all_configured",
		false,
		unmatchedHints,
	);
}

export function widenedRouting(
	all: readonly RoutedConversation[],
	initial: RoutingResult,
): RoutingResult {
	const searched = new Set(initial.conversations.map(({ id }) => id));
	return {
		conversations: all
			.filter(({ id }) => !searched.has(id))
			.map((conversation) => withEvidence(conversation, "widened", "fallback"))
			.sort(routeTieBreak),
		explicitChannelPolicy: "restrict",
		unmatchedHints: initial.unmatchedHints,
		reason: "all_configured",
		canWiden: false,
	};
}

export function searchThreads(
	store: MattermostStore,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
	routing: RoutingResult,
	limit = 100,
): ThreadCandidate[] {
	const conversations = new Map(
		routing.conversations.map((conversation) => [
			conversation.id,
			conversation,
		]),
	);
	const grouped = new Map<
		string,
		{ posts: Map<string, IndexedPost>; matches: SearchMatch[] }
	>();
	for (const probe of probes) {
		const searchValue = probe.terms.join(" ") || probe.value;
		for (const post of store.search(
			searchValue,
			[...conversations.keys()],
			limit,
		)) {
			const group = grouped.get(post.threadId) ?? {
				posts: new Map<string, IndexedPost>(),
				matches: [],
			};
			group.posts.set(post.id, post);
			group.matches.push({
				postId: post.id,
				probe: probe.value,
				excerpt: excerpt(post.message),
			});
			grouped.set(post.threadId, group);
		}
	}

	const relationships =
		subject.kind === "ticket"
			? store.getTicketRelationships(subject.ticketKey)
			: [];
	for (const relationship of relationships) {
		const thread = store.getThread(relationship.threadId);
		if (!thread.length || !conversations.has(thread[0]?.conversationId ?? ""))
			continue;
		const group = grouped.get(relationship.threadId) ?? {
			posts: new Map<string, IndexedPost>(),
			matches: [],
		};
		for (const post of thread) group.posts.set(post.id, post);
		grouped.set(relationship.threadId, group);
	}

	return [...grouped.entries()]
		.map(([threadId, group]) =>
			candidateFromGroup(
				store,
				threadId,
				group.posts,
				group.matches,
				conversations,
				subject,
				probes,
				relationships,
			),
		)
		.filter((candidate): candidate is ThreadCandidate => candidate !== null)
		.sort(compareCandidates);
}

export function directCandidate(
	post: IndexedPost,
	conversation: RoutedConversation,
): ThreadCandidate {
	return {
		threadId: post.threadId,
		rootPostId: post.rootId || post.id,
		conversationId: post.conversationId,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [post.id],
		matches: [
			{ postId: post.id, probe: post.id, excerpt: excerpt(post.message) },
		],
		reasons: ["direct_post", routeReason(conversation)],
		latestActivityAt: post.updateAt || post.createAt,
		priority: conversation.priority,
		scoreVector: [
			1,
			0,
			0,
			0,
			0,
			0,
			routeWeight(conversation),
			conversation.priority,
		],
	};
}

function candidateFromGroup(
	store: MattermostStore,
	threadId: string,
	_matchedPosts: Map<string, IndexedPost>,
	matches: SearchMatch[],
	conversations: ReadonlyMap<string, RoutedConversation>,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
	relationships: readonly TicketThreadRelationship[],
): ThreadCandidate | null {
	const thread = store.getThread(threadId);
	if (!thread.length) return null;
	const root = thread.find((post) => post.id === threadId) ?? thread[0];
	if (!root) return null;
	const conversation = conversations.get(root.conversationId);
	if (!conversation) return null;
	const ticketKey = subject.kind === "ticket" ? subject.ticketKey : undefined;
	const rootHasTicket = Boolean(ticketKey && contains(root.message, ticketKey));
	const replyHasTicket = Boolean(
		ticketKey &&
			thread.some(
				(post) => post.id !== root.id && contains(post.message, ticketKey),
			),
	);
	const explicitRelationship = relationships.some(
		(relationship) =>
			relationship.threadId === threadId && relationship.origin === "explicit",
	);
	const exactPhrase = probes.some((probe) => {
		const phrases = probe.phrases.length ? probe.phrases : [probe.value];
		return phrases.some((phrase) =>
			thread.some((post) => contains(post.message, phrase)),
		);
	});
	const allTerms = probes.some(
		(probe) =>
			probe.terms.length > 0 &&
			probe.terms.every((term) =>
				thread.some((post) => contains(post.message, term)),
			),
	);
	const latestActivityAt = Math.max(
		...thread.map((post) =>
			Math.max(post.createAt, post.updateAt, post.deleteAt),
		),
	);
	const reasons: RankingReason[] = [];
	if (explicitRelationship) reasons.push("explicit_ticket_relationship");
	if (rootHasTicket) reasons.push("ticket_in_root");
	if (replyHasTicket) reasons.push("ticket_in_reply");
	if (exactPhrase) reasons.push("exact_phrase");
	if (allTerms) reasons.push("all_terms_in_thread");
	reasons.push(routeReason(conversation));
	if (conversation.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	return {
		threadId,
		rootPostId: root.id,
		conversationId: conversation.id,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [...new Set(matches.map(({ postId }) => postId))].sort(),
		matches: deduplicateMatches(matches),
		reasons,
		latestActivityAt,
		priority: conversation.priority,
		scoreVector: [
			0,
			explicitRelationship ? 1 : 0,
			rootHasTicket ? 1 : 0,
			replyHasTicket ? 1 : 0,
			exactPhrase ? 1 : 0,
			allTerms ? 1 : 0,
			routeWeight(conversation),
			conversation.priority,
			latestActivityAt,
		],
	};
}

function compareCandidates(
	left: ThreadCandidate,
	right: ThreadCandidate,
): number {
	const length = Math.max(left.scoreVector.length, right.scoreVector.length);
	for (let index = 0; index < length; index += 1) {
		const difference =
			(right.scoreVector[index] ?? 0) - (left.scoreVector[index] ?? 0);
		if (difference) return difference;
	}
	return left.threadId.localeCompare(right.threadId);
}

function routeMetadata(
	config: MattermostConfig,
	alias: string,
	kind: ConversationRecord["kind"],
) {
	const metadata =
		kind === "channel" ? config.channels[alias] : config.directMessages[alias];
	if (!metadata) {
		return { scopes: [] as string[], repositories: [] as string[] };
	}
	return metadata;
}

function routingResult(
	conversations: RoutedConversation[],
	reason: RoutingResult["reason"],
	canWiden: boolean,
	unmatchedHints: RoutingResult["unmatchedHints"] = {
		scopes: [],
		repositories: [],
	},
): RoutingResult {
	return {
		conversations: [...conversations].sort(routeTieBreak),
		explicitChannelPolicy: "restrict",
		unmatchedHints,
		reason,
		canWiden,
	};
}

function unmatchedRoutingHints(
	config: MattermostConfig,
	input: {
		scopes?: readonly string[];
		repositories?: readonly string[];
	},
): RoutingResult["unmatchedHints"] {
	const knownScopes = new Set<string>();
	const knownRepositories = new Set<string>();
	for (const metadata of [
		...Object.values(config.channels),
		...Object.values(config.directMessages),
	]) {
		for (const scope of metadata.scopes) knownScopes.add(scope);
		for (const repository of metadata.repositories) {
			knownRepositories.add(repository);
		}
	}
	return {
		scopes: [...new Set(input.scopes ?? [])]
			.filter((scope) => !knownScopes.has(scope))
			.sort(),
		repositories: [...new Set(input.repositories ?? [])]
			.filter((repository) => !knownRepositories.has(repository))
			.sort(),
	};
}

function withEvidence(
	conversation: RoutedConversation,
	type: RoutingEvidenceType,
	value: string,
): RoutedConversation {
	return { ...conversation, evidence: [{ type, value }] };
}

function routeTieBreak(
	left: Pick<RoutedConversation, "priority" | "alias">,
	right: Pick<RoutedConversation, "priority" | "alias">,
): number {
	return (
		right.priority - left.priority || left.alias.localeCompare(right.alias)
	);
}

function routeWeight(conversation: RoutedConversation): number {
	const weights: Record<RoutingEvidenceType, number> = {
		explicit_channel: 6,
		scope: 5,
		repository: 4,
		ticket_relationship: 3,
		all_configured: 2,
		widened: 1,
	};
	return Math.max(...conversation.evidence.map(({ type }) => weights[type]), 0);
}

function routeReason(conversation: RoutedConversation): RankingReason {
	const type = conversation.evidence[0]?.type ?? "all_configured";
	const reasons: Record<RoutingEvidenceType, RankingReason> = {
		explicit_channel: "routing_explicit_channel",
		scope: "routing_scope",
		repository: "routing_repository",
		ticket_relationship: "routing_ticket_relationship",
		all_configured: "routing_all_configured",
		widened: "routing_widened",
	};
	return reasons[type];
}

function contains(message: string, value: string): boolean {
	return containsNormalizedText(message, value);
}

function excerpt(message: string): string {
	const characters = [...message];
	return characters.length <= 240
		? message
		: `${characters.slice(0, 239).join("")}…`;
}

function deduplicateMatches(matches: readonly SearchMatch[]): SearchMatch[] {
	return [
		...new Map(
			matches.map((match) => [`${match.postId}\0${match.probe}`, match]),
		).values(),
	].sort(
		(left, right) =>
			left.postId.localeCompare(right.postId) ||
			left.probe.localeCompare(right.probe),
	);
}
