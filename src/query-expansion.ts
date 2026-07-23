import { containsNormalizedExactText, normalizeSearchText } from "./text.ts";

export type QueryExpansionKind =
	| "russian_variant"
	| "synonym"
	| "transliteration";

export interface QueryExpansion {
	sourceTerm: string;
	value: string;
	kind: QueryExpansionKind;
	match: "exact" | "prefix";
}

const MAX_QUERY_EXPANSIONS = 24;
const MAX_SYNONYMS_PER_TERM = 8;
const MIN_RUSSIAN_STEM_LENGTH = 4;

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

const RUSSIAN_ENDINGS = [
	"иями",
	"ями",
	"ами",
	"ются",
	"утся",
	"ятся",
	"атся",
	"ишь",
	"ешь",
	"ого",
	"его",
	"ому",
	"ему",
	"ыми",
	"ими",
	"ить",
	"ыть",
	"ать",
	"ять",
	"еть",
	"ила",
	"ыла",
	"ала",
	"яла",
	"ела",
	"или",
	"ыли",
	"али",
	"яли",
	"ели",
	"ией",
	"ий",
	"ый",
	"ой",
	"ая",
	"яя",
	"ое",
	"ее",
	"ие",
	"ые",
	"ую",
	"юю",
	"ам",
	"ям",
	"ах",
	"ях",
	"ов",
	"ев",
	"ей",
	"ом",
	"ем",
	"ит",
	"ют",
	"ут",
	"ят",
	"ат",
	"ла",
	"ли",
	"им",
	"у",
	"ю",
	"а",
	"я",
	"ы",
	"и",
	"е",
] as const;

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
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

export function expandQueryTerms(
	terms: readonly string[],
	configuredSynonyms: Readonly<Record<string, readonly string[]>> = {},
): QueryExpansion[] {
	const normalizedTerms = [...new Set(terms.map(normalizeSearchText))];
	const synonyms = synonymLookup(configuredSynonyms);
	const expansions: QueryExpansion[] = [];

	for (const sourceTerm of normalizedTerms) {
		const stem = russianStem(sourceTerm);
		if (stem) {
			expansions.push({
				sourceTerm,
				value: stem,
				kind: "russian_variant",
				match: "prefix",
			});
		}
	}
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
	for (const sourceTerm of normalizedTerms) {
		const value = transliterateMixedToken(sourceTerm);
		if (value) {
			expansions.push({
				sourceTerm,
				value,
				kind: "transliteration",
				match: "exact",
			});
		}
	}

	const seen = new Set<string>();
	return expansions
		.filter(({ sourceTerm, value, match }) => {
			if (!value || value === sourceTerm) return false;
			const key = `${sourceTerm}\0${value}\0${match}`;
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

function russianStem(term: string): string | null {
	if (!/^[а-я]+$/u.test(term) || term.length < MIN_RUSSIAN_STEM_LENGTH + 1) {
		return null;
	}
	for (const ending of RUSSIAN_ENDINGS) {
		if (!term.endsWith(ending)) continue;
		const stem = term.slice(0, -ending.length);
		if (stem.length >= MIN_RUSSIAN_STEM_LENGTH) return stem;
	}
	return null;
}

function transliterateMixedToken(term: string): string | null {
	if (!/[а-я]/u.test(term) || !/[a-z]/u.test(term)) return null;
	return [...term]
		.map((character) => CYRILLIC_TO_LATIN[character] ?? character)
		.join("");
}
