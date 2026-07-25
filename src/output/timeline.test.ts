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
import { projectAgentResult } from "./agent-view.ts";
import { formatHumanResult } from "./format.ts";
import { buildCrossThreadTimeline } from "./timeline.ts";

const DM_ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DM_REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_ROOT = "cccccccccccccccccccccccccc";

describe("cross-thread timeline", () => {
	test("interleaves threads by time instead of by rank", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-7", local: true, timeline: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as {
			timeline: Array<{ at: string; conversation: string; postId?: string }>;
			threads: Array<{ posts?: unknown; brief?: unknown }>;
		};

		expect(result.timeline.map(({ postId }) => postId)).toEqual([
			DM_ROOT,
			DM_REPLY,
			CHANNEL_ROOT,
		]);
		// The breakage report is last in time even though its thread ranks first.
		expect(result.timeline.at(-1)?.conversation).toBe("payments");
		// Messages travel once: per-thread transcripts are dropped, briefs stay.
		expect(result.threads.every((thread) => thread.posts === undefined)).toBe(
			true,
		);
		store.close();
	});

	test("prose prints one merged chronology with conversation tags", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-7", local: true, timeline: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const text = formatHumanResult(
			commandSuccess("context", context, context.warnings),
		);

		expect(text).toContain("Timeline across threads");
		expect(text.indexOf("катим BTB-7")).toBeLessThan(
			text.indexOf("транзакций не создано"),
		);
		expect(text).toContain("[platform]");
		store.close();
	});

	test("places a leading skip next to the post it precedes, not at the epoch", () => {
		const thread = {
			threadId: "t1",
			conversationAlias: "payments",
			conversationKind: "channel" as const,
			reasons: [],
			omittedPosts: 4,
			posts: [],
			timeline: [
				{ kind: "skip" as const, skip: { posts: 4, before: "p9" } },
				{
					kind: "post" as const,
					post: {
						id: "p9",
						rootId: "t1",
						userId: "u1",
						authorUsername: "alice",
						authorDisplayName: "alice",
						createAt: 5_000,
						updateAt: 5_000,
						deleteAt: 0,
						message: "хвост треда",
						attachments: [],
						renderedUnits: 10,
					},
				},
			],
		} as unknown as Parameters<typeof buildCrossThreadTimeline>[0][number];

		const entries = buildCrossThreadTimeline([thread]);

		expect(entries[0]).toMatchObject({ at: "1970-01-01T00:00:05.000Z" });
		expect("skip" in (entries[0] ?? {})).toBe(true);
	});

	test("--timeline --brief merges only the decision layer", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-7", local: true, timeline: true, brief: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as { timeline: Array<{ postId?: string }> };

		const ids = result.timeline.map(({ postId }) => postId);
		expect(ids).toContain(DM_REPLY);
		expect(ids).not.toContain(DM_ROOT);
		store.close();
	});
});

async function seededStore(): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture("platform", "channel-platform"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: DM_ROOT,
				channel_id: "channel-platform",
				message: "BTB-7 посмотрели, там всё работает",
				create_at: 10,
				update_at: 10,
			}),
			postFixture({
				id: DM_REPLY,
				channel_id: "channel-platform",
				root_id: DM_ROOT,
				message: "решили: катим BTB-7",
				create_at: 20,
				update_at: 20,
			}),
		],
		checkpoint: {
			conversationId: "channel-platform",
			newestPostId: DM_REPLY,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: 1_000,
			coverageComplete: true,
		},
	});
	store.writePage({
		conversation: conversationFixture(),
		users: [userFixture()],
		posts: [
			postFixture({
				id: CHANNEL_ROOT,
				message: "BTB-7 проверили на проде: транзакций не создано вообще",
				create_at: 30,
				update_at: 30,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: CHANNEL_ROOT,
			newestPostAt: 30,
			oldestCoveredAt: 30,
			lastSuccessAt: 1_000,
			coverageComplete: true,
		},
	});
	return store;
}
