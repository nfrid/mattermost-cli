import { describe, expect, test } from "bun:test";
import type { RetrievalBenchmarkReport } from "./benchmark.ts";
import { compareRetrievalBenchmarkReports } from "./benchmark-comparison.ts";

function report(ranking: string[], ndcgAt5: number): RetrievalBenchmarkReport {
	return {
		schemaVersion: 1,
		fixture: "fixture",
		runs: 1,
		cases: [
			{
				id: "case",
				queryClass: "exact_phrase",
				query: "query",
				expectedThreadIds: ["relevant"],
				rankedThreadIds: ranking,
				rankingReasons: Object.fromEntries(
					ranking.map((id) => [id, ["rank_fusion"]]),
				),
				recallAt5: 1,
				recallAt10: 1,
				reciprocalRank: 1,
				ndcgAt5,
				ndcgAt10: ndcgAt5,
				irrelevantThreadsInTop5: 1,
				irrelevantThreadsHydrated: 0,
				contextBudgetBeforeFirstRelevant: 0,
				meanQueryDurationMs: 2,
				retrievalRequestsPerProbe: 3,
				stable: true,
			},
		],
		summary: {
			caseCount: 1,
			meanRecallAt5: 1,
			meanRecallAt10: 1,
			meanReciprocalRank: 1,
			meanNdcgAt5: ndcgAt5,
			meanNdcgAt10: ndcgAt5,
			irrelevantThreadsInTop5: 1,
			irrelevantThreadsHydrated: 0,
			meanContextBudgetBeforeFirstRelevant: 0,
			meanQueryDurationMs: 2,
			meanRetrievalRequestsPerProbe: 3,
			indexSizeBytes: 4096,
			stable: true,
		},
	};
}

describe("retrieval benchmark comparison", () => {
	test("reports per-query ranking changes and aggregate deltas", () => {
		const comparison = compareRetrievalBenchmarkReports(
			report(["relevant", "removed"], 0.8),
			report(["relevant", "added"], 1),
		);
		expect(comparison.summaryDelta.meanNdcgAt5).toBe(0.2);
		expect(comparison.cases[0]).toMatchObject({
			query: "query",
			addedCandidates: ["added"],
			removedCandidates: ["removed"],
			baselineRanking: ["relevant", "removed"],
			candidateRanking: ["relevant", "added"],
		});
	});

	test("rejects incompatible fixtures", () => {
		const candidate = report(["relevant"], 1);
		candidate.fixture = "other";
		expect(() =>
			compareRetrievalBenchmarkReports(report(["relevant"], 1), candidate),
		).toThrow("different fixtures");
	});
});
