import { describe, expect, test } from "bun:test";
import { getMattermostContext, searchMattermost } from "../context/index.ts";
import { commandSuccess } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { contextResultV1Schema, searchResultV1Schema } from "./contracts.ts";

// Snapshots here intentionally embed fusion scores, BM25 values, and rank
// weights: they exist to catch unintended ranking drift. Expect churn on any
// deliberate scoring change; contracts.test.ts owns schema-shape guarantees.
describe("ranking regression snapshots", () => {
	test("locks populated deterministic search and context output", async () => {
		const store = await MattermostStore.open(":memory:");
		const config = configFixture();
		const conversation = conversationFixture();
		const rootId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
		const replyId = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
		store.writePage({
			conversation,
			users: [userFixture()],
			files: [
				{
					id: "file-1",
					user_id: "user-1",
					post_id: replyId,
					create_at: 20,
					update_at: 20,
					delete_at: 0,
					name: "synthetic.txt",
					extension: "txt",
					size: 42,
					mime_type: "text/plain",
				},
			],
			posts: [
				postFixture({
					id: rootId,
					message: "synthetic payment evidence",
					create_at: 10,
				}),
				postFixture({
					id: replyId,
					root_id: rootId,
					message: "payment evidence confirmed",
					file_ids: ["file-1"],
					create_at: 20,
				}),
			],
			checkpoint: {
				conversationId: conversation.id,
				newestPostId: replyId,
				newestPostAt: 20,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const dependencies = { config, store, now: () => 1_000 };
		const search = await searchMattermost(
			{ subject: "payment evidence", channels: ["payments"] },
			dependencies,
		);
		const context = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
			},
			dependencies,
		);
		expect(
			searchResultV1Schema.parse(
				commandSuccess("search", search, search.warnings),
			),
		).toMatchSnapshot("populated search v1");
		expect(
			contextResultV1Schema.parse(
				commandSuccess("context", context, context.warnings),
			),
		).toMatchSnapshot("populated context v1");
		const remoteDocument = contextResultV1Schema.parse(
			commandSuccess(
				"context",
				{
					...context,
					remoteSearch: {
						requested: true,
						performed: true,
						reason: "explicit" as const,
						queries: [
							{
								probe: "payment evidence",
								returnedPosts: 2,
								acceptedPosts: 1,
							},
						],
						candidateThreads: 1,
						failures: 0,
					},
					threads: context.threads.map((thread) => ({
						...thread,
						reasons: ["remote_search" as const, ...thread.reasons],
					})),
				},
				context.warnings,
			),
		);
		expect(remoteDocument.data.remoteSearch).toMatchObject({
			performed: true,
			reason: "explicit",
		});
		store.close();
	});
});
