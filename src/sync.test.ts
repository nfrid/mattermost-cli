import { describe, expect, test } from "bun:test";
import type { MattermostConfig } from "./config.ts";
import type {
	MattermostChannel,
	MattermostFileInfo,
	MattermostPost,
	MattermostPostList,
	MattermostUser,
} from "./mattermost/schemas.ts";
import { MattermostStore } from "./storage.ts";
import {
	inspectFreshness,
	resolveConversations,
	type SyncClient,
	syncConfiguredConversations,
} from "./sync.ts";

const config = {
	schemaVersion: 1,
	url: "https://chat.example.test",
	teamId: "team-id",
	token: "secret",
	databasePath: ":memory:",
	configPath: "/tmp/config.json",
	projectRoot: "/tmp",
	freshnessSeconds: 300,
	reconciliationOverlapMs: 30,
	historyDays: 1,
	pageSize: 2,
	budgets: {
		defaultMaxCharacters: 16_000,
		defaultPerThreadCharacters: 6_000,
		defaultMaxThreads: 3,
		moreMaxCharacters: 32_000,
		morePerThreadCharacters: 10_000,
		moreMaxThreads: 6,
	},
	channels: {
		payments: {
			name: "payments",
			description: "Payments",
			tags: [],
			repositories: [],
			scopes: [],
			priority: 0,
		},
		platform: {
			id: "channel-platform",
			name: "platform",
			description: "Platform",
			tags: [],
			repositories: [],
			scopes: [],
			priority: 0,
		},
	},
	directMessages: {
		alice: {
			channelId: "dm-alice",
			description: "Alice",
			participants: ["alice"],
			tags: [],
			repositories: [],
			scopes: [],
			priority: 0,
		},
	},
} satisfies MattermostConfig;

