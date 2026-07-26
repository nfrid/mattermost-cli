import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { getMattermostContext } from "./index.ts";
import { FakeContextClient } from "./test-helpers.ts";

const TICKET_ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESIGN_ROOT = "cccccccccccccccccccccccccc";
const DESIGN_REPLY = "dddddddddddddddddddddddddd";
const OUTSIDE_ROOT = "ffffffffffffffffffffffffff";

/**
 * A ticket in `payments`, an unrelated design thread in `platform` that never
 * names the ticket, and a post in a conversation that is not configured at all.
 */
async function seededStore(): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture("payments", "channel-payments"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: TICKET_ROOT,
				channel_id: "channel-payments",
				message: "BTB-1 duplicate charge on retry",
				create_at: 1_000,
			}),
		],
	});
	store.writePage({
		conversation: conversationFixture("platform", "channel-platform"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: DESIGN_ROOT,
				channel_id: "channel-platform",
				message: "designing idempotency keys",
				create_at: 10,
			}),
			postFixture({
				id: DESIGN_REPLY,
				root_id: DESIGN_ROOT,
				channel_id: "channel-platform",
				message: "keys must survive a retry storm",
				create_at: 20,
			}),
		],
	});
	store.writePage({
		conversation: conversationFixture("secret", "channel-secret"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: OUTSIDE_ROOT,
				channel_id: "channel-secret",
				message: "not configured",
				create_at: 30,
			}),
		],
	});
	return store;
}

