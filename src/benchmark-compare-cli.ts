#!/usr/bin/env bun
import type { RetrievalBenchmarkReport } from "./benchmark.ts";
import { compareRetrievalBenchmarkReports } from "./benchmark-comparison.ts";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
	throw new Error(
		"Usage: bun run src/benchmark-compare-cli.ts <baseline.json> <candidate.json>",
	);
}
const [baseline, candidate] = await Promise.all([
	Bun.file(baselinePath).json() as Promise<RetrievalBenchmarkReport>,
	Bun.file(candidatePath).json() as Promise<RetrievalBenchmarkReport>,
]);
process.stdout.write(
	`${JSON.stringify(compareRetrievalBenchmarkReports(baseline, candidate), null, 2)}\n`,
);
