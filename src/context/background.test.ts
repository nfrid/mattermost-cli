import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { getMattermostContext } from "./index.ts";

const TICKET_ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESIGN_ROOT = "cccccccccccccccccccccccccc";
const DESIGN_REPLY = "dddddddddddddddddddddddddd";

/**
 * A ticket lives in `payments`; the design discussion that predates it lives in
 * `platform`, which the ticket relationship never routes to.
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
				message: "designing idempotency keys for retries",
				create_at: 10,
			}),
			postFixture({
				id: DESIGN_REPLY,
				root_id: DESIGN_ROOT,
				channel_id: "channel-platform",
				message: "idempotency keys must survive a retry storm",
				create_at: 20,
			}),
		],
	});
	return store;
}

describe("background threads", () => {
	test("reaches thematically close threads outside ticket routing", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				queries: ["idempotency keys"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);
		expect(
			context.threads.map(({ conversationAlias }) => conversationAlias),
		).toEqual(["payments"]);
		expect(context.background?.map(({ threadId }) => threadId)).toEqual([
			DESIGN_ROOT,
		]);
		const [pointer] = context.background ?? [];
		expect(pointer?.conversationAlias).toBe("platform");
		expect(pointer?.matchedProbes).toEqual(["idempotency keys"]);
		expect(pointer?.excerpts.length).toBeGreaterThan(0);
		store.close();
	});

	test("stays absent without explicit probes and leaves the packet untouched", async () => {
		const store = await seededStore();
		const config = configFixture();
		const plain = await getMattermostContext(
			{ subject: "BTB-1", local: true },
			{ config, store, now: () => 2_000 },
		);
		const probed = await getMattermostContext(
			{ subject: "BTB-1", queries: ["idempotency keys"], local: true },
			{ config, store, now: () => 2_000 },
		);
		expect(plain.background).toBeUndefined();
		expect(probed.threads).toEqual(plain.threads);
		expect(probed.selection).toEqual(plain.selection);
		store.close();
	});

	test("never repeats a thread that is already selected", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				queries: ["duplicate charge"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);
		const selected = new Set(context.threads.map(({ threadId }) => threadId));
		for (const pointer of context.background ?? []) {
			expect(selected.has(pointer.threadId)).toBe(false);
		}
		store.close();
	});
});
