import type { MattermostConfig, SearchConcepts } from "./config.ts";
import { extractTicketKeys } from "./entities.ts";
import { ConfigError } from "./errors.ts";
import {
	expandQueryTerms,
	matchesQueryExpansion,
	type QueryExpansion,
} from "./query-expansion.ts";
import { deadlineReached } from "./runtime-limits.ts";
import {
	type ConceptQueryMatch,
	conceptQueryMatches,
	conceptToken,
} from "./search-concepts.ts";
import {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeMorphText,
} from "./search-token-normalization.ts";
import type {
	ConversationRecord,
	IndexedPost,
	LexicalRetrievalSource,
	MattermostStore,
	StructuredEntityHit,
	ThreadSearchFilters,
	TicketThreadRelationship,
} from "./storage.ts";
import { trigramSearchPolicy } from "./storage.ts";
import {
	containsNormalizedExactText,
	normalizeSearchText,
	STOP_WORDS,
} from "./text.ts";
import { segmentThreadByTicketProximity } from "./ticket-segments.ts";

const POST_ID_PATTERN = /^[a-z0-9]{26}$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/i;
const PERMALINK_PATTERN = /\/pl\/([a-z0-9]{26})(?:[/?#]|$)/i;
const MAX_TERMS_PER_PROBE = 8;
const MAX_MORPH_TERMS_PER_PROBE = 8;
const MAX_CONCEPT_MATCHES_PER_PROBE = 8;
const MAX_FUZZY_REQUESTS_PER_PROBE = 8;
const MAX_CANDIDATES_PER_SOURCE = 100;
const MIN_PREFIX_LENGTH = 4;
const MAX_PROXIMITY_TERMS_PER_PROBE = 8;
const MAX_PROXIMITY_TOKENS_PER_POST = 512;
const MIN_SUBSTANTIVE_POST_TOKENS = 6;
const MIN_SUBSTANTIVE_THREAD_POSTS = 3;
const MAX_SUBSTANTIVE_THREAD_DEPTH = 5;
const NEAR_TOKEN_WINDOW = 8;
const LOW_TICKET_DENSITY_THRESHOLD = 0.15;
const LOW_TICKET_DENSITY_MIN_POSTS = 20;
export const RRF_RANK_CONSTANT = 60;

export type RankFusionSource =
	| LexicalRetrievalSource
	| "synonym"
	| "keyboard_layout"
	| "transliteration"
	| "mixed_script";

export type TypoFallbackKind =
	| "identifier"
	| "latin_technical_term"
	| "russian_word";

export const RETRIEVAL_SOURCE_WEIGHTS: Readonly<
	Record<RankFusionSource, number>
> = Object.freeze({
	exact_phrase: 1,
	strict_fts: 0.9,
	term_fts: 0.75,
	broad_fts: 0.55,
	morph_fts: 0.45,
	concept_fts: 0.35,
	synonym: 0.35,
	keyboard_layout: 0.25,
	transliteration: 0.25,
	mixed_script: 0.25,
	prefix_fts: 0.2,
	trigram: 0.15,
});

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
	morphTerms?: string[];
	conceptMatches?: ConceptQueryMatch[];
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
	| "exact_terms_near"
	| "morph_terms_near"
	| "exact_terms_same_post"
	| "morph_terms_same_post"
	| "expanded_terms_same_post"
	| "terms_across_thread"
	| "morphology_match"
	| "concept_match"
	| "keyboard_layout_match"
	| "transliteration_match"
	| "mixed_script_match"
	| "prefix_match"
	| "typo_match"
	| "query_expansion"
	| "multiple_probes_in_thread"
	| "substantive_thread_depth"
	| "thin_thread"
	| "multi_ticket_root"
	| "rank_fusion"
	| "routing_explicit_channel"
	| "routing_scope"
	| "routing_repository"
	| "routing_ticket_relationship"
	| "routing_all_configured"
	| "routing_widened"
	| "conversation_priority"
	| "latest_activity";

export type ProximityKind =
	| "exact_terms_near"
	| "morph_terms_near"
	| "exact_terms_same_post"
	| "morph_terms_same_post"
	| "expanded_terms_same_post"
	| "terms_across_thread";

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
	morphMatchedTermCount?: number;
	expandedMatchedTermCount?: number;
	fallbackMatchedTermCount?: number;
	expansionMatchCount?: number;
	exactTermsInSamePost?: number;
	morphTermsInSamePost?: number;
	matchedTermsInSamePost?: number;
	minimumTokenWindow?: number | null;
	matchedTermsAcrossThread?: number;
	matchedTermsInRoot?: number;
	matchedTermsInReplies?: number;
	distinctProbeCoverage?: number;
	proximityKind?: ProximityKind;
	totalTermCount: number;
	matchingPostCount: number;
	threadPostCount?: number;
	substantivePostCount?: number;
	threadDepthScore?: number;
	thinTicketStub?: boolean;
	multiTicketRoot?: boolean;
	ticketDensity?: number;
	nearestTicketDistance?: number | null;
	rootAnchoredFocused?: boolean;
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
	source: RankFusionSource;
	sourceQuery: string;
	rank: number;
	weight: number;
	score: number;
	conceptId?: string;
	sourcePhrase?: string;
	fallbackKind?: TypoFallbackKind;
	minimumSimilarity?: number;
	maximumEditDistance?: number;
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
	proximityTier: number;
	proximityWindow: number;
	fullProbeCoverage: number;
	matchedProbeCount: number;
	structuredMatchCount: number;
	routing: number;
	threadDepth: number;
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
	configuredConcepts: Readonly<SearchConcepts> | undefined = {},
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
			].slice(0, MAX_TERMS_PER_PROBE);
			const expansions = expandQueryTerms(terms, configuredSynonyms ?? {}, {
				rawText: value,
				enableScriptVariants:
					(!kind ||
						!["repository", "file_path", "symbol", "error_message"].includes(
							kind,
						)) &&
					!/(?:https?:\/\/|[/\\])/iu.test(value),
			});
			const morphTerms = morphSearchTerms(terms).slice(
				0,
				MAX_MORPH_TERMS_PER_PROBE,
			);
			const conceptMatches = conceptQueryMatches(
				value,
				configuredConcepts ?? {},
			).slice(0, MAX_CONCEPT_MATCHES_PER_PROBE);
			return {
				value,
				phrases,
				terms,
				...(morphTerms.length ? { morphTerms } : {}),
				...(conceptMatches.length ? { conceptMatches } : {}),
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

export interface SearchThreadsOptions {
	deadlineAt?: number;
	incomplete?: { value: boolean };
	includeAutomation?: boolean;
	suppressAuthors?: readonly string[];
	threadCache?: Map<string, IndexedPost[]>;
}

export function searchThreads(
	store: MattermostStore,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
	routing: RoutingResult,
	limit = 100,
	filters: ThreadSearchFilters = {},
	options: SearchThreadsOptions = {},
): ThreadCandidate[] {
	const conversations = new Map(
		routing.conversations.map((conversation) => [
			conversation.id,
			conversation,
		]),
	);
	const grouped = new Map<string, CandidateGroup>();
	const conversationIds = [...conversations.keys()];
	const sourceLimit = Math.min(limit, MAX_CANDIDATES_PER_SOURCE);
	const threadCache = options.threadCache ?? new Map<string, IndexedPost[]>();
	const getThread = (threadId: string): IndexedPost[] => {
		const cached = threadCache.get(threadId);
		if (cached) return cached;
		const thread = store.getThread(threadId);
		threadCache.set(threadId, thread);
		return thread;
	};
	const timedOut = (): boolean => {
		if (!deadlineReached(options.deadlineAt)) return false;
		if (options.incomplete) options.incomplete.value = true;
		return true;
	};

	const relationships =
		subject.kind === "ticket"
			? store.getTicketRelationships(subject.ticketKey)
			: [];
	for (const relationship of relationships) {
		const thread = getThread(relationship.threadId);
		if (!thread.length || !conversations.has(thread[0]?.conversationId ?? ""))
			continue;
		const group = grouped.get(relationship.threadId) ?? createCandidateGroup();
		grouped.set(relationship.threadId, group);
	}

	const strongPass: Array<{
		probe: RetrievalProbe;
		retrieve: (
			source: LexicalRetrievalSource,
			value: string,
			fusionSource?: RankFusionSource,
			fusionMetadata?: Pick<
				RankFusionContribution,
				| "conceptId"
				| "sourcePhrase"
				| "fallbackKind"
				| "minimumSimilarity"
				| "maximumEditDistance"
			>,
		) => ReturnType<MattermostStore["search"]>;
		coveredTerms: Set<string>;
	}> = [];

	for (const probe of probes) {
		if (timedOut()) break;
		const requestCache = new Map<
			string,
			ReturnType<MattermostStore["search"]>
		>();
		const retrieve = (
			source: LexicalRetrievalSource,
			value: string,
			fusionSource: RankFusionSource = source,
			fusionMetadata: Pick<
				RankFusionContribution,
				| "conceptId"
				| "sourcePhrase"
				| "fallbackKind"
				| "minimumSimilarity"
				| "maximumEditDistance"
			> = {},
		): ReturnType<MattermostStore["search"]> => {
			if (timedOut()) return [];
			const key = `${source}\0${normalizeSearchText(value)}`;
			const cached = requestCache.get(key);
			if (cached) {
				addLexicalHits(grouped, probe, cached, fusionSource, fusionMetadata);
				return cached;
			}
			const hits = store.search(value, conversationIds, sourceLimit, {
				source,
				filters,
			});
			requestCache.set(key, hits);
			addLexicalHits(grouped, probe, hits, fusionSource, fusionMetadata);
			return hits;
		};
		const coveredTerms = new Set<string>();
		strongPass.push({ probe, retrieve, coveredTerms });
		const requests = deduplicateLexicalRequests(strongLexicalRequests(probe));
		for (const request of requests) {
			if (timedOut()) break;
			const hits = retrieve(request.source, request.value);
			if (!hits.length) continue;
			if (request.source === "term_fts") {
				coveredTerms.add(normalizeSearchText(request.value));
			} else if (
				request.source === "exact_phrase" ||
				request.source === "strict_fts"
			) {
				for (const term of probe.terms) coveredTerms.add(term);
			}
		}
		if (!timedOut()) {
			addStructuredHits(
				grouped,
				store,
				probe,
				store.searchEntities(
					probe.value,
					conversationIds,
					sourceLimit,
					filters,
					probe.kind === "participant" ? "username" : undefined,
				),
			);
		}
	}

	const strongTicket =
		subject.kind === "ticket" &&
		(relationships.length > 0 ||
			hasTicketHitInGrouped(grouped, getThread, subject.ticketKey));

	if (!strongTicket && !timedOut()) {
		for (const entry of strongPass) {
			if (timedOut()) break;
			runWeakRetrieval(
				entry.probe,
				entry.retrieve,
				entry.coveredTerms,
				timedOut,
			);
		}
	}

	return [...grouped.entries()]
		.filter(([threadId]) => store.threadMatchesFilters(threadId, filters))
		.filter(([threadId]) => {
			if (options.includeAutomation) return true;
			return !isUnrepliedAutomationThread(
				store,
				threadId,
				getThread,
				options.suppressAuthors ?? [],
			);
		})
		.map(([threadId, group]) =>
			candidateFromGroup(
				store,
				threadId,
				group,
				conversations,
				subject,
				probes,
				relationships,
				getThread,
			),
		)
		.filter((candidate): candidate is ThreadCandidate => candidate !== null)
		.sort(compareCandidates);
}

function runWeakRetrieval(
	probe: RetrievalProbe,
	retrieve: (
		source: LexicalRetrievalSource,
		value: string,
		fusionSource?: RankFusionSource,
		fusionMetadata?: Pick<
			RankFusionContribution,
			| "conceptId"
			| "sourcePhrase"
			| "fallbackKind"
			| "minimumSimilarity"
			| "maximumEditDistance"
		>,
	) => ReturnType<MattermostStore["search"]>,
	coveredTerms: Set<string>,
	timedOut: () => boolean,
): void {
	const morphEntries = probe.terms
		.map((term) => ({ term, morph: morphSearchTerms([term])[0] }))
		.filter(
			(entry): entry is { term: string; morph: string } =>
				entry.morph !== undefined,
		)
		.slice(0, MAX_MORPH_TERMS_PER_PROBE);
	if (morphEntries.length > 1 && !timedOut()) {
		const hits = retrieve(
			"morph_fts",
			morphEntries.map(({ morph }) => morph).join(" "),
		);
		if (hits.length) {
			for (const { term } of morphEntries) coveredTerms.add(term);
		}
	}
	for (const morph of new Set(morphEntries.map((entry) => entry.morph))) {
		if (timedOut()) return;
		const hits = retrieve("morph_fts", morph);
		if (!hits.length) continue;
		for (const entry of morphEntries) {
			if (entry.morph === morph) coveredTerms.add(entry.term);
		}
	}
	for (const concept of probe.conceptMatches ?? []) {
		if (timedOut()) return;
		retrieve("concept_fts", conceptToken(concept.conceptId), "concept_fts", {
			conceptId: concept.conceptId,
			sourcePhrase: concept.sourcePhrase,
		});
	}
	for (const expansion of probe.expansions ?? []) {
		if (timedOut()) return;
		const source =
			expansion.match === "morph"
				? "morph_fts"
				: expansion.match === "prefix"
					? "prefix_fts"
					: expansion.value.includes(" ")
						? "exact_phrase"
						: "term_fts";
		const value =
			expansion.match === "morph"
				? normalizeMorphText(expansion.value)
				: expansion.value;
		if (value) retrieve(source, value, expansion.kind);
	}
	let fuzzyRequestCount = 0;
	for (const term of probe.terms) {
		if (timedOut()) return;
		if (
			coveredTerms.has(term) ||
			fuzzyRequestCount >= MAX_FUZZY_REQUESTS_PER_PROBE
		) {
			continue;
		}
		const fallback = typoFallbackPolicy(probe, term);
		if (!fallback) continue;
		if (probe.conceptMatches?.length && fallback.kind === "russian_word") {
			continue;
		}
		if (fallback.allowPrefix && term.length >= MIN_PREFIX_LENGTH) {
			fuzzyRequestCount += 1;
			const prefixHits = retrieve("prefix_fts", term, "prefix_fts", {
				fallbackKind: fallback.kind,
			});
			if (prefixHits.length) continue;
		}
		const trigram = trigramSearchPolicy(term);
		if (!trigram || fuzzyRequestCount >= MAX_FUZZY_REQUESTS_PER_PROBE) {
			continue;
		}
		fuzzyRequestCount += 1;
		retrieve("trigram", term, "trigram", {
			fallbackKind: fallback.kind,
			minimumSimilarity: trigram.minimumSimilarity,
			maximumEditDistance: trigram.maximumEditDistance,
		});
	}
}

function hasTicketHitInGrouped(
	grouped: Map<string, CandidateGroup>,
	getThread: (threadId: string) => IndexedPost[],
	ticketKey: string,
): boolean {
	for (const threadId of grouped.keys()) {
		const thread = getThread(threadId);
		if (thread.some((post) => contains(post.message, ticketKey))) return true;
	}
	return false;
}

export function isUnrepliedAutomationThread(
	store: MattermostStore,
	threadId: string,
	getThread: (threadId: string) => IndexedPost[],
	suppressAuthors: readonly string[],
): boolean {
	if (store.threadReplyCount(threadId) > 0) return false;
	const thread = getThread(threadId);
	const root = thread.find((post) => post.id === threadId) ?? thread[0];
	if (!root) return false;
	return isAutomationAuthor(store, root, suppressAuthors);
}

export function isAutomationAuthor(
	store: MattermostStore,
	post: IndexedPost,
	suppressAuthors: readonly string[] = [],
): boolean {
	const user = store.getUser(post.userId);
	if (user?.isBot) return true;
	if (user && suppressAuthors.includes(user.username)) return true;
	const props = post.props ?? {};
	if (props.from_bot === true || props.from_webhook === true) return true;
	if (props.from_bot === "true" || props.from_webhook === "true") return true;
	return false;
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
		rank.proximityTier ?? 0,
		rank.proximityWindow ?? 0,
		rank.structuredMatchCount ?? 0,
		rank.routing ?? 0,
		rank.threadDepth ?? 0,
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

function typoFallbackPolicy(
	probe: RetrievalProbe,
	term: string,
): { kind: TypoFallbackKind; allowPrefix: boolean } | null {
	const rawToken = (probe.value.match(/[\p{L}\p{N}_-]+/gu) ?? []).find(
		(value) => normalizeSearchText(value) === term,
	);
	const explicitIdentifier =
		probe.kind !== undefined &&
		["repository", "file_path", "symbol", "service"].includes(probe.kind);
	const identifierShape =
		/[-_\d]/u.test(rawToken ?? term) ||
		/[a-z][A-Z]/u.test(rawToken ?? "") ||
		/[A-Z][a-z]+[A-Z]/u.test(rawToken ?? "");
	if (explicitIdentifier || identifierShape) {
		return { kind: "identifier", allowPrefix: true };
	}
	if (/^[\p{Script=Cyrillic}]+$/u.test(term)) {
		return { kind: "russian_word", allowPrefix: false };
	}
	if (/^[a-z]+$/u.test(term) && term.length >= 5) {
		return { kind: "latin_technical_term", allowPrefix: false };
	}
	return null;
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
	for (const term of probe.terms.slice(0, MAX_TERMS_PER_PROBE)) {
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
	fusionSource: RankFusionSource,
	fusionMetadata: Pick<
		RankFusionContribution,
		| "conceptId"
		| "sourcePhrase"
		| "fallbackKind"
		| "minimumSimilarity"
		| "maximumEditDistance"
	> = {},
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
			const key = `${probe.kind ?? ""}\0${probe.value}\0${fusionSource}`;
			const weight = RETRIEVAL_SOURCE_WEIGHTS[fusionSource];
			const contribution: RankFusionContribution = {
				probe: probe.value,
				...(probe.kind ? { probeKind: probe.kind } : {}),
				source: fusionSource,
				sourceQuery: hit.sourceQuery,
				rank,
				weight,
				score: weightedReciprocalRankFusionScore(fusionSource, rank),
				...fusionMetadata,
			};
			const current = group.fusionContributions.get(key);
			if (!current || isStrongerFusionContribution(contribution, current)) {
				group.fusionContributions.set(key, contribution);
			}
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

export function weightedReciprocalRankFusionScore(
	source: RankFusionSource,
	rank: number,
	rankConstant = RRF_RANK_CONSTANT,
): number {
	return (
		RETRIEVAL_SOURCE_WEIGHTS[source] *
		reciprocalRankFusionScore(rank, rankConstant)
	);
}

function isStrongerFusionContribution(
	candidate: RankFusionContribution,
	current: RankFusionContribution,
): boolean {
	return (
		candidate.score > current.score ||
		(candidate.score === current.score &&
			(candidate.rank < current.rank ||
				(candidate.rank === current.rank &&
					candidate.sourceQuery.localeCompare(current.sourceQuery) < 0)))
	);
}

function candidateFromGroup(
	store: MattermostStore,
	threadId: string,
	group: CandidateGroup,
	conversations: ReadonlyMap<string, RoutedConversation>,
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
	relationships: readonly TicketThreadRelationship[],
	getThread: (threadId: string) => IndexedPost[] = (id) => store.getThread(id),
): ThreadCandidate | null {
	const { matches } = group;
	const thread = getThread(threadId);
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
		group.matches,
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
	if (
		!(rankingEvidence.threadDepthScore ?? 0) &&
		(rankingEvidence.substantivePostCount ?? 0) >=
			MIN_SUBSTANTIVE_THREAD_POSTS &&
		fusionContributions.some(
			({ source, sourcePhrase }) =>
				source === "concept_fts" && Boolean(sourcePhrase?.trim().includes(" ")),
		)
	) {
		rankingEvidence.threadDepthScore =
			rankingEvidence.substantivePostCount ?? 0;
	}
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
	if (rankingEvidence.proximityKind) {
		reasons.push(rankingEvidence.proximityKind);
	}
	if ((rankingEvidence.morphMatchedTermCount ?? 0) > 0) {
		reasons.push("morphology_match");
	}
	if (fusionContributions.some(({ source }) => source === "concept_fts")) {
		reasons.push("concept_match");
	}
	if (fusionContributions.some(({ source }) => source === "keyboard_layout")) {
		reasons.push("keyboard_layout_match");
	}
	if (fusionContributions.some(({ source }) => source === "transliteration")) {
		reasons.push("transliteration_match");
	}
	if (fusionContributions.some(({ source }) => source === "mixed_script")) {
		reasons.push("mixed_script_match");
	}
	if (fusionContributions.some(({ source }) => source === "prefix_fts")) {
		reasons.push("prefix_match");
	}
	if (fusionContributions.some(({ source }) => source === "trigram")) {
		reasons.push("typo_match");
	}
	if ((rankingEvidence.expansionMatchCount ?? 0) > 0) {
		reasons.push("query_expansion");
	}
	if (rankingEvidence.matchedProbeCount > 1) {
		reasons.push("multiple_probes_in_thread");
	}
	if ((rankingEvidence.threadDepthScore ?? 0) > 0) {
		reasons.push("substantive_thread_depth");
	}
	const thinTicketStub = Boolean(rankingEvidence.thinTicketStub);
	if (thinTicketStub) reasons.push("thin_thread");
	const multiTicketRoot = Boolean(rankingEvidence.multiTicketRoot);
	if (multiTicketRoot) reasons.push("multi_ticket_root");
	if (fusionScore) reasons.push("rank_fusion");
	reasons.push(routeReason(conversation));
	if (conversation.priority) reasons.push("conversation_priority");
	reasons.push("latest_activity");
	const demoteRootTicket = thinTicketStub || multiTicketRoot;
	const ticketDensity = rankingEvidence.ticketDensity ?? 0;
	const rootAnchoredFocused = Boolean(rankingEvidence.rootAnchoredFocused);
	const substantiveDepth = rankingEvidence.threadDepthScore ?? 0;
	// Low density only hurts multi-topic threads. Root-anchored support chains
	// (ticket only in the announce) are the opposite of off-topic.
	const densityPenalty =
		subject.kind === "ticket" &&
		!demoteRootTicket &&
		!rootAnchoredFocused &&
		(rankingEvidence.threadPostCount ?? 0) >= LOW_TICKET_DENSITY_MIN_POSTS &&
		ticketDensity < LOW_TICKET_DENSITY_THRESHOLD
			? -2
			: 0;
	// Cap density boost by substantive depth so a 2-post announce with
	// density=1 cannot outrank a long discussion thread.
	const ticketProximityBoost =
		subject.kind === "ticket" && !demoteRootTicket
			? Math.min(
					Math.round(ticketDensity * 10),
					Math.max(1, substantiveDepth + 1),
				) +
				(rootAnchoredFocused ? 2 : 0) +
				(rootHasTicket || rankingEvidence.nearestTicketDistance === 0 ? 1 : 0) -
				((rankingEvidence.nearestTicketDistance ?? 0) > 20 ? 1 : 0)
			: 0;
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
			// Thin URL/ticket stubs and multi-ticket bulletin roots keep reply-tier
			// ticket signal so focused discussions outrank list dumps.
			ticketInRoot: rootHasTicket && !demoteRootTicket ? 1 : 0,
			ticketInReply:
				replyHasTicket || (rootHasTicket && demoteRootTicket) ? 1 : 0,
			subjectInRoot: rankingEvidence.subjectInRoot && !demoteRootTicket ? 1 : 0,
			exactPhraseInRoot: demoteRootTicket
				? 0
				: rankingEvidence.exactPhraseInRootCount,
			proximityTier: proximityTier(rankingEvidence.proximityKind),
			proximityWindow: proximityWindowRank(rankingEvidence),
			fullProbeCoverage:
				(rankingEvidence.exactFullyMatchedProbeCount ?? 0) * 2 +
				(rankingEvidence.fullyMatchedProbeCount -
					(rankingEvidence.exactFullyMatchedProbeCount ?? 0)),
			matchedProbeCount: rankingEvidence.matchedProbeCount,
			structuredMatchCount: structuredMatches.length,
			routing: routeWeight(conversation),
			// Negative depth demotes thin stubs / bulletins before fusion/recency.
			// Ticket proximity folds into depth so long low-density threads lose.
			threadDepth: demoteRootTicket
				? multiTicketRoot
					? -2
					: -1
				: (rankingEvidence.threadDepthScore ?? 0) +
					ticketProximityBoost +
					densityPenalty,
			fusion: fusionScore,
			matchedTermCount: rankingEvidence.matchedTermCount,
			exactPhraseInReply:
				rankingEvidence.exactPhraseInReplyCount +
				(demoteRootTicket ? rankingEvidence.exactPhraseInRootCount : 0),
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
	matches: readonly SearchMatch[] = [],
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
		const morphMatchedTerms = probe.terms.filter((term) => {
			if (exactMatchedTerms.includes(term)) return false;
			const [morphTerm] = morphSearchTerms([term]);
			return Boolean(
				morphTerm &&
					thread.some((post) =>
						containsNormalizedExactText(
							normalizeMorphText(post.message),
							morphTerm,
						),
					),
			);
		});
		const matchingExpansions = (probe.expansions ?? []).filter((expansion) =>
			thread.some((post) => matchesQueryExpansion(post.message, expansion)),
		);
		const expandedMatchedTerms = probe.terms.filter(
			(term) =>
				!exactMatchedTerms.includes(term) &&
				!morphMatchedTerms.includes(term) &&
				matchingExpansions.some(({ sourceTerm }) => sourceTerm === term),
		);
		const fallbackMatchedTerms =
			probe.conceptMatches?.length || probe.expansions?.length
				? []
				: probe.terms.filter(
						(term) =>
							!exactMatchedTerms.includes(term) &&
							!morphMatchedTerms.includes(term) &&
							!expandedMatchedTerms.includes(term) &&
							matches.some(
								(match) =>
									match.probe === probe.value &&
									(match.lexicalSource === "prefix_fts" ||
										match.lexicalSource === "trigram") &&
									normalizeSearchText(match.sourceQuery ?? "") === term,
							),
					);
		const matchedTermCount =
			exactMatchedTerms.length +
			morphMatchedTerms.length +
			expandedMatchedTerms.length +
			fallbackMatchedTerms.length;
		return {
			phraseInRoot,
			phraseInReplies,
			matchedTermCount,
			exactMatchedTermCount: exactMatchedTerms.length,
			morphMatchedTermCount: morphMatchedTerms.length,
			expandedMatchedTermCount: expandedMatchedTerms.length,
			fallbackMatchedTermCount: fallbackMatchedTerms.length,
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
	const proximity = evaluateProximityEvidence(thread, rootPostId, probes);
	const relevantPosts = thread.filter((post) =>
		probes.some((probe) => {
			const phrases = probe.phrases.length ? probe.phrases : [probe.value];
			return (
				phrases.some((phrase) => contains(post.message, phrase)) ||
				probe.terms.some((term) => contains(post.message, term)) ||
				(probe.morphTerms ?? []).some((term) =>
					containsNormalizedExactText(normalizeMorphText(post.message), term),
				) ||
				(probe.expansions ?? []).some((expansion) =>
					matchesQueryExpansion(post.message, expansion),
				) ||
				matches.some(
					(match) =>
						match.postId === post.id &&
						match.probe === probe.value &&
						(match.lexicalSource === "prefix_fts" ||
							match.lexicalSource === "trigram"),
				)
			);
		}),
	);
	const exactPhraseInRootCount = probeEvidence.filter(
		({ phraseInRoot }) => phraseInRoot,
	).length;
	const substantivePostCount = boundedSubstantivePostCount(thread);
	const threadDepthScore =
		exactPhraseInRootCount > 0 &&
		substantivePostCount >= MIN_SUBSTANTIVE_THREAD_POSTS
			? substantivePostCount
			: 0;
	const ticketKey = subject.kind === "ticket" ? subject.ticketKey : undefined;
	const thinTicketStub = isThinTicketStub(thread, ticketKey);
	const multiTicketRoot = isMultiTicketRootBulletin(
		thread,
		rootPostId,
		ticketKey,
	);
	const ticketProximity = ticketKey
		? segmentThreadByTicketProximity(thread, {
				subjectTicket: ticketKey,
				matchingPostIds: matches.map(({ postId }) => postId),
			})
		: undefined;
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
		exactPhraseInRootCount,
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
		morphMatchedTermCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.morphMatchedTermCount,
			0,
		),
		expandedMatchedTermCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.expandedMatchedTermCount,
			0,
		),
		fallbackMatchedTermCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.fallbackMatchedTermCount,
			0,
		),
		expansionMatchCount: probeEvidence.reduce(
			(total, evidence) => total + evidence.expansionMatchCount,
			0,
		),
		...proximity,
		totalTermCount: probes.reduce(
			(total, probe) => total + probe.terms.length,
			0,
		),
		matchingPostCount: relevantPosts.length,
		threadPostCount: thread.length,
		substantivePostCount,
		threadDepthScore,
		thinTicketStub,
		multiTicketRoot,
		...(ticketProximity
			? {
					ticketDensity: ticketProximity.ticketDensity,
					nearestTicketDistance: ticketProximity.nearestTicketDistance,
					rootAnchoredFocused: ticketProximity.rootAnchoredFocused,
				}
			: {}),
		latestRelevantMatchAt: relevantPosts.length
			? Math.max(
					...relevantPosts.map((post) =>
						Math.max(post.createAt, post.updateAt, post.deleteAt),
					),
				)
			: null,
	};
}

function boundedSubstantivePostCount(
	thread: readonly Pick<IndexedPost, "message">[],
): number {
	let count = 0;
	for (const { message } of thread) {
		const tokenCount = (message.match(/[\p{L}\p{N}]+/gu) ?? []).length;
		if (tokenCount < MIN_SUBSTANTIVE_POST_TOKENS) continue;
		count += 1;
		if (count === MAX_SUBSTANTIVE_THREAD_DEPTH) break;
	}
	return count;
}

/** Short ticket threads whose residual text is mostly URLs / the ticket key. */
function isThinTicketStub(
	thread: readonly Pick<IndexedPost, "message">[],
	ticketKey?: string,
): boolean {
	if (!ticketKey) return false;
	if (boundedSubstantivePostCount(thread) >= MIN_SUBSTANTIVE_THREAD_POSTS) {
		return false;
	}
	const residualTokens = thread.flatMap(({ message }) => {
		let cleaned = message.replace(/https?:\/\/\S+/gi, " ");
		cleaned = cleaned.replace(new RegExp(escapeRegExp(ticketKey), "gi"), " ");
		return cleaned.match(/[\p{L}\p{N}]+/gu) ?? [];
	});
	return residualTokens.length <= 4;
}

const MULTI_TICKET_ROOT_MIN_KEYS = 3;

/**
 * Manager-style bulletin roots that list many tracker keys where the subject is
 * only one of several and nobody followed up on it in-thread.
 */
function isMultiTicketRootBulletin(
	thread: readonly Pick<IndexedPost, "id" | "message">[],
	rootId?: string,
	ticketKey?: string,
): boolean {
	if (!ticketKey || !rootId) return false;
	const root = thread.find((post) => post.id === rootId) ?? thread[0];
	if (!root) return false;
	const normalizedKey = ticketKey.toUpperCase();
	const rootTickets = extractTicketKeys(root.message);
	if (rootTickets.length < MULTI_TICKET_ROOT_MIN_KEYS) return false;
	if (!rootTickets.includes(normalizedKey)) return false;
	const replies = thread.filter((post) => post.id !== root.id);
	if (replies.some((post) => contains(post.message, ticketKey))) return false;
	return true;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ProximityToken {
	exact: string;
	morph: string;
}

interface TermPositions {
	exact: number[];
	morph: number[];
	matched: number[];
}

interface ProximityTermMatcher {
	exactValues: ReadonlySet<string>;
	morphValues: ReadonlySet<string>;
	expandedExactValues: ReadonlySet<string>;
	expandedMorphValues: ReadonlySet<string>;
	expandedPrefixes: readonly string[];
}

interface PostProbeProximity {
	exactCount: number;
	morphCount: number;
	matchedCount: number;
	exactWindow: number | null;
	morphWindow: number | null;
	matchedWindow: number | null;
	matchedTermIndexes: Set<number>;
}

function evaluateProximityEvidence(
	thread: readonly Pick<IndexedPost, "id" | "message">[],
	rootPostId: string,
	probes: readonly RetrievalProbe[],
): Pick<
	ThreadRankingEvidence,
	| "exactTermsInSamePost"
	| "morphTermsInSamePost"
	| "matchedTermsInSamePost"
	| "minimumTokenWindow"
	| "matchedTermsAcrossThread"
	| "matchedTermsInRoot"
	| "matchedTermsInReplies"
	| "distinctProbeCoverage"
	| "proximityKind"
> {
	let exactTermsInSamePost = 0;
	let morphTermsInSamePost = 0;
	let matchedTermsInSamePost = 0;
	let matchedTermsAcrossThread = 0;
	let matchedTermsInRoot = 0;
	let matchedTermsInReplies = 0;
	let distinctProbeCoverage = 0;
	let minimumTokenWindow: number | null = null;
	let bestKind: ProximityKind | undefined;
	if (probes.length === 1 && (probes[0]?.terms.length ?? 0) < 2) return {};
	const tokenizedPosts = thread.map((post) => ({
		post,
		tokens: proximityTokens(post.message),
	}));

	for (const probe of probes) {
		const terms = probe.terms.slice(0, MAX_PROXIMITY_TERMS_PER_PROBE);
		if (!terms.length) continue;
		const matchers = terms.map((term) => proximityTermMatcher(probe, term));
		const postEvidence = tokenizedPosts.map(({ post, tokens }) => ({
			post,
			evidence: postProbeProximity(tokens, matchers),
		}));
		exactTermsInSamePost += Math.max(
			0,
			...postEvidence.map(({ evidence }) => evidence.exactCount),
		);
		morphTermsInSamePost += Math.max(
			0,
			...postEvidence.map(({ evidence }) => evidence.morphCount),
		);
		matchedTermsInSamePost += Math.max(
			0,
			...postEvidence.map(({ evidence }) => evidence.matchedCount),
		);

		const across = unionTermIndexes(
			postEvidence.map(({ evidence }) => evidence),
		);
		const inRoot = unionTermIndexes(
			postEvidence
				.filter(({ post }) => post.id === rootPostId)
				.map(({ evidence }) => evidence),
		);
		const inReplies = unionTermIndexes(
			postEvidence
				.filter(({ post }) => post.id !== rootPostId)
				.map(({ evidence }) => evidence),
		);
		matchedTermsAcrossThread += across.size;
		matchedTermsInRoot += inRoot.size;
		matchedTermsInReplies += inReplies.size;
		if (across.size) distinctProbeCoverage += 1;

		for (const { evidence } of postEvidence) {
			if (
				evidence.matchedWindow !== null &&
				(minimumTokenWindow === null ||
					evidence.matchedWindow < minimumTokenWindow)
			) {
				minimumTokenWindow = evidence.matchedWindow;
			}
		}
		if (
			terms.length < 2 ||
			probe.terms.length > MAX_PROXIMITY_TERMS_PER_PROBE
		) {
			continue;
		}
		const probeKind = proximityKindForProbe(postEvidence, terms.length, across);
		if (proximityTier(probeKind) > proximityTier(bestKind))
			bestKind = probeKind;
	}

	return {
		exactTermsInSamePost,
		morphTermsInSamePost,
		matchedTermsInSamePost,
		minimumTokenWindow,
		matchedTermsAcrossThread,
		matchedTermsInRoot,
		matchedTermsInReplies,
		distinctProbeCoverage,
		...(bestKind ? { proximityKind: bestKind } : {}),
	};
}

function postProbeProximity(
	tokens: readonly ProximityToken[],
	matchers: readonly ProximityTermMatcher[],
): PostProbeProximity {
	const positions = matchers.map((matcher) => termPositions(tokens, matcher));
	const exactCount = positions.filter(({ exact }) => exact.length).length;
	const morphCount = positions.filter(({ morph }) => morph.length).length;
	const matchedCount = positions.filter(({ matched }) => matched.length).length;
	return {
		exactCount,
		morphCount,
		matchedCount,
		exactWindow:
			exactCount === matchers.length
				? minimumCoveringWindow(positions.map(({ exact }) => exact))
				: null,
		morphWindow:
			morphCount === matchers.length
				? minimumCoveringWindow(positions.map(({ morph }) => morph))
				: null,
		matchedWindow:
			matchedCount === matchers.length
				? minimumCoveringWindow(positions.map(({ matched }) => matched))
				: null,
		matchedTermIndexes: new Set(
			positions.flatMap(({ matched }, index) =>
				matched.length ? [index] : [],
			),
		),
	};
}

function proximityTokens(message: string): ProximityToken[] {
	return (message.match(/[\p{L}\p{N}]+/gu) ?? [])
		.slice(0, MAX_PROXIMITY_TOKENS_PER_POST)
		.map((token) => {
			const analysis = analyzeSearchToken(token);
			return {
				exact: analysis.normalized,
				morph: analysis.stem ?? analysis.normalized,
			};
		});
}

function proximityTermMatcher(
	probe: RetrievalProbe,
	term: string,
): ProximityTermMatcher {
	const expandedExactValues = new Set<string>();
	const expandedMorphValues = new Set<string>();
	const expandedPrefixes: string[] = [];
	for (const expansion of probe.expansions ?? []) {
		if (expansion.sourceTerm !== term) continue;
		const values = normalizeSearchText(expansion.value).match(
			/[\p{L}\p{N}_-]+/gu,
		);
		if (values?.length !== 1 || !values[0]) continue;
		if (expansion.match === "morph") {
			const morph = morphSearchTerms([values[0]])[0];
			if (morph) expandedMorphValues.add(morph);
		} else if (expansion.match === "prefix") {
			expandedPrefixes.push(values[0]);
		} else {
			expandedExactValues.add(values[0]);
		}
	}
	return {
		exactValues: new Set([normalizeSearchText(term)]),
		morphValues: new Set(morphSearchTerms([term])),
		expandedExactValues,
		expandedMorphValues,
		expandedPrefixes,
	};
}

function termPositions(
	tokens: readonly ProximityToken[],
	matcher: ProximityTermMatcher,
): TermPositions {
	const exact: number[] = [];
	const morph: number[] = [];
	const matched: number[] = [];
	for (const [index, token] of tokens.entries()) {
		const exactMatch = matcher.exactValues.has(token.exact);
		const morphMatch = exactMatch || matcher.morphValues.has(token.morph);
		const expandedMatch =
			matcher.expandedExactValues.has(token.exact) ||
			matcher.expandedMorphValues.has(token.morph) ||
			matcher.expandedPrefixes.some((prefix) => token.exact.startsWith(prefix));
		if (exactMatch) exact.push(index);
		if (morphMatch) morph.push(index);
		if (morphMatch || expandedMatch) matched.push(index);
	}
	return { exact, morph, matched };
}

function minimumCoveringWindow(
	positionGroups: readonly number[][],
): number | null {
	if (
		!positionGroups.length ||
		positionGroups.some((positions) => !positions.length)
	) {
		return null;
	}
	const occurrences = positionGroups
		.flatMap((positions, termIndex) =>
			positions.map((position) => ({ position, termIndex })),
		)
		.sort((left, right) => left.position - right.position);
	const counts = new Map<number, number>();
	let covered = 0;
	let left = 0;
	let minimum = Number.POSITIVE_INFINITY;
	for (let right = 0; right < occurrences.length; right += 1) {
		const rightOccurrence = occurrences[right];
		if (!rightOccurrence) continue;
		const count = counts.get(rightOccurrence.termIndex) ?? 0;
		if (!count) covered += 1;
		counts.set(rightOccurrence.termIndex, count + 1);
		while (covered === positionGroups.length && left <= right) {
			const leftOccurrence = occurrences[left];
			if (!leftOccurrence) break;
			minimum = Math.min(
				minimum,
				rightOccurrence.position - leftOccurrence.position + 1,
			);
			const leftCount = counts.get(leftOccurrence.termIndex) ?? 0;
			if (leftCount <= 1) {
				counts.delete(leftOccurrence.termIndex);
				covered -= 1;
			} else {
				counts.set(leftOccurrence.termIndex, leftCount - 1);
			}
			left += 1;
		}
	}
	return Number.isFinite(minimum) ? minimum : null;
}

function unionTermIndexes(
	evidence: readonly PostProbeProximity[],
): Set<number> {
	return new Set(
		evidence.flatMap(({ matchedTermIndexes }) => [...matchedTermIndexes]),
	);
}

function proximityKindForProbe(
	postEvidence: readonly { evidence: PostProbeProximity }[],
	termCount: number,
	across: ReadonlySet<number>,
): ProximityKind | undefined {
	if (
		postEvidence.some(
			({ evidence }) =>
				evidence.exactCount === termCount &&
				evidence.exactWindow !== null &&
				evidence.exactWindow <= NEAR_TOKEN_WINDOW,
		)
	) {
		return "exact_terms_near";
	}
	if (
		postEvidence.some(
			({ evidence }) =>
				evidence.morphCount === termCount &&
				evidence.morphWindow !== null &&
				evidence.morphWindow <= NEAR_TOKEN_WINDOW,
		)
	) {
		return "morph_terms_near";
	}
	if (postEvidence.some(({ evidence }) => evidence.exactCount === termCount)) {
		return "exact_terms_same_post";
	}
	if (postEvidence.some(({ evidence }) => evidence.morphCount === termCount)) {
		return "morph_terms_same_post";
	}
	if (
		postEvidence.some(({ evidence }) => evidence.matchedCount === termCount)
	) {
		return "expanded_terms_same_post";
	}
	if (across.size === termCount) return "terms_across_thread";
	return undefined;
}

function proximityTier(kind: ProximityKind | undefined): number {
	switch (kind) {
		case "exact_terms_near":
			return 6;
		case "morph_terms_near":
			return 5;
		case "exact_terms_same_post":
			return 4;
		case "morph_terms_same_post":
			return 3;
		case "expanded_terms_same_post":
		case "terms_across_thread":
			return 1;
		default:
			return 0;
	}
}

function proximityWindowRank(evidence: ThreadRankingEvidence): number {
	if (
		!evidence.minimumTokenWindow ||
		!evidence.proximityKind ||
		![
			"exact_terms_near",
			"morph_terms_near",
			"exact_terms_same_post",
			"morph_terms_same_post",
		].includes(evidence.proximityKind)
	) {
		return 0;
	}
	return MAX_PROXIMITY_TOKENS_PER_POST + 1 - evidence.minimumTokenWindow;
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
		exact_phrase: 7,
		strict_fts: 6,
		term_fts: 5,
		broad_fts: 4,
		morph_fts: 3,
		concept_fts: 2,
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
