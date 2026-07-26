import { describe, expect, test } from "bun:test";
import type { EvidenceNextStep } from "../evidence/evidence.ts";
import type { FileDownloadResult } from "../sync/file-download.ts";
import { followRecommendedSteps } from "./follow-recommended.ts";
import type { ContextResult } from "./types.ts";

function emptyContext(next: EvidenceNextStep[] = []): ContextResult {
	return {
		subject: { kind: "ticket", ticketKey: "BTB-1", raw: "BTB-1" },
		filters: {},
		freshnessMode: "network",
		complete: true,
		searchCoverageComplete: true,
		selectedThreadsComplete: true,
		selectedEvidenceCurrent: true,
		budget: { used: 0, limit: 10_000, maxThreads: 3 },
		threads: [],
		freshness: [],
		searchedConversations: [],
		remoteSearch: { requested: false, performed: false, failures: 0 },
		selection: {
			candidateThreads: 0,
			returnedThreads: 0,
			droppedThin: 0,
			droppedByBudget: 0,
			droppedByBudgetSubjectMatched: 0,
			droppedNoMatch: 0,
			droppedCandidates: [],
		},
		evidence: {
			adequacy: "insufficient",
			currency: "current",
			verdict: {
				canAnswerFromSelectedEvidence: false,
				mayHaveMissedOtherThreads: false,
				selectedEvidenceMayBeStale: false,
				recommendedActionRequired: next.some(
					({ priority }) => priority === "recommended",
				),
			},
			completeness: {
				selectedThreads: "not_applicable",
				selection: "complete",
				indexHistory: "full",
				discovery: "current",
			},
			next,
			selection: {
				candidateThreads: 0,
				returnedThreads: 0,
				droppedThin: 0,
				droppedByBudget: 0,
				droppedByBudgetSubjectMatched: 0,
				droppedNoMatch: 0,
				droppedCandidates: [],
			},
			packing: {
				omittedPosts: 0,
				largestSkip: 0,
				recommendedHydrationThreadIds: [],
				recommendFullThreadIds: [],
			},
		},
		warnings: [],
	} as unknown as ContextResult;
}

const notInterpretedImage: FileDownloadResult = {
	id: "img-1",
	name: "shot.png",
	mimeType: "image/png",
	size: 4,
	path: "/tmp/shot.png",
	postId: "p1",
	conversationId: "c1",
	inspection: {
		status: "not_interpreted",
		format: "image",
		interpreted: false,
		downloaded: true,
		inspected: false,
		reason: "external_image_reader_required",
		recommendedAction: "open externally",
	},
};

describe("followRecommendedSteps", () => {
	test("emits an empty followLog when there is nothing to run", async () => {
		const { context, followLog } = await followRecommendedSteps({
			context: emptyContext(),
			config: {
				databasePath: ":memory:",
				concepts: {},
			} as never,
			dependencies: { store: { close() {} } as never },
		});
		expect(followLog).toEqual([]);
		expect(context.followLog).toEqual([]);
	});

	test("skips external-reader inspect and continues later recommended steps", async () => {
		const next: EvidenceNextStep[] = [
			{
				action: "read_attachments",
				reason: "media_only_outcome_post",
				priority: "recommended",
				impact: "requires_external_reader",
				command: ["mm", "file", "img-1", "--inspect", "--agent"],
				threadId: "t1",
				postId: "p1",
			},
			{
				action: "sync",
				reason: "incomplete_history",
				priority: "recommended",
				impact: "older_discovery_only",
				command: ["mm", "sync", "--agent"],
			},
		];
		const { followLog, context } = await followRecommendedSteps({
			context: emptyContext(next),
			config: {
				databasePath: ":memory:",
				concepts: {},
			} as never,
			dependencies: { store: { close() {} } as never },
			downloadAttachment: async () => notInterpretedImage,
		});

		expect(followLog).toEqual([
			{
				command: ["mm", "file", "img-1", "--inspect", "--agent"],
				action: "read_attachments",
				status: "skipped_external_reader",
				inspectionStatus: "not_interpreted",
			},
			{
				command: ["mm", "sync", "--agent"],
				action: "sync",
				status: "skipped_disallowed",
			},
		]);
		expect(context.followedAttachments).toHaveLength(1);
		expect(
			context.warnings.some(
				({ kind }) => kind === "follow_skipped_external_reader",
			),
		).toBe(true);
	});

	test("re-runs context for recommended review_candidates max-threads bump", async () => {
		const next: EvidenceNextStep[] = [
			{
				action: "review_candidates",
				reason: "subject_matched_budget_drops",
				priority: "recommended",
				impact: "may_add_dropped_pointer",
				command: ["mm", "context", "BTB-1", "--max-threads", "5", "--agent"],
			},
		];
		const expanded = emptyContext();
		expanded.budget = { ...expanded.budget, maxThreads: 5 };
		expanded.selection = {
			...expanded.selection,
			returnedThreads: 5,
			droppedByBudgetSubjectMatched: 0,
		};

		const { followLog, context } = await followRecommendedSteps({
			context: emptyContext(next),
			config: {
				databasePath: ":memory:",
				concepts: {},
			} as never,
			dependencies: { store: { close() {} } as never },
			rerunContext: async (maxThreads) => {
				expect(maxThreads).toBe(5);
				return expanded;
			},
		});

		expect(followLog).toEqual([
			{
				command: ["mm", "context", "BTB-1", "--max-threads", "5", "--agent"],
				action: "review_candidates",
				status: "ok",
			},
		]);
		expect(context.budget.maxThreads).toBe(5);
		expect(context.followLog).toEqual(followLog);
	});

	test("skips review_candidates when no rerun hook is provided", async () => {
		const next: EvidenceNextStep[] = [
			{
				action: "review_candidates",
				reason: "subject_matched_budget_drops",
				priority: "recommended",
				impact: "may_add_dropped_pointer",
				command: ["mm", "context", "BTB-1", "--max-threads", "5", "--agent"],
			},
		];
		const { followLog } = await followRecommendedSteps({
			context: emptyContext(next),
			config: {
				databasePath: ":memory:",
				concepts: {},
			} as never,
			dependencies: { store: { close() {} } as never },
		});
		expect(followLog).toEqual([
			{
				command: ["mm", "context", "BTB-1", "--max-threads", "5", "--agent"],
				action: "review_candidates",
				status: "skipped_disallowed",
			},
		]);
	});
});
