import { describe, expect, test } from "bun:test";
import {
	formatQuestionCorpusReport,
	loadQuestionCorpus,
	runQuestionCorpus,
} from "./question-corpus.ts";

const FIXTURE = "benchmarks/questions.v1.json";

describe("open-question corpus", () => {
	test("the shipped fixture loads and every expectation names a real post", async () => {
		const fixture = await loadQuestionCorpus(FIXTURE);
		expect(fixture.cases.length).toBeGreaterThanOrEqual(30);
		for (const entry of fixture.cases) {
			const ids = new Set(entry.posts.map((post) => post.id));
			for (const expected of entry.expectedOpenQuestions) {
				expect(ids.has(expected)).toBe(true);
			}
			// A case expecting questions must expect the hint, and vice versa: the
			// two are the same judgement seen at different granularity.
			expect(entry.expectPurposeHint).toBe(
				entry.expectedOpenQuestions.length > 0,
			);
		}
	});

	test("the fixture keeps both labels represented", async () => {
		const fixture = await loadQuestionCorpus(FIXTURE);
		const positives = fixture.cases.filter(
			(entry) => entry.expectedOpenQuestions.length > 0,
		).length;
		expect(positives).toBeGreaterThanOrEqual(10);
		expect(fixture.cases.length - positives).toBeGreaterThanOrEqual(10);
	});

	test("rejects an expectation naming an unknown post", async () => {
		expect(
			loadQuestionCorpus("src/benchmark/question-corpus.invalid.fixture.json"),
		).rejects.toThrow(/unknown post id/);
	});

	test("scores the shipped fixture and reports failures readably", async () => {
		const report = runQuestionCorpus(await loadQuestionCorpus(FIXTURE));
		expect(report.casesTotal).toBe(report.cases.length);
		expect(report.questions.truePositives).toBeGreaterThan(0);
		const text = formatQuestionCorpusReport(report);
		expect(text).toContain("open questions:");
		expect(text).toContain("purpose hint:");
	});

	test("recall stays perfect: the gate may cost precision, never a real question", async () => {
		const report = runQuestionCorpus(await loadQuestionCorpus(FIXTURE));
		expect(report.questions.recall).toBe(1);
	});
});
