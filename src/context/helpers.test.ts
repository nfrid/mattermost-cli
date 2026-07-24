import { describe, expect, test } from "bun:test";
import type { EvidencePost } from "../evidence/packing.ts";
import { scoreSurroundRelevance } from "./helpers.ts";

function post(id: string, message: string): EvidencePost {
	return {
		id,
		rootId: id,
		userId: "user-1",
		authorUsername: "alice",
		authorDisplayName: "Alice",
		createAt: 10,
		updateAt: 10,
		deleteAt: 0,
		message,
		attachments: [],
	};
}

describe("scoreSurroundRelevance", () => {
	test("returns unknown when subject ticket is missing", () => {
		expect(
			scoreSurroundRelevance(
				[post("s1", "payment timeout discussion")],
				undefined,
				"BTB-100 timeout",
			),
		).toBe("unknown");
		expect(
			scoreSurroundRelevance(
				[post("s1", "payment timeout discussion")],
				"  ",
				"BTB-100 timeout",
			),
		).toBe("unknown");
	});

	test("returns low when surround lacks subject mention and root overlap", () => {
		expect(
			scoreSurroundRelevance(
				[post("s1", "unrelated standup notes about lunch")],
				"BTB-100",
				"BTB-100 payment timeout in checkout",
			),
		).toBe("low");
	});

	test("returns unknown when a surround post mentions the subject ticket", () => {
		expect(
			scoreSurroundRelevance(
				[post("s1", "earlier we saw BTB-100 failing")],
				"BTB-100",
				"BTB-100 payment timeout",
			),
		).toBe("unknown");
	});

	test("returns unknown on non-trivial token overlap beyond the ticket key", () => {
		expect(
			scoreSurroundRelevance(
				[post("s1", "checkout payment timeout started yesterday")],
				"BTB-100",
				"BTB-100 payment timeout in checkout",
			),
		).toBe("unknown");
	});

	test("ignores ticket-key-only overlap when deciding low", () => {
		expect(
			scoreSurroundRelevance(
				[post("s1", "fyi BTB-999")],
				"BTB-100",
				"BTB-100 linked from announce",
			),
		).toBe("low");
	});

	test("still labels relevance without dropping surround posts", () => {
		const surround = [post("s1", "unrelated standup notes about lunch")];
		expect(scoreSurroundRelevance(surround, "BTB-100", "BTB-100")).toBe("low");
		expect(surround).toHaveLength(1);
	});
});
