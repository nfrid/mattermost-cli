const ENGLISH_STOP_WORDS = [
	"a",
	"an",
	"and",
	"are",
	"for",
	"from",
	"in",
	"is",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
];

const RUSSIAN_STOP_WORDS = [
	"без",
	"более",
	"был",
	"была",
	"были",
	"было",
	"быть",
	"вам",
	"вас",
	"весь",
	"все",
	"всего",
	"всех",
	"во",
	"вы",
	"где",
	"даже",
	"для",
	"до",
	"его",
	"ее",
	"если",
	"есть",
	"еще",
	"же",
	"за",
	"здесь",
	"или",
	"им",
	"их",
	"как",
	"ко",
	"когда",
	"кто",
	"ли",
	"либо",
	"мне",
	"может",
	"мы",
	"над",
	"надо",
	"наш",
	"не",
	"него",
	"нее",
	"нет",
	"ни",
	"но",
	"ну",
	"он",
	"от",
	"по",
	"под",
	"почему",
	"при",
	"про",
	"со",
	"так",
	"также",
	"такой",
	"там",
	"тем",
	"того",
	"тоже",
	"только",
	"уже",
	"хотя",
	"чем",
	"что",
	"чтобы",
	"эта",
	"эти",
	"это",
];

export const STOP_WORDS = new Set(
	[...ENGLISH_STOP_WORDS, ...RUSSIAN_STOP_WORDS].map(normalizeSearchText),
);

export function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replaceAll("ё", "е");
}

export function containsNormalizedText(
	message: string,
	value: string,
): boolean {
	return normalizeSearchText(message).includes(normalizeSearchText(value));
}

export function containsNormalizedExactText(
	message: string,
	value: string,
): boolean {
	const normalizedMessage = normalizeSearchText(message);
	const normalizedValue = normalizeSearchText(value).trim();
	if (!normalizedValue) return false;
	let offset = normalizedMessage.indexOf(normalizedValue);
	while (offset >= 0) {
		const before = Array.from(normalizedMessage.slice(0, offset)).at(-1);
		const after = Array.from(
			normalizedMessage.slice(offset + normalizedValue.length),
		)[0];
		const valueCharacters = Array.from(normalizedValue);
		const startsWithToken = isSearchTokenCharacter(valueCharacters[0]);
		const endsWithToken = isSearchTokenCharacter(valueCharacters.at(-1));
		if (
			(!startsWithToken || !isSearchTokenCharacter(before)) &&
			(!endsWithToken || !isSearchTokenCharacter(after))
		) {
			return true;
		}
		offset = normalizedMessage.indexOf(normalizedValue, offset + 1);
	}
	return false;
}

function isSearchTokenCharacter(value: string | undefined): boolean {
	return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}
