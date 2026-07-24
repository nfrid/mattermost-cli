import { describe, expect, test } from "bun:test";
import {
	commandResultV1Schema,
	failureResultV1Schema,
	parseCommandResultV1,
} from "./contracts.ts";

const fixtureUrl = new URL("./contracts.v1.fixture.json", import.meta.url);

describe("schema version 2 command contracts", () => {
	test("accepts complete synthetic golden output for every command", async () => {
		const fixtures = (await Bun.file(fixtureUrl).json()) as unknown[];
		const parsed = fixtures.map(parseCommandResultV1);
		expect(parsed.map(({ command }) => command)).toEqual([
			"whoami",
			"channels",
			"channels.validate",
			"doctor",
			"sync",
			"search",
			"context",
			"thread",
			"file",
			"context",
		]);
		expect(parsed.filter(({ success }) => success)).toHaveLength(9);
		expect(parsed.filter(({ success }) => !success)).toHaveLength(1);
	});

	test("rejects incompatible versions and missing required evidence metadata", () => {
		expect(
			commandResultV1Schema.safeParse({
				command: "context",
				schemaVersion: 1,
				success: true,
				data: {},
				warnings: [],
			}).success,
		).toBe(false);
		expect(
			commandResultV1Schema.safeParse({
				command: "context",
				schemaVersion: 3,
				success: true,
				data: {},
				warnings: [],
			}).success,
		).toBe(false);
		expect(
			commandResultV1Schema.safeParse({
				command: "search",
				schemaVersion: 2,
				success: true,
				data: { freshnessMode: "local" },
				warnings: [],
			}).success,
		).toBe(false);
	});

	test("accepts stable failure envelopes", () => {
		const failure = failureResultV1Schema.parse({
			command: "context",
			schemaVersion: 2,
			success: false,
			error: {
				source: "config",
				kind: "missing_token",
				message: "missing",
			},
			warnings: [],
		});
		expect(failure.success).toBe(false);
		expect(failure.error.kind).toBe("missing_token");
	});
});
