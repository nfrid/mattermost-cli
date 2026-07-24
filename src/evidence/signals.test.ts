import { describe, expect, test } from "bun:test";
import type { EvidencePost } from "./packing.ts";
import {
	buildThreadBrief,
	buildThreadSignals,
	citedSignalPostIds,
	isCandidateSpanKind,
	MAX_CANDIDATE_SPANS,
	MAX_DECISION_POST_IDS,
	MAX_PURPOSE_HINTS,
	type ThreadBrief,
	type ThreadSignals,
} from "./signals.ts";

function post(
	id: string,
	message: string,
	createAt: number,
	options: { deleteAt?: number } = {},
): EvidencePost {
	return {
		id,
		rootId: "root-synthetic",
		userId: "user-1",
		authorUsername: "alice",
		authorDisplayName: "Alice",
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
		expect(brief.outcomeWindow?.postIds).toEqual([
			"m3",
			"m4",
			"m5",
			"m6",
			"m7",
		]);
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
			"outcomeWindow",
			"purposeHints",
		]);
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
