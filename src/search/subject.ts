import type { SearchConcepts } from "../config/config.ts";
import { ConfigError } from "../shared/errors.ts";
import { extractPermalinkId } from "./extract.ts";
import { expandQueryTerms } from "./query-expansion.ts";
import { conceptQueryMatches } from "./search-concepts.ts";
import { morphSearchTerms } from "./search-token-normalization.ts";
import { normalizeSearchText, STOP_WORDS } from "./text.ts";
import type {
	AgentProbeInput,
	AgentProbeKind,
	MattermostSubject,
	RetrievalProbe,
} from "./types.ts";

const POST_ID_PATTERN = /^[a-z0-9]{26}$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/i;
const MAX_TERMS_PER_PROBE = 8;
const MAX_MORPH_TERMS_PER_PROBE = 8;
const MAX_CONCEPT_MATCHES_PER_PROBE = 8;

export function classifySubject(
	positional: string | undefined,
	explicitTicket?: string,
): MattermostSubject {
	if (explicitTicket !== undefined) {
		const ticketKey = explicitTicket.trim().toUpperCase();
		if (!TICKET_PATTERN.test(ticketKey)) {
			throw new ConfigError(
				`Invalid ticket key: ${explicitTicket}.`,
				"invalid_ticket",
			);
		}
		return { kind: "ticket", ticketKey, raw: explicitTicket };
	}
	const raw = positional?.trim() ?? "";
	const permalink = extractPermalinkId(raw);
	if (permalink) {
		return {
			kind: "post",
			postId: permalink,
			raw,
			source: "permalink",
		};
	}
	if (POST_ID_PATTERN.test(raw)) {
		return { kind: "post", postId: raw, raw, source: "id" };
	}
	if (TICKET_PATTERN.test(raw)) {
		return { kind: "ticket", ticketKey: raw.toUpperCase(), raw };
	}
	if (!raw) {
		throw new ConfigError(
			"A subject, query, or --ticket is required.",
			"missing_subject",
		);
	}
	return { kind: "text", text: raw, raw };
}

export function resolveProbes(
	subject: MattermostSubject,
	queries: readonly string[] = [],
	configuredSynonyms:
		| Readonly<Record<string, readonly string[]>>
		| undefined = {},
	agentProbes: readonly AgentProbeInput[] = [],
	configuredConcepts: Readonly<SearchConcepts> | undefined = {},
): RetrievalProbe[] {
	const subjectValues =
		subject.kind === "ticket"
			? [subject.ticketKey]
			: subject.kind === "text"
				? [subject.text]
				: [];
	const values: Array<{ value: string; kind?: AgentProbeKind }> = [
		...subjectValues.map((value) => ({ value })),
		...queries.map((value) => ({ value })),
	];
	for (const probe of agentProbes) {
		const value = probe.value.trim();
		if (!value) continue;
		const genericIndex = values.findIndex(
			(existing) =>
				existing.kind === undefined && existing.value.trim() === value,
		);
		if (genericIndex >= 0) {
			values[genericIndex] = { value, kind: probe.kind };
		} else if (
			!values.some(
				(existing) =>
					existing.kind === probe.kind && existing.value.trim() === value,
			)
		) {
			values.push({ value, kind: probe.kind });
		}
	}
	const normalizedValues = values
		.map(({ value, kind }) => ({ value: value.trim(), kind }))
		.filter(({ value }) => Boolean(value));
	const seenGeneric = new Set<string>();
	return normalizedValues
		.filter(({ value, kind }) => {
			if (kind !== undefined) return true;
			if (seenGeneric.has(value)) return false;
			seenGeneric.add(value);
			return true;
		})
		.map(({ value, kind }) => {
			const phrases = [...value.matchAll(/"([^"]+)"/g)]
				.map((match) => match[1]?.trim())
				.filter((phrase): phrase is string => Boolean(phrase));
			const terms = [
				...new Set(
					(value.match(/[\p{L}\p{N}_-]+/gu) ?? [])
						.map(normalizeSearchText)
						.filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
				),
			].slice(0, MAX_TERMS_PER_PROBE);
			const expansions = expandQueryTerms(terms, configuredSynonyms ?? {}, {
				rawText: value,
				enableScriptVariants:
					(!kind ||
						!["repository", "file_path", "symbol", "error_message"].includes(
							kind,
						)) &&
					!/(?:https?:\/\/|[/\\])/iu.test(value),
			});
			const morphTerms = morphSearchTerms(terms).slice(
				0,
				MAX_MORPH_TERMS_PER_PROBE,
			);
			const conceptMatches = conceptQueryMatches(
				value,
				configuredConcepts ?? {},
			).slice(0, MAX_CONCEPT_MATCHES_PER_PROBE);
			return {
				value,
				phrases,
				terms,
				...(morphTerms.length ? { morphTerms } : {}),
				...(conceptMatches.length ? { conceptMatches } : {}),
				...(kind ? { kind } : {}),
				...(expansions.length ? { expansions } : {}),
			};
		});
}
