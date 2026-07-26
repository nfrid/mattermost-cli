#!/usr/bin/env bun
import {
	formatQuestionCorpusReport,
	loadQuestionCorpus,
	runQuestionCorpus,
} from "./question-corpus.ts";

const fixturePath = process.argv[2] ?? "benchmarks/questions.v1.json";
const json = process.argv.includes("--json");
if (
	process.argv
		.slice(2)
		.some((value) => value !== fixturePath && value !== "--json")
) {
	throw new Error(
		"The question corpus accepts only a fixture path and --json.",
	);
}

const report = runQuestionCorpus(await loadQuestionCorpus(fixturePath));
process.stdout.write(
	json
		? `${JSON.stringify(report, null, 2)}\n`
		: formatQuestionCorpusReport(report),
);
