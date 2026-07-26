import { describe, expect, test } from "bun:test";
import { CueTelemetry, formatCueFiringReport } from "./cue-telemetry.ts";
import type { EvidencePost } from "./packing.ts";
import {
	buildThreadBrief,
	buildThreadSignals,
	cueInventory,
} from "./signals.ts";

function post(
	id: string,
	message: string,
	createAt: number,
	author = "alice",
): EvidencePost {
	return {
		id,
		rootId: "root-synthetic",
		userId: `user-${author}`,
		authorUsername: author,
		authorDisplayName: author,
		createAt,
		updateAt: createAt,
		deleteAt: 0,
		message,
		attachments: [],
	};
}

function rowFor(
	telemetry: CueTelemetry,
	family: string,
	cue: string,
): NonNullable<ReturnType<typeof findRow>> {
	const row = findRow(telemetry, family, cue);
	if (!row) throw new Error(`No row for ${family}:${cue}`);
	return row;
}

function findRow(telemetry: CueTelemetry, family: string, cue: string) {
	return telemetry
		.snapshot(cueInventory())
		.rows.find((entry) => entry.family === family && entry.cue === cue);
}

describe("cue inventory", () => {
	test("covers every cue table and marks uninstrumented ones", () => {
		const inventory = cueInventory();
		const families = new Set(inventory.map((entry) => entry.family));
		expect(families).toContain("decision");
		expect(families).toContain("tech_approach");
		expect(families).toContain("rejected");
		expect(families).toContain("open_question");
		expect(families).toContain("scope_refinement");
		expect(families).toContain("role:testing");
		expect(families).toContain("hedge");
		expect(families).toContain("decision_meta_reject");
		// Hedges and the meta-reject list are consulted outside the recorded match
		// path; reporting them as instrumented would read as "never fired".
		for (const entry of inventory) {
			const uninstrumented =
				entry.family === "hedge" || entry.family === "decision_meta_reject";
			expect(entry.instrumented).toBe(!uninstrumented);
		}
	});

	test("every instrumented cue is uniquely identified by family and cue", () => {
		const keys = cueInventory().map((entry) => `${entry.family}:${entry.cue}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("per-cue firing telemetry", () => {
	test("records the full lifecycle of a surviving decision cue", () => {
		const telemetry = new CueTelemetry();
		buildThreadBrief(
			[
				post("p1", "BTB-1 обсуждаем вариант с отдельным роутом", 1),
				post("p2", "решили делать через capabilities", 2, "bob"),
				post("p3", "ок", 3, "carol"),
			],
			{ cueTelemetry: telemetry },
		);
		const row = rowFor(telemetry, "decision", "решили");
		expect(row.counts.matched).toBe(1);
		expect(row.counts.guardRejected).toBe(0);
		expect(row.counts.reported).toBe(1);
		expect(row.counts.survived).toBe(1);
		expect(row.counts.brief).toBe(1);
		expect(row.survivalRate).toBe(1);
	});

	test("separates a guard-rejected match from a reported one", () => {
		const telemetry = new CueTelemetry();
		buildThreadSignals([post("q1", "что будем делать с этим?", 1)], {
			cueTelemetry: telemetry,
		});
		const row = rowFor(telemetry, "decision", "будем");
		expect(row.counts.matched).toBe(1);
		expect(row.counts.guardRejected).toBe(1);
		expect(row.counts.reported).toBe(0);
		expect(row.counts.survived).toBe(0);
		expect(row.reportRate).toBe(0);
	});

	test("counts a cue that was the only evidence for its signal", () => {
		const telemetry = new CueTelemetry();
		buildThreadSignals([post("s1", "договорились", 1)], {
			cueTelemetry: telemetry,
		});
		const row = rowFor(telemetry, "decision", "договорились");
		expect(row.counts.reported).toBe(1);
		expect(row.counts.sole).toBe(1);
		expect(row.soleRate).toBe(1);
	});

	test("does not credit sole when a stronger cue co-fires", () => {
		const telemetry = new CueTelemetry();
		buildThreadSignals([post("s2", "решили и договорились", 1)], {
			cueTelemetry: telemetry,
		});
		expect(rowFor(telemetry, "decision", "решили").counts.sole).toBe(0);
		expect(rowFor(telemetry, "decision", "договорились").counts.sole).toBe(0);
	});

	test("deduplicates the repeated passes over the same post", () => {
		const telemetry = new CueTelemetry();
		// `collectDecisionBoundaryIds` and `collectCandidateSpans` both run the
		// decision tables over every post; that is one observation, not two.
		buildThreadBrief([post("d1", "договорились так и сделать", 1)], {
			cueTelemetry: telemetry,
		});
		expect(rowFor(telemetry, "decision", "договорились").counts.matched).toBe(
			1,
		);
	});

	test("deduplicates a post packed into two separate briefs", () => {
		const telemetry = new CueTelemetry();
		const posts = [post("d2", "утвердили вариант B", 1)];
		buildThreadBrief(posts, { cueTelemetry: telemetry });
		buildThreadBrief(posts, { cueTelemetry: telemetry });
		expect(rowFor(telemetry, "decision", "утвердили").counts.matched).toBe(1);
	});

	test("matched splits exactly into guardRejected, capped and reported", () => {
		const telemetry = new CueTelemetry();
		buildThreadBrief(
			[
				post(
					"m1",
					"решили, договорились, утвердили, фиксируем, итого, ок делаем",
					1,
				),
				post(
					"m2",
					"не ясно, какой вариант, что выбрать, стоит ли, нужно ли?",
					2,
					"bob",
				),
				post("m3", "будем это делать?", 3, "carol"),
			],
			{ cueTelemetry: telemetry },
		);
		for (const row of telemetry.snapshot(cueInventory()).rows) {
			const { matched, guardRejected, capped, reported } = row.counts;
			expect(guardRejected + capped + reported).toBe(matched);
		}
	});

	test("reports never-fired instrumented cues and omits uninstrumented ones", () => {
		const telemetry = new CueTelemetry();
		buildThreadSignals([post("n1", "решили", 1)], { cueTelemetry: telemetry });
		const report = telemetry.snapshot(cueInventory());
		expect(report.neverFired).toContain("decision:approved");
		expect(report.neverFired).not.toContain("decision:решили");
		expect(report.neverFired.some((cue) => cue.startsWith("hedge:"))).toBe(
			false,
		);
	});

	test("tracks corpus size from observed threads", () => {
		const telemetry = new CueTelemetry();
		telemetry.observe(["a", "b"]);
		telemetry.observe(["b", "c"]);
		const report = telemetry.snapshot(cueInventory());
		expect(report.threadsScanned).toBe(2);
		expect(report.postsScanned).toBe(3);
	});

	test("formats a readable table", () => {
		const telemetry = new CueTelemetry();
		buildThreadSignals([post("f1", "договорились", 1)], {
			cueTelemetry: telemetry,
		});
		telemetry.observe(["f1"]);
		const text = formatCueFiringReport(telemetry.snapshot(cueInventory()));
		expect(text).toContain("threads=1 posts=1");
		expect(text).toContain("договорились");
		expect(text).toContain("never fired");
	});
});

describe("telemetry is inert when absent", () => {
	test("signals and brief are identical with and without a recorder", () => {
		const posts = [
			post("i1", "предлагаю вынести на отдельный сервис", 1),
			post("i2", "решили: делаем отдельный роут", 2, "bob"),
			post("i3", "ок", 3, "carol"),
			post("i4", "а что с тестами? непонятно", 4, "bob"),
		];
		expect(
			buildThreadSignals(posts, { cueTelemetry: new CueTelemetry() }),
		).toEqual(buildThreadSignals(posts));
		expect(
			buildThreadBrief(posts, { cueTelemetry: new CueTelemetry() }),
		).toEqual(buildThreadBrief(posts));
	});
});
