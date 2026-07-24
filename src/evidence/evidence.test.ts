import { describe, expect, test } from "bun:test";
import type { SelectionEvidence } from "../context/types.ts";
import { buildEvidence } from "./evidence.ts";

const emptySelection = (): SelectionEvidence => ({
	candidateThreads: 0,
	returnedThreads: 0,
	droppedThin: 0,
	droppedByBudget: 0,
	droppedNoMatch: 0,
	droppedCandidates: [],
});

describe("buildEvidence", () => {
	test("marks usable current evidence when threads are complete", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [
				{
					alias: "payments",
					conversationId: "channel-1",
					kind: "channel",
					observedAt: 1_000,
					lastSuccessAt: 1_000,
					ageSeconds: 0,
					stale: false,
					coverageComplete: true,
				},
			],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				{
					threadId: "t1",
					selectionStrategy: ["full_thread"],
					totalPosts: 1,
					returnedPosts: 1,
					omittedPosts: 0,
					returnedAttachments: 0,
					totalOmittedAttachments: 0,
					omittedAttachments: [],
					unreportedOmittedAttachments: 0,
					budget: {
						measurement: "unicode_code_points_in_rendered_post",
						limit: 100,
						used: 10,
					},
					posts: [],
					timeline: [],
					conversationId: "channel-1",
					conversationAlias: "payments",
					conversationKind: "channel",
					reasons: ["ticket_in_root"],
					matchingPostIds: ["t1"],
					latestActivityAt: 1,
					link: "https://example.test/t1",
				},
			],
			remoteSearch: {
				requested: false,
				performed: false,
				reason: null,
				queries: [],
				candidateThreads: 0,
				failures: 0,
			},
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
		});
		expect(evidence).toMatchObject({
			adequacy: "usable",
			currency: "current",
			completeness: {
				selectedThreads: "complete",
				indexHistory: "full",
			},
			next: [],
		});
	});

	test("emits orthogonal next actions for packing and incomplete history", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: false,
			selectedThreadsComplete: false,
			freshnessMode: "network",
			freshness: [
				{
					alias: "payments",
					conversationId: "channel-1",
					kind: "channel",
					observedAt: 1_000,
					lastSuccessAt: 1_000,
					ageSeconds: 0,
					stale: true,
					coverageComplete: false,
				},
			],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				{
					threadId: "t1",
					selectionStrategy: ["root"],
					totalPosts: 20,
					returnedPosts: 4,
					omittedPosts: 16,
					returnedAttachments: 0,
					totalOmittedAttachments: 0,
					omittedAttachments: [],
					unreportedOmittedAttachments: 0,
					budget: {
						measurement: "unicode_code_points_in_rendered_post",
						limit: 100,
						used: 100,
					},
					posts: [],
					timeline: [
						{
							kind: "skip",
							skip: { posts: 12, after: "a", before: "b", reason: "budget" },
						},
					],
					conversationId: "channel-1",
					conversationAlias: "payments",
					conversationKind: "channel",
					reasons: ["ticket_in_root"],
					matchingPostIds: ["t1"],
					latestActivityAt: 1,
					link: "https://example.test/t1",
				},
			],
			remoteSearch: {
				requested: false,
				performed: false,
				reason: null,
				queries: [],
				candidateThreads: 0,
				failures: 0,
			},
			selection: {
				...emptySelection(),
				candidateThreads: 2,
				returnedThreads: 1,
				droppedByBudget: 1,
				droppedCandidates: [
					{
						threadId: "t2",
						url: "https://example.test/t2",
						conversationId: "dm-1",
						conversationAlias: "leads",
						conversationKind: "direct_message",
						dropReason: "thin",
						reasons: ["thin_thread", "ticket_in_root"],
						excerpt: "не работает",
					},
				],
			},
			warnings: [{ kind: "incomplete_history" }],
		});
		expect(evidence.adequacy).toBe("usable");
		expect(evidence.currency).toBe("possibly_stale");
		expect(evidence.completeness).toEqual({
			selectedThreads: "truncated",
			indexHistory: "cutoff_bounded",
		});
		expect(evidence.packing.recommendFullThreadIds).toEqual(["t1"]);
		expect(evidence.next.map(({ action }) => action).sort()).toEqual([
			"fresh_or_remote",
			"inspect_dropped",
			"sync",
			"thread_full",
		]);
	});

	test("marks insufficient when no threads return", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: false,
			freshnessMode: "local",
			freshness: [],
			searchedConversations: [],
			threads: [],
			remoteSearch: {
				requested: false,
				performed: false,
				reason: null,
				queries: [],
				candidateThreads: 0,
				failures: 0,
			},
			selection: emptySelection(),
			warnings: [{ kind: "no_results" }],
		});
		expect(evidence.adequacy).toBe("insufficient");
		expect(evidence.currency).toBe("local_only");
	});
});
