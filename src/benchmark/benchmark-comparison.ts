import type {
	RetrievalBenchmarkCaseResult,
	RetrievalBenchmarkReport,
} from "./benchmark.ts";

export interface RetrievalBenchmarkCaseDiff {
	id: string;
	query: string;
	expectedThreadIds: string[];
	baselineRanking: string[];
	candidateRanking: string[];
	addedCandidates: string[];
	removedCandidates: string[];
	baselineRankingReasons: Record<string, string[]>;
	candidateRankingReasons: Record<string, string[]>;
	delta: {
		recallAt5: number;
		recallAt10: number;
		reciprocalRank: number;
		ndcgAt5: number;
		ndcgAt10: number;
		irrelevantThreadsInTop5: number;
		meanQueryDurationMs: number;
	};
}

export interface RetrievalBenchmarkComparison {
	schemaVersion: 1;
	fixture: string;
	baselineRuns: number;
	candidateRuns: number;
	cases: RetrievalBenchmarkCaseDiff[];
	summaryDelta: {
		meanRecallAt5: number;
		meanRecallAt10: number;
		meanReciprocalRank: number;
		meanNdcgAt5: number;
		meanNdcgAt10: number;
		irrelevantThreadsInTop5: number;
		meanQueryDurationMs: number;
		indexSizeBytes: number;
	};
}

export function compareRetrievalBenchmarkReports(
	baseline: RetrievalBenchmarkReport,
	candidate: RetrievalBenchmarkReport,
): RetrievalBenchmarkComparison {
	if (baseline.fixture !== candidate.fixture) {
		throw new Error(
			`Cannot compare different fixtures: ${baseline.fixture} and ${candidate.fixture}.`,
		);
	}
	const candidateCases = new Map(
		candidate.cases.map((item) => [item.id, item]),
	);
	if (
		baseline.cases.length !== candidate.cases.length ||
		baseline.cases.some(({ id }) => !candidateCases.has(id))
	) {
		throw new Error("Cannot compare reports with different benchmark cases.");
	}
	return {
		schemaVersion: 1,
		fixture: baseline.fixture,
		baselineRuns: baseline.runs,
		candidateRuns: candidate.runs,
		cases: baseline.cases.map((baselineCase) => {
			const candidateCase = candidateCases.get(baselineCase.id);
			if (!candidateCase) {
				throw new Error(
					`Missing candidate benchmark case: ${baselineCase.id}.`,
				);
			}
			return compareCase(baselineCase, candidateCase);
		}),
		summaryDelta: {
			meanRecallAt5: delta(
				baseline.summary.meanRecallAt5,
				candidate.summary.meanRecallAt5,
			),
			meanRecallAt10: delta(
				baseline.summary.meanRecallAt10,
				candidate.summary.meanRecallAt10,
			),
			meanReciprocalRank: delta(
				baseline.summary.meanReciprocalRank,
				candidate.summary.meanReciprocalRank,
			),
			meanNdcgAt5: delta(
				baseline.summary.meanNdcgAt5,
				candidate.summary.meanNdcgAt5,
			),
			meanNdcgAt10: delta(
				baseline.summary.meanNdcgAt10,
				candidate.summary.meanNdcgAt10,
			),
			irrelevantThreadsInTop5:
				candidate.summary.irrelevantThreadsInTop5 -
				baseline.summary.irrelevantThreadsInTop5,
			meanQueryDurationMs: delta(
				baseline.summary.meanQueryDurationMs,
				candidate.summary.meanQueryDurationMs,
			),
			indexSizeBytes:
				candidate.summary.indexSizeBytes - baseline.summary.indexSizeBytes,
		},
	};
}

function compareCase(
	baseline: RetrievalBenchmarkCaseResult,
	candidate: RetrievalBenchmarkCaseResult,
): RetrievalBenchmarkCaseDiff {
	const baselineIds = new Set(baseline.rankedThreadIds);
	const candidateIds = new Set(candidate.rankedThreadIds);
	return {
		id: baseline.id,
		query: candidate.query,
		expectedThreadIds: candidate.expectedThreadIds,
		baselineRanking: baseline.rankedThreadIds,
		candidateRanking: candidate.rankedThreadIds,
		addedCandidates: candidate.rankedThreadIds.filter(
			(threadId) => !baselineIds.has(threadId),
		),
		removedCandidates: baseline.rankedThreadIds.filter(
			(threadId) => !candidateIds.has(threadId),
		),
		baselineRankingReasons: baseline.rankingReasons,
		candidateRankingReasons: candidate.rankingReasons,
		delta: {
			recallAt5: delta(baseline.recallAt5, candidate.recallAt5),
			recallAt10: delta(baseline.recallAt10, candidate.recallAt10),
			reciprocalRank: delta(baseline.reciprocalRank, candidate.reciprocalRank),
			ndcgAt5: delta(baseline.ndcgAt5, candidate.ndcgAt5),
			ndcgAt10: delta(baseline.ndcgAt10, candidate.ndcgAt10),
			irrelevantThreadsInTop5:
				candidate.irrelevantThreadsInTop5 - baseline.irrelevantThreadsInTop5,
			meanQueryDurationMs: delta(
				baseline.meanQueryDurationMs,
				candidate.meanQueryDurationMs,
			),
		},
	};
}

function delta(baseline: number, candidate: number): number {
	return Math.round((candidate - baseline) * 1_000_000) / 1_000_000;
}
