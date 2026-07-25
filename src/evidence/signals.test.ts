import { describe, expect, test } from "bun:test";
import { POINTER_EXCERPT_LIMIT } from "../search/match-utils.ts";
import type { EvidencePost } from "./packing.ts";
import {
	buildThreadBrief,
	buildThreadSignals,
	citedSignalPostIds,
	DECISION_CONFIDENCE_FLOOR,
	isCandidateSpanKind,
	MAX_CANDIDATE_SPANS,
	MAX_DECISION_POST_IDS,
	MAX_HINT_EVIDENCE_POST_IDS,
	MAX_PURPOSE_HINTS,
	type ThreadBrief,
	type ThreadSignals,
} from "./signals.ts";

function post(
	id: string,
	message: string,
	createAt: number,
	options: { deleteAt?: number; author?: string } = {},
): EvidencePost {
	const author = options.author ?? "alice";
	return {
		id,
		rootId: "root-synthetic",
		userId: `user-${author}`,
		authorUsername: author,
		authorDisplayName: author,
		createAt,
		updateAt: createAt,
		deleteAt: options.deleteAt ?? 0,
		message,
		attachments: [],
	};
}

describe("buildThreadSignals", () => {
	test("TECHSUPP-109-style decision evolution yields candidate spans only", () => {
		const posts = [
			post("p1", "TECHSUPP-109: consider option A vs B", 10),
			post(
				"p2",
				"Rather than option A — rejected; not going with cache rewrite",
				20,
			),
			post("p3", "TECHSUPP-109 итого: решили идти с option B, фиксируем", 30),
			post("p4", "ship it after QA sign-off", 40),
		];
		const signals = buildThreadSignals(posts, {
			subjectTicket: "TECHSUPP-109",
		});

		expect(
			signals.candidateSpans.every((span) => isCandidateSpanKind(span.kind)),
		).toBe(true);
		expect(
			signals.candidateSpans.some(
				(span) =>
					span.kind === "rejected_option_candidate" && span.postId === "p2",
			),
		).toBe(true);
		expect(
			signals.candidateSpans.some(
				(span) =>
					span.kind === "decision_candidate" &&
					span.postId === "p3" &&
					span.cues.includes("решили"),
			),
		).toBe(true);
		expect(signals.outcomeWindow).toEqual({
			label: "outcome_window",
			subjectTicket: "TECHSUPP-109",
			afterPostId: "p3",
			startPostId: "p4",
			endPostId: "p4",
			postIds: ["p4"],
			precedingInWindow: 0,
		});
		assertCitationsWithin(signals, posts);
	});

	test("BTB-1281-style cause discussion surfaces open questions without inventing decisions", () => {
		const posts = [
			post("c1", "BTB-1281: payment timeout in reconcile?", 10),
			post("c2", "не ясно — нужно уточнить root cause upstream", 20),
			post("c3", "BTB-1281 still open question until logs land", 30),
		];
		const signals = buildThreadSignals(posts, { subjectTicket: "BTB-1281" });

		expect(
			signals.candidateSpans.filter(
				(span) => span.kind === "open_question_candidate",
			).length,
		).toBeGreaterThan(0);
		expect(
			signals.candidateSpans.some((span) => span.kind === "decision_candidate"),
		).toBe(false);
		expect(signals.outcomeWindow).toBeUndefined();
		assertCitationsWithin(signals, posts);
	});

	test("BTB-2112-style noise never cites omitted posts", () => {
		const returned = [
			post("n1", "BTB-2112 navigate fixture — quiet status update", 10),
			post("n2", "BTB-2112 unrelated standup chatter", 20),
		];
		const omitted = [
			post(
				"omitted-decision",
				"BTB-2112 решили merge; approved going with hotfix",
				15,
			),
		];
		const signals = buildThreadSignals(returned, {
			subjectTicket: "BTB-2112",
		});

		const cited = new Set(citedSignalPostIds(signals));
		expect(cited.has("omitted-decision")).toBe(false);
		for (const id of cited) {
			expect(returned.some((item) => item.id === id)).toBe(true);
		}
		expect(
			signals.candidateSpans.some((span) => span.excerpt.includes("решили")),
		).toBe(false);
		// Omitted posts are not passed in — building from them alone would find cues,
		// proving the safety boundary is the returned set.
		const fromOmitted = buildThreadSignals(omitted, {
			subjectTicket: "BTB-2112",
		});
		expect(fromOmitted.candidateSpans.length).toBeGreaterThan(0);
		assertCitationsWithin(signals, returned);
	});

	test("BTB-2080-style role recall emits multi-label roleHints without replacing roles", () => {
		const posts = [
			post("r1", "BTB-2080: кто возьмёт reproduce / QA репро?", 10),
			post("r2", "похоже на regression после релиза", 20),
			post("r3", "залил fix: merged MR !42, deploy tonight", 30),
			post("r4", "назначаю sync созвон на статус", 40),
		];
		const signals = buildThreadSignals(posts, { subjectTicket: "BTB-2080" });

		const labels = signals.roleHints.map((hint) => hint.label).sort();
		expect(labels).toEqual([
			"coordination",
			"implementation",
			"regression",
			"testing",
		]);
		for (const hint of signals.roleHints) {
			expect(hint.evidencePostIds.length).toBeGreaterThan(0);
			expect(hint.cues.length).toBeGreaterThan(0);
			expect(hint.confidence).toBeGreaterThan(0);
			expect(hint.confidence).toBeLessThanOrEqual(0.95);
		}
		assertCitationsWithin(signals, posts);
	});

	test("caps candidate spans and skips deleted posts", () => {
		const posts = Array.from({ length: MAX_CANDIDATE_SPANS + 4 }, (_, index) =>
			post(
				`cap-${index}`,
				index === 0
					? "deleted решили?"
					: `решили option ${index}; вопрос: unclear?`,
				index + 1,
				index === 0 ? { deleteAt: 99 } : {},
			),
		);
		const signals = buildThreadSignals(posts);
		expect(signals.candidateSpans.length).toBeLessThanOrEqual(
			MAX_CANDIDATE_SPANS,
		);
		expect(
			signals.candidateSpans.every((span) => span.postId !== "cap-0"),
		).toBe(true);
		assertCitationsWithin(
			signals,
			posts.filter((item) => !item.deleteAt),
		);
	});

	test("first-person commitments score as decision candidates", () => {
		const utterances: Array<[string, string]> = [
			["u1", "просто выпилю нафиг это"],
			["u2", "наверное, так пока и сделаю"],
			["u3", "обсудили, можно делать"],
			["u4", "i'll go with the capability flag"],
			["u5", "going to remove the legacy route"],
		];
		for (const [id, message] of utterances) {
			const signals = buildThreadSignals([post(id, message, 10)]);
			const decision = signals.candidateSpans.find(
				(span) => span.kind === "decision_candidate",
			);
			expect(decision?.postId).toBe(id);
			expect(decision?.cues.length).toBeGreaterThan(0);
			expect(decision?.confidence).toBeGreaterThanOrEqual(
				DECISION_CONFIDENCE_FLOOR,
			);
		}
	});

	test("interrogative sentence rejects the decision cue it contains", () => {
		const signals = buildThreadSignals([post("q1", "обсудили на дейли ?", 10)]);
		expect(
			signals.candidateSpans.some((span) => span.kind === "decision_candidate"),
		).toBe(false);
		// The same message is still a legitimate open question.
		expect(
			signals.candidateSpans.some(
				(span) => span.kind === "open_question_candidate",
			),
		).toBe(true);

		const brief = buildThreadBrief([post("q1", "обсудили на дейли ?", 10)]);
		expect(brief.decisionPostIds).toEqual([]);
		expect(brief.decisions).toBeUndefined();
	});

	test("interrogative guard is sentence-level, not message-level", () => {
		const message =
			"посмотрел на оба варианта, capabilities не тянут. просто выпилю нафиг это и закрою тикет. кто-нибудь помнит когда был последний релиз?";
		const signals = buildThreadSignals([post("long-1", message, 10)]);
		const decision = signals.candidateSpans.find(
			(span) => span.kind === "decision_candidate",
		);
		expect(decision?.postId).toBe("long-1");
		expect(decision?.cues).toContain("выпилю");
	});

	test("negated commitment does not read as a decision", () => {
		const signals = buildThreadSignals([
			post("n1", "не будем делать это в этом релизе", 10),
		]);
		expect(
			signals.candidateSpans.some((span) => span.kind === "decision_candidate"),
		).toBe(false);
	});

	test("bare future tense reaches the brief but ranks below explicit cues", () => {
		const brief = buildThreadBrief([
			post("b1", "будем не запрещать для КС, а разрешать остальным", 10),
			post("b2", "договорились, выкатываем в понедельник", 20),
		]);
		// Both surface, but the explicit consensus cue outranks bare future tense.
		expect(brief.decisionPostIds).toEqual(["b2", "b1"]);

		const asked = buildThreadBrief([
			post("q1", "а что будем делать с этим?", 10),
		]);
		expect(asked.decisionPostIds).toEqual([]);
	});

	test("the decider's own follow-up posts do not consume the ack window", () => {
		const signals = buildThreadSignals([
			post("d1", "будем не запрещать для КС, а разрешать остальным", 10, {
				author: "bob",
			}),
			post("d2", "ну то бишь эти роли поднимем в приоритете", 20, {
				author: "bob",
			}),
			post("d3", "надо было изначально так и сделать", 30, { author: "bob" }),
			post("d4", "но я забоялся менять поведение", 40, { author: "bob" }),
			post("d5", "хорошо", 50, { author: "alice" }),
		]);
		const decision = signals.candidateSpans.find(
			(span) => span.kind === "decision_candidate" && span.postId === "d1",
		);
		expect(decision?.ackPostId).toBe("d5");
	});

	test("short ack from another author raises decision confidence", () => {
		const posts = [
			post(
				"a1",
				"будем не запрещать для КС и рекрутеров, а разрешать остальным",
				10,
				{ author: "bob" },
			),
			post("a2", "хорошо", 20, { author: "alice" }),
		];
		const signals = buildThreadSignals(posts);
		const decision = signals.candidateSpans.find(
			(span) => span.kind === "decision_candidate",
		);
		expect(decision?.postId).toBe("a1");
		expect(decision?.ackPostId).toBe("a2");
		expect(citedSignalPostIds(signals)).toContain("a2");

		const withoutAck = buildThreadSignals([
			posts[0] as EvidencePost,
			post("a2", "хорошо", 20, { author: "bob" }),
		]);
		const unacked = withoutAck.candidateSpans.find(
			(span) => span.kind === "decision_candidate",
		);
		expect(unacked?.ackPostId).toBeUndefined();
		expect(decision?.confidence).toBeCloseTo(
			(unacked?.confidence ?? 0) + 0.15,
			5,
		);
		// The bump is applied after scoring — cue weights keep their meaning.
		expect(decision?.cues).toEqual(unacked?.cues ?? []);
		assertCitationsWithin(signals, posts);
	});

	test("ack pairing ignores the same author and posts beyond the lookahead", () => {
		const sameAuthor = buildThreadSignals([
			post("s1", "так и сделаю", 10, { author: "bob" }),
			post("s2", "ок", 20, { author: "bob" }),
		]);
		expect(
			sameAuthor.candidateSpans.find(
				(span) => span.kind === "decision_candidate",
			)?.ackPostId,
		).toBeUndefined();

		const tooFar = buildThreadSignals([
			post("f1", "так и сделаю", 10, { author: "bob" }),
			post("f2", "а что с миграцией", 20, { author: "alice" }),
			post("f3", "и с фичефлагом тоже вопрос остаётся", 30, {
				author: "carol",
			}),
			post("f4", "ок", 40, { author: "alice" }),
		]);
		expect(
			tooFar.candidateSpans.find((span) => span.kind === "decision_candidate")
				?.ackPostId,
		).toBeUndefined();
	});

	test("outcome window keeps the tail when it exceeds the cap", () => {
		const posts = [
			post("root", "TICKET-7 обсуждаем лимиты", 10),
			...Array.from({ length: 25 }, (_, index) =>
				post(`w${index}`, `follow-up ${index}`, 20 + index),
			),
		];
		const signals = buildThreadSignals(posts, { subjectTicket: "TICKET-7" });
		expect(signals.outcomeWindow?.postIds.length).toBe(20);
		expect(signals.outcomeWindow?.postIds[0]).toBe("w5");
		expect(signals.outcomeWindow?.startPostId).toBe("w5");
		expect(signals.outcomeWindow?.endPostId).toBe("w24");
		expect(signals.outcomeWindow?.precedingInWindow).toBe(5);
		assertCitationsWithin(signals, posts);
	});

	test("outcome window is a label only — not a verified decision", () => {
		const posts = [
			post("o1", "TICKET-1 announce", 10),
			post("o2", "TICKET-1 last mention", 20),
			post("o3", "follow-up without ticket key", 30),
			post("o4", "another follow-up", 40),
		];
		const signals = buildThreadSignals(posts, { subjectTicket: "TICKET-1" });
		expect(signals.outcomeWindow?.label).toBe("outcome_window");
		expect(signals.outcomeWindow?.postIds).toEqual(["o3", "o4"]);
		expect(JSON.stringify(signals.outcomeWindow).toLowerCase()).not.toContain(
			"verified",
		);
		expect(JSON.stringify(signals.outcomeWindow).toLowerCase()).not.toContain(
			"decision",
		);
	});
});

