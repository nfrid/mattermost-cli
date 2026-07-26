import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Structural guards over the source graph.
 *
 * Import cycles here are not a style question. `evidence/` used to reach up
 * into `context/selection.ts` while `context/types.ts` reached back down for
 * `EvidenceStatus`, so the two directories could not be reasoned about — or
 * moved — independently. These tests fail on the shape, not on the symptom, so
 * the next such edge is caught when it is one line rather than forty files.
 */

const SOURCE_ROOT = resolve(import.meta.dir);

/**
 * Layers, lowest first. A module may import from its own layer or any lower
 * one, never a higher one. `contracts/` and `benchmark/` are deliberately
 * unlisted: they are leaf consumers that may reach anywhere.
 */
const LAYERS: readonly (readonly string[])[] = [
	["text"],
	["shared"],
	["config", "mattermost"],
	["store"],
	["search"],
	["evidence"],
	["sync"],
	["context"],
	["output"],
	["cli"],
];

const LAYER_OF = new Map<string, number>(
	LAYERS.flatMap((names, index) => names.map((name) => [name, index] as const)),
);

/**
 * Known upward edges that are load-bearing rather than accidental.
 *
 * `search → evidence` is real: ranking segments a thread by ticket proximity,
 * which is an evidence primitive. `store → mattermost` and `search → sync` are
 * likewise deliberate. Each entry is a debt, not a blessing — but an explicit
 * one.
 */
const ALLOWED_UPWARD_EDGES: ReadonlySet<string> = new Set([
	"search -> evidence",
	"search -> sync",
	"store -> mattermost",
]);

function sourceFiles(): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
				files.push(path);
			}
		}
	};
	walk(SOURCE_ROOT);
	return files;
}

/** Relative-specifier import graph over non-test sources. */
function importGraph(): Map<string, string[]> {
	const files = new Set(sourceFiles());
	const graph = new Map<string, string[]>();
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const dependencies: string[] = [];
		for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const specifier = match[1];
			if (!specifier) continue;
			const target = resolve(dirname(file), specifier);
			if (files.has(target)) dependencies.push(target);
		}
		graph.set(file, dependencies);
	}
	return graph;
}

function topLevelDirectory(file: string): string {
	return relative(SOURCE_ROOT, file).split("/")[0] ?? "";
}

describe("source graph", () => {
	test("has no import cycles", () => {
		const graph = importGraph();
		const cycles: string[] = [];
		const state = new Map<string, number>();
		const stack: string[] = [];

		const visit = (node: string): void => {
			state.set(node, 1);
			stack.push(node);
			for (const dependency of graph.get(node) ?? []) {
				if (state.get(dependency) === 1) {
					const cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
					cycles.push(
						cycle.map((path) => relative(SOURCE_ROOT, path)).join(" -> "),
					);
				} else if (!state.has(dependency)) visit(dependency);
			}
			stack.pop();
			state.set(node, 2);
		};

		for (const file of graph.keys()) if (!state.has(file)) visit(file);
		expect(cycles).toEqual([]);
	});

	test("never imports upward across layers", () => {
		const graph = importGraph();
		const violations: string[] = [];
		for (const [file, dependencies] of graph) {
			const fromDirectory = topLevelDirectory(file);
			const from = LAYER_OF.get(fromDirectory);
			if (from === undefined) continue;
			for (const dependency of dependencies) {
				const toDirectory = topLevelDirectory(dependency);
				const to = LAYER_OF.get(toDirectory);
				if (to === undefined || to <= from) continue;
				const edge = `${fromDirectory} -> ${toDirectory}`;
				if (ALLOWED_UPWARD_EDGES.has(edge)) continue;
				violations.push(
					`${relative(SOURCE_ROOT, file)} imports ${relative(SOURCE_ROOT, dependency)} (${edge})`,
				);
			}
		}
		expect([...new Set(violations)].sort()).toEqual([]);
	});

	test("keeps the text kernel free of other source layers", () => {
		const graph = importGraph();
		for (const [file, dependencies] of graph) {
			if (topLevelDirectory(file) !== "text") continue;
			for (const dependency of dependencies) {
				expect(topLevelDirectory(dependency)).toBe("text");
			}
		}
	});
});
