import { describe, expect, test } from "bun:test";
import type {
	ContextThread,
	FreshnessEvidence,
	RemoteSearchEvidence,
	SelectionEvidence,
} from "../context/types.ts";
import { buildEvidence } from "./evidence.ts";

const emptySelection = (): SelectionEvidence => ({
	candidateThreads: 0,
	returnedThreads: 0,
	droppedThin: 0,
	droppedByBudget: 0,
	droppedNoMatch: 0,
	droppedCandidates: [],
});

function packedThread(input: {
	threadId: string;
	totalPosts: number;
	omittedPosts: number;
	skip: number;
	reasons?: ContextThread["reasons"];
}): ContextThread {
	return {
		threadId: input.threadId,
		selectionStrategy: ["root"],
		totalPosts: input.totalPosts,
		returnedPosts: input.totalPosts - input.omittedPosts,
		omittedPosts: input.omittedPosts,
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
		timeline: input.skip
			? [
					{
						kind: "skip",
						skip: {
							posts: input.skip,
							after: "a",
							before: "b",
							reason: "budget",
						},
					},
				]
			: [],
		conversationId: "channel-1",
		conversationAlias: "payments",
		conversationKind: "channel",
		reasons: input.reasons ?? ["ticket_in_root"],
		matchingPostIds: [input.threadId],
		latestActivityAt: 1,
		link: `https://example.test/${input.threadId}`,
	};
}

function evidencePost(input: {
	id: string;
	createAt: number;
	message: string;
	files?: readonly string[];
}): ContextThread["posts"][number] {
	return {
		id: input.id,
		rootId: "t1",
		userId: "user-1",
		authorUsername: "alice",
		authorDisplayName: "Alice",
		createAt: input.createAt,
		updateAt: input.createAt,
		deleteAt: 0,
		message: input.message,
		renderedUnits: input.message.length,
		attachments: (input.files ?? []).map((id) => ({
			id,
			postId: input.id,
			name: `${id}.png`,
			extension: "png",
			size: 10,
			mimeType: "image/png",
			deleteAt: 0,
		})),
	};
}

function threadWithPosts(
	threadId: string,
	posts: ContextThread["posts"],
): ContextThread {
	return {
		...packedThread({
			threadId,
			totalPosts: posts.length,
			omittedPosts: 0,
			skip: 0,
		}),
		posts,
		timeline: posts.map((post) => ({ kind: "post" as const, post })),
	};
}

const freshChannel: FreshnessEvidence = {
	alias: "payments",
	conversationId: "channel-1",
	kind: "channel",
	observedAt: 1_000,
	lastSuccessAt: 1_000,
	ageSeconds: 0,
	stale: false,
	coverageComplete: true,
	oldestCoveredAt: null,
};

