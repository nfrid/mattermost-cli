import { describe, expect, test } from "bun:test";
import {
	conceptIndexFingerprint,
	conceptQueryMatches,
	conceptToken,
	conceptTokensForText,
} from "./search-concepts.ts";

const concepts = {
	"duplicate-charge": [
		"повторное списание",
		"списали дважды",
		"duplicate charge",
	],
	retry: ["повторный запуск", "retry", "ретрай", "scheduleRetry"],
};

describe("bounded search concepts", () => {
	test("maps configured document and query phrases to opaque stable tokens", () => {
		const token = conceptToken("duplicate-charge");
		expect(token).toMatch(/^zzconcept[a-f0-9]+$/);
		expect(
			conceptTokensForText(
				"После ретрая получили повторное списание",
				concepts,
			),
		).toEqual([token]);
		expect(
			conceptTokensForText("Разбираемся с повторными списаниями", concepts),
		).toEqual([token]);
		expect(
			conceptQueryMatches("Почему деньги списали дважды?", concepts),
		).toEqual([
			{
				conceptId: "duplicate-charge",
				sourcePhrase: "списали дважды",
			},
		]);
	});

	test("uses exact phrase boundaries and does not build transitive matches", () => {
		expect(
			conceptTokensForText("retryable не является retry", concepts),
		).toEqual([conceptToken("retry")]);
		expect(conceptTokensForText("retryable", concepts)).toEqual([]);
		expect(conceptTokensForText("ретраями", concepts)).toEqual([]);
		expect(conceptQueryMatches("повторная обработка", concepts)).toEqual([]);
	});

	test("fingerprints normalized concept configuration deterministically", () => {
		expect(conceptIndexFingerprint(concepts)).toBe(
			conceptIndexFingerprint({
				retry: ["scheduleRetry", "ретрай", "retry", "повторный запуск"],
				"duplicate-charge": [
					"duplicate charge",
					"списали дважды",
					"повторное списание",
				],
			}),
		);
		expect(conceptIndexFingerprint(concepts)).not.toBe(
			conceptIndexFingerprint({ retry: ["retry", "повторный запуск"] }),
		);
	});
});
