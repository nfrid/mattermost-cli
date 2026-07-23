#!/usr/bin/env bun
import {
	loadRetrievalBenchmarkFixture,
	runRetrievalBenchmark,
} from "./benchmark.ts";

const fixturePath = process.argv[2] ?? "benchmarks/retrieval.v1.json";
const runsArgument = process.argv[3];
if (process.argv[4] !== undefined) {
	throw new Error(
		"The benchmark accepts only a fixture path and repeat count.",
	);
}
const fixture = await loadRetrievalBenchmarkFixture(fixturePath);
const report = await runRetrievalBenchmark(fixture, {
	runs: runsArgument === undefined ? undefined : Number(runsArgument),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
