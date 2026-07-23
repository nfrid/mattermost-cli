import { describe, expect, test } from "bun:test";
import { expandQueryTerms, matchesQueryExpansion } from "./query-expansion.ts";

describe("bounded query expansion", () => {
	test("generates conservative Russian stems and irregular variants", () => {
		const expansions = expandQueryTerms(["уведомление", "клиенту", "пришло"]);
		expect(expansions).toEqual(
			expect.arrayContaining([
				{
					sourceTerm: "уведомление",
					value: "уведомлен",
					kind: "russian_variant",
					match: "prefix",
				},
				{
					sourceTerm: "клиенту",
					value: "клиент",
					kind: "russian_variant",
					match: "prefix",
				},
				{
					sourceTerm: "пришло",
					value: "приходят",
					kind: "synonym",
					match: "exact",
				},
			]),
		);
		expect(expansions.length).toBeLessThanOrEqual(24);
		expect(
			expansions.some((expansion) =>
				matchesQueryExpansion(
					"Уведомления клиентам пока не приходят",
					expansion,
				),
			),
		).toBe(true);
	});

	test("makes configured synonym groups symmetric", () => {
		expect(
			expandQueryTerms(["replication"], { репликация: ["replication"] }),
		).toContainEqual({
			sourceTerm: "replication",
			value: "репликация",
			kind: "synonym",
			match: "exact",
		});
	});

	test("transliterates only bounded mixed-script technical tokens", () => {
		expect(expandQueryTerms(["пэймент-api"])).toContainEqual({
			sourceTerm: "пэймент-api",
			value: "peyment-api",
			kind: "transliteration",
			match: "exact",
		});
		expect(expandQueryTerms(["дом"])).toEqual([]);
	});
});
