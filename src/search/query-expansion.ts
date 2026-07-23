import { normalizeMorphText } from "./search-token-normalization.ts";
import { containsNormalizedExactText, normalizeSearchText } from "./text.ts";

export type QueryExpansionKind =
	| "synonym"
	| "keyboard_layout"
	| "transliteration"
	| "mixed_script";

export interface QueryExpansion {
	sourceTerm: string;
	value: string;
	kind: QueryExpansionKind;
	match: "exact" | "morph" | "prefix";
}

interface QueryExpansionOptions {
	rawText?: string;
	enableScriptVariants?: boolean;
}

const MAX_QUERY_EXPANSIONS = 24;
const MAX_SYNONYMS_PER_TERM = 8;
const MAX_SCRIPT_VARIANTS_PER_KIND = 6;
const MIN_SCRIPT_TOKEN_LENGTH = 4;

const BUILT_IN_GROUPS: readonly (readonly string[])[] = [
	["воркер", "worker"],
	["джоб", "джоба", "job"],
	["деплой", "deploy", "deployment"],
	["откат", "роллбек", "rollback"],
	["таймаут", "timeout"],
	["ретрай", "retry"],
	["колбэк", "callback"],
	["консьюмер", "consumer"],
	["дедлок", "deadlock"],
	[
		"пришел",
		"пришла",
		"пришло",
		"пришли",
		"придет",
		"придут",
		"приходить",
		"приходит",
		"приходят",
	],
];

const ENGLISH_TO_RUSSIAN_KEYBOARD: Readonly<Record<string, string>> = {
	q: "й",
	w: "ц",
	e: "у",
	r: "к",
	t: "е",
	y: "н",
	u: "г",
	i: "ш",
	o: "щ",
	p: "з",
	"[": "х",
	"]": "ъ",
	a: "ф",
	s: "ы",
	d: "в",
	f: "а",
	g: "п",
	h: "р",
	j: "о",
	k: "л",
	l: "д",
	";": "ж",
	"'": "э",
	z: "я",
	x: "ч",
	c: "с",
	v: "м",
	b: "и",
	n: "т",
	m: "ь",
	",": "б",
	".": "ю",
	"`": "ё",
};

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ё: "yo",
	ж: "zh",
	з: "z",
	и: "i",
	й: "y",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ф: "f",
	х: "kh",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "shch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
};

const CYRILLIC_CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = {
	а: "a",
	в: "b",
	е: "e",
	к: "k",
	м: "m",
	н: "h",
	о: "o",
	р: "p",
	с: "c",
	т: "t",
	у: "y",
	х: "x",
};

const LATIN_CONFUSABLE_TO_CYRILLIC: Readonly<Record<string, string>> = {
	a: "а",
	b: "в",
	c: "с",
	e: "е",
	h: "н",
	k: "к",
	m: "м",
	o: "о",
	p: "р",
	t: "т",
	x: "х",
	y: "у",
};

const LATIN_TRANSLITERATION_PAIRS: readonly (readonly [string, string])[] = [
	["shch", "щ"],
	["sch", "щ"],
	["yo", "ё"],
	["zh", "ж"],
	["kh", "х"],
	["ts", "ц"],
	["ch", "ч"],
	["sh", "ш"],
	["yu", "ю"],
	["ya", "я"],
	["ye", "е"],
];

const LATIN_TRANSLITERATION_SINGLE: Readonly<Record<string, string>> = {
	a: "а",
	b: "б",
	c: "ц",
	d: "д",
	e: "е",
	f: "ф",
	g: "г",
	h: "х",
	i: "и",
	j: "й",
	k: "к",
	l: "л",
	m: "м",
	n: "н",
	o: "о",
	p: "п",
	q: "к",
	r: "р",
	s: "с",
	t: "т",
	u: "у",
	v: "в",
	w: "в",
	x: "кс",
	y: "ы",
	z: "з",
};

