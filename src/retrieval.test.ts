import { describe, expect, test } from "bun:test";
import {
	classifySubject,
	configuredConversations,
	resolveProbes,
	routeConversations,
	searchThreads,
	widenedRouting,
} from "./retrieval.ts";
import { MattermostStore } from "./storage.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "./test-fixtures.ts";

describe("subject and probe resolution", () => {
	test("classifies explicit ticket, permalink, raw post ID, positional ticket, and text in order", () => {
		const postId = "abcdefghijklmnopqrstuvwx12";
		expect(
			classifySubject(`https://chat.test/team/pl/${postId}`, "proj-7"),
		).toMatchObject({
			kind: "ticket",
			ticketKey: "PROJ-7",
		});
		expect(
			classifySubject(`https://chat.test/team/pl/${postId}`),
		).toMatchObject({
			kind: "post",
			postId,
			source: "permalink",
		});
		expect(classifySubject(postId)).toMatchObject({ kind: "post", postId });
		expect(classifySubject("proj-1777")).toMatchObject({
			kind: "ticket",
			ticketKey: "PROJ-1777",
		});
		expect(classifySubject("payment timeout")).toEqual({
			kind: "text",
			text: "payment timeout",
			raw: "payment timeout",
		});
	});

	test("adds repeated probes to the subject and normalizes phrases and terms", () => {
		const subject = classifySubject("fallback text");
		expect(
			resolveProbes(subject, ['"payment timeout" API', "billing retry"]),
		).toEqual([
			{
				value: "fallback text",
				phrases: [],
				terms: ["fallback", "text"],
			},
			{
				value: '"payment timeout" API',
				phrases: ["payment timeout"],
				terms: ["payment", "timeout", "api"],
			},
			{
				value: "billing retry",
				phrases: [],
				terms: ["billing", "retry"],
			},
		]);
	});

	test("filters Russian stop words and normalizes Cyrillic case and ё", () => {
		const subject = classifySubject("Что это за платёж и почему он не прошёл");
		expect(resolveProbes(subject)).toEqual([
			{
				value: "Что это за платёж и почему он не прошёл",
				phrases: [],
				terms: ["платеж", "прошел"],
			},
		]);
	});
});

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

	test("groups reply matches by thread and ranks named signals deterministically", async () => {
		const store = await MattermostStore.open(":memory:");
		const config = configFixture();
		const payments = conversationFixture("payments", "channel-payments");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: payments,
			users: [userFixture()],
			posts: [
				postFixture({
					id: "rootpaymentsabcdefghijkl",
					channel_id: payments.id,
					message: "PROJ-1777 payment timeout",
					create_at: 10,
				}),
				postFixture({
					id: "replypaymentsabcdefghijk",
					root_id: "rootpaymentsabcdefghijkl",
					channel_id: payments.id,
					message: "payment timeout reproduced",
					create_at: 20,
				}),
			],
		});
		store.linkTicketThread(
			"PROJ-1777",
			"rootpaymentsabcdefghijkl",
			"rootpaymentsabcdefghijkl",
			"explicit",
		);
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "rootplatformabcdefghijkl",
					channel_id: platform.id,
					message: "payment timeout",
					create_at: 30,
				}),
			],
		});
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("PROJ-1777");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject, ["payment timeout"]),
			routing,
		);

		expect(candidates).toHaveLength(2);
		expect(candidates[0]).toMatchObject({
			threadId: "rootpaymentsabcdefghijkl",
			matchingPostIds: ["replypaymentsabcdefghijk", "rootpaymentsabcdefghijkl"],
		});
		expect(candidates[0]?.reasons).toEqual(
			expect.arrayContaining([
				"explicit_ticket_relationship",
				"ticket_in_root",
				"exact_phrase",
				"all_terms_in_thread",
				"conversation_priority",
			]),
		);
		expect(candidates[1]?.threadId).toBe("rootplatformabcdefghijkl");
		store.close();
	});
});

function seedConversation(
	store: MattermostStore,
	alias: string,
	id: string,
	kind: "channel" | "direct_message",
): void {
	store.writePage({
		conversation: { ...conversationFixture(alias, id), kind },
		posts: [],
	});
}