const noRemoteSearch: RemoteSearchEvidence = {
	requested: false,
	performed: false,
	reason: null,
	queries: [],
	candidateThreads: 0,
	failures: 0,
};

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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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
					oldestCoveredAt: null,
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

	test("recommends exactly one thread_full and keeps the rest optional", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: false,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "wide-skip",
					totalPosts: 40,
					omittedPosts: 16,
					skip: 12,
				}),
				packedThread({
					threadId: "thin-stub",
					totalPosts: 30,
					omittedPosts: 25,
					skip: 8,
					reasons: ["thin_thread"],
				}),
				packedThread({
					threadId: "primary",
					totalPosts: 60,
					omittedPosts: 20,
					skip: 6,
					reasons: ["substantive_thread_depth", "ticket_in_root"],
				}),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 3,
				returnedThreads: 3,
			},
			warnings: [],
		});
		expect(evidence.next).toEqual([
			{
				action: "thread_full",
				reason: "packing_incomplete",
				priority: "recommended",
				impact: "may_recover_omitted_core",
				command: ["mm", "thread", "primary", "--full", "--agent"],
				threadId: "primary",
			},
			{
				action: "thread_full",
				reason: "packing_incomplete",
				priority: "optional",
				impact: "may_recover_omitted_core",
				command: ["mm", "thread", "wide-skip", "--full", "--agent"],
				threadId: "wide-skip",
			},
			{
				action: "thread_full",
				reason: "packing_incomplete",
				priority: "optional",
				impact: "may_recover_omitted_core",
				command: ["mm", "thread", "thin-stub", "--full", "--agent"],
				threadId: "thin-stub",
			},
		]);
		expect(
			evidence.next.filter(({ priority }) => priority === "recommended"),
		).toHaveLength(1);
		expect(evidence.packing.recommendFullThreadIds).toEqual([
			"wide-skip",
			"thin-stub",
			"primary",
		]);
	});

	test("orders non-primary thread_full steps by skip, omitted ratio, then id", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: false,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "complete-primary",
					totalPosts: 100,
					omittedPosts: 0,
					skip: 0,
					reasons: ["substantive_thread_depth"],
				}),
				packedThread({
					threadId: "b-tie",
					totalPosts: 20,
					omittedPosts: 10,
					skip: 9,
				}),
				packedThread({
					threadId: "a-tie",
					totalPosts: 20,
					omittedPosts: 10,
					skip: 9,
				}),
				packedThread({
					threadId: "higher-ratio",
					totalPosts: 10,
					omittedPosts: 9,
					skip: 9,
				}),
				packedThread({
					threadId: "widest-skip",
					totalPosts: 20,
					omittedPosts: 12,
					skip: 12,
				}),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 5,
				returnedThreads: 5,
			},
			warnings: [],
		});
		expect(evidence.next.map(({ threadId }) => threadId)).toEqual([
			"widest-skip",
			"higher-ratio",
			"a-tie",
			"b-tie",
		]);
		expect(evidence.next.map(({ priority }) => priority)).toEqual([
			"recommended",
			"optional",
			"optional",
			"optional",
		]);
	});

	test("recommends reading a media-only post that follows the last ticket mention", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				threadWithPosts("t1", [
					evidencePost({ id: "p1", createAt: 10, message: "BTB-1 broke" }),
					evidencePost({
						id: "p2",
						createAt: 20,
						message: "наверное так и сделаю",
					}),
					evidencePost({
						id: "p3",
						createAt: 30,
						message: "",
						files: ["file-1"],
					}),
				]),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
			subjectTicket: "BTB-1",
		});
		const step = evidence.next.find(
			({ action }) => action === "read_attachments",
		);
		expect(step).toMatchObject({
			reason: "media_only_outcome_post",
			priority: "recommended",
			impact: "may_contradict_visible_text",
			threadId: "t1",
			postId: "p3",
		});
		assertArgv(step?.command);
		expect(step?.command).toEqual(["mm", "file", "file-1", "--agent"]);
	});

	test("stays quiet for media-only posts before the last ticket mention", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				threadWithPosts("t1", [
					evidencePost({
						id: "p1",
						createAt: 10,
						message: "",
						files: ["file-1"],
					}),
					evidencePost({ id: "p2", createAt: 20, message: "BTB-1 fixed" }),
				]),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
			subjectTicket: "BTB-1",
		});
		expect(
			evidence.next.some(({ action }) => action === "read_attachments"),
		).toBe(false);
	});

	test("without a subject ticket only the trailing media-only post counts", () => {
		const trailing = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				threadWithPosts("t1", [
					evidencePost({ id: "p1", createAt: 10, message: "context" }),
					evidencePost({ id: "p2", createAt: 20, message: "", files: ["f"] }),
				]),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
		});
		expect(
			trailing.next.find(({ action }) => action === "read_attachments"),
		).toMatchObject({ postId: "p2" });

		const middle = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				threadWithPosts("t1", [
					evidencePost({ id: "p1", createAt: 10, message: "", files: ["f"] }),
					evidencePost({ id: "p2", createAt: 20, message: "and then" }),
				]),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
		});
		expect(
			middle.next.some(({ action }) => action === "read_attachments"),
		).toBe(false);
	});

	test("names cutoff-bounded conversations, selected ones first", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: false,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [
				{
					...freshChannel,
					alias: "zeta-unselected",
					conversationId: "channel-2",
					coverageComplete: false,
					oldestCoveredAt: 86_400_000,
				},
				{
					...freshChannel,
					alias: "alpha-selected",
					conversationId: "channel-1",
					coverageComplete: false,
					oldestCoveredAt: 172_800_000,
				},
				{ ...freshChannel, alias: "complete", conversationId: "channel-3" },
			],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "t1",
					totalPosts: 3,
					omittedPosts: 0,
					skip: 0,
				}),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
		});
		expect(evidence.history?.cutoffBounded).toEqual([
			{
				alias: "alpha-selected",
				conversationId: "channel-1",
				oldestIndexedAt: "1970-01-03T00:00:00.000Z",
				inSelectedThreads: true,
			},
			{
				alias: "zeta-unselected",
				conversationId: "channel-2",
				oldestIndexedAt: "1970-01-02T00:00:00.000Z",
				inSelectedThreads: false,
			},
		]);
	});

	test("omits history when every searched conversation is fully covered", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "t1",
					totalPosts: 3,
					omittedPosts: 0,
					skip: 0,
				}),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
		});
		expect(evidence.history).toBeUndefined();
	});

	test("reports droppedNoMatch so ranking-only drops are visible", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "t1",
					totalPosts: 3,
					omittedPosts: 0,
					skip: 0,
				}),
			],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 3,
				returnedThreads: 1,
				droppedNoMatch: 2,
			},
			warnings: [],
		});
		expect(evidence.selection.droppedNoMatch).toBe(2);
	});
});
