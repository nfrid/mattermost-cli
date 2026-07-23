import { normalizeSearchText } from "../search/text.ts";
import type { LexicalRetrievalSource, ThreadSearchFilters } from "./types.ts";

export function buildThreadFilterSql(
	threadAlias: string,
	filters: ThreadSearchFilters,
): { clause: string; parameters: Array<string | number> } {
	if (
		!filters.username &&
		filters.after === undefined &&
		filters.before === undefined &&
		!filters.hasFile &&
		!filters.filePattern
	) {
		return { clause: "", parameters: [] };
	}
	const parameters: Array<string | number> = [];
	const postClauses = [
		`fp.thread_id = ${threadAlias}.thread_id`,
		"fp.delete_at = 0",
	];
	if (filters.username) {
		postClauses.push("lower(fu.username) = lower(?)");
		parameters.push(filters.username.replace(/^@/, ""));
	}
	if (filters.after !== undefined) {
		postClauses.push("fp.create_at >= ?");
		parameters.push(filters.after);
	}
	if (filters.before !== undefined) {
		postClauses.push("fp.create_at < ?");
		parameters.push(filters.before);
	}
	let clause = ` AND EXISTS (
SELECT 1 FROM posts fp LEFT JOIN users fu ON fu.id = fp.user_id
WHERE ${postClauses.join(" AND ")})`;
	if (filters.hasFile || filters.filePattern) {
		const fileClauses = [
			`ffp.thread_id = ${threadAlias}.thread_id`,
			"ffp.delete_at = 0",
			"ff.delete_at = 0",
		];
		if (filters.filePattern) {
			fileClauses.push("instr(lower(ff.name), lower(?)) > 0");
			parameters.push(filters.filePattern);
		}
		clause += ` AND EXISTS (
SELECT 1 FROM posts ffp
JOIN post_files fpf ON fpf.post_id = ffp.id
JOIN files ff ON ff.id = fpf.file_id
WHERE ${fileClauses.join(" AND ")})`;
	}
	return { clause, parameters };
}

export function matchCenteredSnippet(
	message: string,
	normalizedProbe: string,
): string {
	const normalized = normalizeSearchText(message);
	const index = normalized.indexOf(normalizedProbe);
	if (index < 0 || message.length <= 240) return message;
	const start = Math.max(0, index - 100);
	const end = Math.min(message.length, index + normalizedProbe.length + 100);
	return `${start ? "… " : ""}${message.slice(start, end)}${end < message.length ? " …" : ""}`;
}

export function buildFtsQuery(
	value: string,
	source: LexicalRetrievalSource,
): string | null {
	const terms = normalizeSearchText(value).match(/[\p{L}\p{N}_-]+/gu);
	if (!terms?.length) return null;
	const escaped = terms.map((term) => term.replaceAll('"', '""'));
	switch (source) {
		case "exact_phrase":
			return `"${escaped.join(" ")}"`;
		case "broad_fts":
			return escaped.map((term) => `"${term}"`).join(" OR ");
		case "prefix_fts":
			return escaped.map((term) => `"${term}"*`).join(" AND ");
		case "trigram":
			return terms.join(" ");
		case "strict_fts":
		case "term_fts":
		case "morph_fts":
		case "concept_fts":
			return escaped.map((term) => `"${term}"`).join(" AND ");
	}
}
