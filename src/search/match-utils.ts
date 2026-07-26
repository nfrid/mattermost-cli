import type { LexicalRetrievalSource } from "../store/index.ts";
import type { SearchMatch } from "./types.ts";

/** Default character budget for search-match excerpts. */
export const SEARCH_EXCERPT_LIMIT = 240;
/** Default character budget for agent/related-ticket string excerpts. */
export const POINTER_EXCERPT_LIMIT = 160;
/**
 * Character budget for the decision-layer texts a reader is told to trust
 * first (`brief.decisions` / their refinements / `brief.openQuestions`).
 *
 * Deliberately far above {@link POINTER_EXCERPT_LIMIT}: a pointer excerpt only
 * has to be recognizable, while these texts are read *instead of* the post, and
 * the condition that qualifies a decision ("…если у них нет …") is exactly what
 * a pointer-sized cut removes. Still bounded, and every cut is reported as
 * `truncated` rather than left to a bare `…`.
 *
 * `signals.candidateSpans` deliberately stays on {@link POINTER_EXCERPT_LIMIT}:
 * a span is a pointer into `posts[]`, not a substitute for reading it.
 */
export const DECISION_EXCERPT_LIMIT = 480;

export function truncateExcerpt(
	message: string,
	limit = SEARCH_EXCERPT_LIMIT,
): string {
	const redacted = redactCredentialExcerpts(message);
	const characters = [...redacted];
	return characters.length <= limit
		? redacted
		: `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
 * {@link truncateExcerpt} that also reports whether anything was cut, so a
 * consumer never has to infer data loss from a trailing ellipsis the author may
 * have typed themselves.
 */
export function excerptWithTruncation(
	message: string,
	limit = SEARCH_EXCERPT_LIMIT,
): { text: string; truncated: boolean } {
	const text = truncateExcerpt(message, limit);
	const redactedOnly = redactCredentialExcerpts(message);
	return { text, truncated: text !== redactedOnly };
}

export function excerpt(message: string): string {
	return truncateExcerpt(message, SEARCH_EXCERPT_LIMIT);
}

/**
 * Best-effort redaction of login/password/token phrases in match and dropped
 * excerpts. False negatives are acceptable; never invent content.
 */
export function redactCredentialExcerpts(value: string): string {
	return value
		.replace(/(password|passwd|пароль|pass)\s*[:=]\s*\S+/giu, "$1: [REDACTED]")
		.replace(
			/(login|логин|username|user|email)\s*[:=]\s*\S+/giu,
			"$1: [REDACTED]",
		)
		.replace(
			/(token|api[_-]?key|secret|bearer)\s*[:=]\s*\S+/giu,
			"$1: [REDACTED]",
		)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._\-+=/]{8,}/gu, "$1 [REDACTED]");
}

export function deduplicateMatches(
	matches: readonly SearchMatch[],
): SearchMatch[] {
	const grouped = new Map<string, SearchMatch[]>();
	for (const match of matches) {
		const key = `${match.postId}\0${match.probeKind ?? ""}\0${match.probe}`;
		const values = grouped.get(key) ?? [];
		values.push(match);
		grouped.set(key, values);
	}
	return [...grouped.values()]
		.map((values) => {
			const ordered = [...values].sort(compareMatchEvidence);
			const best = ordered[0];
			if (!best) throw new Error("Search match group cannot be empty.");
			const lexicalEvidence = ordered.flatMap((match) =>
				match.lexicalSource &&
				match.sourceQuery !== undefined &&
				match.sourceRank !== undefined &&
				match.bm25 !== undefined
					? [
							{
								source: match.lexicalSource,
								sourceQuery: match.sourceQuery,
								rank: match.sourceRank,
								bm25: match.bm25,
							},
						]
					: [],
			);
			return lexicalEvidence.length ? { ...best, lexicalEvidence } : best;
		})
		.sort(
			(left, right) =>
				left.postId.localeCompare(right.postId) ||
				left.probe.localeCompare(right.probe) ||
				(left.probeKind ?? "").localeCompare(right.probeKind ?? ""),
		);
}

export function compareMatchEvidence(
	left: SearchMatch,
	right: SearchMatch,
): number {
	const priority: Record<LexicalRetrievalSource, number> = {
		exact_phrase: 7,
		strict_fts: 6,
		term_fts: 5,
		broad_fts: 4,
		morph_fts: 3,
		concept_fts: 2,
		prefix_fts: 1,
		trigram: 0,
	};
	return (
		(priority[right.lexicalSource ?? "trigram"] ?? 0) -
			(priority[left.lexicalSource ?? "trigram"] ?? 0) ||
		(left.sourceRank ?? Number.MAX_SAFE_INTEGER) -
			(right.sourceRank ?? Number.MAX_SAFE_INTEGER) ||
		(left.sourceQuery ?? "").localeCompare(right.sourceQuery ?? "")
	);
}
