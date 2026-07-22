import { describe, expect, test } from "bun:test";
import {
	type ContextClient,
	getMattermostContext,
	getMattermostThread,
	searchMattermost,
} from "./context.ts";
import { formatHumanResult } from "./format.ts";
import type {
	MattermostChannel,
	MattermostFileInfo,
	MattermostPost,
	MattermostPostList,
	MattermostUser,
} from "./mattermost/schemas.ts";
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
const PLATFORM_ROOT = "cccccccccccccccccccccccccc";
const TAIL = "dddddddddddddddddddddddddd";

describe("context pipeline", () => {
	test("local mode performs zero network calls and reports stale incomplete evidence", async () => {
		const store = await seededStore();
		const client = throwingClient();
		const result = await getMattermostContext(
			{
				subject: "payment timeout",
				channels: ["payments"],
				repositories: ["unknown-service"],
				local: true,
			},
			{ config: configFixture(), store, client, now: () => 1_000_000 },
		);

		expect(result.threads).toHaveLength(1);
		expect(result.threads[0]).toMatchObject({
			threadId: ROOT,
			conversationAlias: "payments",
			matchingPostIds: [ROOT, REPLY],
		});
		expect(result.searchedConversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		expect(result.complete).toBe(false);
		expect(result.searchCoverageComplete).toBe(false);
		expect(result.selectedThreadsComplete).toBe(true);
		expect(result.detailLevel).toBe("compact");
		expect(result.unmatchedHints.repositories).toEqual(["unknown-service"]);
		expect(result.warnings.map(({ kind }) => kind)).toEqual(
			expect.arrayContaining([
				"stale_local_index",
				"incomplete_history",
				"unmapped_routing_hint",
			]),
		);
		store.close();
	});

	test("reports unmapped hints and probes that are ranking signals without text matches", async () => {
		const store = await seededStore({ fresh: true });
		store.linkTicketThread("PROJ-2113", ROOT, ROOT, "explicit");
		const result = await searchMattermost(
			{
				subject: "PROJ-2113",
				queries: ["nonexistent.operation"],
				repositories: ["payment", "unknown-service"],
			},
			{ config: configFixture(), store, now: () => 100 },
		);

		expect(result.probes.map(({ value }) => value)).toEqual([
			"PROJ-2113",
			"nonexistent.operation",
		]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			threadId: ROOT,
			link: `https://chat.example.test/_redirect/pl/${ROOT}`,
			matches: [],
		});
		expect(result.routing.unmatchedHints.repositories).toEqual([
			"unknown-service",
		]);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "unmapped_routing_hint" }),
				expect.objectContaining({ kind: "unmatched_retrieval_probe" }),
			]),
		);

		const empty = await searchMattermost(
			{
				subject: "missing subject",
				queries: ["missing additional probe"],
				channels: ["payments"],
				noWiden: true,
			},
			{ config: configFixture(), store, now: () => 100 },
		);
		expect(empty.candidates).toHaveLength(0);
		expect(empty.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "unmatched_retrieval_probe" }),
			]),
		);
		store.close();
	});

	test("uses compact default human rendering and expands it with --more", async () => {
		const store = await seededStore({ fresh: true });
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			posts: Array.from({ length: 6 }, (_, index) =>
				postFixture({
					id: `${String(index + 1).repeat(26)}`,
					root_id: ROOT,
					channel_id: "channel-payments",
					message: `middle discussion ${index + 1}`,
					create_at: 30 + index,
				}),
			),
		});
		const dependencies = { config: configFixture(), store, now: () => 100 };
		const compact = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"], local: true },
			dependencies,
		);
		const expanded = await getMattermostContext(
			{
				subject: "payment timeout",
				channels: ["payments"],
				local: true,
				more: true,
			},
			dependencies,
		);
		const compactText = formatHumanResult(
			commandSuccess("context", compact, compact.warnings),
		);
		const expandedText = formatHumanResult(
			commandSuccess("context", expanded, expanded.warnings),
		);

		expect(compactText).toContain("Compact human view:");
		expect(compactText).not.toContain("middle discussion 1");
		expect(compactText).toContain("middle discussion 6");
		expect(expandedText).not.toContain("Compact human view:");
		expect(expandedText).toContain("middle discussion 1");
		store.close();
	});

	test("retrieves Russian evidence with stop words, case folding, and ё/е normalization", async () => {
		const store = await seededStore();
		const russianRoot = "eeeeeeeeeeeeeeeeeeeeeeeeee";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			posts: [
				postFixture({
					id: russianRoot,
					channel_id: "channel-payments",
					message: "ПЛАТЁЖ снова не прошёл из-за ошибки провайдера",
					create_at: 40,
				}),
			],
		});
		const result = await getMattermostContext(
			{
				subject: "платеж не прошел",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(result.probes[0]?.terms).toEqual(["платеж", "прошел"]);
		expect(result.threads[0]?.threadId).toBe(russianRoot);
		expect(result.threads[0]?.posts[0]?.message).toBe(
			"ПЛАТЁЖ снова не прошёл из-за ошибки провайдера",
		);
		store.close();
	});

	test("uses the first repeated query as the subject when positional input is absent", async () => {
		const store = await seededStore();
		const result = await getMattermostContext(
			{
				queries: ["payment timeout", "deployment rollback"],
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(result.subject).toMatchObject({
			kind: "text",
			text: "payment timeout",
		});
		expect(result.probes.map(({ value }) => value)).toEqual([
			"payment timeout",
			"deployment rollback",
		]);
		expect(result.threads[0]?.threadId).toBe(ROOT);
		store.close();
	});

	test("widens once when metadata routing misses but never escapes explicit channels", async () => {
		const store = await seededStore();
		const widened = await getMattermostContext(
			{
				subject: "deployment rollback",
				scopes: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(widened.widening.performed).toBe(true);
		expect(widened.threads[0]?.conversationAlias).toBe("platform");
		expect(widened.searchedConversations.map(({ alias }) => alias)).toEqual([
			"payments",
			"platform",
			"leads",
		]);

		const restricted = await getMattermostContext(
			{
				subject: "deployment rollback",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(restricted.threads).toEqual([]);
		expect(restricted.widening.performed).toBe(false);
		expect(restricted.searchedConversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		store.close();
	});

	test("local search cannot return a direct post outside explicit channels", async () => {
		const store = await seededStore();
		const result = await searchMattermost(
			{ subject: PLATFORM_ROOT, channels: ["payments"] },
			{ config: configFixture(), store },
		);
		expect(result.candidates).toEqual([]);
		expect(result.routing.conversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		store.close();
	});

	test("direct permalink bypasses FTS discovery and resolves a reply to its root", async () => {
		const store = await seededStore();
		const result = await getMattermostContext(
			{
				subject: `https://chat.example.test/team/pl/${REPLY}`,
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(result.subject).toMatchObject({ kind: "post", postId: REPLY });
		expect(result.threads[0]).toMatchObject({
			threadId: ROOT,
			matchingPostIds: [REPLY],
		});
		store.close();
	});

	test("fails when a directly targeted reply disappears before hydration", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.posts.set(
			REPLY,
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout reply",
			}),
		);
		client.thread = list(
			postFixture({
				id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout root",
			}),
		);
		await expect(
			getMattermostContext(
				{ subject: REPLY },
				{ config: configFixture(), store, client, now: () => 100 },
			),
		).rejects.toMatchObject({ kind: "post_not_found" });
		store.close();
	});

	test("network hydration replaces stale local message content with current server evidence", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.posts.set(
			ROOT,
			postFixture({ id: ROOT, message: "payment timeout old" }),
		);
		client.thread = list(
			postFixture({
				id: ROOT,
				message: "payment current server text",
				create_at: 10,
				update_at: 100,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				message: "timeout confirmed",
				create_at: 20,
			}),
		);
		const result = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"] },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.threads[0]?.posts[0]?.message).toBe(
			"payment current server text",
		);
		expect(result.threads[0]?.reasons).not.toContain("exact_phrase");
		expect(result.threads[0]?.reasons).toContain("all_terms_in_thread");
		expect(client.threadRequests).toEqual([ROOT]);
		store.close();
	});

	test("rejects hydrated posts that cross the routed conversation boundary", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({
				id: ROOT,
				channel_id: "channel-platform",
				message: "payment timeout",
			}),
		);
		await expect(
			getMattermostContext(
				{ subject: "payment timeout", channels: ["payments"] },
				{ config: configFixture(), store, client, now: () => 100 },
			),
		).rejects.toMatchObject({ kind: "conversation_not_allowed" });
		store.close();
	});

	test("rejects a same-channel response for a different requested thread", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({
				id: PLATFORM_ROOT,
				channel_id: "channel-payments",
				message: "payment timeout",
			}),
		);
		await expect(
			getMattermostContext(
				{ subject: "payment timeout", channels: ["payments"] },
				{ config: configFixture(), store, client, now: () => 100 },
			),
		).rejects.toMatchObject({ kind: "thread_not_found" });
		store.close();
	});

	test("continues past stale hydrated candidates and widens when none remain useful", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.threads.set(
			ROOT,
			list(
				postFixture({
					id: ROOT,
					channel_id: "channel-payments",
					message: "no longer relevant",
				}),
			),
		);
		client.threads.set(
			PLATFORM_ROOT,
			list(
				postFixture({
					id: PLATFORM_ROOT,
					channel_id: "channel-platform",
					message: "shared evidence current",
				}),
			),
		);
		const result = await getMattermostContext(
			{ subject: "shared evidence", scopes: ["payments"] },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.widening.performed).toBe(true);
		expect(
			result.threads.map(({ conversationAlias }) => conversationAlias),
		).toEqual(["platform"]);
		store.close();
	});

	test("fresh mode reconciles and resolves only explicitly routed conversations", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({ id: ROOT, message: "payment timeout", create_at: 10 }),
		);
		await getMattermostContext(
			{
				subject: "payment timeout",
				channels: ["payments"],
				fresh: true,
			},
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(
			new Set(client.postRequests.map(({ channelId }) => channelId)),
		).toEqual(new Set(["channel-payments"]));
		expect(new Set(client.channelRequests)).toEqual(
			new Set(["channel-payments"]),
		);
		store.close();
	});

	test("enforces global and per-thread budgets without splitting messages", async () => {
		const store = await seededStore();
		const config = configFixture({
			budgets: {
				defaultMaxCharacters: 140,
				defaultPerThreadCharacters: 100,
				defaultMaxThreads: 3,
				moreMaxCharacters: 280,
				morePerThreadCharacters: 200,
				moreMaxThreads: 6,
			},
		});
		const result = await getMattermostContext(
			{ subject: "shared evidence", local: true },
			{ config, store },
		);
		expect(result.budget.used).toBeLessThanOrEqual(140);
		expect(result.threads.every(({ budget }) => budget.used <= 100)).toBe(true);
		expect(result.threads.some(({ omittedPosts }) => omittedPosts > 0)).toBe(
			true,
		);
		store.close();
	});
});

