import { normalizeSearchText } from "./text.ts";
import { stemRussianSnowball } from "./vendor/snowball/russian.ts";

type SearchTokenLanguage = "russian" | "latin" | "mixed" | "other";

interface SearchTokenAnalysis {
	original: string;
	normalized: string;
	language: SearchTokenLanguage;
	stem?: string;
}

const MIN_RUSSIAN_TOKEN_LENGTH = 5;
const MIN_RUSSIAN_STEM_LENGTH = 3;
const PURE_RUSSIAN_TOKEN = /^[А-Яа-яЁё]+$/u;

export function normalizeMorphText(value: string): string {
	return (value.match(/[\p{L}\p{N}_-]+/gu) ?? [])
		.map((token) => {
			const analysis = analyzeSearchToken(token);
			return analysis.stem ?? analysis.normalized;
		})
		.filter(Boolean)
		.join(" ");
}

export function morphSearchTerms(terms: readonly string[]): string[] {
	return [
		...new Set(
			terms
				.map(analyzeSearchToken)
				.flatMap(({ language, stem }) =>
					language === "russian" && stem ? [stem] : [],
				),
		),
	];
}

export function analyzeSearchToken(original: string): SearchTokenAnalysis {
	const normalized = normalizeSearchText(original);
	const language = classifyTokenLanguage(normalized);
	if (
		language !== "russian" ||
		!PURE_RUSSIAN_TOKEN.test(original) ||
		normalized.length < MIN_RUSSIAN_TOKEN_LENGTH
	) {
		return { original, normalized, language };
	}
	const stem = stemRussianSnowball(normalized);
	return stem.length >= MIN_RUSSIAN_STEM_LENGTH
		? { original, normalized, language, stem }
		: { original, normalized, language };
}

function classifyTokenLanguage(value: string): SearchTokenLanguage {
	const hasRussian = /[а-я]/u.test(value);
	const hasLatin = /[a-z]/u.test(value);
	if (hasRussian && hasLatin) return "mixed";
	if (hasRussian && /^[а-я]+$/u.test(value)) return "russian";
	if (hasLatin && /^[a-z]+$/u.test(value)) return "latin";
	return "other";
}