describe("targeted synchronization", () => {
	test("backfills only requested configured conversations and records bounded coverage", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		client.pages.set("dm-alice:0", list(post("dm-post", "dm-alice", 1_000)));
		client.pages.set("dm-alice:1", list());

		const result = await syncConfiguredConversations(config, client, store, {
			aliases: ["alice"],
			now: () => 2_000,
		});

		expect(result.conversations).toEqual([
			expect.objectContaining({
				alias: "alice",
				postsProcessed: 1,
				coverageComplete: true,
			}),
		]);
		expect(client.channelLookups).toEqual(["dm-alice"]);
		expect(
			client.postRequests.every(({ channelId }) => channelId === "dm-alice"),
		).toBe(true);
		expect(store.getPost("dm-post")?.conversationId).toBe("dm-alice");
		store.close();
	});

	test("rejects configured conversations with mismatched remote identity or type", async () => {
		const client = new FakeClient();
		client.channelOverrides.set("channel-platform", {
			...channel("channel-platform", "platform"),
			type: "D",
		});
		await expect(
			resolveConversations(config, client, ["platform"]),
		).rejects.toMatchObject({ kind: "channel_identity_mismatch" });
		client.channelOverrides.set("dm-alice", channel("dm-alice", "alice__bob"));
		await expect(
			resolveConversations(config, client, ["alice"]),
		).rejects.toMatchObject({ kind: "direct_message_identity_mismatch" });
	});

	test("records cutoff-bounded initial history", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		const now = 200_000_000;
		client.pages.set(
			"channel-payments:0",
			list(
				post("new", "channel-payments", now - 1_000),
				post("old", "channel-payments", now - 90_000_000),
			),
		);
		const result = await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => now,
		});
		expect(result.conversations[0]).toMatchObject({
			postsProcessed: 1,
			coverageComplete: false,
		});
		expect(store.getPost("old")).toBeNull();
		store.close();
	});

	test("reconciles overlap idempotently and updates edits and tombstones", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		client.pages.set(
			"channel-payments:0",
			list(post("anchor", "channel-payments", 1_000, "original")),
		);
		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => 2_000,
		});

		client.pages.clear();
		client.sincePosts.set(
			"channel-payments",
			list(
				post("anchor", "channel-payments", 1_000, "edited", {
					update_at: 3_000,
				}),
			),
		);
		client.pages.set(
			"channel-payments:0",
			list(
				post("anchor", "channel-payments", 1_000, "edited", {
					update_at: 3_000,
				}),
			),
		);
		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => 4_000,
		});
		expect(store.search("edited", ["channel-payments"])).toHaveLength(1);
		expect(
			store.database
				.query<{ count: number }, []>("SELECT count(*) AS count FROM posts")
				.get()?.count,
		).toBe(1);

		client.sincePosts.set(
			"channel-payments",
			list(
				post("anchor", "channel-payments", 1_000, "edited", {
					delete_at: 5_000,
				}),
			),
		);
		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => 6_000,
		});
		expect(store.search("edited", ["channel-payments"])).toEqual([]);
		store.close();
	});

	test("full sync rebuilds a conversation so omitted deletions cannot remain searchable", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		const indexedConversation = {
			id: "channel-payments",
			alias: "payments",
			kind: "channel" as const,
			name: "payments",
			description: "Payments",
		};
		store.writePage({
			conversation: indexedConversation,
			posts: [
				post("live", "channel-payments", 2_000, "PROJ-1777 current"),
				post("deleted-on-server", "channel-payments", 500, "stale secret", {
					root_id: "live",
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: "deleted-on-server",
				newestPostAt: 500,
				oldestCoveredAt: 500,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		client.pages.set(
			"channel-payments:0",
			list(post("live", "channel-payments", 2_000, "PROJ-1777 current")),
		);

		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			full: true,
			now: () => 3_000,
		});
		expect(store.getPost("deleted-on-server")).toBeNull();
		expect(store.search("stale secret", ["channel-payments"])).toEqual([]);
		expect(store.getPost("live")?.message).toBe("PROJ-1777 current");
		expect(
			store.database
				.query<{ count: number }, []>(
					"SELECT count(*) AS count FROM ticket_threads WHERE ticket_key = 'PROJ-1777'",
				)
				.get()?.count,
		).toBe(1);
		store.close();
	});

	test("failed full sync preserves the prior usable index and checkpoint", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		const indexedConversation = {
			id: "channel-payments",
			alias: "payments",
			kind: "channel" as const,
			name: "payments",
			description: "Payments",
		};
		store.writePage({
			conversation: indexedConversation,
			posts: [post("known-good", "channel-payments", 500, "usable history")],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: "known-good",
				newestPostAt: 500,
				oldestCoveredAt: 500,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		client.pages.set(
			"channel-payments:0",
			list(post("new", "channel-payments", 2_000)),
		);
		client.failUsers = true;

		await expect(
			syncConfiguredConversations(config, client, store, {
				aliases: ["payments"],
				full: true,
				now: () => 3_000,
			}),
		).rejects.toMatchObject({ kind: "reconciliation_failed" });
		expect(store.getPost("known-good")?.message).toBe("usable history");
		expect(store.getCheckpoint("channel-payments")?.lastSuccessAt).toBe(1_000);
		store.close();
	});

	test("refuses to advance freshness when Mattermost caps since results", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		const indexedConversation = {
			id: "channel-payments",
			alias: "payments",
			kind: "channel" as const,
			name: "payments",
			description: "Payments",
		};
		store.writePage({
			conversation: indexedConversation,
			posts: [
				post("anchor", "channel-payments", 1_000),
				post("oldest", "channel-payments", 500),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: "anchor",
				newestPostAt: 1_000,
				oldestCoveredAt: 500,
				lastSuccessAt: 2_000,
				coverageComplete: false,
			},
		});
		client.sincePosts.set(
			"channel-payments",
			list(
				...Array.from({ length: 1_000 }, (_, index) =>
					post(`changed-${index}`, "channel-payments", 3_000 + index),
				),
			),
		);
		client.pages.set(
			"channel-payments:0",
			list(
				post("changed-999", "channel-payments", 3_999),
				post("anchor", "channel-payments", 1_000),
			),
		);
		client.pages.set(
			"channel-payments:1",
			list(post("oldest", "channel-payments", 500)),
		);

		try {
			await syncConfiguredConversations(config, client, store, {
				aliases: ["payments"],
				now: () => 5_000,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({
				kind: "reconciliation_failed",
				details: {
					freshnessComplete: false,
					lastSuccessAt: 2_000,
					reason: "delta_limit",
					recommendedAction: "sync_full",
				},
			});
		}
		expect(client.postRequests.some(({ page }) => page !== undefined)).toBe(
			false,
		);
		expect(store.getCheckpoint("channel-payments")?.lastSuccessAt).toBe(2_000);
		store.close();
	});

	test("widens to prior coverage when the known anchor is absent", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		client.pages.set(
			"channel-payments:0",
			list(
				post("anchor", "channel-payments", 1_000),
				post("oldest", "channel-payments", 900),
			),
		);
		client.pages.set("channel-payments:1", list());
		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => 2_000,
		});

		client.pages.clear();
		client.sincePosts.set(
			"channel-payments",
			list(post("new", "channel-payments", 3_000)),
		);
		client.pages.set(
			"channel-payments:0",
			list(
				post("new", "channel-payments", 3_000),
				post("middle", "channel-payments", 1_500),
			),
		);
		client.pages.set(
			"channel-payments:1",
			list(post("oldest", "channel-payments", 900)),
		);
		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => 4_000,
		});
		expect(
			client.postRequests.some(
				({ channelId, before }) =>
					channelId === "channel-payments" && before === "middle",
			),
		).toBe(true);
		expect(store.getCheckpoint("channel-payments")?.lastSuccessAt).toBe(4_000);
		store.close();
	});

	test("does not advance freshness and returns incomplete metadata when reconciliation fails", async () => {
		const store = await MattermostStore.open(":memory:");
		const client = new FakeClient();
		client.pages.set(
			"channel-payments:0",
			list(post("anchor", "channel-payments", 1_000)),
		);
		await syncConfiguredConversations(config, client, store, {
			aliases: ["payments"],
			now: () => 2_000,
		});
		client.sincePosts.set(
			"channel-payments",
			list(post("changed", "channel-payments", 3_000)),
		);
		client.failUsers = true;
		try {
			await syncConfiguredConversations(config, client, store, {
				aliases: ["payments"],
				now: () => 4_000,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({
				kind: "reconciliation_failed",
				details: {
					alias: "payments",
					freshnessComplete: false,
					lastSuccessAt: 2_000,
				},
			});
		}
		expect(store.getCheckpoint("channel-payments")?.lastSuccessAt).toBe(2_000);
		expect(
			inspectFreshness(
				config,
				store,
				[
					{
						id: "channel-payments",
						alias: "payments",
						kind: "channel",
						name: "payments",
						description: "Payments",
					},
				],
				400_000,
			)[0]?.stale,
		).toBe(true);
		store.close();
	});
});