describe("thread command API", () => {
	test("supports around, more, full, and local thread retrieval", async () => {
		const store = await seededStore();
		const selected = await getMattermostThread(
			{ target: REPLY, local: true, around: REPLY, more: true },
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
});

async function seededStore(
	options: { fresh?: boolean } = {},
): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	const now = options.fresh ? 100 : 1;
	store.writePage({
		conversation: conversationFixture("payments", "channel-payments"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout shared evidence",
				create_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout reply",
				create_at: 20,
			}),
			postFixture({
				id: TAIL,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "follow-up evidence",
				create_at: 25,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: null,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: now,
			coverageComplete: false,
		},
	});
	store.writePage({
		conversation: conversationFixture("platform", "channel-platform"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: PLATFORM_ROOT,
				channel_id: "channel-platform",
				message: "deployment rollback shared evidence",
				create_at: 30,
			}),
		],
		checkpoint: {
			conversationId: "channel-platform",
			newestPostId: null,
			newestPostAt: 30,
			oldestCoveredAt: 30,
			lastSuccessAt: now,
			coverageComplete: true,
		},
	});
	store.writePage({
		conversation: {
			...conversationFixture("leads", "dm-leads"),
			kind: "direct_message",
		},
		posts: [],
		checkpoint: {
			conversationId: "dm-leads",
			newestPostId: null,
			newestPostAt: null,
			oldestCoveredAt: null,
			lastSuccessAt: now,
			coverageComplete: true,
		},
	});
	return store;
}

