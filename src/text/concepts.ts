import { createHash } from "node:crypto";
import { normalizeMorphText } from "./morphology.ts";
import {
	containsNormalizedExactText,
	normalizeSearchText,
} from "./normalize.ts";

/**
 * Concept id → configured alias phrases.
 *
 * Structural on purpose. `config`'s `SearchConcepts` (a Zod output type) is
 * assignable to this, so the tokenizer stays in the text layer instead of
 * importing configuration upward.
 */
export type ConceptAliases = Readonly<Record<string, readonly string[]>>;

export interface ConceptQueryMatch {
	conceptId: string;
	sourcePhrase: string;
}

interface NormalizedConceptAlias {
	exact: string;
	morph: string;
}

interface NormalizedConcept {
	id: string;
	aliases: NormalizedConceptAlias[];
	token: string;
}

export function conceptQueryMatches(
	text: string,
	concepts: ConceptAliases = {},
): ConceptQueryMatch[] {
	const normalizedText = normalizeSearchText(text);
	const morphText = normalizeMorphText(text);
	const matches: ConceptQueryMatch[] = [];
	for (const concept of normalizeConcepts(concepts)) {
		const sourcePhrase = concept.aliases
			.filter((alias) => matchesAlias(normalizedText, morphText, alias))
			.map(({ exact }) => exact)
			.sort(
				(left, right) =>
					right.length - left.length || left.localeCompare(right),
			)[0];
		if (sourcePhrase) {
			matches.push({
				conceptId: concept.id,
				sourcePhrase,
			});
		}
	}
	return matches;
}

export function conceptTokensForText(
	text: string,
	concepts: ConceptAliases = {},
): string[] {
	const normalizedText = normalizeSearchText(text);
	const morphText = normalizeMorphText(text);
	return normalizeConcepts(concepts)
		.filter(({ aliases }) =>
			aliases.some((alias) => matchesAlias(normalizedText, morphText, alias)),
		)
		.map(({ token }) => token);
}

export function conceptToken(conceptId: string): string {
	return `zzconcept${Buffer.from(conceptId, "utf8").toString("hex")}`;
}

export function conceptIndexFingerprint(concepts: ConceptAliases = {}): string {
	const normalized = normalizeConcepts(concepts).map(({ id, aliases }) => ({
		id,
		aliases: aliases.map(({ exact }) => exact),
	}));
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizeConcepts(concepts: ConceptAliases): NormalizedConcept[] {
	return Object.entries(concepts)
		.map(([id, aliases]) => ({
			id,
			aliases: [...new Set(aliases.map(normalizeSearchText).filter(Boolean))]
				.sort()
				.map((exact) => ({
					exact,
					morph:
						exact.split(/\s+/u).length > 1 ? normalizeMorphText(exact) : "",
				})),
			token: conceptToken(id),
		}))
		.filter(({ aliases }) => aliases.length > 0)
		.sort((left, right) => left.id.localeCompare(right.id));
}

function matchesAlias(
	normalizedText: string,
	morphText: string,
	alias: NormalizedConceptAlias,
): boolean {
	return (
		containsNormalizedExactText(normalizedText, alias.exact) ||
		Boolean(alias.morph && containsNormalizedExactText(morphText, alias.morph))
	);
}
