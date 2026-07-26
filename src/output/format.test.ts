import { describe, expect, test } from "bun:test";
import { getMattermostContext } from "../context/index.ts";
import { commandSuccess } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { formatHumanResult } from "./format.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DECISION = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILLER = "eeeeeeeeeeeeeeeeeeeeeeeeee";
const TAIL = "cccccccccccccccccccccccccc";
const STUB_ROOT = "dddddddddddddddddddddddddd";

describe("human formatting", () => {
	test("--brief withholds the transcript and marks decision candidates", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", local: true, brief: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const text = formatHumanResult(
			commandSuccess("context", context, context.warnings),
		);

		expect(text).toContain("[decision candidate]");
		expect(text).toContain("будем не запрещать роли");
		expect(text).toMatch(/withheld \d+ message\(s\) \(brief projection\)/);
		// The withheld post is packed evidence, not a packing omission.
		expect(text).not.toContain("промежуточное сообщение");
		expect(text).toContain("omitted 0");

		const full = formatHumanResult(
			commandSuccess(
				"context",
				await getMattermostContext(
					{ subject: "BTB-1", local: true },
					{ config: configFixture(), store, now: () => 1_000 },
				),
				context.warnings,
			),
		);
		expect(full).toContain("промежуточное сообщение");
		expect(full.length).toBeGreaterThan(text.length);
		// The decision block names how settled it is, not just that one exists.
		expect(full).toContain("Decision candidates:");
		expect(full).toContain("[approved decision]");
		store.close();
	});

	test("--brief keeps the last post of a thread that yielded no brief", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", local: true, brief: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const text = formatHumanResult(
			commandSuccess("context", context, context.warnings),
		);

		// The stub thread has no decision candidate and no outcome window; showing
		// only a withheld count would read as an empty thread.
		expect(text).toContain("BTB-1 глянь пожалуйста");
		store.close();
	});

	test("prints the primary thread first with its retrieval rank", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const text = formatHumanResult(
			commandSuccess("context", context, context.warnings),
		);

		expect(context.threads.length).toBeGreaterThan(1);
		const primaryAt = text.indexOf("[primary]");
		const secondaryAt = text.indexOf("[secondary]");
		expect(primaryAt).toBeGreaterThan(-1);
		expect(secondaryAt).toBeGreaterThan(primaryAt);
		expect(text).toMatch(/\[primary\] · rank \d/);
		store.close();
	});

	test("collapses repeated packing strategies into a count", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const thread = context.threads[0];
		if (!thread) throw new Error("expected a selected thread");
		thread.selectionStrategy = [
			"root",
			"ticket_neighborhoods",
			"ticket_neighborhoods",
			"gap_fill",
		];
		const text = formatHumanResult(
			commandSuccess("context", context, context.warnings),
		);

		expect(text).toContain("strategy root, ticket_neighborhoods ×2, gap_fill");
		store.close();
	});
});

async function seededStore(): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture(),
		users: [userFixture()],
		posts: [
			postFixture({
				id: ROOT,
				message: "BTB-1 обсуждаем ограничения ролей",
				create_at: 10,
				update_at: 10,
			}),
			postFixture({
				id: FILLER,
				root_id: ROOT,
				message: "промежуточное сообщение про интеграцию",
				create_at: 15,
				update_at: 15,
			}),
			postFixture({
				id: DECISION,
				root_id: ROOT,
				message:
					"по BTB-1 решили: будем не запрещать роли, а разрешать остальным",
				create_at: 20,
				update_at: 20,
			}),
			postFixture({
				id: TAIL,
				root_id: ROOT,
				message: "подробности реализации обсудим отдельно",
				create_at: 30,
				update_at: 30,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: TAIL,
			newestPostAt: 30,
			oldestCoveredAt: 10,
			lastSuccessAt: 1_000,
			coverageComplete: true,
		},
	});
	store.writePage({
		conversation: conversationFixture("platform", "channel-platform"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: STUB_ROOT,
				channel_id: "channel-platform",
				message: "BTB-1 глянь пожалуйста",
				create_at: 40,
				update_at: 40,
			}),
		],
		checkpoint: {
			conversationId: "channel-platform",
			newestPostId: STUB_ROOT,
			newestPostAt: 40,
			oldestCoveredAt: 40,
			lastSuccessAt: 1_000,
			coverageComplete: true,
		},
	});
	return store;
}
