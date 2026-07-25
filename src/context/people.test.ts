import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { getMattermostContext } from "./index.ts";
import { getMattermostPeople, listPeople } from "./people.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("people", () => {
	test("prefers the Mattermost profile title over a config override", async () => {
		const store = await seededStore();
		const people = listPeople(
			configFixture({ people: { alice: "Продукт", bob: "Бэкенд" } }),
			store,
		);

		expect(people).toEqual([
			{
				username: "alice",
				displayName: "Alice Example",
				role: "Engineering Manager",
				roleSource: "profile",
				messages: 1,
				latestAt: 10,
			},
			{
				username: "bob",
				displayName: "Bob Example",
				role: "Бэкенд",
				roleSource: "config",
				messages: 1,
				latestAt: 20,
			},
		]);
		store.close();
	});

	test("context lists the authors of the packed posts", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-8", local: true },
			{
				config: configFixture({ people: { bob: "Бэкенд" } }),
				store,
				now: () => 1_000,
			},
		);

		expect(
			context.people?.map(({ username, role }) => [username, role]),
		).toEqual([
			["alice", "Engineering Manager"],
			["bob", "Бэкенд"],
		]);
		store.close();
	});

	test("never lists authors from conversations outside the allowlist", async () => {
		const store = await seededStore();
		store.writePage({
			conversation: conversationFixture("legacy", "channel-legacy"),
			users: [
				userFixture({
					id: "user-3",
					username: "carol",
					first_name: "Carol",
					last_name: "Example",
				}),
			],
			posts: [
				postFixture({
					id: "eeeeeeeeeeeeeeeeeeeeeeeeee",
					channel_id: "channel-legacy",
					user_id: "user-3",
					message: "старое сообщение",
					create_at: 30,
					update_at: 30,
				}),
			],
			checkpoint: {
				conversationId: "channel-legacy",
				newestPostId: "eeeeeeeeeeeeeeeeeeeeeeeeee",
				newestPostAt: 30,
				oldestCoveredAt: 30,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});

		// `legacy` is indexed but absent from the config allowlist.
		const listed = await getMattermostPeople(
			{},
			{ config: configFixture(), store },
		);

		expect(listed.people.map(({ username }) => username)).not.toContain(
			"carol",
		);
		expect(listed.conversations).toContain("payments");
		store.close();
	});

	test("scopes activity counts to the requested conversations", async () => {
		const store = await seededStore();
		const scoped = listPeople(configFixture(), store, {
			conversationIds: ["channel-platform"],
		});

		expect(scoped).toEqual([]);
		store.close();
	});
});

async function seededStore(): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture(),
		users: [
			userFixture({ position: "Engineering Manager" }),
			userFixture({
				id: "user-2",
				username: "bob",
				first_name: "Bob",
				last_name: "Example",
			}),
		],
		posts: [
			postFixture({
				id: ROOT,
				message: "BTB-8 старт",
				create_at: 10,
				update_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				user_id: "user-2",
				message: "BTB-8 посмотрю",
				create_at: 20,
				update_at: 20,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: REPLY,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: 1_000,
			coverageComplete: true,
		},
	});
	return store;
}
