import { describe, expect, test } from "bun:test";
import { MattermostApiError } from "../mattermost/client.ts";
import type { MattermostFileInfo } from "../mattermost/schemas.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { getMattermostThread } from "./index.ts";
import {
	FakeContextClient,
	list,
	REPLY,
	ROOT,
	seededStore,
} from "./test-helpers.ts";

describe("thread command API", () => {
	test("supports around, full, and local thread retrieval", async () => {
		const store = await seededStore();
		const selected = await getMattermostThread(
			{ target: REPLY, local: true, around: REPLY },
			{ config: configFixture(), store },
		);
		expect(selected.thread.threadId).toBe(ROOT);
		expect(selected.thread.selectionStrategy).toContain("match_neighborhoods");
		const full = await getMattermostThread(
			{ target: REPLY, local: true, full: true },
			{ config: configFixture(), store },
		);
		expect(full.thread.returnedPosts).toBe(full.thread.totalPosts);
		store.close();
	});

	test("uses fresh local evidence without forcing remote hydrate", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.getThread = async () => {
			throw new MattermostApiError(
				"Mattermost API request failed with 403 Forbidden.",
				403,
				"forbidden",
			);
		};
		const result = await getMattermostThread(
			{ target: REPLY },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.thread.threadId).toBe(ROOT);
		expect(result.freshnessMode).toBe("local");
		expect(result.warnings.map(({ kind }) => kind)).not.toContain(
			"remote_hydrate_failed",
		);
		expect(client.threadRequests).toEqual([]);
		store.close();
	});

	test("degrades to local thread evidence when remote hydrate fails", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.posts.set(
			REPLY,
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout reply",
				create_at: 20,
			}),
		);
		client.getThread = async (postId: string) => {
			client.threadRequests.push(postId);
			throw new MattermostApiError(
				"Mattermost API request failed with 403 Forbidden.",
				403,
				"forbidden",
			);
		};
		const result = await getMattermostThread(
			{ target: REPLY, fresh: true },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.thread.threadId).toBe(ROOT);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ kind: "remote_hydrate_failed" }),
		);
		expect(client.threadRequests).toEqual([ROOT]);
		store.close();
	});

	test("remote hydrate keeps already-indexed attachments without refetching file info", async () => {
		const fileId = "fileabcdefghijklmnopqrstuv";
		const store = await MattermostStore.open(":memory:");
		const rootPost = postFixture({
			id: ROOT,
			channel_id: "channel-payments",
			message: "если у нас есть 3 логики",
			file_ids: [fileId],
			create_at: 10,
			update_at: 10,
		});
		const knownFile: MattermostFileInfo = {
			id: fileId,
			user_id: "user-1",
			post_id: ROOT,
			create_at: 10,
			update_at: 10,
			delete_at: 0,
			name: "image.png",
			extension: "png",
			size: 42,
			mime_type: "image/png",
		};
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			files: [knownFile],
			posts: [rootPost],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: ROOT,
				newestPostAt: 10,
				oldestCoveredAt: 10,
				lastSuccessAt: 100,
				coverageComplete: true,
			},
		});
		const client = new FakeContextClient();
		client.posts.set(ROOT, rootPost);
		client.thread = list(rootPost);
		const result = await getMattermostThread(
			{ target: ROOT, full: true, fresh: true },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(client.threadRequests).toEqual([ROOT]);
		expect(client.fileInfoRequests).toEqual([]);
		expect(result.thread.posts[0]?.attachments).toEqual([
			expect.objectContaining({
				id: fileId,
				name: "image.png",
				mimeType: "image/png",
			}),
		]);
		store.close();
	});
});
