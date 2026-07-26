import type { EvidenceAttachment, EvidencePost } from "./types.ts";

/** Hard max posts on each side of `--around`. */
export const MAX_AROUND_SIDE_POSTS = 50;

/**
 * Fallback average rendered size when a truncated thread has no packed posts to
 * measure. Conservative enough that recommended `thread_around` windows stay
 * inside the default 6k character budget (~15 side posts).
 */
export const DEFAULT_ESTIMATED_POST_UNITS = 400;

/**
 * Mean rendered units of packed posts, or {@link DEFAULT_ESTIMATED_POST_UNITS}
 * when the thread returned nothing useful to measure.
 */
export function estimateAveragePostUnits(
	posts: readonly (EvidencePost & { renderedUnits?: number })[] | undefined,
): number {
	if (!posts?.length) return DEFAULT_ESTIMATED_POST_UNITS;
	const total = posts.reduce(
		(sum, post) =>
			sum +
			(typeof post.renderedUnits === "number" && post.renderedUnits > 0
				? post.renderedUnits
				: renderedPostUnits(post)),
		0,
	);
	return Math.max(1, Math.ceil(total / posts.length));
}

/**
 * How many posts (including the `--around` anchor) fit under a character budget
 * at the given average size. Always at least 1 so a single-post retry remains
 * expressible even when the average alone exceeds the budget.
 */
export function maxPostsFittingBudget(
	characterBudget: number,
	averagePostUnits: number,
): number {
	const avg = Math.max(1, averagePostUnits);
	const budget = Math.max(0, characterBudget);
	return Math.max(1, Math.floor(budget / avg));
}

/**
 * Cap one side of a gap window so the window (side posts + anchor) fits the
 * per-thread character budget. Used when recommending `thread_around` argv and
 * when paging an incomplete gap recovery.
 */
export function budgetAwareAroundSidePosts(input: {
	requestedSidePosts: number;
	characterBudget: number;
	averagePostUnits?: number;
}): number {
	const requested = Math.max(
		0,
		Math.min(MAX_AROUND_SIDE_POSTS, Math.floor(input.requestedSidePosts)),
	);
	if (requested === 0) return 0;
	const avg = input.averagePostUnits ?? DEFAULT_ESTIMATED_POST_UNITS;
	// Window size = side + 1 (anchor). Leave room for the anchor.
	const maxTotal = maxPostsFittingBudget(input.characterBudget, avg);
	const maxSide = Math.max(0, maxTotal - 1);
	return Math.min(requested, maxSide, MAX_AROUND_SIDE_POSTS);
}

/**
 * Next narrower side-post count after an incomplete gap window. Halves until 1;
 * returns undefined when already at the minimum (caller may then report
 * `noActionAvailable`).
 */
export function narrowerAroundSidePosts(
	requestedSidePosts: number,
): number | undefined {
	const current = Math.max(0, Math.floor(requestedSidePosts));
	if (current <= 1) return undefined;
	return Math.max(1, Math.floor(current / 2));
}

/** Clamp an around side count; undefined / non-finite falls back to default. */
export function clampAroundSidePosts(
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(MAX_AROUND_SIDE_POSTS, Math.floor(value)));
}

export function renderedPostUnits(post: EvidencePost): number {
	return [
		post.authorUsername,
		post.authorDisplayName,
		new Date(post.createAt).toISOString(),
		post.message,
		...post.attachments.map(renderedAttachmentText),
	].reduce((total, value) => total + [...value].length, 0);
}

export function renderedAttachmentUnits(
	attachment: EvidenceAttachment,
): number {
	return [...renderedAttachmentText(attachment)].length;
}

export function renderedAttachmentText(attachment: EvidenceAttachment): string {
	return `${attachment.name}|${attachment.mimeType}|${attachment.size}|${attachment.id}|${attachment.postId}`;
}
