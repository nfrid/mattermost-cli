import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	seedConversation,
} from "../test-fixtures.ts";
import {
	configuredConversations,
	routeConversations,
	widenedRouting,
} from "./index.ts";

describe("routing and ranking", () => {
	test("applies hard explicit routing and one-time metadata/ticket fallbacks", async () => {
		const store = await MattermostStore.open(":memory:");
		const config = configFixture();
		seedConversation(store, "payments", "channel-payments", "channel");
		seedConversation(store, "platform", "channel-platform", "channel");
		seedConversation(store, "leads", "dm-leads", "direct_message");
		const ticketPost = postFixture({
			id: "ticketrootabcdefghijklmnop",
			channel_id: "channel-platform",
			message: "PROJ-1777 rollout",
		});
		store.writePage({
			conversation: conversationFixture("platform", "channel-platform"),
			posts: [ticketPost],
		});
		const all = configuredConversations(config, store);

		const explicit = routeConversations(config, store, all, {
			channels: ["payments"],
			scopes: ["platform", "unmapped-scope"],
		});
		expect(explicit.conversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		expect(explicit.canWiden).toBe(false);
		expect(explicit.explicitChannelPolicy).toBe("restrict");
		expect(explicit.unmatchedHints.scopes).toEqual(["unmapped-scope"]);

		const scoped = routeConversations(config, store, all, {
			scopes: ["platform"],
		});
		expect(scoped.conversations.map(({ alias }) => alias)).toEqual([
			"platform",
		]);
		expect(
			widenedRouting(all, scoped).conversations.map(({ alias }) => alias),
		).toEqual(["payments", "leads"]);

		const repository = routeConversations(config, store, all, {
			repositories: ["payment", "unmapped-repository"],
		});
		expect(repository.reason).toBe("repositories");
		expect(repository.conversations[0]?.alias).toBe("payments");
		expect(repository.unmatchedHints).toEqual({
			scopes: [],
			repositories: ["unmapped-repository"],
		});
		expect(widenedRouting(all, repository).unmatchedHints).toEqual(
			repository.unmatchedHints,
		);

		const ticket = routeConversations(config, store, all, {
			ticketKey: "PROJ-1777",
		});
		expect(ticket.reason).toBe("ticket_relationships");
		expect(ticket.conversations.map(({ alias }) => alias)).toEqual([
			"platform",
		]);
		store.close();
	});

	test("treats current configured IDs as authoritative over stale alias rows", async () => {
		const store = await MattermostStore.open(":memory:");
		seedConversation(store, "payments", "channel-old", "channel");
		seedConversation(store, "leads", "dm-old", "direct_message");
		const all = configuredConversations(configFixture(), store);
		expect(all.find(({ alias }) => alias === "payments")?.id).toBe(
			"channel-payments",
		);
		expect(all.find(({ alias }) => alias === "leads")?.id).toBe("dm-leads");
		expect(all.map(({ id }) => id)).not.toContain("channel-old");
		expect(all.map(({ id }) => id)).not.toContain("dm-old");
		store.close();
	});
});
