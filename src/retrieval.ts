import type { MattermostConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import {
	expandQueryTerms,
	matchesQueryExpansion,
	type QueryExpansion,
} from "./query-expansion.ts";
import type {
	ConversationRecord,
	IndexedPost,
	LexicalRetrievalSource,
	MattermostStore,
	StructuredEntityHit,
	ThreadSearchFilters,
	TicketThreadRelationship,
} from "./storage.ts";
import {
	containsNormalizedExactText,
	normalizeSearchText,
	STOP_WORDS,
} from "./text.ts";

const POST_ID_PATTERN = /^[a-z0-9]{26}$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/i;
const PERMALINK_PATTERN = /\/pl\/([a-z0-9]{26})(?:[/?#]|$)/i;
const MAX_TERM_SEARCHES_PER_PROBE = 8;
const MIN_PREFIX_LENGTH = 4;
export const RRF_RANK_CONSTANT = 60;

export type MattermostSubject =
	| { kind: "ticket"; ticketKey: string; raw: string }
	| { kind: "post"; postId: string; raw: string; source: "permalink" | "id" }
	| { kind: "text"; text: string; raw: string };

export type AgentProbeKind =
	| "ticket_title"
	| "ticket_description"
	| "repository"
	| "file_path"
	| "symbol"
	| "error_message"
	| "service"
	| "participant";

export interface AgentProbeInput {
	kind: AgentProbeKind;
	value: string;
}

export interface RetrievalProbe {
	value: string;
	phrases: string[];
	terms: string[];
	kind?: AgentProbeKind;
	expansions?: QueryExpansion[];
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

export interface LexicalMatchEvidence {
	source: LexicalRetrievalSource;
	sourceQuery: string;
	rank: number;
	bm25: number;
}

export interface SearchMatch {
	postId: string;
	probe: string;
	probeKind?: AgentProbeKind;
	excerpt: string;
	lexicalSource?: LexicalRetrievalSource;
	sourceQuery?: string;
	sourceRank?: number;
	bm25?: number;
	lexicalEvidence?: LexicalMatchEvidence[];
	remoteRank?: number;
}

export type RankingReason =
	| "direct_post"
	| "explicit_ticket_relationship"
	| "ticket_in_root"
	| "ticket_in_reply"
	| "structured_entity_match"
	| "remote_search"
	| "subject_in_root"
	| "exact_phrase"
	| "exact_phrase_in_root"
	| "exact_phrase_in_reply"
	| "all_terms_in_thread"
	| "all_expanded_terms_in_thread"
	| "query_expansion"
	| "multiple_probes_in_thread"
	| "rank_fusion"
	| "routing_explicit_channel"
	| "routing_scope"
	| "routing_repository"
	| "routing_ticket_relationship"
	| "routing_all_configured"
	| "routing_widened"
	| "conversation_priority"
	| "latest_activity";

export interface ThreadRankingEvidence {
	subjectInRoot: boolean;
	subjectInReplies: boolean;
	exactPhraseInRootCount: number;
	exactPhraseInReplyCount: number;
	matchedProbeCount: number;
	fullyMatchedProbeCount: number;
	exactFullyMatchedProbeCount?: number;
	totalProbeCount: number;
	matchedTermCount: number;
	expandedMatchedTermCount?: number;
	expansionMatchCount?: number;
	totalTermCount: number;
	matchingPostCount: number;
	latestRelevantMatchAt: number | null;
}

export interface StructuredSearchMatch {
	postId: string;
	probe: string;
	probeKind?: AgentProbeKind;
	kind: StructuredEntityHit["kind"];
	value: string;
}

export interface RankFusionContribution {
	probe: string;
	probeKind?: AgentProbeKind;
	source: LexicalRetrievalSource;
	sourceQuery: string;
	rank: number;
	score: number;
}

type ScoreVector = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

interface CandidateRank {
	direct: number;
	explicitTicketRelationship: number;
	ticketInRoot: number;
	ticketInReply: number;
	subjectInRoot: number;
	exactPhraseInRoot: number;
	fullProbeCoverage: number;
	matchedProbeCount: number;
	structuredMatchCount: number;
	routing: number;
	fusion: number;
	matchedTermCount: number;
	exactPhraseInReply: number;
	conversationPriority: number;
	latestRelevantMatchAt: number;
	latestActivityAt: number;
}

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
	scoreVector: ScoreVector;
	rankingEvidence?: ThreadRankingEvidence;
	fusionScore?: number;
	fusionContributions?: RankFusionContribution[];
	structuredMatches?: StructuredSearchMatch[];
}

interface CandidateGroup {
	matches: SearchMatch[];
	structuredMatches: Map<string, StructuredSearchMatch>;
	fusionContributions: Map<string, RankFusionContribution>;
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
	configuredSynonyms:
		| Readonly<Record<string, readonly string[]>>
		| undefined = {},
	agentProbes: readonly AgentProbeInput[] = [],
): RetrievalProbe[] {
	const subjectValues =
		subject.kind === "ticket"
			? [subject.ticketKey]
			: subject.kind === "text"
				? [subject.text]
				: [];
	const values: Array<{ value: string; kind?: AgentProbeKind }> = [
		...subjectValues.map((value) => ({ value })),
		...queries.map((value) => ({ value })),
	];
	for (const probe of agentProbes) {
		const value = probe.value.trim();
		if (!value) continue;
		const genericIndex = values.findIndex(
			(existing) =>
				existing.kind === undefined && existing.value.trim() === value,
		);
		if (genericIndex >= 0) {
			values[genericIndex] = { value, kind: probe.kind };
		} else if (
			!values.some(
				(existing) =>
					existing.kind === probe.kind && existing.value.trim() === value,
			)
		) {
			values.push({ value, kind: probe.kind });
		}
	}
	const normalizedValues = values
		.map(({ value, kind }) => ({ value: value.trim(), kind }))
		.filter(({ value }) => Boolean(value));
	const seenGeneric = new Set<string>();
	return normalizedValues
		.filter(({ value, kind }) => {
			if (kind !== undefined) return true;
			if (seenGeneric.has(value)) return false;
			seenGeneric.add(value);
			return true;
		})
		.map(({ value, kind }) => {
			const phrases = [...value.matchAll(/"([^"]+)"/g)]
				.map((match) => match[1]?.trim())
				.filter((phrase): phrase is string => Boolean(phrase));
			const terms = [
				...new Set(
					(value.match(/[\p{L}\p{N}_-]+/gu) ?? [])
						.map(normalizeSearchText)
						.filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
				),
			];
			const expansions = expandQueryTerms(terms, configuredSynonyms ?? {});
			return {
				value,
				phrases,
				terms,
				...(kind ? { kind } : {}),
				...(expansions.length ? { expansions } : {}),
			};
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
	filters: ThreadSearchFilters = {},
): ThreadCandidate[] {
	const conversations = new Map(
		routing.conversations.map((conversation) => [
			conversation.id,
			conversation,
		]),
	);
	const grouped = new Map<string, CandidateGroup>();
	const conversationIds = [...conversations.keys()];
	for (const probe of probes) {
		const requests = deduplicateLexicalRequests(strongLexicalRequests(probe));
		for (const request of requests) {
			const hits = store.search(request.value, conversationIds, limit, {
				source: request.source,
				filters,
			});
			addLexicalHits(grouped, probe, hits);
			if (
				request.source !== "term_fts" ||
				hits.length > 0 ||
				request.value.length < MIN_PREFIX_LENGTH
			) {
				continue;
			}
			const prefixHits = store.search(request.value, conversationIds, limit, {
				source: "prefix_fts",
				filters,
			});
			addLexicalHits(grouped, probe, prefixHits);
			if (!prefixHits.length) {
				addLexicalHits(
					grouped,
					probe,
					store.search(request.value, conversationIds, limit, {
						source: "trigram",
						filters,
					}),
				);
			}
		}
		for (const expansion of probe.expansions ?? []) {
			addLexicalHits(
				grouped,
				probe,
				store.search(expansion.value, conversationIds, limit, {
					source:
						expansion.match === "prefix"
							? "prefix_fts"
							: expansion.value.includes(" ")
								? "exact_phrase"
								: "term_fts",
					filters,
				}),
			);
		}
		addStructuredHits(
			grouped,
			store,
			probe,
			store.searchEntities(
				probe.value,
				conversationIds,
				limit,
				filters,
				probe.kind === "participant" ? "username" : undefined,
			),
		);
	}

	const relationships =
		subject.kind === "ticket"
			? store.getTicketRelationships(subject.ticketKey)
			: [];
	for (const relationship of relationships) {
		const thread = store.getThread(relationship.threadId);
		if (!thread.length || !conversations.has(thread[0]?.conversationId ?? ""))
			continue;
		const group = grouped.get(relationship.threadId) ?? createCandidateGroup();
		grouped.set(relationship.threadId, group);
	}

	return [...grouped.entries()]
		.filter(([threadId]) => store.threadMatchesFilters(threadId, filters))
		.map(([threadId, group]) =>
			candidateFromGroup(
				store,
				threadId,
				group,
				conversations,
				subject,
				probes,
				relationships,
			),
		)
		.filter((candidate): candidate is ThreadCandidate => candidate !== null)
		.sort(compareCandidates);
}

function scoreVector(rank: Partial<CandidateRank>): ScoreVector {
	return [
		rank.direct ?? 0,
		rank.explicitTicketRelationship ?? 0,
		rank.ticketInRoot ?? 0,
		rank.ticketInReply ?? 0,
		rank.subjectInRoot ?? 0,
		rank.exactPhraseInRoot ?? 0,
		rank.fullProbeCoverage ?? 0,
		rank.matchedProbeCount ?? 0,
		rank.structuredMatchCount ?? 0,
		rank.routing ?? 0,
		rank.fusion ?? 0,
		rank.matchedTermCount ?? 0,
		rank.exactPhraseInReply ?? 0,
		rank.conversationPriority ?? 0,
		rank.latestRelevantMatchAt ?? 0,
		rank.latestActivityAt ?? 0,
	];
}

export function remoteSearchCandidate(
	post: IndexedPost,
	conversation: RoutedConversation,
	probe: string,
	rank: number,
	probeKind?: AgentProbeKind,
): ThreadCandidate {
	if (!Number.isInteger(rank) || rank < 1) {
		throw new Error("Remote search rank must be a positive integer.");
	}
	const latestActivityAt = Math.max(
		post.createAt,
		post.updateAt,
		post.deleteAt,
	);
	const fusionScore = reciprocalRankFusionScore(rank);
	const reasons: RankingReason[] = [
		"remote_search",
		"rank_fusion",
		routeReason(conversation),
	];
	if (conversation.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	return {
		threadId: post.threadId,
		rootPostId: post.rootId || post.id,
		conversationId: post.conversationId,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [post.id],
		matches: [
			{
				postId: post.id,
				probe,
				...(probeKind ? { probeKind } : {}),
				excerpt: excerpt(post.message),
				remoteRank: rank,
			},
		],
		reasons,
		latestActivityAt,
		priority: conversation.priority,
		scoreVector: scoreVector({
			matchedProbeCount: 1,
			routing: routeWeight(conversation),
			fusion: fusionScore,
			conversationPriority: conversation.priority,
			latestRelevantMatchAt: latestActivityAt,
			latestActivityAt,
		}),
		fusionScore,
	};
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
		scoreVector: scoreVector({
			direct: 1,
			routing: routeWeight(conversation),
			conversationPriority: conversation.priority,
			latestRelevantMatchAt: post.updateAt || post.createAt,
			latestActivityAt: post.updateAt || post.createAt,
		}),
	};
}

function strongLexicalRequests(
	probe: RetrievalProbe,
): Array<{ source: LexicalRetrievalSource; value: string }> {
	const requests: Array<{ source: LexicalRetrievalSource; value: string }> = [];
	const phraseValues = probe.phrases.length
		? probe.phrases
		: probe.terms.length > 1
			? [probe.value]
			: [];
	for (const value of phraseValues) {
		requests.push({ source: "exact_phrase", value });
	}
	if (probe.terms.length > 1) {
		const allTerms = probe.terms.join(" ");
		requests.push(
			{ source: "strict_fts", value: allTerms },
			{ source: "broad_fts", value: allTerms },
		);
	}
	for (const term of probe.terms.slice(0, MAX_TERM_SEARCHES_PER_PROBE)) {
		requests.push({ source: "term_fts", value: term });
	}
	if (!requests.length) {
		requests.push({ source: "strict_fts", value: probe.value });
	}
	return requests;
}

function deduplicateLexicalRequests(
	requests: Array<{ source: LexicalRetrievalSource; value: string }>,
): Array<{ source: LexicalRetrievalSource; value: string }> {
	const seen = new Set<string>();
	return requests.filter(({ source, value }) => {
		const key = `${source}\0${normalizeSearchText(value)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function addLexicalHits(
	grouped: Map<string, CandidateGroup>,
	probe: RetrievalProbe,
	hits: ReturnType<MattermostStore["search"]>,
): void {
	const rankedThreads = new Map<string, number>();
	for (const hit of hits) {
		if (!rankedThreads.has(hit.post.threadId)) {
			rankedThreads.set(hit.post.threadId, rankedThreads.size + 1);
		}
		const group = grouped.get(hit.post.threadId) ?? createCandidateGroup();
		group.matches.push({
			postId: hit.post.id,
			probe: probe.value,
			...(probe.kind ? { probeKind: probe.kind } : {}),
			excerpt: hit.snippet,
			lexicalSource: hit.source,
			sourceQuery: hit.sourceQuery,
			sourceRank: hit.rank,
			bm25: hit.bm25,
		});
		const rank = rankedThreads.get(hit.post.threadId);
		if (rank !== undefined) {
			const key = `${probe.kind ?? ""}\0${probe.value}\0${hit.source}\0${hit.sourceQuery}`;
			group.fusionContributions.set(key, {
				probe: probe.value,
				...(probe.kind ? { probeKind: probe.kind } : {}),
				source: hit.source,
				sourceQuery: hit.sourceQuery,
				rank,
				score: reciprocalRankFusionScore(rank),
			});
		}
		grouped.set(hit.post.threadId, group);
	}
}

function addStructuredHits(
	grouped: Map<string, CandidateGroup>,
	store: MattermostStore,
	probe: RetrievalProbe,
	hits: readonly StructuredEntityHit[],
): void {
	for (const hit of hits) {
		const post = store.getPost(hit.postId);
		if (!post) continue;
		const group = grouped.get(hit.threadId) ?? createCandidateGroup();
		group.structuredMatches.set(
			`${post.id}\0${probe.kind ?? ""}\0${probe.value}\0${hit.kind}\0${hit.normalizedValue}`,
			{
				postId: post.id,
				probe: probe.value,
				...(probe.kind ? { probeKind: probe.kind } : {}),
				kind: hit.kind,
				value: hit.value,
			},
		);
		group.matches.push({
			postId: post.id,
			probe: probe.value,
			...(probe.kind ? { probeKind: probe.kind } : {}),
			excerpt: post.message
				? excerpt(post.message)
				: `Attachment: ${hit.value}`,
		});
		grouped.set(hit.threadId, group);
	}
}

function createCandidateGroup(): CandidateGroup {
	return {
		matches: [],
		structuredMatches: new Map<string, StructuredSearchMatch>(),
		fusionContributions: new Map<string, RankFusionContribution>(),
	};
}

export function reciprocalRankFusionScore(
	rank: number,
	rankConstant = RRF_RANK_CONSTANT,
): number {
	if (!Number.isInteger(rank) || rank < 1) {
		throw new Error("Rank fusion requires a positive integer rank.");
	}
	if (!Number.isFinite(rankConstant) || rankConstant < 0) {
		throw new Error("Rank fusion constant must be a non-negative number.");
	}
	return 1 / (rankConstant + rank);
}

function candidateFromGroup(
	store: MattermostStore,
	threadId: string,
	group: CandidateGroup,
	conversations: ReadonlyMap<string, RoutedConversation>,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
	relationships: readonly TicketThreadRelationship[],
): ThreadCandidate | null {
	const { matches } = group;
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
	const rankingEvidence = evaluateThreadEvidence(
		thread,
		root.id,
		subject,
		probes,
	);
	const exactPhrase =
		rankingEvidence.exactPhraseInRootCount > 0 ||
		rankingEvidence.exactPhraseInReplyCount > 0;
	const allTerms = (rankingEvidence.exactFullyMatchedProbeCount ?? 0) > 0;
	const allExpandedTerms =
		rankingEvidence.fullyMatchedProbeCount >
		(rankingEvidence.exactFullyMatchedProbeCount ?? 0);
	const structuredMatches = [...group.structuredMatches.values()].sort(
		(left, right) =>
			left.postId.localeCompare(right.postId) ||
			left.probe.localeCompare(right.probe) ||
			left.kind.localeCompare(right.kind) ||
			left.value.localeCompare(right.value),
	);
	const fusionContributions = [...group.fusionContributions.values()].sort(
		compareFusionContributions,
	);
	const fusionScore = fusionContributions.reduce(
		(total, contribution) => total + contribution.score,
		0,
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
	if (structuredMatches.length) reasons.push("structured_entity_match");
	if (rankingEvidence.subjectInRoot) reasons.push("subject_in_root");
	if (exactPhrase) reasons.push("exact_phrase");
	if (rankingEvidence.exactPhraseInRootCount) {
		reasons.push("exact_phrase_in_root");
	}
	if (rankingEvidence.exactPhraseInReplyCount) {
		reasons.push("exact_phrase_in_reply");
	}
	if (allTerms) reasons.push("all_terms_in_thread");
	if (allExpandedTerms) reasons.push("all_expanded_terms_in_thread");
	if ((rankingEvidence.expansionMatchCount ?? 0) > 0) {
		reasons.push("query_expansion");
	}
	if (rankingEvidence.matchedProbeCount > 1) {
		reasons.push("multiple_probes_in_thread");
	}
	if (fusionScore) reasons.push("rank_fusion");
	reasons.push(routeReason(conversation));
	if (conversation.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	return {
		threadId,
		rootPostId: root.id,
		conversationId: conversation.id,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		matchingPostIds: [
			...new Set([
				...matches.map(({ postId }) => postId),
				...structuredMatches.map(({ postId }) => postId),
			]),
		].sort(),
		matches: deduplicateMatches(matches),
		reasons,
		latestActivityAt,
		priority: conversation.priority,
		scoreVector: scoreVector({
			explicitTicketRelationship: explicitRelationship ? 1 : 0,
			ticketInRoot: rootHasTicket ? 1 : 0,
			ticketInReply: replyHasTicket ? 1 : 0,
			subjectInRoot: rankingEvidence.subjectInRoot ? 1 : 0,
			exactPhraseInRoot: rankingEvidence.exactPhraseInRootCount,
			fullProbeCoverage:
				(rankingEvidence.exactFullyMatchedProbeCount ?? 0) * 2 +
				(rankingEvidence.fullyMatchedProbeCount -
					(rankingEvidence.exactFullyMatchedProbeCount ?? 0)),
			matchedProbeCount: rankingEvidence.matchedProbeCount,
			structuredMatchCount: structuredMatches.length,
			routing: routeWeight(conversation),
			fusion: fusionScore,
			matchedTermCount: rankingEvidence.matchedTermCount,
			exactPhraseInReply: rankingEvidence.exactPhraseInReplyCount,
			conversationPriority: conversation.priority,
			latestRelevantMatchAt: rankingEvidence.latestRelevantMatchAt ?? 0,
			latestActivityAt,
		}),
		rankingEvidence,
		fusionScore,
		fusionContributions,
		...(structuredMatches.length ? { structuredMatches } : {}),
	};
}

function compareFusionContributions(
	left: RankFusionContribution,
	right: RankFusionContribution,
): number {
	return (
		left.probe.localeCompare(right.probe) ||
		(left.probeKind ?? "").localeCompare(right.probeKind ?? "") ||
		left.source.localeCompare(right.source) ||
		left.sourceQuery.localeCompare(right.sourceQuery) ||
		left.rank - right.rank
	);
}

export function evaluateThreadEvidence(
	thread: readonly Pick<
		IndexedPost,
		"id" | "message" | "createAt" | "updateAt" | "deleteAt"
	>[],
	rootPostId: string,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
): ThreadRankingEvidence {
	const root = thread.find(({ id }) => id === rootPostId);
	const replies = thread.filter(({ id }) => id !== rootPostId);
	const probeEvidence = probes.map((probe) => {
		const phrases = probe.phrases.length ? probe.phrases : [probe.value];
		const phraseInRoot = Boolean(
			root && phrases.some((phrase) => contains(root.message, phrase)),
		);
		const phraseInReplies = phrases.some((phrase) =>
			replies.some((post) => contains(post.message, phrase)),
		);
		const exactMatchedTerms = probe.terms.filter((term) =>
			thread.some((post) => contains(post.message, term)),
		);
		const matchingExpansions = (probe.expansions ?? []).filter((expansion) =>
			thread.some((post) => matchesQueryExpansion(post.message, expansion)),
		);
		const expandedMatchedTerms = probe.terms.filter(
			(term) =>
				!exactMatchedTerms.includes(term) &&
				matchingExpansions.some(({ sourceTerm }) => sourceTerm === term),
		);
		const matchedTermCount =
			exactMatchedTerms.length + expandedMatchedTerms.length;
		return {
			phraseInRoot,
			phraseInReplies,
			matchedTermCount,
			exactMatchedTermCount: exactMatchedTerms.length,
			expandedMatchedTermCount: expandedMatchedTerms.length,
			expansionMatchCount: matchingExpansions.length,
			matched: phraseInRoot || phraseInReplies || matchedTermCount > 0,
			exactFullyMatched:
				phraseInRoot ||
				phraseInReplies ||
				(probe.terms.length > 0 &&
					exactMatchedTerms.length === probe.terms.length),
			fullyMatched:
				phraseInRoot ||
				phraseInReplies ||
				(probe.terms.length > 0 && matchedTermCount === probe.terms.length),
		};
	});
	const relevantPosts = thread.filter((post) =>
		probes.some((probe) => {
			const phrases = probe.phrases.length ? probe.phrases : [probe.value];
			return (
				phrases.some((phrase) => contains(post.message, phrase)) ||
				probe.terms.some((term) => contains(post.message, term)) ||
				(probe.expansions ?? []).some((expansion) =>
					matchesQueryExpansion(post.message, expansion),
				)
			);
		}),
	);
	const subjectPhrases =
		subject.kind === "text"
			? probes[0]?.phrases.length
				? probes[0].phrases
				: [subject.text]
			: [];
	return {
		subjectInRoot: Boolean(
			root && subjectPhrases.some((phrase) => contains(root.message, phrase)),
		),
		subjectInReplies: subjectPhrases.some((phrase) =>
			replies.some((post) => contains(post.message, phrase)),
		),
		exactPhraseInRootCount: probeEvidence.filter(
			({ phraseInRoot }) => phraseInRoot,
		).length,
		exactPhraseInReplyCount: probeEvidence.filter(
			({ phraseInReplies }) => phraseInReplies,
		).length,
		matchedProbeCount: probeEvidence.filter(({ matched }) => matched).length,
		fullyMatchedProbeCount: probeEvidence.filter(
			({ fullyMatched }) => fullyMatched,
		).length,
		exactFullyMatchedProbeCount: probeEvidence.filter(
			({ exactFullyMatched }) => exactFullyMatched,
		).length,
		totalProbeCount: probes.length,
		matchedTermCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.matchedTermCount,
			0,
		),
		expandedMatchedTermCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.expandedMatchedTermCount,
			0,
		),
		expansionMatchCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.expansionMatchCount,
			0,
		),
		totalTermCount: probes.reduce(
			(total, probe) => total + probe.terms.length,
			0,
		),
		matchingPostCount: relevantPosts.length,
		latestRelevantMatchAt: relevantPosts.length
			? Math.max(
					...relevantPosts.map((post) =>
						Math.max(post.createAt, post.updateAt, post.deleteAt),
					),
				)
			: null,
	};
}

export function mergeThreadCandidates(
	...candidateLists: ReadonlyArray<readonly ThreadCandidate[]>
): ThreadCandidate[] {
	const merged = new Map<string, ThreadCandidate>();
	for (const candidate of candidateLists.flat()) {
		const existing = merged.get(candidate.threadId);
		if (!existing) {
			merged.set(candidate.threadId, structuredClone(candidate));
			continue;
		}
		const preferred =
			compareCandidates(existing, candidate) <= 0 ? existing : candidate;
		const other = preferred === existing ? candidate : existing;
		preferred.matchingPostIds = [
			...new Set([...preferred.matchingPostIds, ...other.matchingPostIds]),
		].sort();
		preferred.matches = deduplicateMatches([
			...preferred.matches,
			...other.matches,
		]);
		preferred.reasons = [...new Set([...preferred.reasons, ...other.reasons])];
		preferred.latestActivityAt = Math.max(
			preferred.latestActivityAt,
			other.latestActivityAt,
		);
		merged.set(candidate.threadId, preferred);
	}
	return [...merged.values()].sort(compareCandidates);
}

function compareCandidates(
	left: ThreadCandidate,
	right: ThreadCandidate,
): number {
	for (const [index, rightValue] of right.scoreVector.entries()) {
		const difference = rightValue - (left.scoreVector[index] ?? 0);
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
	return containsNormalizedExactText(message, value);
}

function excerpt(message: string): string {
	const characters = [...message];
	return characters.length <= 240
		? message
		: `${characters.slice(0, 239).join("")}…`;
}

function deduplicateMatches(matches: readonly SearchMatch[]): SearchMatch[] {
	const grouped = new Map<string, SearchMatch[]>();
	for (const match of matches) {
		const key = `${match.postId}\0${match.probeKind ?? ""}\0${match.probe}`;
		const values = grouped.get(key) ?? [];
		values.push(match);
		grouped.set(key, values);
	}
	return [...grouped.values()]
		.map((values) => {
			const ordered = [...values].sort(compareMatchEvidence);
			const best = ordered[0];
			if (!best) throw new Error("Search match group cannot be empty.");
			const lexicalEvidence = ordered.flatMap((match) =>
				match.lexicalSource &&
				match.sourceQuery !== undefined &&
				match.sourceRank !== undefined &&
				match.bm25 !== undefined
					? [
							{
								source: match.lexicalSource,
								sourceQuery: match.sourceQuery,
								rank: match.sourceRank,
								bm25: match.bm25,
							},
						]
					: [],
			);
			return lexicalEvidence.length ? { ...best, lexicalEvidence } : best;
		})
		.sort(
			(left, right) =>
				left.postId.localeCompare(right.postId) ||
				left.probe.localeCompare(right.probe) ||
				(left.probeKind ?? "").localeCompare(right.probeKind ?? ""),
		);
}

function compareMatchEvidence(left: SearchMatch, right: SearchMatch): number {
	const priority: Record<LexicalRetrievalSource, number> = {
		exact_phrase: 5,
		strict_fts: 4,
		broad_fts: 3,
		term_fts: 2,
		prefix_fts: 1,
		trigram: 0,
	};
	return (
		(priority[right.lexicalSource ?? "trigram"] ?? 0) -
			(priority[left.lexicalSource ?? "trigram"] ?? 0) ||
		(left.sourceRank ?? Number.MAX_SAFE_INTEGER) -
			(right.sourceRank ?? Number.MAX_SAFE_INTEGER) ||
		(left.sourceQuery ?? "").localeCompare(right.sourceQuery ?? "")
	);
}
