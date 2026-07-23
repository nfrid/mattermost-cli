// Russian Snowball stemmer, implemented from the algorithm published at:
// https://snowballstem.org/algorithms/russian/stemmer.html
// Snowball is distributed under the 3-clause BSD license; see LICENSE.

const VOWELS = new Set(["а", "е", "и", "о", "у", "ы", "э", "ю", "я"]);

const PERFECTIVE_GERUND_GROUP_1 = ["вшись", "вши", "в"] as const;
const PERFECTIVE_GERUND_GROUP_2 = [
	"ившись",
	"ывшись",
	"ивши",
	"ывши",
	"ив",
	"ыв",
] as const;
const REFLEXIVE = ["ся", "сь"] as const;
const ADJECTIVE = [
	"ими",
	"ыми",
	"его",
	"ого",
	"ему",
	"ому",
	"ее",
	"ие",
	"ые",
	"ое",
	"ей",
	"ий",
	"ый",
	"ой",
	"ем",
	"им",
	"ым",
	"ом",
	"их",
	"ых",
	"ую",
	"юю",
	"ая",
	"яя",
	"ою",
	"ею",
] as const;
const PARTICIPLE_GROUP_1 = ["ющ", "ем", "нн", "вш", "щ"] as const;
const PARTICIPLE_GROUP_2 = ["ующ", "ивш", "ывш"] as const;
const VERB_GROUP_1 = [
	"ете",
	"йте",
	"ешь",
	"нно",
	"ла",
	"на",
	"ли",
	"ем",
	"ло",
	"но",
	"ет",
	"ют",
	"ны",
	"ть",
	"й",
	"л",
	"н",
] as const;
const VERB_GROUP_2 = [
	"ила",
	"ыла",
	"ена",
	"ейте",
	"уйте",
	"ите",
	"или",
	"ыли",
	"ило",
	"ыло",
	"ено",
	"ены",
	"ить",
	"ыть",
	"ишь",
	"уют",
	"ей",
	"уй",
	"ил",
	"ыл",
	"им",
	"ым",
	"ен",
	"ят",
	"ует",
	"ит",
	"ыт",
	"ую",
	"ю",
] as const;
const NOUN = [
	"иями",
	"ями",
	"ами",
	"ией",
	"иям",
	"ием",
	"иях",
	"ью",
	"ья",
	"ие",
	"ье",
	"еи",
	"ии",
	"ей",
	"ой",
	"ий",
	"ям",
	"ем",
	"ам",
	"ом",
	"ах",
	"ях",
	"ию",
	"ия",
	"ев",
	"ов",
	"а",
	"е",
	"и",
	"й",
	"о",
	"у",
	"ы",
	"ь",
	"ю",
	"я",
] as const;

export function stemRussianSnowball(value: string): string {
	let word = value.toLowerCase().replaceAll("ё", "е");
	const { rv, r2 } = markRegions(word);
	const perfective =
		removeConditionedSuffix(word, PERFECTIVE_GERUND_GROUP_1, rv) ??
		removeSuffix(word, PERFECTIVE_GERUND_GROUP_2, rv);
	if (perfective !== null) {
		word = perfective;
	} else {
		word = removeSuffix(word, REFLEXIVE, rv) ?? word;
		const adjective = removeSuffix(word, ADJECTIVE, rv);
		if (adjective !== null) {
			word =
				removeConditionedSuffix(adjective, PARTICIPLE_GROUP_1, rv) ??
				removeSuffix(adjective, PARTICIPLE_GROUP_2, rv) ??
				adjective;
		} else {
			word =
				removeConditionedSuffix(word, VERB_GROUP_1, rv) ??
				removeSuffix(word, VERB_GROUP_2, rv) ??
				removeSuffix(word, NOUN, rv) ??
				word;
		}
	}
	word = removeSuffix(word, ["и"], rv) ?? word;
	word = removeSuffix(word, ["ость", "ост"], r2) ?? word;
	if (word.endsWith("нн")) {
		word = word.slice(0, -1);
	} else {
		const withoutSuperlative = removeSuffix(word, ["ейше", "ейш"], rv);
		if (withoutSuperlative !== null) {
			word = withoutSuperlative.endsWith("нн")
				? withoutSuperlative.slice(0, -1)
				: withoutSuperlative;
		} else {
			word = removeSuffix(word, ["ь"], rv) ?? word;
		}
	}
	return word;
}

function markRegions(word: string): { rv: number; r2: number } {
	let rv = word.length;
	for (let index = 0; index < word.length; index += 1) {
		if (VOWELS.has(word[index] ?? "")) {
			rv = index + 1;
			break;
		}
	}
	return { rv, r2: nextRegion(word, nextRegion(word, 0)) };
}

function nextRegion(word: string, start: number): number {
	for (let index = start; index < word.length - 1; index += 1) {
		if (VOWELS.has(word[index] ?? "") && !VOWELS.has(word[index + 1] ?? "")) {
			return index + 2;
		}
	}
	return word.length;
}

function removeConditionedSuffix(
	word: string,
	suffixes: readonly string[],
	regionStart: number,
): string | null {
	const suffix = longestSuffix(word, suffixes, regionStart);
	if (!suffix) return null;
	const suffixStart = word.length - suffix.length;
	if (
		suffixStart - 1 < regionStart ||
		!/[ая]/u.test(word[suffixStart - 1] ?? "")
	) {
		return null;
	}
	return word.slice(0, suffixStart);
}

function removeSuffix(
	word: string,
	suffixes: readonly string[],
	regionStart: number,
): string | null {
	const suffix = longestSuffix(word, suffixes, regionStart);
	return suffix ? word.slice(0, -suffix.length) : null;
}

function longestSuffix(
	word: string,
	suffixes: readonly string[],
	regionStart: number,
): string | null {
	let match: string | null = null;
	for (const suffix of suffixes) {
		if (
			word.endsWith(suffix) &&
			word.length - suffix.length >= regionStart &&
			(match === null || suffix.length > match.length)
		) {
			match = suffix;
		}
	}
	return match;
}
