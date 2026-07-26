import type { IndexedPost } from "../../store/index.ts";
import {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeSearchText,
} from "../../text/index.ts";
import type {
	ProximityKind,
	RetrievalProbe,
	ThreadRankingEvidence,
} from "../types.ts";

export const MAX_PROXIMITY_TERMS_PER_PROBE = 8;

export const MAX_PROXIMITY_TOKENS_PER_POST = 512;

export const NEAR_TOKEN_WINDOW = 8;

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ProximityToken {
	exact: string;
	morph: string;
}

export interface TermPositions {
	exact: number[];
	morph: number[];
	matched: number[];
}

export interface ProximityTermMatcher {
	exactValues: ReadonlySet<string>;
	morphValues: ReadonlySet<string>;
	expandedExactValues: ReadonlySet<string>;
	expandedMorphValues: ReadonlySet<string>;
	expandedPrefixes: readonly string[];
}

export interface PostProbeProximity {
	exactCount: number;
	morphCount: number;
	matchedCount: number;
	exactWindow: number | null;
	morphWindow: number | null;
	matchedWindow: number | null;
	matchedTermIndexes: Set<number>;
}

export function evaluateProximityEvidence(
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

export function postProbeProximity(
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

export function proximityTokens(message: string): ProximityToken[] {
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

export function proximityTermMatcher(
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

export function termPositions(
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

export function minimumCoveringWindow(
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

export function unionTermIndexes(
	evidence: readonly PostProbeProximity[],
): Set<number> {
	return new Set(
		evidence.flatMap(({ matchedTermIndexes }) => [...matchedTermIndexes]),
	);
}

export function proximityKindForProbe(
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

export function proximityTier(kind: ProximityKind | undefined): number {
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

export function proximityWindowRank(evidence: ThreadRankingEvidence): number {
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
