import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import {
	findTrackerUrlBesideKey,
	resolveRelatedTicketPointers,
} from "./related-tickets.ts";
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
				unresolvableTracker: true,
			}),
		]);
		expect(pointers[0]?.threadId).toBeUndefined();
		expect(pointers[0]?.url).toBeUndefined();
		expect(pointers[0]?.trackerUrl).toBeUndefined();
		store.close();
	});

	test("attaches trackerUrl when a tracker link co-occurs and no MM thread resolves", async () => {
		const store = await MattermostStore.open(":memory:");
		const message =
			"BTB-100 also linked to BTB-200 https://tracker.example/BTB-200 for checkout";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: SUBJECT_ROOT,
					message,
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
			threads: [subjectThread(message)],
			subjectTicket: "BTB-100",
			allowlist: new Set(),
		});

		expect(pointers).toEqual([
			expect.objectContaining({
				key: "BTB-200",
				sourceThreadId: SUBJECT_ROOT,
				alreadyInPacket: true,
				trackerUrl: "https://tracker.example/BTB-200",
			}),
		]);
		expect(pointers[0]?.threadId).toBeUndefined();
		expect(pointers[0]?.url).toBeUndefined();
		expect(pointers[0]?.unresolvableTracker).toBeUndefined();
		store.close();
	});

	test("keeps Mattermost url separate when trackerUrl co-occurs on a resolved thread", async () => {
		const store = await MattermostStore.open(":memory:");
		const message =
			"BTB-100 also linked to BTB-200 https://tracker.example/BTB-200 for checkout";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: SUBJECT_ROOT,
					message,
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
			threads: [subjectThread(message)],
			subjectTicket: "BTB-100",
			allowlist: new Set(["channel-payments"]),
		});

		expect(pointers).toEqual([
			expect.objectContaining({
				key: "BTB-200",
				threadId: SUBJECT_ROOT,
				url: `https://chat.example.test/_redirect/pl/${SUBJECT_ROOT}`,
				trackerUrl: "https://tracker.example/BTB-200",
				alreadyInPacket: true,
			}),
		]);
		expect(pointers[0]?.unresolvableTracker).toBeUndefined();
		store.close();
	});

	test("findTrackerUrlBesideKey matches key in URL path and strips trailing punctuation", () => {
		expect(
			findTrackerUrlBesideKey(
				"see https://tracker.yandex.ru/BTB-200.",
				"BTB-200",
			),
		).toBe("https://tracker.yandex.ru/BTB-200");
		expect(
			findTrackerUrlBesideKey("BTB-200 with no link", "BTB-200"),
		).toBeUndefined();
		expect(
			findTrackerUrlBesideKey(
				"https://tracker.example/OTHER-1 and BTB-200",
				"BTB-200",
			),
		).toBeUndefined();
		expect(
			findTrackerUrlBesideKey(
				"https://jira.mygig.tech/browse/PCRM-1555",
				"PCRM-1555",
			),
		).toBe("https://jira.mygig.tech/browse/PCRM-1555");
	});

	test("rejects Kibana-style URLs as trackerUrl and does not emit API-2026", async () => {
		const kibanaUrl =
			"https://kibana.mygig.tech/s/kubernetes-production/app/discover#/doc/409e20ae-c74a-4f59-8f5f-ccc6c78d3b43/.ds-prod-api-2026.24-2026.06.15-000001?id=AZ7LBwvBCAmQdXddylWO";
		expect(findTrackerUrlBesideKey(kibanaUrl, "API-2026")).toBeUndefined();

		const store = await MattermostStore.open(":memory:");
		const message = `BTB-100 logs ${kibanaUrl}`;
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: SUBJECT_ROOT,
					message,
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
			threads: [subjectThread(message)],
			subjectTicket: "BTB-100",
			allowlist: new Set(),
		});

		expect(
			pointers.find((pointer) => pointer.key === "API-2026"),
		).toBeUndefined();
		expect(pointers.every((pointer) => pointer.trackerUrl === undefined)).toBe(
			true,
		);
		store.close();
	});
});