export function expandQueryTerms(
	terms: readonly string[],
	configuredSynonyms: Readonly<Record<string, readonly string[]>> = {},
	options: QueryExpansionOptions = {},
): QueryExpansion[] {
	const normalizedTerms = [...new Set(terms.map(normalizeSearchText))];
	const synonyms = synonymLookup(configuredSynonyms);
	const expansions: QueryExpansion[] = [];

	for (const sourceTerm of normalizedTerms) {
		for (const value of [...(synonyms.get(sourceTerm) ?? [])].slice(
			0,
			MAX_SYNONYMS_PER_TERM,
		)) {
			expansions.push({
				sourceTerm,
				value,
				kind: "synonym",
				match: "exact",
			});
		}
	}

	if (options.enableScriptVariants !== false) {
		for (const sourceTerm of normalizedTerms) {
			const value = normalizeMixedScriptToken(sourceTerm);
			if (value) {
				expansions.push({
					sourceTerm,
					value,
					kind: "mixed_script",
					match: "exact",
				});
			}
		}

		for (const sourceTerm of layoutTokens(
			options.rawText,
			normalizedTerms,
		).slice(0, MAX_SCRIPT_VARIANTS_PER_KIND)) {
			const value = correctEnglishKeyboardLayout(sourceTerm);
			if (value) {
				expansions.push({
					sourceTerm,
					value,
					kind: "keyboard_layout",
					match: "morph",
				});
			}
		}

		for (const sourceTerm of normalizedTerms
			.filter(
				(term) =>
					isBoundedLatinToken(term) && looksLikeLatinTransliteration(term),
			)
			.slice(0, MAX_SCRIPT_VARIANTS_PER_KIND)) {
			const value = transliterateLatinToken(sourceTerm);
			if (value) {
				expansions.push({
					sourceTerm,
					value,
					kind: "transliteration",
					match: "morph",
				});
			}
		}
	}

	const seen = new Set<string>();
	return expansions
		.filter(({ sourceTerm, value, kind, match }) => {
			if (!value || value === sourceTerm) return false;
			const key = `${sourceTerm}\0${value}\0${kind}\0${match}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, MAX_QUERY_EXPANSIONS);
}

export function matchesQueryExpansion(
	text: string,
	expansion: QueryExpansion,
): boolean {
	const normalized = normalizeSearchText(text);
	if (expansion.match === "exact") {
		return containsNormalizedExactText(normalized, expansion.value);
	}
	if (expansion.match === "morph") {
		const morphValue = normalizeMorphText(expansion.value);
		return Boolean(
			morphValue &&
				containsNormalizedExactText(normalizeMorphText(text), morphValue),
		);
	}
	const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
	return tokens.some((token) => token.startsWith(expansion.value));
}

function synonymLookup(
	configured: Readonly<Record<string, readonly string[]>>,
): Map<string, Set<string>> {
	const lookup = new Map<string, Set<string>>();
	for (const group of BUILT_IN_GROUPS) addSynonymGroup(lookup, group);
	for (const [term, aliases] of Object.entries(configured)) {
		addSynonymGroup(lookup, [term, ...aliases]);
	}
	return lookup;
}

function addSynonymGroup(
	lookup: Map<string, Set<string>>,
	values: readonly string[],
): void {
	const normalized = [
		...new Set(values.map(normalizeSearchText).filter(Boolean)),
	];
	for (const value of normalized) {
		const aliases = lookup.get(value) ?? new Set<string>();
		for (const alias of normalized) {
			if (alias !== value) aliases.add(alias);
		}
		lookup.set(value, aliases);
	}
}

function normalizeMixedScriptToken(term: string): string | null {
	const cyrillicCount = [...term].filter((character) =>
		/[а-я]/u.test(character),
	).length;
	const latinCount = [...term].filter((character) =>
		/[a-z]/u.test(character),
	).length;
	if (!cyrillicCount || !latinCount) return null;
	const mapping =
		latinCount >= cyrillicCount
			? CYRILLIC_CONFUSABLE_TO_LATIN
			: LATIN_CONFUSABLE_TO_CYRILLIC;
	const value = [...term]
		.map((character) => mapping[character] ?? character)
		.join("");
	if (!/[а-я]/u.test(value) || !/[a-z]/u.test(value)) return value;
	const latinValue = [...term]
		.map((character) => CYRILLIC_TO_LATIN[character] ?? character)
		.join("");
	return /[а-я]/u.test(latinValue) ? null : latinValue;
}

function layoutTokens(
	rawText: string | undefined,
	normalizedTerms: readonly string[],
): string[] {
	const rawTokens = rawText?.toLowerCase().match(/[a-z;,'[\].`]+/g) ?? [];
	return [
		...new Set(
			(rawTokens.length ? rawTokens : normalizedTerms).filter((token) => {
				const letters = token.match(/[a-z]/g)?.length ?? 0;
				return (
					letters >= MIN_SCRIPT_TOKEN_LENGTH &&
					(!/[aeiou]/u.test(token) || /[;,'[\].`]/u.test(token)) &&
					[...token].every((character) =>
						Object.hasOwn(ENGLISH_TO_RUSSIAN_KEYBOARD, character),
					)
				);
			}),
		),
	];
}

function correctEnglishKeyboardLayout(term: string): string | null {
	const value = [...term]
		.map((character) => ENGLISH_TO_RUSSIAN_KEYBOARD[character] ?? character)
		.join("");
	return value === term ? null : normalizeSearchText(value);
}

function isBoundedLatinToken(term: string): boolean {
	return (
		term.length >= MIN_SCRIPT_TOKEN_LENGTH &&
		term.length <= 32 &&
		/^[a-z]+$/u.test(term)
	);
}

function looksLikeLatinTransliteration(term: string): boolean {
	return /(?:shch|sch|zh|kh|ts|ch|sh|yu|ya|yo|iy|yy|yh|ciya)/u.test(term);
}

function transliterateLatinToken(term: string): string | null {
	let value = "";
	for (let offset = 0; offset < term.length; ) {
		const pair = LATIN_TRANSLITERATION_PAIRS.find(([source]) =>
			term.startsWith(source, offset),
		);
		if (pair) {
			value += pair[1];
			offset += pair[0].length;
			continue;
		}
		const character = term[offset];
		if (!character) break;
		value += LATIN_TRANSLITERATION_SINGLE[character] ?? character;
		offset += 1;
	}
	return value === term ? null : normalizeSearchText(value);
}