describe("buildThreadBrief", () => {
	test("BTB-2113-style: product go-ahead vs eng discussion vs DM noise", () => {
		const product = [
			post("b2b-1", "BTB-2113: past-month cancel for superadmin?", 10),
			post("b2b-2", "BTB-2113 обсудили, можно делать", 20),
		];
		const eng = [
			post("be-1", "BTB-2113: capabilities vs dedicated route — unclear?", 10),
			post(
				"be-2",
				"нужно уточнить authz model before implement; open question on MR shape",
				20,
			),
			post("be-3", "QA: reproduce edge case after deploy?", 30),
		];
		const dm = [post("dm-1", "BTB-2113 https://tracker.example/BTB-2113", 10)];

		const productBrief = buildThreadBrief(product, {
			subjectTicket: "BTB-2113",
		});
		expect(
			productBrief.purposeHints.some((hint) => hint.label === "decision"),
		).toBe(true);
		expect(productBrief.decisionPostIds).toContain("b2b-2");
		expect(
			productBrief.purposeHints.some((hint) => hint.label === "noise"),
		).toBe(false);
		assertBriefCitationsWithin(productBrief, product);

		const engBrief = buildThreadBrief(eng, { subjectTicket: "BTB-2113" });
		expect(engBrief.decisionPostIds).toEqual([]);
		expect(
			engBrief.purposeHints.some((hint) => hint.label === "debugging"),
		).toBe(true);
		expect(
			engBrief.purposeHints.some((hint) => hint.label === "decision"),
		).toBe(false);
		assertBriefCitationsWithin(engBrief, eng);

		const dmBrief = buildThreadBrief(dm, { subjectTicket: "BTB-2113" });
		expect(dmBrief.purposeHints.map((hint) => hint.label)).toEqual(["noise"]);
		expect(dmBrief.decisionPostIds).toEqual([]);
		assertBriefCitationsWithin(dmBrief, dm);
	});

	test("rejects meta решение phrasing and caps lean outcomeWindow", () => {
		const posts = [
			post("m1", "TECHSUPP-109: какое решение сейчас по лимитам?", 10),
			post("m2", "TECHSUPP-109 финальное решение было создано в трекере", 20),
			post("m3", "follow-up 1", 30),
			post("m4", "follow-up 2", 40),
			post("m5", "follow-up 3", 50),
			post("m6", "follow-up 4", 60),
			post("m7", "follow-up 5", 70),
			post("m8", "follow-up 6", 80),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "TECHSUPP-109" });
		expect(brief.decisionPostIds).toEqual([]);
		expect(brief.purposeHints.some((hint) => hint.label === "decision")).toBe(
			false,
		);
		expect(brief.outcomeWindow?.postIds.length).toBeLessThanOrEqual(5);
		// Tail-anchored: the last five eligible posts, not the first five.
		expect(brief.outcomeWindow?.postIds).toEqual([
			"m4",
			"m5",
			"m6",
			"m7",
			"m8",
		]);
		expect(brief.outcomeWindow?.startPostId).toBe("m4");
		expect(brief.outcomeWindow?.endPostId).toBe("m8");
		expect(brief.outcomeWindow?.precedingInWindow).toBe(1);
		assertBriefCitationsWithin(brief, posts);
	});

	test("катим surfaces as status not decision", () => {
		const posts = [post("s1", "BTB-2080 катим в прод сегодня", 10)];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-2080" });
		expect(brief.decisionPostIds).toEqual([]);
		expect(brief.purposeHints.some((hint) => hint.label === "status")).toBe(
			true,
		);
		expect(brief.purposeHints.some((hint) => hint.label === "decision")).toBe(
			false,
		);
	});

	test("TECHSUPP-style outcome window uses packed posts only", () => {
		const packed = [
			post("p1", "TECHSUPP-109: consider option A vs B", 10),
			post("p2", "TECHSUPP-109 итого: решили option B, фиксируем", 20),
			post("p3", "follow-up after QA sign-off", 30),
		];
		const brief = buildThreadBrief(packed, { subjectTicket: "TECHSUPP-109" });

		expect(brief.outcomeWindow).toEqual({
			label: "outcome_window",
			subjectTicket: "TECHSUPP-109",
			afterPostId: "p2",
			startPostId: "p3",
			endPostId: "p3",
			postIds: ["p3"],
			precedingInWindow: 0,
		});
		expect(brief.decisionPostIds).toEqual(["p2"]);
		expect(brief.purposeHints.some((hint) => hint.label === "decision")).toBe(
			true,
		);
		expect(JSON.stringify(brief)).not.toContain("omitted-later");
		assertBriefCitationsWithin(brief, packed);

		// Extra packed follow-up after the last ticket mention extends the window;
		// posts never returned in the packet cannot appear in the brief.
		const withExtraPacked = buildThreadBrief(
			[...packed, post("p4", "another packed follow-up", 35)],
			{ subjectTicket: "TECHSUPP-109" },
		);
		expect(withExtraPacked.outcomeWindow?.postIds).toEqual(["p3", "p4"]);
		expect(
			buildThreadBrief(packed, { subjectTicket: "TECHSUPP-109" }).outcomeWindow
				?.postIds,
		).not.toContain("p4");
	});

	test("announce presentation and multi_ticket_root reason surface announce hint", () => {
		const posts = [
			post("a1", "Duty: BTB-1 BTB-2 BTB-3 CLIENTS-9 — assignment bulletin", 10),
			post("a2", "ping owners for status", 20),
		];
		const fromPresentation = buildThreadBrief(posts, {
			subjectTicket: "BTB-1",
			presentation: "announce",
		});
		expect(
			fromPresentation.purposeHints.some((hint) => hint.label === "announce"),
		).toBe(true);
		expect(fromPresentation.purposeHints[0]?.evidencePostIds).toContain("a1");

		const fromReason = buildThreadBrief(posts, {
			subjectTicket: "BTB-1",
			reasons: ["multi_ticket_root", "latest_activity"],
		});
		expect(
			fromReason.purposeHints.some((hint) => hint.label === "announce"),
		).toBe(true);
	});

	test("status hint needs coordination without decision; caps stay lean", () => {
		const statusPosts = [
			post("s1", "TICKET-9: кто возьмёт sync на статус?", 10),
			post("s2", "назначаю созвон завтра", 20),
			post("s3", "ping owners after standup", 30),
		];
		const statusBrief = buildThreadBrief(statusPosts, {
			subjectTicket: "TICKET-9",
		});
		expect(
			statusBrief.purposeHints.some((hint) => hint.label === "status"),
		).toBe(true);
		expect(statusBrief.decisionPostIds).toEqual([]);

		const decisionBlocksStatus = buildThreadBrief(
			[
				...statusPosts,
				post("s4", "TICKET-9 итого: решили ship it, фиксируем", 40),
			],
			{ subjectTicket: "TICKET-9" },
		);
		expect(
			decisionBlocksStatus.purposeHints.some((hint) => hint.label === "status"),
		).toBe(false);
		expect(decisionBlocksStatus.decisionPostIds).toContain("s4");

		const manyDecisions = Array.from({ length: 8 }, (_, index) =>
			post(`d${index}`, `TICKET-9 решили option ${index}; approved`, index + 1),
		);
		const capped = buildThreadBrief(manyDecisions, {
			subjectTicket: "TICKET-9",
		});
		expect(capped.decisionPostIds.length).toBeLessThanOrEqual(
			MAX_DECISION_POST_IDS,
		);
		expect(capped.purposeHints.length).toBeLessThanOrEqual(MAX_PURPOSE_HINTS);
		expect(capped.purposeHints.every((hint) => hint.label !== "noise")).toBe(
			true,
		);
		const decisionHint = capped.purposeHints.find(
			(hint) => hint.label === "decision",
		);
		expect(decisionHint?.evidencePostIds).toEqual(capped.decisionPostIds);
		expect(decisionHint?.evidencePostIds.length).toBeLessThanOrEqual(
			MAX_DECISION_POST_IDS,
		);
		assertBriefCitationsWithin(capped, manyDecisions);
	});

	test("noise is exclusive — not combined with status or announce", () => {
		const pingDm = buildThreadBrief(
			[post("pdm-1", "BTB-99 ping https://tracker.example/BTB-99", 10)],
			{ subjectTicket: "BTB-99" },
		);
		expect(pingDm.purposeHints.map((hint) => hint.label)).toEqual(["status"]);
		expect(pingDm.purposeHints.some((hint) => hint.label === "noise")).toBe(
			false,
		);

		const announceShort = buildThreadBrief(
			[post("ann-1", "BTB-1 BTB-2 BTB-3 duty bulletin", 10)],
			{ subjectTicket: "BTB-1", presentation: "announce" },
		);
		expect(announceShort.purposeHints.map((hint) => hint.label)).toEqual([
			"announce",
		]);
		expect(
			announceShort.purposeHints.some((hint) => hint.label === "noise"),
		).toBe(false);
	});

	test("open_question is its own purpose, not debugging", () => {
		const posts = [
			post("oq1", "TICKET-3: не ясно кто владелец лимитов", 10),
			post("oq2", "нужно уточнить у продукта, ждём ответа", 20),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "TICKET-3" });
		const labels = brief.purposeHints.map((hint) => hint.label);
		expect(labels).toContain("open_question");
		expect(labels).not.toContain("debugging");
		const question = brief.purposeHints.find(
			(hint) => hint.label === "open_question",
		);
		expect(question?.evidencePostIds).toEqual(["oq1", "oq2"]);
		expect(question?.confidence).toBeGreaterThanOrEqual(0.5);
		assertBriefCitationsWithin(brief, posts);
	});

	test("debugging comes from debug role hints, questions never promote it", () => {
		const posts = [
			post("dbg1", "TICKET-4 регресс после релиза, репро есть", 10),
			post("dbg2", "залил fix: merged MR", 20),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "TICKET-4" });
		expect(brief.purposeHints.map((hint) => hint.label)).toContain("debugging");
		expect(
			brief.purposeHints.find((hint) => hint.label === "debugging")
				?.evidencePostIds,
		).toEqual(["dbg1", "dbg2"]);
	});

	test("a bare ? alone does not raise open_question", () => {
		const quiet = [
			post("bq1", "TICKET-5 кто-нибудь смотрел это ?", 10),
			post("bq2", "я гляну вечером", 20),
		];
		const quietBrief = buildThreadBrief(quiet, { subjectTicket: "TICKET-5" });
		expect(quietBrief.purposeHints.map((hint) => hint.label)).not.toContain(
			"open_question",
		);
		expect(quietBrief.purposeHints.map((hint) => hint.label)).not.toContain(
			"debugging",
		);

		// Three distinct posts carrying bare questions do cross the bar.
		const recurring = [
			...quiet,
			post("bq3", "а по срокам что ?", 30),
			post("bq4", "и кто владелец ?", 40),
		];
		const recurringBrief = buildThreadBrief(recurring, {
			subjectTicket: "TICKET-5",
		});
		expect(recurringBrief.purposeHints.map((hint) => hint.label)).toContain(
			"open_question",
		);
	});

	test("hint evidence is capped at the chronologically last ids", () => {
		const posts = Array.from({ length: 8 }, (_, index) =>
			post(`hq${index}`, `не ясно по пункту ${index}`, 10 + index),
		);
		const brief = buildThreadBrief(posts, { subjectTicket: "TICKET-6" });
		const question = brief.purposeHints.find(
			(hint) => hint.label === "open_question",
		);
		expect(question?.evidencePostIds.length).toBe(MAX_HINT_EVIDENCE_POST_IDS);
		expect(question?.evidencePostIds).toEqual([
			"hq3",
			"hq4",
			"hq5",
			"hq6",
			"hq7",
		]);
	});

	test("brief inlines the capped decisions with numeric createAt", () => {
		const posts = [
			post("i1", "BTB-2113: past-month cancel for superadmin?", 10),
			post("i2", "BTB-2113 обсудили, можно делать", 20, { author: "bob" }),
			post("i3", "хорошо", 30, { author: "alice" }),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-2113" });
		expect(brief.decisionPostIds).toEqual(["i2"]);
		expect(brief.decisions).toHaveLength(1);
		const decision = brief.decisions?.[0];
		expect(decision?.postId).toBe("i2");
		expect(decision?.author).toBe("bob");
		expect(decision?.createAt).toBe(20);
		expect(typeof decision?.createAt).toBe("number");
		expect(decision?.excerpt).toBe("BTB-2113 обсудили, можно делать");
		expect(decision?.cues).toContain("можно делать");
		expect(decision?.ackPostId).toBe("i3");
		expect(decision?.confidence).toBeLessThanOrEqual(0.95);

		const manyDecisions = Array.from({ length: 9 }, (_, index) =>
			post(`md${index}`, `TICKET-8 итого: решили option ${index}`, 10 + index),
		);
		const cappedBrief = buildThreadBrief(manyDecisions, {
			subjectTicket: "TICKET-8",
		});
		expect(cappedBrief.decisions?.length).toBe(MAX_DECISION_POST_IDS);
		expect(cappedBrief.decisions?.map((item) => item.postId)).toEqual(
			cappedBrief.decisionPostIds,
		);
		expect(
			cappedBrief.decisions?.every(
				(item) => item.excerpt.length <= POINTER_EXCERPT_LIMIT,
			),
		).toBe(true);
	});

	test("brief never invents prose summaries or verified outcomes", () => {
		const posts = [
			post("x1", "TECHSUPP-1 kickoff", 10),
			post("x2", "TECHSUPP-1 решили rollback", 20),
			post("x3", "follow-up deploy", 30),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "TECHSUPP-1" });
		const serialized = JSON.stringify(brief).toLowerCase();
		expect(serialized).not.toContain("summary");
		expect(serialized).not.toContain("verified");
		expect(brief.outcomeWindow?.label).toBe("outcome_window");
		expect(Object.keys(brief).sort()).toEqual([
			"decisionPostIds",
			"decisions",
			"outcomeWindow",
			"purposeHints",
		]);
	});

	test("inlines open questions and reports how many messages followed", () => {
		const posts = [
			post("q1", "BTB-1 давайте решим: capabilities или отдельный роут?", 10),
			post("q2", "я за отдельный роут", 20, { author: "bob" }),
			post("q3", "надо будет с Аней обсудить", 30),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-1" });

		const questions = brief.openQuestions ?? [];
		expect(questions.length).toBeGreaterThan(0);
		const tail = questions.find((question) => question.isThreadTail);
		expect(tail?.postId).toBe("q3");
		expect(tail?.repliesAfter).toBe(0);
		const first = questions.find((question) => question.postId === "q1");
		expect(first?.repliesAfter).toBe(1);
		assertBriefCitationsWithin(brief, posts);
	});

	test("reports open_question when the thread stops on a question", () => {
		const posts = [
			post("t1", "BTB-2 смотрим отчёт", 10),
			post("t2", "а по координаторам что делаем?", 20, { author: "bob" }),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-2" });

		const hint = brief.purposeHints.find(
			({ label }) => label === "open_question",
		);
		// A bare `?` scores 0.4 and used to leave the thread with no purpose at all.
		expect(hint?.confidence).toBeGreaterThanOrEqual(0.55);
	});

	test("attaches scope refinements that narrow a decision", () => {
		const posts = [
			post("d0", "BTB-3 обсуждаем ограничения", 10),
			post("d1", "решили: будем разрешать остальным роли", 20),
			post("d2", "так кс не сможет проводить модерацию", 30, { author: "bob" }),
			post("d3", "нет, это только про координацию", 40),
			post("d4", "хорошо", 50, { author: "bob" }),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-3" });

		const decision = brief.decisions?.find(({ postId }) => postId === "d1");
		expect(decision?.refinements?.map(({ postId }) => postId)).toEqual(["d3"]);
		expect(decision?.refinements?.[0]?.excerpt).toContain(
			"только про координацию",
		);
	});

	test("never frames the same post as both a decision and an open question", () => {
		const posts = [
			post("m1", "BTB-4 стартуем", 10),
			post("m2", "решили: катим в прод, но надо решить детали с Аней", 20),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-4" });

		expect(brief.decisionPostIds).toContain("m2");
		expect(
			brief.openQuestions?.map(({ postId }) => postId) ?? [],
		).not.toContain("m2");
	});

	test("does not claim a thread tail when packing omitted posts", () => {
		const posts = [
			post("o1", "BTB-5 контекст", 10),
			post("o2", "а что с координаторами?", 20, { author: "bob" }),
		];
		const complete = buildThreadBrief(posts, { subjectTicket: "BTB-5" });
		const truncated = buildThreadBrief(posts, {
			subjectTicket: "BTB-5",
			omittedPosts: 4,
		});

		expect(complete.openQuestions?.[0]?.isThreadTail).toBe(true);
		expect(truncated.openQuestions?.[0]?.isThreadTail).toBeUndefined();
	});

	test("does not read a finished discussion as an open question", () => {
		const posts = [
			post("f1", "BTB-6 созвон", 10),
			post(
				"f2",
				"созвонились и успели всё обсудить, договорились по плану",
				20,
			),
		];
		const brief = buildThreadBrief(posts, { subjectTicket: "BTB-6" });

		expect(brief.openQuestions ?? []).toEqual([]);
	});

	test("ignores generic discourse markers as scope refinements", () => {
		const posts = [
			post("g1", "решили: выпилю старый роут", 10),
			post("g2", "кстати я в отпуске только в пятницу заканчиваю", 20, {
				author: "bob",
			}),
			post("g3", "точнее, созвон в среду, а не в четверг", 30, {
				author: "bob",
			}),
		];
		const brief = buildThreadBrief(posts, {});

		expect(brief.decisions?.[0]?.refinements).toBeUndefined();
	});

	test("never attributes a refinement across two decisions", () => {
		const posts = [
			post("r1", "решили: выпилю старый роут", 10),
			post("r2", "решили: перепишу валидацию", 20),
			post("r3", "то бишь только для координаторов", 30),
		];
		const brief = buildThreadBrief(posts, {});

		const first = brief.decisions?.find(({ postId }) => postId === "r1");
		const second = brief.decisions?.find(({ postId }) => postId === "r2");
		expect(first?.refinements).toBeUndefined();
		expect(second?.refinements?.map(({ postId }) => postId)).toEqual(["r3"]);
	});
});

function assertCitationsWithin(
	signals: ThreadSignals,
	posts: readonly EvidencePost[],
): void {
	const allowed = new Set(posts.map((item) => item.id));
	for (const id of citedSignalPostIds(signals)) {
		expect(allowed.has(id)).toBe(true);
	}
}

function assertBriefCitationsWithin(
	brief: ThreadBrief,
	posts: readonly EvidencePost[],
): void {
	const allowed = new Set(posts.map((item) => item.id));
	for (const id of brief.decisionPostIds) {
		expect(allowed.has(id)).toBe(true);
	}
	for (const hint of brief.purposeHints) {
		for (const id of hint.evidencePostIds) {
			expect(allowed.has(id)).toBe(true);
		}
	}
	if (brief.outcomeWindow) {
		expect(allowed.has(brief.outcomeWindow.afterPostId)).toBe(true);
		for (const id of brief.outcomeWindow.postIds) {
			expect(allowed.has(id)).toBe(true);
		}
	}
}
