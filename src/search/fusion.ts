import {
	type RankFusionContribution,
	type RankFusionSource,
	RETRIEVAL_SOURCE_WEIGHTS,
	RRF_RANK_CONSTANT,
} from "./types.ts";

export { RETRIEVAL_SOURCE_WEIGHTS, RRF_RANK_CONSTANT } from "./types.ts";

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

export function isStrongerFusionContribution(
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
