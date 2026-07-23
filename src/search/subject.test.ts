import { describe, expect, test } from "bun:test";
import {
	classifySubject,
	evaluateThreadEvidence,
	RETRIEVAL_SOURCE_WEIGHTS,
	reciprocalRankFusionScore,
	resolveProbes,
	weightedReciprocalRankFusionScore,
} from "./index.ts";

describe("subject and probe resolution", () => {
	test("classifies explicit ticket, permalink, raw post ID, positional ticket, and text in order", () => {
		const postId = "abcdefghijklmnopqrstuvwx12";
		expect(
			classifySubject(`https://chat.test/team/pl/${postId}`, "proj-7"),
		).toMatchObject({
			kind: "ticket",
			ticketKey: "PROJ-7",
		});
		expect(
			classifySubject(`https://chat.test/team/pl/${postId}`),
		).toMatchObject({
			kind: "post",
			postId,
			source: "permalink",
		});
		expect(classifySubject(postId)).toMatchObject({ kind: "post", postId });
		expect(classifySubject("proj-1777")).toMatchObject({
			kind: "ticket",
			ticketKey: "PROJ-1777",
		});
		expect(classifySubject("payment timeout")).toEqual({
			kind: "text",
			text: "payment timeout",
			raw: "payment timeout",
		});
	});

	test("computes weighted reciprocal rank contributions deterministically", () => {
		expect(reciprocalRankFusionScore(1)).toBe(1 / 61);
		expect(reciprocalRankFusionScore(5, 10)).toBe(1 / 15);
		expect(weightedReciprocalRankFusionScore("exact_phrase", 1)).toBe(1 / 61);
		expect(weightedReciprocalRankFusionScore("morph_fts", 1)).toBe(0.45 / 61);
		expect(RETRIEVAL_SOURCE_WEIGHTS.term_fts).toBeGreaterThan(
			RETRIEVAL_SOURCE_WEIGHTS.morph_fts,
		);
		expect(RETRIEVAL_SOURCE_WEIGHTS.morph_fts).toBeGreaterThan(
			RETRIEVAL_SOURCE_WEIGHTS.prefix_fts,
		);
		expect(() => reciprocalRankFusionScore(0)).toThrow();
	});

	test("adds repeated probes to the subject and normalizes phrases and terms", () => {
		const subject = classifySubject("fallback text");
		expect(
			resolveProbes(subject, ['"payment timeout" API', "billing retry"]),
		).toEqual([
			{
				value: "fallback text",
				phrases: [],
				terms: ["fallback", "text"],
			},
			{
				value: '"payment timeout" API',
				phrases: ["payment timeout"],
				terms: ["payment", "timeout", "api"],
				expansions: [
					{
						sourceTerm: "timeout",
						value: "таймаут",
						kind: "synonym",
						match: "exact",
					},
				],
			},
			{
				value: "billing retry",
				phrases: [],
				terms: ["billing", "retry"],
				expansions: [
					{
						sourceTerm: "retry",
						value: "ретрай",
						kind: "synonym",
						match: "exact",
					},
				],
			},
		]);
	});

	test("accepts typed agent probes and retains their independent origins", () => {
		const subject = classifySubject("payment timeout");
		expect(
			resolveProbes(subject, [], {}, [
				{ kind: "ticket_title", value: "payment timeout" },
				{ kind: "file_path", value: "src/payments/worker.ts" },
				{ kind: "symbol", value: "reconcilePayment" },
				{ kind: "symbol", value: "reconcilePayment" },
				{ kind: "service", value: "  " },
			]),
		).toEqual([
			{
				value: "payment timeout",
				phrases: [],
				terms: ["payment", "timeout"],
				kind: "ticket_title",
				expansions: [
					{
						sourceTerm: "timeout",
						value: "таймаут",
						kind: "synonym",
						match: "exact",
					},
				],
			},
			{
				value: "src/payments/worker.ts",
				phrases: [],
				terms: ["src", "payments", "worker", "ts"],
				kind: "file_path",
				expansions: [
					{
						sourceTerm: "worker",
						value: "воркер",
						kind: "synonym",
						match: "exact",
					},
				],
			},
			{
				value: "reconcilePayment",
				phrases: [],
				terms: ["reconcilepayment"],
				kind: "symbol",
			},
		]);
	});

	test("bounds probe terms and proximity analysis for oversized input", () => {
		const subject = classifySubject(
			"one two three four five six seven eight nine",
		);
		const probes = resolveProbes(subject);
		expect(probes[0]?.terms).toHaveLength(8);
		expect(probes[0]?.terms).not.toContain("nine");
		const evidence = evaluateThreadEvidence(
			[
				{
					id: "root",
					message: `${"filler ".repeat(513)} one two three four five six seven eight nine`,
					createAt: 1,
					updateAt: 0,
					deleteAt: 0,
				},
			],
			"root",
			subject,
			probes,
		);
		expect(evidence).toMatchObject({
			exactTermsInSamePost: 0,
			morphTermsInSamePost: 0,
			matchedTermsInSamePost: 0,
			minimumTokenWindow: null,
		});
		expect(evidence.proximityKind).toBeUndefined();
	});

	test("bounds concept matches per probe deterministically", () => {
		const concepts = Object.fromEntries(
			Array.from({ length: 10 }, (_, index) => [
				`concept-${index}`,
				[`phrase ${index}`, `alternate ${index}`],
			]),
		);
		const subject = classifySubject(
			Array.from({ length: 10 }, (_, index) => `phrase ${index}`).join(" "),
		);
		expect(
			resolveProbes(subject, [], {}, [], concepts)[0]?.conceptMatches,
		).toEqual(
			Array.from({ length: 8 }, (_, index) => ({
				conceptId: `concept-${index}`,
				sourcePhrase: `phrase ${index}`,
			})),
		);
	});

	test("filters Russian stop words and normalizes Cyrillic case and ё", () => {
		const subject = classifySubject("Что это за платёж и почему он не прошёл");
		expect(resolveProbes(subject)).toEqual([
			{
				value: "Что это за платёж и почему он не прошёл",
				phrases: [],
				terms: ["платеж", "прошел"],
				morphTerms: ["платеж", "прошел"],
			},
		]);
	});
});
