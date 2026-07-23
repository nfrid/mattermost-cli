import type { EvidencePost } from "../evidence/packing.ts";
import { ConfigError } from "../shared/errors.ts";
import {
	type ThreadSearchFilters,
	threadPostsMatchFilters,
} from "../store/index.ts";
import type { SearchFilterInput, SearchFilters } from "./types.ts";

export function resolveSearchFilters(input: SearchFilterInput): {
	output: SearchFilters;
	storage: ThreadSearchFilters;
} {
	const from = input.from?.trim().replace(/^@/, "") || undefined;
	const after = parseFilterDate(input.after, "after");
	const before = parseFilterDate(input.before, "before");
	if (after !== undefined && before !== undefined && after >= before) {
		throw new ConfigError(
			"--after must be earlier than --before.",
			"invalid_search_filter",
		);
	}
	const file = input.file?.trim() || undefined;
	const hasFile = Boolean(input.hasFile || file);
	return {
		output: {
			...(from ? { from } : {}),
			...(after !== undefined ? { after: new Date(after).toISOString() } : {}),
			...(before !== undefined
				? { before: new Date(before).toISOString() }
				: {}),
			...(hasFile ? { hasFile: true } : {}),
			...(file ? { file } : {}),
		},
		storage: {
			...(from ? { username: from } : {}),
			...(after !== undefined ? { after } : {}),
			...(before !== undefined ? { before } : {}),
			...(hasFile ? { hasFile: true } : {}),
			...(file ? { filePattern: file } : {}),
		},
	};
}

function parseFilterDate(
	value: string | undefined,
	name: "after" | "before",
): number | undefined {
	if (!value) return undefined;
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
	const offsetDateTime =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
	if (!dateOnly.test(value) && !offsetDateTime.test(value)) {
		throw new ConfigError(
			`Invalid --${name} date: ${value}. Use YYYY-MM-DD or an ISO date-time with Z or an explicit UTC offset.`,
			"invalid_search_filter",
		);
	}
	const normalized = dateOnly.test(value) ? `${value}T00:00:00Z` : value;
	const timestamp = Date.parse(normalized);
	if (!Number.isFinite(timestamp)) {
		throw new ConfigError(
			`Invalid --${name} date: ${value}.`,
			"invalid_search_filter",
		);
	}
	return timestamp;
}

export function evidenceMatchesFilters(
	posts: readonly EvidencePost[],
	filters: ThreadSearchFilters,
): boolean {
	return threadPostsMatchFilters(posts, filters);
}
