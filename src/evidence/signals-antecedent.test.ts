import { describe, expect, test } from "bun:test";
import { buildThreadBrief } from "./signals.ts";

function post(
	id: string,
	message: string,
	createAt: number,
	extra: { author?: string } = {},
) {
	return {
		id,
		rootId: "root",
		userId: extra.author ?? "u1",
		authorUsername: extra.author ?? "alice",
		authorDisplayName: extra.author ?? "Alice",
		createAt,
		updateAt: createAt,
		deleteAt: 0,
		message,
		attachments: [],
	};
}

describe("decision antecedent and voice marker", () => {
	test("attaches supporting posts to a short settled cue", () => {
		const brief = buildThreadBrief([
			post(
				"p1",
				"наверное, так пока и сделаю: выпилим legacy route и оставим capability flag",
				10,
				{ author: "bob" },
			),
			post("p2", "обсудили, можно делать", 20, { author: "carol" }),
		]);
		const decision = brief.decisions?.find((entry) => entry.postId === "p2");
		expect(decision?.kind).toBe("approved_decision");
		expect(decision?.supportingPostIds).toEqual(["p1"]);
		expect(decision?.supportingExcerpt).toContain("capability flag");
	});

	test("marks offline/voice approval without changing kind", () => {
		const brief = buildThreadBrief([
			post("v1", "обсудили голосом вариант B, можно делать", 10),
		]);
		const decision = brief.decisions?.[0];
		expect(decision?.offlineOrVoiceApproval).toBe(true);
		expect(decision?.kind).toBe("approved_decision");
	});

	test("marks на дейли as offline/voice without inventing approval alone", () => {
		const brief = buildThreadBrief([
			post("d1", "на дейли договорились, можно делать", 10),
		]);
		expect(brief.decisions?.[0]?.offlineOrVoiceApproval).toBe(true);
	});
});
