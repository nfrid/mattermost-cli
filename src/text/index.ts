/**
 * Text kernel: normalization, excerpting, and entity extraction over raw
 * message text.
 *
 * Deliberately the lowest layer in the repo — it depends on nothing else under
 * `src/`. These primitives are needed by `config/`, `store/`, `search/`,
 * `evidence/`, `context/`, and `output/` alike; when they lived under
 * `search/` those directories all had to import *upward* into retrieval, which
 * is what made `config ↔ search`, `store ↔ search`, and `evidence ↔ search`
 * mutually dependent.
 */
export {
	type ConceptAliases,
	type ConceptQueryMatch,
	conceptIndexFingerprint,
	conceptQueryMatches,
	conceptToken,
	conceptTokensForText,
} from "./concepts.ts";
export {
	DECISION_EXCERPT_LIMIT,
	excerpt,
	excerptWithTruncation,
	POINTER_EXCERPT_LIMIT,
	redactCredentialExcerpts,
	SEARCH_EXCERPT_LIMIT,
	truncateExcerpt,
} from "./excerpt.ts";
export {
	type EngineeringEntity,
	type EngineeringEntityKind,
	extractEngineeringEntities,
	extractPermalinkId,
	extractTicketKeys,
	isPermalinkUrl,
	isTrackerIssueHost,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
	PERMALINK_PATH_PATTERN,
	TICKET_PATTERN,
	textForTicketKeyExtraction,
} from "./extract.ts";
export {
	analyzeSearchToken,
	morphSearchTerms,
	normalizeMorphText,
} from "./morphology.ts";
export {
	containsNormalizedExactText,
	containsNormalizedText,
	normalizeSearchText,
	STOP_WORDS,
} from "./normalize.ts";
