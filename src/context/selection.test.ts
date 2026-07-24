import { describe, expect, test } from "bun:test";
import type { ThreadCandidate } from "../search/index.ts";
import { configFixture } from "../test-fixtures.ts";
import {
	buildDroppedCandidates,
	isActionableDroppedCandidate,
	orderCandidatesForThinReserve,
	shouldRecommendInspectDropped,
} from "./selection.ts";

function candidate(
	threadId: string,
	reasons: ThreadCandidate["reasons"],
	excerpt = "hit",
): ThreadCandidate {
	return {
		threadId,
		rootPostId: threadId,
		conversationId: `conv-${threadId}`,
		conversationAlias: threadId,
		conversationKind: "direct_message",
		matchingPostIds: [threadId],
		matches: [
			{
				postId: threadId,
				probe: excerpt,
				excerpt,
			},
		],
		reasons,
		latestActivityAt: 1,
		priority: 0,
		scoreVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	};
}

describe("selection helpers", () => {
	test("reserves the last slot for the best thin ticket candidate", () => {
		const ordered = orderCandidatesForThinReserve(
			[
				candidate("s1", ["ticket_in_root", "substantive_thread_depth"]),
				candidate("s2", ["ticket_in_reply"]),
				candidate("s3", ["ticket_in_root"]),
				candidate("thin", ["thin_thread", "ticket_in_root"], "не работает"),
			],
			{ kind: "ticket", ticketKey: "BTB-1", raw: "BTB-1" },
			3,
		);
		expect(ordered.map(({ threadId }) => threadId)).toEqual([
			"s1",
			"s2",
			"thin",
			"s3",
		]);
	});

	test("does not reserve a thin slot for non-ticket subjects", () => {
		const ordered = orderCandidatesForThinReserve(
			[
				candidate("s1", ["exact_phrase"]),
				candidate("s2", ["exact_phrase"]),
				candidate("thin", ["thin_thread"]),
			],
			{ kind: "text", text: "не работает", raw: "не работает" },
			3,
		);
		expect(ordered.map(({ threadId }) => threadId)).toEqual([
			"s1",
			"s2",
			"thin",
		]);
	});

	test("builds droppedCandidates with urls and specific reasons", () => {
		const dropped = buildDroppedCandidates({
			candidates: [
				candidate("kept", ["ticket_in_root"]),
				candidate("thin", ["thin_thread", "ticket_in_root"], "не работает"),
				candidate("budget", ["ticket_in_reply"], "other"),
			],
			selectedIds: new Set(["kept"]),
			noMatchIds: new Set(),
			config: configFixture(),
		});
		expect(dropped).toEqual([
			expect.objectContaining({
				threadId: "thin",
				dropReason: "thin",
				excerpt: "не работает",
				excerpts: ["не работает"],
				url: expect.stringContaining("thin"),
			}),
			expect.objectContaining({
				threadId: "budget",
				dropReason: "budget",
			}),
		]);
	});

	test("sorts thin and ticket drops ahead of plain budget bulletin noise", () => {
		const dropped = buildDroppedCandidates({
			candidates: [
				candidate("bulletin", ["exact_phrase", "multi_ticket_root"], "noise"),
				candidate("ticket", ["ticket_in_reply"], "ticket hit"),
				candidate("thin", ["thin_thread", "ticket_in_root"], "не работает"),
			],
			selectedIds: new Set(),
			noMatchIds: new Set(),
			config: configFixture(),
		});
		expect(dropped.map(({ threadId }) => threadId)).toEqual([
			"thin",
			"ticket",
			"bulletin",
		]);
		expect(isActionableDroppedCandidate(dropped[0]!)).toBe(true);
		expect(isActionableDroppedCandidate(dropped[1]!)).toBe(true);
		expect(isActionableDroppedCandidate(dropped[2]!)).toBe(false);
	});

	test("keeps at most two distinct existing excerpts", () => {
		const droppedCandidate = candidate("thin", ["thin_thread"], "first");
		droppedCandidate.matches.push(
			{ postId: "p2", probe: "second", excerpt: "second" },
			{ postId: "p3", probe: "duplicate", excerpt: "first" },
			{ postId: "p4", probe: "third", excerpt: "third" },
		);
		const [dropped] = buildDroppedCandidates({
			candidates: [droppedCandidate],
			selectedIds: new Set(),
			noMatchIds: new Set(),
			config: configFixture(),
		});
		expect(dropped?.excerpt).toBe("first");
		expect(dropped?.excerpts).toEqual(["first", "second"]);
	});

	test("shouldRecommendInspectDropped skips empty and thin link-only excerpts", () => {
		expect(shouldRecommendInspectDropped({ excerpt: "" }, ["selected"])).toBe(
			false,
		);
		expect(shouldRecommendInspectDropped({}, ["selected"])).toBe(false);
		expect(
			shouldRecommendInspectDropped(
				{ excerpt: "BTB-1 https://tracker.example/BTB-1" },
				["selected"],
			),
		).toBe(false);
		expect(
			shouldRecommendInspectDropped({ excerpt: "…BTB-2080 не работает" }, [
				"selected",
			]),
		).toBe(false);
		expect(
			shouldRecommendInspectDropped({ excerpt: "не работает checkout" }, [
				"selected",
			]),
		).toBe(true);
	});

	test("shouldRecommendInspectDropped skips excerpts already in selected messages", () => {
		expect(
			shouldRecommendInspectDropped(
				{ excerpt: "payment   timeout  reproduced" },
				["Earlier: payment timeout reproduced in staging"],
			),
		).toBe(false);
		expect(
			shouldRecommendInspectDropped(
				{
					excerpts: ["BTB-1", "unique symptom: duplicate charge"],
				},
				["BTB-1 ping only"],
			),
		).toBe(true);
	});
});
