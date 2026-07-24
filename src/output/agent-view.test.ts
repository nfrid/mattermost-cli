import { describe, expect, test } from "bun:test";
import {
	getMattermostContext,
	getMattermostThread,
	searchMattermost,
} from "../context/index.ts";
import { commandSuccess } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { projectAgentResult } from "./agent-view.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("agent projection", () => {
	test("projects context evidence as consecutive author groups with file ids", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);

		expect(result).toEqual({
			command: "context",
			schemaVersion: 2,
			success: true,
			subject: "payment evidence",
			status: {
				freshness: "local",
			},
			evidence: expect.objectContaining({
				adequacy: "usable",
				currency: "local_only",
				completeness: {
					selectedThreads: "complete",
					indexHistory: "full",
				},
				packing: expect.objectContaining({
					omittedPosts: 0,
					recommendFullThreadIds: [],
				}),
			}),
			threads: [
				{
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					role: "primary",
					omitted: { posts: 0, attachments: 0 },
					posts: [
						{
							author: "alice",
							messages: [
								{
									id: ROOT,
									text: "synthetic payment evidence",
									at: "1970-01-01T00:00:00.010Z",
								},
								{
									id: REPLY,
									text: "payment evidence confirmed",
									at: "1970-01-01T00:00:00.020Z",
									files: [
										{
											id: "file-1",
											name: "trace.txt",
											mimeType: "text/plain",
											size: 42,
										},
									],
								},
							],
						},
					],
				},
			],
			warnings: [],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/"data"|rootId|userId|renderedUnits|scoreVector|matchingPostIds|displayName|"from"|"to"|"why"/,
		);
		store.close();
	});

	test("projects a direct thread and emits only meaningful post state", async () => {
		const store = await seededStore();
		const thread = await getMattermostThread(
			{ target: ROOT, local: true, full: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const first = thread.thread.posts[0];
		const second = thread.thread.posts[1];
		if (!first || !second) throw new Error("Expected two fixture posts.");
		first.updateAt = 30;
		second.deleteAt = 40;
		second.message = "";

		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		);

		expect(result).toMatchObject({
			command: "thread",
			subject: ROOT,
			status: {
				freshness: "local",
			},
			thread: {
				threadId: ROOT,
				conversation: "payments",
				kind: "channel",
				posts: [
					{
						author: "alice",
						messages: [
							{ id: ROOT, editedAt: "1970-01-01T00:00:00.030Z" },
							{ id: REPLY, text: "", deleted: true },
						],
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toMatch(
			/"updateAt"|"deleteAt"|"from"|"to"|displayName|"why"/,
		);
		store.close();
	});

	test("projects compact search candidates without why or detailed freshness evidence", async () => {
		const store = await seededStore({ stale: true, complete: false });
		const search = await searchMattermost(
			{
				subject: "payment evidence",
				channels: ["payments"],
			},
			{ config: configFixture(), store, now: () => 8_200_000 },
		);
		const result = projectAgentResult(
			commandSuccess("search", search, search.warnings),
		);

		expect(result).toMatchObject({
			command: "search",
			subject: "payment evidence",
			status: {
				freshness: "local",
			},
			candidates: [
				{
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					latestAt: "1970-01-01T00:00:00.020Z",
					excerpts: [
						"synthetic payment evidence",
						"payment evidence confirmed",
					],
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/rootPostId|conversationId|priority|scoreVector|postId|probes|evidenceIssues|"complete"|rank_fusion|routing_|"why"/,
		);
		store.close();
	});

	test("surfaces packing completeness hints and related tracker keys", async () => {
		const store = await MattermostStore.open(":memory:");
		const longRoot = ROOT;
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: longRoot,
					message: "TECHSUPP-109 kickoff; also see BTBOLD-238",
					create_at: 10,
				}),
				...Array.from({ length: 10 }, (_, index) =>
					postFixture({
						id: `${String.fromCharCode(98 + index)}${"b".repeat(25)}`,
						root_id: longRoot,
						message: `decision detail ${index + 1} for the rollout`,
						create_at: 20 + index,
					}),
				),
			],
		});
		const context = await getMattermostContext(
			{ subject: "TECHSUPP-109", channels: ["payments"], local: true },
			{
				config: configFixture({
					budgets: {
						...configFixture().budgets,
						defaultPerThreadCharacters: 220,
						defaultMaxCharacters: 220,
						defaultMaxThreads: 1,
					},
				}),
				store,
				now: () => 1_000,
			},
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		expect(result).toMatchObject({
			command: "context",
			subject: "TECHSUPP-109",
			evidence: expect.objectContaining({
				adequacy: "usable",
				completeness: expect.objectContaining({
					selectedThreads: "truncated",
				}),
				packing: expect.objectContaining({
					recommendFullThreadIds: expect.arrayContaining([longRoot]),
				}),
				next: expect.arrayContaining([
					expect.objectContaining({
						action: "thread_full",
						threadId: longRoot,
					}),
				]),
			}),
			relatedTickets: [
				expect.objectContaining({
					key: "BTBOLD-238",
					hydrated: false,
				}),
			],
		});
		const thread = (
			result as unknown as {
				threads: Array<{
					recommendFull?: boolean;
					largestSkip?: number;
					omittedRatio?: number;
					omitted: { posts: number };
					ticketDensity?: number;
				}>;
			}
		).threads[0];
		expect(thread?.omitted.posts).toBeGreaterThan(0);
		expect(thread?.recommendFull).toBe(true);
		expect(thread?.largestSkip).toBeGreaterThanOrEqual(5);
		expect(thread?.omittedRatio).toBeGreaterThan(0);
		expect(thread?.ticketDensity).toBeGreaterThanOrEqual(0);
		store.close();
	});
});

async function seededStore(
	options: { stale?: boolean; complete?: boolean } = {},
): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture(),
		users: [userFixture()],
		files: [
			{
				id: "file-1",
				user_id: "user-1",
				post_id: REPLY,
				create_at: 20,
				update_at: 20,
				delete_at: 0,
				name: "trace.txt",
				extension: "txt",
				size: 42,
				mime_type: "text/plain",
			},
		],
		posts: [
			postFixture({
				id: ROOT,
				message: "synthetic payment evidence",
				create_at: 10,
				update_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				message: "payment evidence confirmed",
				file_ids: ["file-1"],
				create_at: 20,
				update_at: 20,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: REPLY,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: options.stale ? 1_000_000 : 1_000,
			coverageComplete: options.complete ?? true,
		},
	});
	return store;
}
