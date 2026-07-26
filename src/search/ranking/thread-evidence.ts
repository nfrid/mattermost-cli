/**
 * Whether a thread's content actually supports the subject: substantive depth,
 * thin ticket stubs, multi-ticket bulletin roots, and ticket density.
 */
import { segmentThreadByTicketProximity } from "../../evidence/ticket-segments.ts";
import type { IndexedPost } from "../../store/index.ts";
import {
	containsNormalizedExactText,
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
	morphSearchTerms,
	normalizeMorphText,
	normalizeSearchText,
} from "../../text/index.ts";
import { matchesQueryExpansion } from "../query-expansion.ts";
import type {
	MattermostSubject,
	RetrievalProbe,
	SearchMatch,
	ThreadRankingEvidence,
} from "../types.ts";
import { escapeRegExp, evaluateProximityEvidence } from "./proximity.ts";

export const MIN_SUBSTANTIVE_POST_TOKENS = 6;

export const MIN_SUBSTANTIVE_THREAD_POSTS = 3;

export const MAX_SUBSTANTIVE_THREAD_DEPTH = 5;

export const LOW_TICKET_DENSITY_THRESHOLD = 0.15;

export const LOW_TICKET_DENSITY_MIN_POSTS = 20;

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
					exclusiveSubjectKey: ticketProximity.exclusiveSubjectKey,
					otherTicketDominated: ticketProximity.otherTicketDominated,
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

export function boundedSubstantivePostCount(
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
export function isThinTicketStub(
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
export function isMultiTicketRootBulletin(
	thread: readonly Pick<IndexedPost, "id" | "message">[],
	rootId?: string,
	ticketKey?: string,
): boolean {
	if (!ticketKey || !rootId) return false;
	const root = thread.find((post) => post.id === rootId) ?? thread[0];
	if (!root) return false;
	const normalizedKey = ticketKey.toUpperCase();
	const rootTickets = extractTicketKeys(root.message);
	if (rootTickets.length < MULTI_TICKET_BULLETIN_MIN_KEYS) return false;
	if (!rootTickets.includes(normalizedKey)) return false;
	const replies = thread.filter((post) => post.id !== root.id);
	if (
		replies.some((post) => containsNormalizedExactText(post.message, ticketKey))
	)
		return false;
	return true;
}
