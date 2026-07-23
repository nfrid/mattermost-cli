import { normalizeSearchText } from "../search/text.ts";
import type { ThreadSearchFilters } from "./types.ts";

/** Normalized thread-filter predicate shared by SQL and in-memory backends. */
export interface ThreadFilterPredicate {
	username?: string;
	after?: number;
	before?: number;
	requireFile: boolean;
	filePattern?: string;
}

export function describeThreadFilters(
	filters: ThreadSearchFilters = {},
): ThreadFilterPredicate {
	return {
		...(filters.username
			? { username: filters.username.replace(/^@/, "") }
			: {}),
		...(filters.after !== undefined ? { after: filters.after } : {}),
		...(filters.before !== undefined ? { before: filters.before } : {}),
		requireFile: Boolean(filters.hasFile || filters.filePattern),
		...(filters.filePattern ? { filePattern: filters.filePattern } : {}),
	};
}

export function threadFilterIsEmpty(predicate: ThreadFilterPredicate): boolean {
	return (
		!predicate.username &&
		predicate.after === undefined &&
		predicate.before === undefined &&
		!predicate.requireFile
	);
}

export function postMatchesThreadFilter(
	post: {
		deleteAt: number;
		createAt: number;
		authorUsername: string;
		attachments: readonly { name: string; deleteAt: number }[];
	},
	predicate: ThreadFilterPredicate,
): boolean {
	if (post.deleteAt) return false;
	if (
		predicate.username &&
		post.authorUsername.toLowerCase() !== predicate.username.toLowerCase()
	) {
		return false;
	}
	if (predicate.after !== undefined && post.createAt < predicate.after) {
		return false;
	}
	if (predicate.before !== undefined && post.createAt >= predicate.before) {
		return false;
	}
	return true;
}

export function threadPostsMatchFilters(
	posts: readonly {
		deleteAt: number;
		createAt: number;
		authorUsername: string;
		attachments: readonly { name: string; deleteAt: number }[];
	}[],
	filters: ThreadSearchFilters,
): boolean {
	const predicate = describeThreadFilters(filters);
	const postMatches = posts.some((post) =>
		postMatchesThreadFilter(post, predicate),
	);
	if (!postMatches) return false;
	if (!predicate.requireFile) return true;
	const pattern = predicate.filePattern
		? normalizeSearchText(predicate.filePattern)
		: undefined;
	return posts.some((post) =>
		post.attachments.some(
			(attachment) =>
				!attachment.deleteAt &&
				(!pattern || normalizeSearchText(attachment.name).includes(pattern)),
		),
	);
}
