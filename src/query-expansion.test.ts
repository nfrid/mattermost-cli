import { describe, expect, test } from "bun:test";
import { expandQueryTerms, matchesQueryExpansion } from "./query-expansion.ts";

describe("bounded query expansion", () => {
	test("keeps irregular variants separate from morphology", () => {
		const expansions = expandQueryTerms(["уведомление", "клиенту", "пришло"]);
		expect(expansions).toContainEqual({
			sourceTerm: "пришло",
			value: "приходят",
			kind: "synonym",
			match: "exact",
		});
		expect(
			expansions.some(({ sourceTerm }) =>
				["уведомление", "клиенту"].includes(sourceTerm),
			),
		).toBe(false);
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

	test("keeps mixed-script correction separate from transliteration", () => {
		expect(expandQueryTerms(["пэймент-api"])).toContainEqual({
			sourceTerm: "пэймент-api",
			value: "peyment-api",
			kind: "mixed_script",
			match: "exact",
		});
		expect(expandQueryTerms(["paymеnt"])).toContainEqual({
			sourceTerm: "paymеnt",
			value: "payment",
			kind: "mixed_script",
			match: "exact",
		});
	});

	test("corrects bounded keyboard-layout tokens including Russian punctuation keys", () => {
		const expansions = expandQueryTerms(
			["pfdbckb", "gkfnt", "b"],
			{},
			{
				rawText: "pfdbckb gkfnt;b",
			},
		);
		expect(expansions).toContainEqual({
			sourceTerm: "pfdbckb",
			value: "зависли",
			kind: "keyboard_layout",
			match: "morph",
		});
		expect(expansions).toContainEqual({
			sourceTerm: "gkfnt;b",
			value: "платежи",
			kind: "keyboard_layout",
			match: "morph",
		});
		expect(
			expandQueryTerms(["payment", "callback"]).filter(
				({ kind }) => kind !== "synonym",
			),
		).toEqual([]);
	});

	test("transliterates bounded Latin spellings without expanding ordinary English", () => {
		const expansions = expandQueryTerms(["replikaciya", "dannyh"]);
		expect(expansions).toContainEqual({
			sourceTerm: "replikaciya",
			value: "репликация",
			kind: "transliteration",
			match: "morph",
		});
		expect(expansions).toContainEqual({
			sourceTerm: "dannyh",
			value: "данных",
			kind: "transliteration",
			match: "morph",
		});
		expect(expandQueryTerms(["domain", "payment"])).toEqual([]);
		expect(
			expandQueryTerms(["replikaciya"], {}, { enableScriptVariants: false }),
		).toEqual([]);
	});
});
