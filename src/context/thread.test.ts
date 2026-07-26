import { describe, expect, test } from "bun:test";
import { MattermostApiError } from "../mattermost/client.ts";
import type { MattermostFileInfo } from "../mattermost/schemas.ts";
import { AppError } from "../shared/errors.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { getMattermostContext, getMattermostThread } from "./index.ts";
import {
	FakeContextClient,
	list,
	PLATFORM_ROOT,
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

	test("supports asymmetric around before/after posts", async () => {
		const store = await MattermostStore.open(":memory:");
		const ids = [
			"aaaaaaaaaaaaaaaaaaaaaaaaaa",
			"bbbbbbbbbbbbbbbbbbbbbbbbbb",
			"cccccccccccccccccccccccccc",
			"dddddddddddddddddddddddddd",
			"eeeeeeeeeeeeeeeeeeeeeeeeee",
			"ffffffffffffffffffffffffff",
			"gggggggggggggggggggggggggg",
		] as const;
		const [root, , , around, , , far] = ids;
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			posts: ids.map((id, index) =>
				postFixture({
					id,
					root_id: index === 0 ? "" : root,
					channel_id: "channel-payments",
					message: `post-${index}`,
					create_at: 10 + index,
				}),
			),
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: far,
				newestPostAt: 16,
				oldestCoveredAt: 10,
				lastSuccessAt: 100,
				coverageComplete: true,
			},
		});
		const selected = await getMattermostThread(
			{
				target: root,
				local: true,
				around,
				beforePosts: 1,
				afterPosts: 3,
			},
			{ config: configFixture(), store },
		);
		expect(selected.thread.selectionStrategy).toContain("around_neighborhood");
		expect(selected.thread.posts.map(({ id }) => id)).toContain(far);
		expect(selected.thread.posts.map(({ id }) => id)).toEqual([
			...ids.slice(0, 7),
		]);

		const delta = await getMattermostThread(
			{
				target: root,
				local: true,
				around,
				beforePosts: 1,
				afterPosts: 3,
				windowOnly: true,
			},
			{ config: configFixture(), store },
		);
		expect(delta.thread.selectionStrategy).toEqual(["around_window_only"]);
		expect(delta.thread.posts.map(({ id }) => id)).toEqual(ids.slice(2, 7));
		expect(delta.retrieval).toEqual({
			mode: "gap_window",
			rootPostId: root,
			anchorPostId: around,
			requestedBefore: 1,
			requestedAfter: 3,
			requestedPosts: 5,
			returnedPosts: 5,
			requestedRangeComplete: true,
		});
		store.close();
	});

	test("rejects around posts missing from the thread", async () => {
		const store = await seededStore();
		await expect(
			getMattermostThread(
				{
					target: REPLY,
					local: true,
					around: PLATFORM_ROOT,
				},
				{ config: configFixture(), store },
			),
		).rejects.toMatchObject({
			name: "ConfigError",
			kind: "around_post_not_in_thread",
		});
		store.close();
	});

	test("rejects before/after posts without around", async () => {
		const store = await seededStore();
		await expect(
			getMattermostThread(
				{ target: REPLY, local: true, beforePosts: 1 },
				{ config: configFixture(), store },
			),
		).rejects.toMatchObject({
			name: "ConfigError",
			kind: "invalid_around_options",
		});
		store.close();
	});

	test("names the conversation in incomplete_history", async () => {
		const store = await seededStore();
		const result = await getMattermostThread(
			{ target: REPLY, local: true },
			{ config: configFixture(), store },
		);
		expect(
			result.warnings.find(({ kind }) => kind === "incomplete_history")
				?.message,
		).toBe(
			"Local thread evidence comes from cutoff-bounded history: payments.",
		);
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

describe("allowlist refusals", () => {
	test("says why the conversation is off-limits and what would change it", async () => {
		// A bare `conversation_not_allowed` left a caller holding a permalink with
		// nothing to act on and nothing to ask an operator for.
		const store = await MattermostStore.open(":memory:");
		const outsideRoot = "ffffffffffffffffffffffffff";
		store.writePage({
			conversation: conversationFixture("secret", "channel-secret"),
			users: [userFixture()],
			posts: [
				postFixture({
					id: outsideRoot,
					channel_id: "channel-secret",
					message: "not configured",
					create_at: 10,
				}),
			],
		});

		const failure = await getMattermostThread(
			{ target: outsideRoot, local: true },
			{ config: configFixture(), store },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AppError);
		const error = failure as AppError;
		expect(error.kind).toBe("conversation_not_allowed");
		expect(error.details).toMatchObject({
			reason: "not_configured",
			postId: outsideRoot,
		});
		// Naming the channel behind a refusal would make refusals an existence
		// oracle over everything the token can read.
		expect(error.details).not.toHaveProperty("conversationId");
		// Never a way around the allowlist — only who can widen it.
		expect(String(error.details?.recommendedAction)).toContain("config owner");
		store.close();
	});

	test("distinguishes an explicit --channel restriction from a missing config entry", async () => {
		const store = await seededStore();
		const failure = await getMattermostContext(
			{ subject: PLATFORM_ROOT, channels: ["payments"], local: true },
			{ config: configFixture(), store },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AppError);
		const error = failure as AppError;
		expect(error.kind).toBe("conversation_not_allowed");
		expect(error.details).toMatchObject({
			reason: "channel_restriction",
			postId: PLATFORM_ROOT,
			restrictedTo: ["payments"],
		});
		expect(String(error.details?.recommendedAction)).toContain("--channel");
		store.close();
	});
});
