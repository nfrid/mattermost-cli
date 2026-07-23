import { segmentThreadByTicketProximity } from "../evidence/ticket-segments.ts";
import type {
	IndexedPost,
	LexicalRetrievalSource,
	MattermostStore,
	TicketThreadRelationship,
} from "../store/index.ts";
import { scoreVector } from "./candidates.ts";
import { extractTicketKeys } from "./extract.ts";
import { deduplicateMatches, excerpt } from "./match-utils.ts";
import { matchesQueryExpansion } from "./query-expansion.ts";
import { routeReason, routeWeight } from "./routing.ts";
import {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeMorphText,
} from "./search-token-normalization.ts";
import { containsNormalizedExactText, normalizeSearchText } from "./text.ts";
import type {
	CandidateGroup,
	MattermostSubject,
	ProximityKind,
	RankFusionContribution,
	RankingReason,
	RetrievalProbe,
	RoutedConversation,
	SearchMatch,
	StructuredSearchMatch,
	ThreadCandidate,
	ThreadRankingEvidence,
} from "./types.ts";

const MAX_PROXIMITY_TERMS_PER_PROBE = 8;
const MAX_PROXIMITY_TOKENS_PER_POST = 512;
const MIN_SUBSTANTIVE_POST_TOKENS = 6;
const MIN_SUBSTANTIVE_THREAD_POSTS = 3;
const MAX_SUBSTANTIVE_THREAD_DEPTH = 5;
const NEAR_TOKEN_WINDOW = 8;
const LOW_TICKET_DENSITY_THRESHOLD = 0.15;
const LOW_TICKET_DENSITY_MIN_POSTS = 20;
const MULTI_TICKET_ROOT_MIN_KEYS = 3;

export function candidateFromGroup(
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
	const rootHasTicket = Boolean(
		ticketKey && containsNormalizedExactText(root.message, ticketKey),
	);
	const replyHasTicket = Boolean(
		ticketKey &&
			thread.some(
				(post) =>
					post.id !== root.id &&
					containsNormalizedExactText(post.message, ticketKey),
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
			root &&
				phrases.some((phrase) =>
					containsNormalizedExactText(root.message, phrase),
				),
		);
		const phraseInReplies = phrases.some((phrase) =>
			replies.some((post) => containsNormalizedExactText(post.message, phrase)),
		);
		const exactMatchedTerms = probe.terms.filter((term) =>
			thread.some((post) => containsNormalizedExactText(post.message, term)),
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
				phrases.some((phrase) =>
					containsNormalizedExactText(post.message, phrase),
				) ||
				probe.terms.some((term) =>
					containsNormalizedExactText(post.message, term),
				) ||
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
			root &&
				subjectPhrases.some((phrase) =>
					containsNormalizedExactText(root.message, phrase),
				),
		),
		subjectInReplies: subjectPhrases.some((phrase) =>
			replies.some((post) => containsNormalizedExactText(post.message, phrase)),
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
	if (
		replies.some((post) => containsNormalizedExactText(post.message, ticketKey))
	)
		return false;
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
