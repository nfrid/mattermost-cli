#!/usr/bin/env bun
/**
 * Packet-level regression harness.
 *
 * Runs `context` for a set of subjects against two checkouts and compares the
 * emitted packets byte for byte. The unit test suite pins behavior it knows
 * about; this pins the actual product — the JSON a caller receives — against
 * the real local index, which is what a refactor must not move.
 *
 * Read-only and offline: every run passes `--local`, so nothing contacts
 * Mattermost and nothing is written to the index.
 *
 *   bun run scripts/packet-diff.ts --baseline <git-ref> TECHSUPP-109 BTB-2113
 *
 * With no `--baseline`, writes the current packets to the snapshot directory
 * so a later run can compare against them.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Projections worth pinning: each exposes a different slice of the packet. */
const MODES: readonly (readonly string[])[] = [
	["--agent"],
	["--json"],
	["--agent", "--signals"],
	["--json", "--full-posts"],
	["--agent", "--brief"],
	["--agent", "--navigate"],
];

const PROJECT_ROOT = resolve(import.meta.dir, "..");

/**
 * Wall-clock fields. They move between any two runs and say nothing about
 * behavior, so they are masked rather than compared.
 */
function normalize(packet: string): string {
	return packet
		.replace(/"observedAt":\d+/g, '"observedAt":<t>')
		.replace(/"ageSeconds":[\d.]+/g, '"ageSeconds":<age>');
}

function capture(
	binDir: string,
	outDir: string,
	subjects: readonly string[],
): void {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	for (const subject of subjects) {
		for (const mode of MODES) {
			const result = spawnSync(
				"bun",
				[
					"run",
					join(binDir, "src/cli/bin.ts"),
					"context",
					subject,
					"--local",
					...mode,
				],
				{ cwd: binDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
			);
			const name = `${subject}${mode.join("")}`.replaceAll("-", "");
			writeFileSync(join(outDir, `${name}.txt`), result.stdout + result.stderr);
		}
	}
}

function main(): void {
	const argv = process.argv.slice(2);
	const baselineIndex = argv.indexOf("--baseline");
	const baselineRef = baselineIndex >= 0 ? argv[baselineIndex + 1] : undefined;
	const subjects = argv.filter(
		(arg, index) => !arg.startsWith("--") && index !== baselineIndex + 1,
	);
	if (!subjects.length) {
		console.error(
			"Usage: bun run scripts/packet-diff.ts [--baseline <ref>] <subject>…",
		);
		process.exit(2);
	}

	const snapshots = join(PROJECT_ROOT, ".mattermost/packet-snapshots");
	const current = join(snapshots, "current");
	capture(PROJECT_ROOT, current, subjects);

	if (!baselineRef) {
		console.log(
			`Wrote ${subjects.length * MODES.length} packets to ${current}`,
		);
		return;
	}

	const worktree = join(snapshots, "baseline-worktree");
	rmSync(worktree, { recursive: true, force: true });
	spawnSync("git", ["worktree", "prune"], { cwd: PROJECT_ROOT });
	const added = spawnSync(
		"git",
		["worktree", "add", "--detach", worktree, baselineRef],
		{ cwd: PROJECT_ROOT, encoding: "utf8" },
	);
	if (added.status !== 0) {
		console.error(added.stderr);
		process.exit(1);
	}
	// The baseline resolves config and database relative to its own source root.
	mkdirSync(join(worktree, ".mattermost"), { recursive: true });
	for (const file of ["config.json", "mattermost.sqlite3"]) {
		writeFileSync(
			join(worktree, ".mattermost", file),
			readFileSync(join(PROJECT_ROOT, ".mattermost", file)),
		);
	}
	spawnSync("bun", ["install"], { cwd: worktree, encoding: "utf8" });

	const baseline = join(snapshots, "baseline");
	capture(worktree, baseline, subjects);

	const differing = readdirSync(baseline).filter(
		(file) =>
			normalize(readFileSync(join(baseline, file), "utf8")) !==
			normalize(readFileSync(join(current, file), "utf8")),
	);
	spawnSync("git", ["worktree", "remove", "--force", worktree], {
		cwd: PROJECT_ROOT,
	});

	if (differing.length) {
		console.error(`${differing.length} packet(s) differ from ${baselineRef}:`);
		for (const file of differing) console.error(`  ${file}`);
		console.error(`\nCompare: diff ${baseline}/<name> ${current}/<name>`);
		process.exit(1);
	}
	console.log(
		`All ${readdirSync(baseline).length} packets identical to ${baselineRef}.`,
	);
}

main();
