import { deadlineReached } from "../shared/limits.ts";
import type {
	IndexedPost,
	LexicalRetrievalSource,
	MattermostStore,
	StructuredEntityHit,
	ThreadSearchFilters,
	TicketThreadRelationship,
} from "../store/index.ts";
import { trigramSearchPolicy } from "../store/index.ts";
import { compareCandidates, createCandidateGroup } from "./candidates.ts";
import {
	isStrongerFusionContribution,
	weightedReciprocalRankFusionScore,
} from "./fusion.ts";
import { excerpt } from "./match-utils.ts";
import { matchesQueryExpansion } from "./query-expansion.ts";
import { candidateFromGroup } from "./ranking.ts";
import { conceptToken } from "./search-concepts.ts";
import {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeMorphText,
} from "./search-token-normalization.ts";
import { containsNormalizedExactText, normalizeSearchText } from "./text.ts";
import type {
	CandidateGroup,
	MattermostSubject,
	RankFusionContribution,
	RankFusionSource,
	RetrievalProbe,
	RoutedConversation,
	RoutingResult,
	SearchMatch,
	SearchResult,
	StructuredSearchMatch,
	ThreadCandidate,
	TypoFallbackKind,
} from "./types.ts";
import { RETRIEVAL_SOURCE_WEIGHTS } from "./types.ts";

const MAX_CANDIDATES_PER_SOURCE = 100;
const MAX_FUZZY_REQUESTS_PER_PROBE = 8;
const MAX_MORPH_TERMS_PER_PROBE = 8;
const MAX_TERMS_PER_PROBE = 8;
const MIN_PREFIX_LENGTH = 4;

interface SearchThreadsOptions {
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
		if (
			thread.some((post) =>
				containsNormalizedExactText(post.message, ticketKey),
			)
		)
			return true;
	}
	return false;
}

function isUnrepliedAutomationThread(
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

function isAutomationAuthor(
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
