import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	loadRetrievalBenchmarkFixture,
	normalizedDiscountedCumulativeGain,
	retrievalBenchmarkFixtureSchema,
	runRetrievalBenchmark,
} from "./benchmark.ts";

const fixturePath = join(import.meta.dir, "../benchmarks/retrieval.v1.json");

const requiredQueryClasses = [
	"exact_ticket_id",
	"exact_phrase",
	"distributed_terms",
	"repository_file_symbol",
	"russian_inflection",
	"russian_english_terminology",
	"configured_russian_english_synonym",
	"misspelling_incomplete_identifier",
	"vague_paraphrase",
	"old_relevant_vs_recent_irrelevant",
	"unrelated_subtopics",
	"independent_repeated_queries",
	"multi_probe_thread_depth",
	"root_phrase_vs_incidental_reply",
	"russian_inflected_multi_probe_depth",
	"russian_inflection_prefix_suppression",
	"old_investigation_vs_recent_shallow_exact",
];

describe("retrieval benchmark", () => {
	test("loads a versioned fixture covering required and graded query classes", async () => {
		const fixture = await loadRetrievalBenchmarkFixture(fixturePath);
		expect(fixture.schemaVersion).toBe(1);
		expect(new Set(fixture.cases.map(({ queryClass }) => queryClass))).toEqual(
			new Set(requiredQueryClasses),
		);
		expect(
			fixture.cases.every(({ expectedThreads, notes }) =>
				Boolean(expectedThreads.length && notes),
			),
		).toBe(true);
	});

	test("models new weaknesses as graded Russian conversations with depth", async () => {
		const fixture = await loadRetrievalBenchmarkFixture(fixturePath);
		for (const [caseId, deepThreadId] of [
			[
				"russian-prefix-suppressed-by-weak-exact",
				"thread-notification-morphology-deep",
			],
			[
				"old-deep-investigation-vs-shallow-exact",
				"thread-duplicate-key-investigation",
			],
		] as const) {
			const benchmarkCase = fixture.cases.find(({ id }) => id === caseId);
			expect(
				benchmarkCase?.expectedThreads.find(({ grade }) => grade === 3),
			).toEqual(expect.objectContaining({ threadId: deepThreadId }));
			expect(
				benchmarkCase?.expectedThreads.filter(({ grade }) => grade === 1)
					.length,
			).toBeGreaterThanOrEqual(2);
			const threadPosts = fixture.posts.filter(
				({ id, rootId }) => id === deepThreadId || rootId === deepThreadId,
			);
			expect(threadPosts.length).toBeGreaterThanOrEqual(4);
			expect(
				threadPosts.every(({ message }) => /[А-Яа-яЁё]/.test(message)),
			).toBe(true);
		}
	});

	test("reports bounded ranking, hydration, budget, and stability metrics", async () => {
		const fixture = await loadRetrievalBenchmarkFixture(fixturePath);
		const report = await runRetrievalBenchmark(fixture, { runs: 2 });
		expect(report).toMatchObject({
			schemaVersion: 1,
			fixture: fixture.name,
			runs: 2,
			summary: { caseCount: fixture.cases.length, stable: true },
		});
		for (const result of report.cases) {
			for (const metric of [
				result.recallAt5,
				result.recallAt10,
				result.reciprocalRank,
				result.ndcgAt5,
				result.ndcgAt10,
			]) {
				expect(metric).toBeGreaterThanOrEqual(0);
				expect(metric).toBeLessThanOrEqual(1);
			}
			expect(result.irrelevantThreadsHydrated).toBeGreaterThanOrEqual(0);
			expect(result.contextBudgetBeforeFirstRelevant).toBeGreaterThanOrEqual(0);
			expect(result.stable).toBe(true);
		}
		expect(report.cases.find(({ id }) => id === "exact-ticket")).toMatchObject({
			rankedThreadIds: ["thread-ticket"],
			recallAt5: 1,
			reciprocalRank: 1,
		});
		expect(report.summary.meanRecallAt5).toBeGreaterThanOrEqual(0.95);
		expect(report.summary.meanRecallAt10).toBe(1);
		expect(report.summary.meanReciprocalRank).toBe(1);
		expect(report.summary.meanNdcgAt5).toBeGreaterThanOrEqual(0.94);
		expect(report.summary.irrelevantThreadsHydrated).toBeLessThanOrEqual(1);
	});

	test("uses relevance grades to reward stronger threads near the top", () => {
		const grades = new Map([
			["deep-thread", 3],
			["incidental-thread", 1],
		]);
		expect(
			normalizedDiscountedCumulativeGain(
				["deep-thread", "incidental-thread"],
				grades,
				5,
			),
		).toBe(1);
		expect(
			normalizedDiscountedCumulativeGain(
				["incidental-thread", "deep-thread"],
				grades,
				5,
			),
		).toBeLessThan(1);
	});

	test("rejects broken fixture references", async () => {
		const fixture = await loadRetrievalBenchmarkFixture(fixturePath);
		const broken = structuredClone(fixture);
		broken.cases[0]?.expectedThreads.push({ threadId: "missing-thread" });
		const result = retrievalBenchmarkFixtureSchema.safeParse(broken);
		expect(result.success).toBe(false);
		expect(
			result.error?.issues.some(({ message }) =>
				message.includes("expects an unknown thread"),
			),
		).toBe(true);
	});
});
