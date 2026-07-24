import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { resolveRelatedTicketPointers } from "./related-tickets.ts";
import type { ContextThread } from "./types.ts";

const SUBJECT_ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
/** Sorts after SUBJECT_ROOT so in-packet relationship wins when both exist. */
const RELATED_LATER = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
/** Sorts before SUBJECT_ROOT so out-of-packet relationship is chosen as best. */
const RELATED_FIRST = "00000000000000000000000000";

function packedThread(
	overrides: Partial<ContextThread> &
		Pick<ContextThread, "threadId" | "posts" | "conversationId">,
): ContextThread {
	return {
		conversationAlias: "payments",
		conversationKind: "channel",
		reasons: ["ticket_in_root"],
		matchingPostIds: [],
		latestActivityAt: 20,
		link: `https://chat.example.test/_redirect/pl/${overrides.threadId}`,
		selectionStrategy: ["match"],
		totalPosts: overrides.posts.length,
		returnedPosts: overrides.posts.length,
		omittedPosts: 0,
		returnedAttachments: 0,
		totalOmittedAttachments: 0,
		omittedAttachments: [],
		unreportedOmittedAttachments: 0,
		budget: {
			measurement: "unicode_code_points_in_rendered_post",
			limit: 1_000,
			used: 10,
		},
		timeline: overrides.posts.map((post) => ({
			kind: "post" as const,
			post: { ...post, renderedUnits: post.message.length },
		})),
		...overrides,
	};
}

function subjectThread(message: string): ContextThread {
	return packedThread({
		threadId: SUBJECT_ROOT,
		conversationId: "channel-payments",
		matchingPostIds: [SUBJECT_ROOT],
		posts: [
			{
				id: SUBJECT_ROOT,
				rootId: SUBJECT_ROOT,
				userId: "user-1",
				authorUsername: "alice",
				authorDisplayName: "Alice",
				createAt: 10,
				updateAt: 10,
				deleteAt: 0,
				message,
				attachments: [],
				renderedUnits: message.length,
			},
		],
	});
}

describe("resolveRelatedTicketPointers", () => {
	test("sets alreadyInPacket when projected threadId is already selected", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: SUBJECT_ROOT,
					message: "BTB-100 also linked to BTB-200 for checkout",
					create_at: 10,
					update_at: 10,
				}),
				postFixture({
					id: RELATED_LATER,
					message: "BTB-200 checkout regression",
					create_at: 5,
					update_at: 5,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: SUBJECT_ROOT,
				newestPostAt: 10,
				oldestCoveredAt: 5,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});

		const pointers = resolveRelatedTicketPointers({
			config: configFixture(),
			store,
			threads: [subjectThread("BTB-100 also linked to BTB-200 for checkout")],
			subjectTicket: "BTB-100",
			allowlist: new Set(["channel-payments"]),
		});

		expect(pointers).toEqual([
			expect.objectContaining({
				key: "BTB-200",
				threadId: SUBJECT_ROOT,
				sourceThreadId: SUBJECT_ROOT,
				alreadyInPacket: true,
				hydrated: false,
			}),
		]);
		store.close();
	});

	test("omits alreadyInPacket when bestThreadId resolves outside the packet", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: SUBJECT_ROOT,
					message: "BTB-100 also linked to BTB-200 for checkout",
					create_at: 10,
					update_at: 10,
				}),
				postFixture({
					id: RELATED_FIRST,
					message: "BTB-200 checkout regression",
					create_at: 5,
					update_at: 5,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: SUBJECT_ROOT,
				newestPostAt: 10,
				oldestCoveredAt: 5,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});

		const pointers = resolveRelatedTicketPointers({
			config: configFixture(),
			store,
			threads: [subjectThread("BTB-100 also linked to BTB-200 for checkout")],
			subjectTicket: "BTB-100",
			allowlist: new Set(["channel-payments"]),
		});

		expect(pointers).toEqual([
			expect.objectContaining({
				key: "BTB-200",
				threadId: RELATED_FIRST,
				sourceThreadId: SUBJECT_ROOT,
				hydrated: false,
			}),
		]);
		expect(pointers[0]?.alreadyInPacket).toBeUndefined();
		store.close();
	});

	test("sets alreadyInPacket for source-only pointers without a resolved thread", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: SUBJECT_ROOT,
					message: "BTB-100 also linked to BTB-200 for checkout",
					create_at: 10,
					update_at: 10,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: SUBJECT_ROOT,
				newestPostAt: 10,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});

		const pointers = resolveRelatedTicketPointers({
			config: configFixture(),
			store,
			threads: [subjectThread("BTB-100 also linked to BTB-200 for checkout")],
			subjectTicket: "BTB-100",
			// Empty allowlist → no resolved bestThreadId; excerpt stays the mention.
			allowlist: new Set(),
		});

		expect(pointers).toEqual([
			expect.objectContaining({
				key: "BTB-200",
				sourceThreadId: SUBJECT_ROOT,
				alreadyInPacket: true,
				hydrated: false,
			}),
		]);
		expect(pointers[0]?.threadId).toBeUndefined();
		store.close();
	});
});
