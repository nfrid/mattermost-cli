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

describe("late-thread acknowledgement", () => {
	test("emits lateAcknowledgement when a short ack lands far after a decision", () => {
		const posts = [
			post("d1", "будем не запрещать capabilities", 10, { author: "alice" }),
			post("c1", "а что с skipValidations?", 20, { author: "bob" }),
			post("c2", "нужно уточнить с продуктом", 30, { author: "carol" }),
			post("c3", "ещё вопрос по edge case", 40, { author: "bob" }),
			post("a1", "ок", 50, { author: "bob" }),
		];
		const brief = buildThreadBrief(posts);
		expect(brief.lateAcknowledgement).toMatchObject({
			kind: "late_thread_acknowledgement",
			decisionPostId: "d1",
			ackPostId: "a1",
			author: "bob",
		});
		expect(brief.lateAcknowledgement?.confidence).toBeLessThan(0.7);
		expect(
			brief.decisions?.find((entry) => entry.postId === "d1")?.ackPostId,
		).toBeUndefined();
	});

	test("does not emit lateAcknowledgement when adjacency already paired", () => {
		const brief = buildThreadBrief([
			post("d1", "можно делать", 10, { author: "alice" }),
			post("a1", "ок", 20, { author: "bob" }),
		]);
		expect(brief.lateAcknowledgement).toBeUndefined();
		expect(brief.decisions?.[0]?.ackPostId).toBe("a1");
	});
});

describe("tech-approach cues", () => {
	test("maps architectural approach statements to proposal only", () => {
		const cases = [
			"оставляем на стороне бэка",
			"делаем отдельный роут",
			"keep it on the backend",
			"выносим на отдельный сервис",
		];
		for (const message of cases) {
			const brief = buildThreadBrief([post("p1", message, 10)]);
			const decision = brief.decisions?.find((entry) => entry.postId === "p1");
			expect(decision?.kind).toBe("proposal");
			expect(decision?.kind).not.toBe("approved_decision");
		}
	});

	test("does not upgrade a tech-approach cue via a short ack", () => {
		const brief = buildThreadBrief([
			post("p1", "оставляем на стороне фронта", 10, { author: "alice" }),
			post("p2", "ок", 20, { author: "bob" }),
		]);
		expect(brief.decisions?.[0]?.kind).toBe("proposal");
		expect(brief.decisions?.[0]?.ackPostId).toBe("p2");
	});
});
