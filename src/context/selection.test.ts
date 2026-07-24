import { describe, expect, test } from "bun:test";
import type { ThreadCandidate } from "../search/index.ts";
import { configFixture } from "../test-fixtures.ts";
import {
	buildDroppedCandidates,
	orderCandidatesForThinReserve,
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
				url: expect.stringContaining("thin"),
			}),
			expect.objectContaining({
				threadId: "budget",
				dropReason: "budget",
			}),
		]);
	});
});
