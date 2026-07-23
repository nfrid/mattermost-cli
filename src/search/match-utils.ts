import type { LexicalRetrievalSource } from "../store/index.ts";
import type { SearchMatch } from "./types.ts";

/** Default character budget for search-match excerpts. */
export const SEARCH_EXCERPT_LIMIT = 240;
/** Default character budget for agent/related-ticket string excerpts. */
export const POINTER_EXCERPT_LIMIT = 160;

export function truncateExcerpt(
	message: string,
	limit = SEARCH_EXCERPT_LIMIT,
): string {
	const characters = [...message];
	return characters.length <= limit
		? message
		: `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function excerpt(message: string): string {
	return truncateExcerpt(message, SEARCH_EXCERPT_LIMIT);
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
