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
	"russian_verb_forms",
	"russian_participles",
	"russian_irregular_forms",
	"russian_technical_anglicisms",
	"russian_adjective_agreement",
	"wrong_keyboard_layout",
	"russian_word_typo",
	"russian_prefix_negative",
	"russian_perfective_participle",
	"domain_concept_paraphrase",
	"domain_concept_retry",
	"wrong_keyboard_layout_phrase",
	"latin_transliteration_phrase",
	"mixed_script_confusable",
	"short_russian_word_typo",
	"same_post_token_proximity",
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

	test("defines reviewed relevance and future lexical challenges", async () => {
		const fixture = await loadRetrievalBenchmarkFixture(fixturePath);
		const notificationCase = fixture.cases.find(
			({ id }) => id === "russian-prefix-suppressed-by-weak-exact",
		);
		expect(notificationCase?.expectedThreads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					threadId: "thread-russian-agreement",
					grade: 2,
				}),
				expect.objectContaining({
					threadId: "thread-russian-typo",
					grade: 2,
				}),
			]),
		);
		for (const caseId of [
			"concept-duplicate-charge",
			"concept-retry-action",
			"full-wrong-keyboard-layout",
			"latin-transliteration-phrase",
			"mixed-script-confusable",
			"short-russian-typo",
			"proximity-same-post-window",
		]) {
			const benchmarkCase = fixture.cases.find(({ id }) => id === caseId);
			expect(benchmarkCase?.expectedThreads.length).toBeGreaterThan(0);
			expect(benchmarkCase?.notes.length).toBeGreaterThan(40);
		}
		const proximityPosts = fixture.posts.filter(
			({ id, rootId }) =>
				id === "thread-proximity-investigation" ||
				rootId === "thread-proximity-investigation",
		);
		expect(proximityPosts).toHaveLength(4);
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
			expect(result.query).not.toBeEmpty();
			expect(result.expectedThreadIds).not.toBeEmpty();
			expect(result.irrelevantThreadsInTop5).toBeGreaterThanOrEqual(0);
			expect(result.irrelevantThreadsHydrated).toBeGreaterThanOrEqual(0);
			expect(result.contextBudgetBeforeFirstRelevant).toBeGreaterThanOrEqual(0);
			expect(result.meanQueryDurationMs).toBeGreaterThanOrEqual(0);
			expect(result.retrievalRequestsPerProbe).toBeGreaterThan(0);
			expect(result.stable).toBe(true);
		}
		expect(report.cases.find(({ id }) => id === "exact-ticket")).toMatchObject({
			rankedThreadIds: ["thread-ticket"],
			recallAt5: 1,
			reciprocalRank: 1,
		});
		expect(report.summary.meanRecallAt5).toBeGreaterThanOrEqual(0.8);
		expect(report.summary.meanRecallAt10).toBeGreaterThanOrEqual(0.85);
		expect(report.summary.meanReciprocalRank).toBeGreaterThanOrEqual(0.8);
		expect(report.summary.meanNdcgAt5).toBeGreaterThanOrEqual(0.8);
		expect(report.summary.indexSizeBytes).toBeGreaterThan(0);
		expect(report.summary.meanQueryDurationMs).toBeGreaterThanOrEqual(0);
		expect(report.summary.meanRetrievalRequestsPerProbe).toBeGreaterThan(0);
		const deepInvestigation = report.cases.find(
			({ id }) => id === "old-deep-investigation-vs-shallow-exact",
		);
		expect(deepInvestigation?.rankedThreadIds[0]).toBe(
			"thread-duplicate-key-investigation",
		);
		expect(
			deepInvestigation?.rankingReasons["thread-duplicate-key-investigation"],
		).toContain("substantive_thread_depth");
		expect(
			report.cases.find(({ id }) => id === "russian-perfective-participle")
				?.rankingReasons["thread-russian-perfective-participle"],
		).toContain("morphology_match");
		for (const [caseId, threadId] of [
			["concept-duplicate-charge", "thread-russian-payment-deep"],
			["concept-retry-action", "thread-callback-deep"],
		] as const) {
			const result = report.cases.find(({ id }) => id === caseId);
			expect(result?.reciprocalRank).toBe(1);
			expect(result?.rankingReasons[threadId]).toContain("concept_match");
		}
		for (const [caseId, threadId, reason] of [
			["full-wrong-keyboard-layout", "thread-russian", "keyboard_layout_match"],
			[
				"latin-transliteration-phrase",
				"thread-mixed-language",
				"transliteration_match",
			],
			["mixed-script-confusable", "thread-probes", "mixed_script_match"],
		] as const) {
			const result = report.cases.find(({ id }) => id === caseId);
			expect(result?.reciprocalRank).toBe(1);
			expect(result?.rankingReasons[threadId]).toContain(reason);
		}
		const proximity = report.cases.find(
			({ id }) => id === "proximity-same-post-window",
		);
		expect(proximity).toMatchObject({
			rankedThreadIds: [
				"thread-proximity-investigation",
				"thread-proximity-glossary",
			],
			ndcgAt5: 1,
		});
		expect(
			proximity?.rankingReasons["thread-proximity-investigation"],
		).toContain("exact_terms_near");
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