class FakeContextClient implements ContextClient {
	readonly posts = new Map<string, MattermostPost>();
	readonly postRequests: Array<{
		channelId: string;
		since?: number;
		page?: number;
	}> = [];
	readonly channelRequests: string[] = [];
	readonly threadRequests: string[] = [];
	readonly threads = new Map<string, MattermostPostList>();
	thread: MattermostPostList = list();

	async getChannelByName(
		_teamId: string,
		name: string,
	): Promise<MattermostChannel> {
		return channel(`channel-${name}`, name);
	}

	async getChannel(channelId: string): Promise<MattermostChannel> {
		this.channelRequests.push(channelId);
		return channel(
			channelId,
			channelId.replace(/^channel-/, ""),
			channelId.startsWith("dm-") ? "D" : "O",
		);
	}

	async getChannelPosts(
		channelId: string,
		options: { since?: number; page?: number } = {},
	): Promise<MattermostPostList> {
		this.postRequests.push({
			channelId,
			since: options.since,
			page: options.page,
		});
		return list();
	}

	async getUsersByIds(userIds: readonly string[]): Promise<MattermostUser[]> {
		return userIds.map((id) => userFixture({ id }));
	}

	async getFileInfo(fileId: string): Promise<MattermostFileInfo> {
		return {
			id: fileId,
			user_id: "user-1",
			post_id: ROOT,
			create_at: 1,
			update_at: 1,
			delete_at: 0,
			name: fileId,
			extension: "txt",
			size: 1,
			mime_type: "text/plain",
		};
	}

	async getPost(postId: string): Promise<MattermostPost> {
		const post = this.posts.get(postId);
		if (!post) throw new Error(`Missing fake post ${postId}`);
		return post;
	}

	async getThread(postId: string): Promise<MattermostPostList> {
		this.threadRequests.push(postId);
		return this.threads.get(postId) ?? this.thread;
	}
}

function throwingClient(): ContextClient {
	return new Proxy(
		{},
		{
			get() {
				return () => {
					throw new Error("Local mode made a network call");
				};
			},
		},
	) as ContextClient;
}

function channel(id: string, name: string, type = "O"): MattermostChannel {
	return {
		id,
		team_id: type === "D" ? "" : "team-id",
		type,
		name,
		display_name: name,
		header: "",
		purpose: "",
		delete_at: 0,
	};
}

function list(...posts: MattermostPost[]): MattermostPostList {
	return {
		order: posts.map(({ id }) => id),
		posts: Object.fromEntries(posts.map((post) => [post.id, post])),
	};
}
