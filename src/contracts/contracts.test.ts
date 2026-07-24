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
			"files",
			"context",
		]);
		expect(parsed.filter(({ success }) => success)).toHaveLength(10);
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

	test("accepts additive optional signals flag on context and thread data", () => {
		const contextOk = commandResultV1Schema.safeParse({
			command: "context",
			schemaVersion: 2,
			success: true,
			data: {
				subject: { kind: "ticket", ticketKey: "BTB-1", raw: "BTB-1" },
				probes: [],
				freshnessMode: "local",
				complete: true,
				freshness: [],
				searchedConversations: [],
				explicitChannelPolicy: "restrict",
				widening: { allowed: true, performed: false },
				threads: [],
				budget: {
					measurement: "unicode_code_points_in_rendered_post",
					limit: 1,
					used: 0,
					maxThreads: 1,
				},
				warnings: [],
				signals: true,
			},
			warnings: [],
		});
		expect(contextOk.success).toBe(true);

		const threadOk = commandResultV1Schema.safeParse({
			command: "thread",
			schemaVersion: 2,
			success: true,
			data: {
				subject: {
					kind: "post",
					postId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
					raw: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
					source: "id",
				},
				freshnessMode: "local",
				complete: true,
				freshness: {
					alias: "payments",
					conversationId: "channel-payments",
					kind: "channel",
					observedAt: 1,
					lastSuccessAt: 1,
					ageSeconds: 0,
					stale: false,
					coverageComplete: true,
				},
				conversation: {
					id: "channel-payments",
					alias: "payments",
					kind: "channel",
				},
				link: "https://chat.example.test/_redirect/pl/aaaaaaaaaaaaaaaaaaaaaaaaaa",
				thread: {
					threadId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
					selectionStrategy: ["full"],
					totalPosts: 0,
					returnedPosts: 0,
					omittedPosts: 0,
					returnedAttachments: 0,
					totalOmittedAttachments: 0,
					omittedAttachments: [],
					unreportedOmittedAttachments: 0,
					budget: {
						measurement: "unicode_code_points_in_rendered_post",
						limit: 1,
						used: 0,
					},
					posts: [],
					timeline: [],
				},
				warnings: [],
				signals: true,
			},
			warnings: [],
		});
		expect(threadOk.success).toBe(true);
	});
});