describe("--permalink targets", () => {
	test("folds a link into the packet even when it never names the ticket", async () => {
		// Two permalinks in a ticket description used to cost two extra processes
		// and manual reconciliation against the ticket packet.
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				permalinks: [
					`https://chat.example.test/_redirect/pl/${DESIGN_REPLY}`,
					TICKET_ROOT,
				],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(context.permalinks).toEqual([
			{
				input: `https://chat.example.test/_redirect/pl/${DESIGN_REPLY}`,
				postId: DESIGN_REPLY,
				threadId: DESIGN_ROOT,
				conversationId: "channel-platform",
				status: "resolved",
				packed: true,
			},
			{
				input: TICKET_ROOT,
				postId: TICKET_ROOT,
				threadId: TICKET_ROOT,
				conversationId: "channel-payments",
				status: "resolved",
				packed: true,
			},
		]);
		expect(context.threads.map(({ threadId }) => threadId)).toContain(
			DESIGN_ROOT,
		);
		store.close();
	});

	test("reports one refused link without costing the caller the rest", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				permalinks: [OUTSIDE_ROOT, DESIGN_REPLY],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);
		const [refused, allowed] = context.permalinks ?? [];

		expect(refused).toMatchObject({
			input: OUTSIDE_ROOT,
			status: "not_allowed",
			reason: "conversation_not_allowed",
		});
		expect(allowed).toMatchObject({ status: "resolved" });
		expect(context.threads.map(({ threadId }) => threadId)).toContain(
			DESIGN_ROOT,
		);
		store.close();
	});

	test("rejects a remotely resolved post outside the configured allowlist", async () => {
		const store = await seededStore();
		const client = new FakeContextClient();
		client.posts.set(
			OUTSIDE_ROOT,
			postFixture({
				id: OUTSIDE_ROOT,
				channel_id: "channel-secret",
				message: "remote content must not cross the allowlist",
			}),
		);
		const context = await getMattermostContext(
			{ subject: "BTB-1", permalinks: [OUTSIDE_ROOT], fresh: true },
			{ config: configFixture(), store, client, now: () => 2_000 },
		);

		expect(context.permalinks?.[0]).toMatchObject({
			postId: OUTSIDE_ROOT,
			status: "not_allowed",
			details: {
				reason: "not_configured",
				postId: OUTSIDE_ROOT,
			},
		});
		expect(context.permalinks?.[0]?.details).not.toHaveProperty(
			"conversationId",
		);
		store.close();
	});

	test("keeps an explicit --channel restriction over an explicit link", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				channels: ["payments"],
				permalinks: [DESIGN_REPLY],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(context.permalinks?.[0]).toMatchObject({ status: "not_allowed" });
		expect(context.threads.map(({ threadId }) => threadId)).not.toContain(
			DESIGN_ROOT,
		);
		store.close();
	});

	test("reports every repeated or invalid input in argument order", async () => {
		const store = await seededStore();
		const padded = `  ${DESIGN_REPLY}  `;
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				permalinks: [
					padded,
					DESIGN_REPLY,
					`https://chat.example.test/_redirect/pl/${DESIGN_ROOT}`,
					"BTB-9",
					" ",
				],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(
			context.permalinks?.map(({ input, status, reason }) => ({
				input,
				status,
				reason,
			})),
		).toEqual([
			{ input: padded, status: "resolved", reason: undefined },
			{ input: DESIGN_REPLY, status: "duplicate", reason: "duplicate_input" },
			{
				input: `https://chat.example.test/_redirect/pl/${DESIGN_ROOT}`,
				status: "duplicate",
				reason: undefined,
			},
			{
				input: "BTB-9",
				status: "invalid",
				reason: "not_a_permalink_or_post_id",
			},
			{ input: " ", status: "invalid", reason: "empty_permalink" },
		]);
		expect(
			context.threads.filter(({ threadId }) => threadId === DESIGN_ROOT),
		).toHaveLength(1);
		store.close();
	});

	test("a post subject plus a link in another thread still returns a packet", async () => {
		// The subject post is required of its own thread only. Demanding it of a
		// linked thread failed the whole request over a link nobody claimed was
		// there — the opposite of the per-link failure this feature promises.
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: TICKET_ROOT, permalinks: [DESIGN_REPLY], local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(context.permalinks?.[0]).toMatchObject({
			status: "resolved",
			packed: true,
		});
		expect(context.threads.map(({ threadId }) => threadId)).toContain(
			TICKET_ROOT,
		);
		store.close();
	});

	test("a --channel refusal points at the flag, not at a config owner", async () => {
		const store = await seededStore();
		const restricted = await getMattermostContext(
			{
				subject: "BTB-1",
				channels: ["payments"],
				permalinks: [DESIGN_REPLY],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);
		const unconfigured = await getMattermostContext(
			{ subject: "BTB-1", permalinks: [OUTSIDE_ROOT], local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(restricted.permalinks?.[0]?.details).toMatchObject({
			reason: "channel_restriction",
			postId: DESIGN_REPLY,
			conversationId: "channel-platform",
			conversationAlias: "platform",
			restrictionSource: "cli",
			restrictedTo: ["payments"],
		});
		expect(
			String(restricted.permalinks?.[0]?.details?.recommendedAction),
		).toContain("--channel");
		// A conversation that is not configured at all names no channel id.
		expect(unconfigured.permalinks?.[0]?.details).toMatchObject({
			reason: "not_configured",
		});
		expect(unconfigured.permalinks?.[0]?.details).not.toHaveProperty(
			"conversationId",
		);
		store.close();
	});

	test("warns when explicit links fill the packet and crowd out the subject", async () => {
		const store = await seededStore();
		const extra: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const id = `${String.fromCharCode(103 + index).repeat(26)}`;
			extra.push(id);
			store.writePage({
				conversation: conversationFixture("platform", "channel-platform"),
				users: [userFixture()],
				posts: [
					postFixture({
						id,
						channel_id: "channel-platform",
						message: `unrelated design note ${index}`,
						create_at: 100 + index,
					}),
				],
			});
		}
		const context = await getMattermostContext(
			{ subject: "BTB-1", permalinks: extra, local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(context.threads).toHaveLength(3);
		expect(
			context.warnings.some(
				({ kind }) => kind === "permalink_crowded_out_ranked",
			),
		).toBe(true);
		store.close();
	});

	test("leaves the packet untouched when no permalink is passed", async () => {
		const store = await seededStore();
		const config = configFixture();
		const plain = await getMattermostContext(
			{ subject: "BTB-1", local: true },
			{ config, store, now: () => 2_000 },
		);

		expect(plain.permalinks).toBeUndefined();
		expect(plain.threads.map(({ threadId }) => threadId)).not.toContain(
			DESIGN_ROOT,
		);
		store.close();
	});

	test("brief mode keeps a meaningful permalink pack beside a fat ticket sibling", async () => {
		// Live smoke (BTB-2080): permalink packed as 1/26 under ticket --agent brief
		// while a discovery sibling took 32/32. Root cause was ticket-window + brief
		// historical-neighbor crush, not character-budget floor alone.
		const store = await MattermostStore.open(":memory:");
		const ticketRoot = "t0t0t0t0t0t0t0t0t0t0t0t0t0";
		const permalinkRoot = "p0p0p0p0p0p0p0p0p0p0p0p0p0";
		const permalinkHit = "p1p1p1p1p1p1p1p1p1p1p1p1p1";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			posts: [
				postFixture({
					id: ticketRoot,
					channel_id: "channel-payments",
					message: "BTB-2080 kickoff with action_id confusion",
					create_at: 1_000,
				}),
				...Array.from({ length: 30 }, (_, index) =>
					postFixture({
						id: `d${String(index).padStart(25, "0")}`,
						root_id: ticketRoot,
						channel_id: "channel-payments",
						message: `BTB-2080 discovery detail ${index} ${"y".repeat(40)}`,
						create_at: 1_100 + index,
					}),
				),
				postFixture({
					id: "dzzzzzzzzzzzzzzzzzzzzzzzz",
					root_id: ticketRoot,
					channel_id: "channel-payments",
					message: "BTB-2080 resolved on discovery thread",
					create_at: 2_000,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: "dzzzzzzzzzzzzzzzzzzzzzzzz",
				newestPostAt: 2_000,
				oldestCoveredAt: 1_000,
				lastSuccessAt: 2_000,
				coverageComplete: true,
			},
		});
		store.linkTicketThread("BTB-2080", ticketRoot, ticketRoot, "explicit");
		const permalinkPosts = [
			postFixture({
				id: permalinkRoot,
				channel_id: "channel-platform",
				message: "promo engine design kickoff",
				create_at: 10,
			}),
			...Array.from({ length: 20 }, (_, index) =>
				postFixture({
					id: `m${String(index).padStart(25, "0")}`,
					root_id: permalinkRoot,
					channel_id: "channel-platform",
					message: `design discussion ${index}`,
					create_at: 20 + index,
				}),
			),
			postFixture({
				id: permalinkHit,
				root_id: permalinkRoot,
				channel_id: "channel-platform",
				message: "decision: action_id is the promo code",
				create_at: 50,
			}),
			postFixture({
				id: "mttttttttttttttttttttttttt",
				root_id: permalinkRoot,
				channel_id: "channel-platform",
				message: "ack, shipping that",
				create_at: 60,
			}),
			postFixture({
				id: "muuuuuuuuuuuuuuuuuuuuuuuuu",
				root_id: permalinkRoot,
				channel_id: "channel-platform",
				message: "follow-up note",
				create_at: 70,
			}),
			postFixture({
				id: "mvvvvvvvvvvvvvvvvvvvvvvvvv",
				root_id: permalinkRoot,
				channel_id: "channel-platform",
				message: "closing",
				create_at: 80,
			}),
			postFixture({
				id: "mwwwwwwwwwwwwwwwwwwwwwwwww",
				root_id: permalinkRoot,
				channel_id: "channel-platform",
				message: "done",
				create_at: 90,
			}),
		];
		expect(permalinkPosts).toHaveLength(26);
		store.writePage({
			conversation: conversationFixture("platform", "channel-platform"),
			users: [userFixture()],
			posts: permalinkPosts,
			checkpoint: {
				conversationId: "channel-platform",
				newestPostId: "mwwwwwwwwwwwwwwwwwwwwwwwww",
				newestPostAt: 90,
				oldestCoveredAt: 10,
				lastSuccessAt: 2_000,
				coverageComplete: true,
			},
		});

		const context = await getMattermostContext(
			{
				subject: "BTB-2080",
				permalinks: [permalinkHit],
				brief: true,
				local: true,
			},
			{
				config: configFixture({
					budgets: {
						...configFixture().budgets,
						defaultMaxCharacters: 24_000,
						defaultPerThreadCharacters: 8_000,
						defaultMaxThreads: 3,
					},
				}),
				store,
				now: () => 3_000,
			},
		);

		const permalink = context.threads.find(
			({ threadId }) => threadId === permalinkRoot,
		);
		const discovery = context.threads.find(
			({ threadId }) => threadId === ticketRoot,
		);
		expect(permalink).toBeDefined();
		expect(discovery).toBeDefined();
		expect(permalink?.reasons).toContain("direct_post");
		expect(permalink?.historicalNeighbor).toBeUndefined();
		expect(permalink?.totalPosts).toBe(26);
		// Must not collapse to the pre-fix 1/26 stub under brief + fat sibling.
		expect(permalink?.returnedPosts ?? 0).toBeGreaterThanOrEqual(8);
		expect(permalink?.posts.some(({ id }) => id === permalinkHit)).toBe(true);
		expect(discovery?.returnedPosts ?? 0).toBeGreaterThan(1);
		store.close();
	});
});
