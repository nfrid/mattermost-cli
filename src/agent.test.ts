import { describe, expect, test } from "bun:test";
import { projectAgentResult } from "./agent.ts";
import {
	getMattermostContext,
	getMattermostThread,
	searchMattermost,
} from "./context.ts";
import { commandSuccess } from "./results.ts";
import { MattermostStore } from "./storage.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "./test-fixtures.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("agent projection", () => {
	test("projects context evidence as consecutive author groups", async () => {
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
			schemaVersion: 1,
			success: true,
			subject: "payment evidence",
			status: {
				freshness: "local",
				searchComplete: true,
				threadsComplete: true,
			},
			threads: [
				{
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					why: [
						"subject_in_root",
						"exact_phrase",
						"exact_phrase_in_root",
						"exact_phrase_in_reply",
						"all_terms_in_thread",
						"rank_fusion",
						"routing_explicit_channel",
					],
					omitted: { posts: 0, attachments: 0 },
					posts: [
						{
							author: "alice",
							displayName: "Alice Example",
							from: "1970-01-01T00:00:00.010Z",
							to: "1970-01-01T00:00:00.020Z",
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
			/"data"|rootId|userId|renderedUnits|scoreVector|matchingPostIds/,
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
				searchComplete: true,
				threadsComplete: true,
			},
			thread: {
				threadId: ROOT,
				conversation: "payments",
				kind: "channel",
				posts: [
					{
						author: "alice",
						from: "1970-01-01T00:00:00.010Z",
						to: "1970-01-01T00:00:00.020Z",
						messages: [
							{ id: ROOT, editedAt: "1970-01-01T00:00:00.030Z" },
							{ id: REPLY, text: "", deleted: true },
						],
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toMatch(/"updateAt"|"deleteAt"/);
		store.close();
	});

	test("projects compact search candidates without detailed freshness evidence", async () => {
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
				searchComplete: false,
				threadsComplete: false,
			},
			candidates: [
				{
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					latestAt: "1970-01-01T00:00:00.020Z",
					why: [
						"subject_in_root",
						"exact_phrase",
						"exact_phrase_in_root",
						"exact_phrase_in_reply",
						"all_terms_in_thread",
						"exact_terms_near",
						"rank_fusion",
						"routing_explicit_channel",
					],
					excerpts: [
						"synthetic payment evidence",
						"payment evidence confirmed",
					],
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/rootPostId|conversationId|priority|scoreVector|postId|probes|evidenceIssues|"complete"/,
		);
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
