import { describe, expect, test } from "bun:test";
import { isTruncatedRussianStemTerm } from "./helpers.ts";

describe("isTruncatedRussianStemTerm", () => {
	test("does not flag complete lemmas like месяц or платеж", () => {
		expect(isTruncatedRussianStemTerm("месяц")).toBe(false);
		expect(isTruncatedRussianStemTerm("платеж")).toBe(false);
		expect(isTruncatedRussianStemTerm("задач")).toBe(false);
	});

	test("still flags truncated paste-stems like транзакц", () => {
		expect(isTruncatedRussianStemTerm("транзакц")).toBe(true);
		expect(isTruncatedRussianStemTerm("уведомл")).toBe(true);
	});
});
