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

function assertArgv(command: string[] | undefined): void {
	expect(command).toBeDefined();
	expect(Array.isArray(command)).toBe(true);
	expect(command?.every((part) => typeof part === "string")).toBe(true);
	expect(command?.some((part) => part.includes(" "))).toBe(false);
}

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
				discovery: "current",
			},
			next: [],
		});
	});

	test("separates fresh selected evidence from stale discovery", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: false,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [
				{
					alias: "payments",
					conversationId: "channel-1",
					kind: "channel",
					observedAt: 1_000,
					lastSuccessAt: 1,
					ageSeconds: 999,
					stale: true,
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
			selectedEvidenceCurrent: true,
		});
		expect(evidence.currency).toBe("current");
		expect(evidence.completeness.discovery).toBe("possibly_stale");
		expect(evidence.next).toEqual([]);
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
					totalPosts: 40,
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
						excerpt: "не работает checkout на past-month",
					},
				],
			},
			warnings: [{ kind: "incomplete_history" }],
			subject: "BTB-1",
		});
		expect(evidence.adequacy).toBe("usable");
		expect(evidence.currency).toBe("possibly_stale");
		expect(evidence.completeness).toEqual({
			selectedThreads: "truncated",
			indexHistory: "cutoff_bounded",
			discovery: "possibly_stale",
		});
		expect(evidence.packing.recommendFullThreadIds).toEqual(["t1"]);
		expect(evidence.next.map(({ action }) => action).sort()).toEqual([
			"fresh_or_remote",
			"inspect_dropped",
			"sync",
			"thread_full",
		]);
		const byAction = Object.fromEntries(
			evidence.next.map((step) => [step.action, step]),
		);
		expect(byAction.thread_full).toMatchObject({
			priority: "recommended",
			impact: "may_recover_omitted_core",
			command: ["mm", "thread", "t1", "--full", "--agent"],
			threadId: "t1",
		});
		expect(byAction.thread_around).toBeUndefined();
		expect(byAction.sync).toMatchObject({
			priority: "optional",
			impact: "older_discovery_only",
			command: ["mm", "sync", "--channel", "payments", "--agent"],
			conversationId: "channel-1",
		});
		expect(byAction.inspect_dropped).toMatchObject({
			priority: "optional",
			impact: "may_add_dropped_pointer",
			command: ["mm", "thread", "t2", "--agent"],
			threadId: "t2",
		});
		expect(byAction.fresh_or_remote).toMatchObject({
			priority: "optional",
			impact: "may_refresh_selected_or_discovery",
			command: ["mm", "context", "BTB-1", "--fresh", "--agent"],
		});
		for (const step of evidence.next) {
			assertArgv(step.command);
			expect(step).not.toHaveProperty("required");
		}
	});

	test("emits thread_full with recommended argv", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
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
					stale: false,
					coverageComplete: true,
				},
			],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				{
					threadId: "root-1",
					selectionStrategy: ["root"],
					totalPosts: 40,
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
					matchingPostIds: ["root-1"],
					latestActivityAt: 1,
					link: "https://example.test/root-1",
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
		expect(evidence.next).toEqual([
			{
				action: "thread_full",
				reason: "packing_incomplete",
				priority: "recommended",
				impact: "may_recover_omitted_core",
				command: ["mm", "thread", "root-1", "--full", "--agent"],
				threadId: "root-1",
			},
		]);
	});

	test("does not emit thread_around even when skip boundaries exist", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
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
					stale: false,
					coverageComplete: true,
				},
			],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				{
					threadId: "root-2",
					selectionStrategy: ["root"],
					totalPosts: 30,
					returnedPosts: 5,
					omittedPosts: 25,
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
							skip: {
								posts: 8,
								after: "a",
								before: "first-kept",
								reason: "budget",
							},
						},
					],
					conversationId: "channel-1",
					conversationAlias: "payments",
					conversationKind: "channel",
					reasons: ["ticket_in_root"],
					matchingPostIds: ["root-2"],
					latestActivityAt: 1,
					link: "https://example.test/root-2",
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
		expect(evidence.packing.recommendFullThreadIds).toEqual(["root-2"]);
		expect(evidence.next.map(({ action }) => action)).toEqual(["thread_full"]);
	});

	test("skips sync when usable current packet is complete despite incomplete history", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: false,
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
					coverageComplete: false,
				},
				{
					alias: "ops",
					conversationId: "channel-2",
					kind: "channel",
					observedAt: 1_000,
					lastSuccessAt: 1_000,
					ageSeconds: 0,
					stale: false,
					coverageComplete: false,
				},
			],
			searchedConversations: [{ id: "channel-1" }, { id: "channel-2" }],
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
			selectedEvidenceCurrent: true,
		});
		expect(evidence.adequacy).toBe("usable");
		expect(evidence.currency).toBe("current");
		expect(evidence.completeness).toMatchObject({
			selectedThreads: "complete",
			indexHistory: "cutoff_bounded",
		});
		expect(evidence.next.map(({ action }) => action)).not.toContain("sync");
		expect(evidence.next).toEqual([]);
	});

	test("emits sync without channel when incomplete history and packet is not trusted", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: false,
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
					coverageComplete: false,
				},
				{
					alias: "ops",
					conversationId: "channel-2",
					kind: "channel",
					observedAt: 1_000,
					lastSuccessAt: 1_000,
					ageSeconds: 0,
					stale: false,
					coverageComplete: false,
				},
			],
			searchedConversations: [{ id: "channel-1" }, { id: "channel-2" }],
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
			selectedEvidenceCurrent: false,
		});
		expect(evidence.currency).toBe("possibly_stale");
		expect(evidence.next).toEqual([
			{
				action: "sync",
				reason: "incomplete_history",
				priority: "optional",
				impact: "older_discovery_only",
				command: ["mm", "sync", "--agent"],
				conversationId: "channel-1",
			},
		]);
	});

	test("inspect_dropped hydrates first actionable drop thread without subject", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "local",
			freshness: [
				{
					alias: "payments",
					conversationId: "channel-1",
					kind: "channel",
					observedAt: 1_000,
					lastSuccessAt: 1,
					ageSeconds: 999,
					stale: true,
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
				candidateThreads: 2,
				returnedThreads: 1,
				droppedThin: 1,
				droppedCandidates: [
					{
						threadId: "t2",
						url: "https://example.test/t2",
						conversationId: "dm-1",
						conversationAlias: "leads",
						conversationKind: "direct_message",
						dropReason: "thin",
						reasons: ["thin_thread", "ticket_in_root"],
						excerpt: "не работает checkout на past-month",
					},
				],
			},
			warnings: [],
		});
		const byAction = Object.fromEntries(
			evidence.next.map((step) => [step.action, step]),
		);
		expect(byAction.inspect_dropped).toMatchObject({
			priority: "optional",
			impact: "may_add_dropped_pointer",
			command: ["mm", "thread", "t2", "--agent"],
			threadId: "t2",
		});
		assertArgv(byAction.inspect_dropped?.command);
		expect(byAction.fresh_or_remote).toMatchObject({
			priority: "optional",
			impact: "may_refresh_selected_or_discovery",
		});
		expect(byAction.fresh_or_remote).not.toHaveProperty("command");
	});

	test("omits inspect_dropped command when actionable drop lacks threadId", () => {
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
				candidateThreads: 2,
				returnedThreads: 1,
				droppedThin: 1,
				droppedCandidates: [
					{
						threadId: "",
						url: "https://example.test/missing",
						conversationId: "dm-1",
						conversationAlias: "leads",
						conversationKind: "direct_message",
						dropReason: "thin",
						reasons: ["thin_thread", "ticket_in_root"],
						excerpt: "не работает checkout на past-month",
					},
				],
			},
			warnings: [],
		});
		const inspect = evidence.next.find(
			(step) => step.action === "inspect_dropped",
		);
		expect(inspect).toMatchObject({
			priority: "optional",
			impact: "may_add_dropped_pointer",
		});
		expect(inspect).not.toHaveProperty("command");
		expect(inspect).not.toHaveProperty("threadId");
	});

	test("does not emit inspect_dropped for pure budget bulletin drops", () => {
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
				candidateThreads: 2,
				returnedThreads: 1,
				droppedByBudget: 1,
				droppedCandidates: [
					{
						threadId: "t2",
						url: "https://example.test/t2",
						conversationId: "channel-2",
						conversationAlias: "bulletin",
						conversationKind: "channel",
						dropReason: "budget",
						reasons: ["exact_phrase", "multi_ticket_root"],
						excerpt: "weekly update",
					},
				],
			},
			warnings: [],
		});
		expect(evidence.selection.droppedCandidates).toHaveLength(1);
		expect(evidence.next.map(({ action }) => action)).not.toContain(
			"inspect_dropped",
		);
	});

	test("does not emit inspect_dropped for thin ticket/URL-only excerpts", () => {
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
				candidateThreads: 2,
				returnedThreads: 1,
				droppedThin: 1,
				droppedCandidates: [
					{
						threadId: "t2",
						url: "https://example.test/t2",
						conversationId: "dm-1",
						conversationAlias: "leads",
						conversationKind: "direct_message",
						dropReason: "thin",
						reasons: ["thin_thread", "ticket_in_root"],
						excerpt: "BTB-1 https://tracker.example/BTB-1",
					},
				],
			},
			warnings: [],
		});
		expect(evidence.next.map(({ action }) => action)).not.toContain(
			"inspect_dropped",
		);
	});

	test("does not emit inspect_dropped when excerpt is already in selected messages", () => {
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
					posts: [
						{
							id: "t1",
							rootId: "t1",
							userId: "u1",
							authorUsername: "alice",
							authorDisplayName: "Alice",
							createAt: 1,
							updateAt: 1,
							deleteAt: 0,
							message: "BTB-1: не работает checkout in staging",
							attachments: [],
							renderedUnits: 40,
						},
					],
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
				candidateThreads: 2,
				returnedThreads: 1,
				droppedThin: 1,
				droppedCandidates: [
					{
						threadId: "t2",
						url: "https://example.test/t2",
						conversationId: "dm-1",
						conversationAlias: "leads",
						conversationKind: "direct_message",
						dropReason: "thin",
						reasons: ["thin_thread", "ticket_in_root"],
						excerpt: "не работает checkout",
					},
				],
			},
			warnings: [],
		});
		expect(evidence.next.map(({ action }) => action)).not.toContain(
			"inspect_dropped",
		);
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
