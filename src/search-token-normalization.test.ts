import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeMorphText,
} from "./search-token-normalization.ts";
import { stemRussianSnowball } from "./vendor/snowball/russian.ts";

const vectorsPath = join(
	import.meta.dir,
	"vendor/snowball/russian-vectors.tsv",
);

describe("Russian Snowball search token normalization", () => {
	test("matches selected upstream Snowball vectors", async () => {
		const vectors = (await Bun.file(vectorsPath).text())
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => line.split("\t") as [string, string]);
		expect(vectors.length).toBeGreaterThanOrEqual(250);
		for (const [word, expected] of vectors) {
			expect(stemRussianSnowball(word)).toBe(expected);
		}
	});

	test("normalizes Russian morphology with a single token API", () => {
		expect(analyzeSearchToken("Зависшими")).toEqual({
			original: "Зависшими",
			normalized: "зависшими",
			language: "russian",
			stem: "зависш",
		});
		expect(analyzeSearchToken("платежами").stem).toBe("платеж");
		expect(analyzeSearchToken("уведомления").stem).toBe("уведомлен");
		expect(analyzeSearchToken("задачи").stem).toBe("задач");
	});

	test("builds deterministic document and query morphology", () => {
		expect(
			normalizeMorphText(
				"Разобрались с зависшими платежами в payment-api/PAY-1777",
			),
		).toBe("разобра с зависш платеж в payment-api pay-1777");
		expect(
			morphSearchTerms(["зависший", "платеж", "payment-api", "сбой"]),
		).toEqual(["зависш", "платеж"]);
	});

	test("does not stem technical, mixed, username, or short tokens", () => {
		for (const token of [
			"PAY-1777",
			"https://пример.рф",
			"src/задача.ts",
			"файл.ts",
			"метод_тест",
			"12345",
			"paymentПлатеж",
			"@пользователь",
			"@scope/пакет",
			"сбой",
		]) {
			expect(analyzeSearchToken(token).stem).toBeUndefined();
		}
	});
});
