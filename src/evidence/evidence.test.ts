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
	droppedByBudgetSubjectMatched: 0,
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

function evidenceForThread(thread: ContextThread) {
	return buildEvidence({
		searchCoverageComplete: true,
		selectedThreadsComplete: false,
		freshnessMode: "network",
		freshness: [freshChannel],
		searchedConversations: [{ id: "channel-1" }],
		threads: [thread],
		remoteSearch: noRemoteSearch,
		selection: {
			...emptySelection(),
			candidateThreads: 1,
			returnedThreads: 1,
		},
		warnings: [],
	});
}

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

	test("reports budget-bounded selection separately from thread completeness", () => {
		const build = (selection: Partial<SelectionEvidence>) =>
			buildEvidence({
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
					packedThread({
						threadId: "t1",
						totalPosts: 1,
						omittedPosts: 0,
						skip: 0,
					}),
				],
				remoteSearch: noRemoteSearch,
				selection: { ...emptySelection(), ...selection },
				warnings: [],
				subject: "BTB-2113",
			});

		// Selected threads can be complete while most candidates were never judged.
		const bounded = build({
			candidateThreads: 138,
			returnedThreads: 3,
			droppedByBudget: 135,
		});
		expect(bounded.completeness).toMatchObject({
			selectedThreads: "complete",
			selection: "budget_bounded",
		});
		const review = bounded.next.find(
			({ action }) => action === "review_candidates",
		);
		expect(review).toMatchObject({
			priority: "optional",
			reason: "selection_budget_bounded",
		});
		assertArgv(review?.command);
		expect(review?.command).toEqual(["mm", "search", "BTB-2113", "--agent"]);

		// Judged-and-rejected candidates are not a completeness gap.
		const judged = build({
			candidateThreads: 138,
			returnedThreads: 3,
			droppedNoMatch: 135,
		});
		expect(judged.completeness.selection).toBe("complete");
		expect(judged.next.map(({ action }) => action)).not.toContain(
			"review_candidates",
		);
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
			selection: "budget_bounded",
			indexHistory: "cutoff_bounded",
			discovery: "possibly_stale",
		});
		expect(evidence.packing.recommendFullThreadIds).toEqual(["t1"]);
		expect(evidence.next.map(({ action }) => action).sort()).toEqual([
			"fresh_or_remote",
			"inspect_dropped",
			"sync",
			"thread_around",
		]);
		const byAction = Object.fromEntries(
			evidence.next.map((step) => [step.action, step]),
		);
		expect(byAction.thread_around).toMatchObject({
			priority: "recommended",
			impact: "may_recover_omitted_core",
			command: [
				"mm",
				"thread",
				"t1",
				"--around",
				"a",
				"--before-posts",
				"0",
				"--after-posts",
				"12",
				"--window-only",
				"--agent",
			],
			threadId: "t1",
		});
		expect(byAction.thread_full).toBeUndefined();
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

	test("emits bounded thread_around with recommended argv", () => {
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
				action: "thread_around",
				reason: "packing_incomplete_range",
				priority: "recommended",
				impact: "may_recover_omitted_core",
				command: [
					"mm",
					"thread",
					"root-1",
					"--around",
					"a",
					"--before-posts",
					"0",
					"--after-posts",
					"12",
					"--window-only",
					"--agent",
				],
				threadId: "root-1",
			},
		]);
	});

	test("uses the kept post after a leading skip as the range anchor", () => {
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
		expect(evidence.next).toEqual([
			{
				action: "thread_around",
				reason: "packing_incomplete_range",
				priority: "recommended",
				impact: "may_recover_omitted_core",
				command: [
					"mm",
					"thread",
					"root-2",
					"--around",
					"first-kept",
					"--before-posts",
					"8",
					"--after-posts",
					"0",
					"--window-only",
					"--agent",
				],
				threadId: "root-2",
			},
		]);
	});

	test("caps a trailing range and falls back to full without a boundary", () => {
		const trailing = packedThread({
			threadId: "trailing",
			totalPosts: 100,
			omittedPosts: 75,
			skip: 75,
		});
		trailing.timeline = [
			{ kind: "skip", skip: { posts: 75, after: "last-kept" } },
		];
		const malformed = packedThread({
			threadId: "legacy",
			totalPosts: 20,
			omittedPosts: 15,
			skip: 15,
		});
		malformed.timeline = [{ kind: "skip", skip: { posts: 15 } }];

		expect(evidenceForThread(trailing).next[0]).toMatchObject({
			action: "thread_around",
			command: [
				"mm",
				"thread",
				"trailing",
				"--around",
				"last-kept",
				"--before-posts",
				"0",
				"--after-posts",
				"50",
				"--window-only",
				"--agent",
			],
		});
		expect(evidenceForThread(malformed).next[0]).toMatchObject({
			action: "thread_full",
			command: ["mm", "thread", "legacy", "--full", "--agent"],
		});
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
		// Nothing was selected, so there is no transcript to call truncated.
		expect(evidence.completeness.selectedThreads).toBe("not_applicable");
	});

	test("recommends exactly one bounded hydration and keeps the rest optional", () => {
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
		expect(
			evidence.next.map(({ action, priority, threadId }) => ({
				action,
				priority,
				threadId,
			})),
		).toEqual([
			{
				action: "thread_around",
				priority: "recommended",
				threadId: "primary",
			},
			{
				action: "thread_around",
				priority: "optional",
				threadId: "wide-skip",
			},
			{
				action: "thread_around",
				priority: "optional",
				threadId: "thin-stub",
			},
		]);
		for (const step of evidence.next) {
			expect(step.command).toContain("--around");
			expect(step.command).not.toContain("--full");
		}
		expect(
			evidence.next.filter(({ priority }) => priority === "recommended"),
		).toHaveLength(1);
		expect(evidence.packing.recommendFullThreadIds).toEqual([
			"wide-skip",
			"thin-stub",
			"primary",
		]);
	});

	test("orders non-primary hydration steps by skip, omitted ratio, then id", () => {
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
		expect(step?.command).toEqual([
			"mm",
			"file",
			"file-1",
			"--inspect",
			"--agent",
		]);
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

describe("evidence verdict", () => {
	const baseInput = () => ({
		searchCoverageComplete: true,
		selectedThreadsComplete: true,
		freshnessMode: "network" as const,
		freshness: [freshChannel],
		searchedConversations: [{ id: "channel-1" }],
		threads: [
			packedThread({ threadId: "t1", totalPosts: 3, omittedPosts: 0, skip: 0 }),
		],
		remoteSearch: noRemoteSearch,
		selection: { ...emptySelection(), candidateThreads: 1, returnedThreads: 1 },
		warnings: [],
	});

	test("rolls a clean packet up to an answerable verdict", () => {
		expect(buildEvidence(baseInput()).verdict).toEqual({
			canAnswerFromSelectedEvidence: true,
			mayHaveMissedOtherThreads: false,
			selectedEvidenceMayBeStale: false,
			recommendedActionRequired: false,
		});
	});

	test("a weak budget-bounded tail alone does not claim missed threads", () => {
		// The field report's BTB-2113: 173 unexamined candidates, none of which
		// carried subject-level evidence. `budget_bounded` still holds.
		const evidence = buildEvidence({
			...baseInput(),
			selection: {
				...emptySelection(),
				candidateThreads: 176,
				returnedThreads: 3,
				droppedByBudget: 173,
				droppedByBudgetSubjectMatched: 0,
			},
		});

		expect(evidence.completeness.selection).toBe("budget_bounded");
		expect(evidence.verdict.mayHaveMissedOtherThreads).toBe(false);
	});

	test("one unexamined subject-matched candidate does claim missed threads", () => {
		const evidence = buildEvidence({
			...baseInput(),
			selection: {
				...emptySelection(),
				candidateThreads: 176,
				returnedThreads: 3,
				droppedByBudget: 173,
				droppedByBudgetSubjectMatched: 1,
			},
		});

		expect(evidence.verdict.mayHaveMissedOtherThreads).toBe(true);
	});

	test("never contradicts the axes it is derived from", () => {
		const evidence = buildEvidence({
			...baseInput(),
			selectedThreadsComplete: false,
			threads: [
				packedThread({
					threadId: "t1",
					totalPosts: 40,
					omittedPosts: 30,
					skip: 12,
				}),
			],
		});

		expect(evidence.completeness.selectedThreads).toBe("truncated");
		expect(evidence.verdict.canAnswerFromSelectedEvidence).toBe(false);
		expect(evidence.verdict.recommendedActionRequired).toBe(
			evidence.next.some(({ priority }) => priority === "recommended"),
		);
	});
});

describe("evidence verdict and bounded history", () => {
	const boundedChannel: FreshnessEvidence = {
		...freshChannel,
		coverageComplete: false,
		oldestCoveredAt: 500,
	};

	test("a trusted packet is not flagged merely for bounded history", () => {
		// Almost every conversation is cutoff-bounded by `historyDays`; letting that
		// alone set the flag would pin it to `true` on every packet.
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [boundedChannel],
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

		expect(evidence.completeness.indexHistory).toBe("cutoff_bounded");
		expect(evidence.verdict.mayHaveMissedOtherThreads).toBe(false);
	});

	test("bounded history does flag a packet that is not otherwise trusted", () => {
		const evidence = buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: false,
			freshnessMode: "network",
			freshness: [boundedChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "t1",
					totalPosts: 40,
					omittedPosts: 30,
					skip: 12,
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

		expect(evidence.verdict.mayHaveMissedOtherThreads).toBe(true);
	});
});

describe("verdict states the axes must agree with", () => {
	const build = (overrides: Parameters<typeof buildEvidence>[0]) =>
		buildEvidence(overrides);

	test("an empty packet is never answerable", () => {
		const evidence = build({
			searchCoverageComplete: true,
			selectedThreadsComplete: false,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [],
			remoteSearch: noRemoteSearch,
			selection: emptySelection(),
			warnings: [],
		});

		expect(evidence.adequacy).toBe("insufficient");
		expect(evidence.completeness.selectedThreads).toBe("not_applicable");
		expect(evidence.verdict.canAnswerFromSelectedEvidence).toBe(false);
	});

	test("a thin-only packet is never answerable", () => {
		const evidence = build({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [
				packedThread({
					threadId: "t1",
					totalPosts: 1,
					omittedPosts: 0,
					skip: 0,
					reasons: ["thin_thread"],
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

		expect(evidence.adequacy).toBe("thin");
		expect(evidence.verdict.canAnswerFromSelectedEvidence).toBe(false);
	});
});

describe("data-file attachments on decision-layer posts", () => {
	const build = (posts: ContextThread["posts"]) =>
		buildEvidence({
			searchCoverageComplete: true,
			selectedThreadsComplete: true,
			freshnessMode: "network",
			freshness: [freshChannel],
			searchedConversations: [{ id: "channel-1" }],
			threads: [threadWithPosts("t1", posts)],
			remoteSearch: noRemoteSearch,
			selection: {
				...emptySelection(),
				candidateThreads: 1,
				returnedThreads: 1,
			},
			warnings: [],
			subjectTicket: "BTB-2080",
		});

	const dataPost = (
		id: string,
		message: string,
		createAt: number,
		file: string,
	): ContextThread["posts"][number] => {
		const post = evidencePost({ id, createAt, message, files: [file] });
		const attachment = post.attachments[0];
		if (attachment) {
			attachment.name = file;
			attachment.extension = file.split(".").pop() ?? "";
		}
		return post;
	};

	test("recommends a spreadsheet attached to an open question", () => {
		// BTB-2080: the post had text, so the media-only rule never fired, yet the
		// XLSX was the only place the duplicate count could be checked.
		const evidence = build([
			evidencePost({ id: "p1", createAt: 10, message: "BTB-2080 импорт" }),
			dataPost("p2", "вот дубли, что с ними делать?", 20, "duplicates.xlsx"),
		]);
		const step = evidence.next.find(
			({ action }) => action === "read_attachments",
		);

		expect(step).toMatchObject({
			reason: "data_file_on_decision_post",
			priority: "recommended",
			impact: "may_verify_quantitative_claim",
			postId: "p2",
		});
		expect(step?.command).toEqual([
			"mm",
			"file",
			"duplicates.xlsx",
			"--inspect",
			"--agent",
		]);
	});

	test("stays quiet for a data file outside the decision layer", () => {
		const evidence = build([
			evidencePost({ id: "p1", createAt: 10, message: "BTB-2080 импорт" }),
			dataPost("p2", "кстати вот выгрузка за март", 20, "march.csv"),
			evidencePost({ id: "p3", createAt: 30, message: "спасибо" }),
		]);

		expect(
			evidence.next.some(({ action }) => action === "read_attachments"),
		).toBe(false);
	});

	test("stays quiet for a screenshot, which the media-only rule owns", () => {
		const evidence = build([
			evidencePost({ id: "p1", createAt: 10, message: "BTB-2080 импорт" }),
			dataPost("p2", "вот скрин, что делать?", 20, "screen.png"),
		]);

		expect(
			evidence.next.some(
				({ reason }) => reason === "data_file_on_decision_post",
			),
		).toBe(false);
	});

	test("a media-only outcome post keeps priority over a data file", () => {
		const evidence = build([
			evidencePost({ id: "p1", createAt: 10, message: "BTB-2080 импорт" }),
			dataPost("p2", "вот дубли, что делать?", 20, "duplicates.csv"),
			evidencePost({ id: "p3", createAt: 30, message: "", files: ["shot"] }),
		]);
		const steps = evidence.next.filter(
			({ action }) => action === "read_attachments",
		);

		expect(steps[0]).toMatchObject({
			reason: "media_only_outcome_post",
			priority: "recommended",
		});
		expect(steps[1]).toMatchObject({
			reason: "data_file_on_decision_post",
			priority: "optional",
		});
	});
});
