import { describe, expect, test } from "bun:test";
import { getMattermostContext, searchMattermost } from "../context/index.ts";
import { projectAgentResult } from "../output/agent-view.ts";
import { commandSuccess } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";

const BOT_ROOT = "cccccccccccccccccccccccccc";
const HUMAN_ROOT = "dddddddddddddddddddddddddd";
const PRIOR = "eeeeeeeeeeeeeeeeeeeeeeeeee";
const TICKET_ROOT = "ffffffffffffffffffffffffff";

describe("automation and surround selection", () => {
	test("suppresses unreplied bot roots but keeps bot roots with replies", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [
				userFixture(),
				userFixture({
					id: "bot-1",
					username: "duty-bot",
					first_name: "Duty",
					last_name: "Bot",
					is_bot: true,
				}),
			],
			posts: [
				postFixture({
					id: BOT_ROOT,
					user_id: "bot-1",
					message: "Новое обращение! TECHSUPP-1",
					create_at: 10,
					update_at: 10,
				}),
				postFixture({
					id: "gggggggggggggggggggggggggg",
					user_id: "bot-1",
					message: "Задачу взяли TECHSUPP-1",
					create_at: 20,
					update_at: 20,
				}),
				postFixture({
					id: "hhhhhhhhhhhhhhhhhhhhhhhhhh",
					root_id: BOT_ROOT,
					user_id: "user-1",
					message: "looking at TECHSUPP-1 now",
					create_at: 30,
					update_at: 30,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: "hhhhhhhhhhhhhhhhhhhhhhhhhh",
				newestPostAt: 30,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});

		const hidden = await searchMattermost(
			{ subject: "TECHSUPP-1", channels: ["payments"] },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		expect(hidden.candidates.map(({ threadId }) => threadId)).toEqual([
			BOT_ROOT,
		]);

		const included = await searchMattermost(
			{
				subject: "TECHSUPP-1",
				channels: ["payments"],
				includeAutomation: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		expect(included.candidates.map(({ threadId }) => threadId).sort()).toEqual(
			["gggggggggggggggggggggggggg", BOT_ROOT].sort(),
		);
		store.close();
	});

	test("adds DM conversation surround for short ticket threads", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: {
				id: "dm-leads",
				alias: "leads",
				kind: "direct_message",
				name: "leads",
				description: "Leads",
			},
			users: [userFixture()],
			posts: [
				postFixture({
					id: PRIOR,
					channel_id: "dm-leads",
					message: "у нас сломалось подтверждение смен для КС",
					create_at: 10,
					update_at: 10,
				}),
				postFixture({
					id: HUMAN_ROOT,
					channel_id: "dm-leads",
					message: "давай посмотрим логи",
					create_at: 20,
					update_at: 20,
				}),
				postFixture({
					id: TICKET_ROOT,
					channel_id: "dm-leads",
					message: "завела https://tracker.yandex.ru/BTB-9999",
					create_at: 30,
					update_at: 30,
				}),
			],
			checkpoint: {
				conversationId: "dm-leads",
				newestPostId: TICKET_ROOT,
				newestPostAt: 30,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});

		const context = await getMattermostContext(
			{ subject: "BTB-9999", channels: ["leads"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		expect(context.threads).toHaveLength(1);
		expect(context.threads[0]?.threadId).toBe(TICKET_ROOT);
		expect(context.threads[0]?.surround?.map(({ id }) => id)).toEqual([
			PRIOR,
			HUMAN_ROOT,
		]);

		const agent = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		expect(agent).toMatchObject({
			threads: [
				{
					threadId: TICKET_ROOT,
					surround: [
						{
							author: "alice",
							messages: [{ id: PRIOR }, { id: HUMAN_ROOT }],
						},
					],
				},
			],
		});
		store.close();
	});
});