class FakeClient implements SyncClient {
	readonly pages = new Map<string, MattermostPostList>();
	readonly sincePosts = new Map<string, MattermostPostList>();
	readonly channelLookups: string[] = [];
	readonly channelOverrides = new Map<string, MattermostChannel>();
	readonly postRequests: {
		channelId: string;
		since?: number;
		page?: number;
		before?: string;
	}[] = [];
	failUsers = false;

	async getChannelByName(
		_teamId: string,
		name: string,
	): Promise<MattermostChannel> {
		return (
			this.channelOverrides.get(`name:${name}`) ??
			channel(`channel-${name}`, name)
		);
	}

	async getChannel(channelId: string): Promise<MattermostChannel> {
		this.channelLookups.push(channelId);
		const override = this.channelOverrides.get(channelId);
		if (override) return override;
		return {
			...channel(channelId, channelId.replace(/^channel-/, "")),
			type: channelId.startsWith("dm-") ? "D" : "O",
			team_id: channelId.startsWith("dm-") ? "" : "team-id",
		};
	}

	async getChannelPosts(
		channelId: string,
		options: { since?: number; page?: number; before?: string } = {},
	): Promise<MattermostPostList> {
		this.postRequests.push({
			channelId,
			since: options.since,
			page: options.page,
			before: options.before,
		});
		if (options.since !== undefined)
			return this.sincePosts.get(channelId) ?? list();
		if (options.before) {
			for (let page = 0; ; page += 1) {
				const current = this.pages.get(`${channelId}:${page}`);
				if (!current) break;
				if (current.order.includes(options.before)) {
					return this.pages.get(`${channelId}:${page + 1}`) ?? list();
				}
			}
		}
		return this.pages.get(`${channelId}:${options.page ?? 0}`) ?? list();
	}

	async getUsersByIds(userIds: readonly string[]): Promise<MattermostUser[]> {
		if (this.failUsers) throw new Error("user lookup failed");
		return userIds.map((id) => ({
			id,
			username: id,
			first_name: "",
			last_name: "",
			nickname: "",
			delete_at: 0,
		}));
	}

	async getFileInfo(fileId: string): Promise<MattermostFileInfo> {
		return {
			id: fileId,
			user_id: "user-1",
			post_id: "post-1",
			create_at: 1,
			update_at: 1,
			delete_at: 0,
			name: fileId,
			extension: "",
			size: 0,
			mime_type: "application/octet-stream",
		};
	}
}

function channel(id: string, name: string): MattermostChannel {
	return {
		id,
		team_id: "team-id",
		type: "O",
		name,
		display_name: name,
		header: "",
		purpose: "",
		delete_at: 0,
	};
}

function post(
	id: string,
	channelId: string,
	createAt: number,
	message = id,
	overrides: Partial<MattermostPost> = {},
): MattermostPost {
	return {
		id,
		create_at: createAt,
		update_at: createAt,
		delete_at: 0,
		user_id: "user-1",
		channel_id: channelId,
		root_id: "",
		message,
		type: "",
		props: {},
		file_ids: [],
		...overrides,
	};
}

function list(...posts: MattermostPost[]): MattermostPostList {
	return {
		order: posts.map(({ id }) => id),
		posts: Object.fromEntries(posts.map((post) => [post.id, post])),
	};
}
