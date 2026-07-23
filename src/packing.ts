import { extractTicketKeys } from "./entities.ts";
import {
	segmentThreadByTicketProximity,
	ticketWindowPostIds,
} from "./ticket-segments.ts";

export interface EvidenceAttachment {
	id: string;
	postId: string;
	name: string;
	extension: string;
	size: number;
	mimeType: string;
	deleteAt: number;
}

export interface EvidencePost {
	id: string;
	rootId: string;
	userId: string;
	authorUsername: string;
	authorDisplayName: string;
	createAt: number;
	updateAt: number;
	deleteAt: number;
	message: string;
	attachments: EvidenceAttachment[];
}

export interface PackedPost extends EvidencePost {
	renderedUnits: number;
}

export type PackSkipReason = "outside_ticket_window" | "omitted_gap" | "budget";

/** Gap between returned posts in chronological thread order. */
export interface PackSkip {
	posts: number;
	after?: string;
	before?: string;
	reason?: PackSkipReason;
}

export type PackTimelineItem =
	| { kind: "post"; post: PackedPost }
	| { kind: "skip"; skip: PackSkip };

export interface PackedThread {
	threadId: string;
	selectionStrategy: string[];
	totalPosts: number;
	returnedPosts: number;
	omittedPosts: number;
	returnedAttachments: number;
	totalOmittedAttachments: number;
	omittedAttachments: EvidenceAttachment[];
	unreportedOmittedAttachments: number;
	budget: {
		measurement: "unicode_code_points_in_rendered_post";
		limit: number;
		used: number;
	};
	posts: PackedPost[];
	/** Chronological posts with explicit skip markers for omitted spans. */
	timeline: PackTimelineItem[];
}

export interface PackThreadOptions {
	matchingPostIds?: readonly string[];
	aroundPostId?: string;
	/** Inclusive neighbor distance around each match / aroundPostId. Default 2. */
	neighborhoodRadius?: number;
	/**
	 * Inclusive neighbor distance around subject-ticket mentions. Defaults to a
	 * larger radius than {@link neighborhoodRadius} (8).
	 */
	ticketNeighborhoodRadius?: number;
	/** Subject tracker key used for ticket-window packing bias. */
	subjectTicketKey?: string;
	/**
	 * Fill chronological gaps of at most this many posts between selected
	 * clusters so micro-windows merge. Default 2.
	 */
	clusterMergeGap?: number;
	/**
	 * After priority selection, spend leftover budget on the largest internal
	 * skip between selected clusters. Default true for default mode; false for
	 * short mode. When a subject ticket is set, gap-fill prefers ticket windows
	 * and does not spend budget on off-topic gaps first.
	 */
	gapFill?: boolean;
	/**
	 * Prefer attachment / code-fence / long / multi-ticket posts and the densest
	 * activity window before the short latest-post priority. Default true;
	 * short mode keeps files / multi-ticket / fences only.
	 */
	structuralAnchors?: boolean;
	/** Packing projection mode. Short keeps root + ticket/file/latest anchors. */
	mode?: "default" | "short";
	limit: number;
	full?: boolean;
}

const DEFAULT_NEIGHBORHOOD_RADIUS = 2;
const DEFAULT_TICKET_NEIGHBORHOOD_RADIUS = 8;
const DEFAULT_CLUSTER_MERGE_GAP = 2;
/** High-priority tail posts before gap-fill; remainder may fill later. */
const LATEST_PRIORITY_COUNT = 3;
const SHORT_LATEST_PRIORITY_COUNT = 2;
const STRUCTURAL_LONG_MESSAGE_UNITS = 400;
const DENSE_WINDOW_MS = 60 * 60 * 1000;
const DENSE_WINDOW_MIN_POSTS = 3;

export function packThread(
	threadId: string,
	posts: readonly EvidencePost[],
	options: PackThreadOptions,
): PackedThread {
	const chronological = [...posts].sort(
		(left, right) =>
			left.createAt - right.createAt || left.id.localeCompare(right.id),
	);
	const byId = new Map(chronological.map((post) => [post.id, post]));
	const order: string[] = [];
	const strategies: string[] = [];
	const add = (ids: readonly string[], strategy: string) => {
		let added = false;
		for (const id of ids) {
			if (byId.has(id) && !order.includes(id)) {
				order.push(id);
				added = true;
			}
		}
		if (added) strategies.push(strategy);
	};
	const shortMode = options.mode === "short";
	const subjectTicket = options.subjectTicketKey?.toUpperCase();
	const matchRadius = Math.max(
		1,
		options.neighborhoodRadius ?? DEFAULT_NEIGHBORHOOD_RADIUS,
	);
	const ticketRadius =
		options.ticketNeighborhoodRadius !== undefined
			? Math.max(0, options.ticketNeighborhoodRadius)
			: Math.max(matchRadius, DEFAULT_TICKET_NEIGHBORHOOD_RADIUS);
	const mergeGap = Math.max(
		0,
		options.clusterMergeGap ?? DEFAULT_CLUSTER_MERGE_GAP,
	);
	const ticketMetrics = subjectTicket
		? segmentThreadByTicketProximity(chronological, {
				subjectTicket,
				matchingPostIds: options.matchingPostIds,
				ticketRadius,
				matchRadius,
				clusterMergeGap: mergeGap,
			})
		: undefined;
	const inTicketWindow = subjectTicket
		? ticketWindowPostIds(chronological, {
				subjectTicket,
				matchingPostIds: options.matchingPostIds,
				ticketRadius,
				matchRadius,
				clusterMergeGap: mergeGap,
			})
		: undefined;

	if (options.full) {
		add(
			chronological.map(({ id }) => id),
			"full_thread",
		);
	} else {
		add(
			chronological.slice(0, 1).map(({ id }) => id),
			"root",
		);

		if (subjectTicket && ticketMetrics?.ticketHitPostIds.length) {
			add(ticketMetrics.ticketHitPostIds, "ticket_mentions");
			for (let distance = 1; distance <= ticketRadius; distance += 1) {
				const ring: string[] = [];
				for (const target of ticketMetrics.ticketHitPostIds) {
					const index = chronological.findIndex(({ id }) => id === target);
					if (index < 0) continue;
					const before = chronological[index - distance]?.id;
					const after = chronological[index + distance]?.id;
					if (before) ring.push(before);
					if (after) ring.push(after);
				}
				add(
					ring,
					distance === 1
						? "ticket_neighborhoods"
						: "ticket_neighborhoods_extended",
				);
			}
		}

		add(options.matchingPostIds ?? [], "matching_posts");
		const neighborhoodTargets = [
			...(options.matchingPostIds ?? []),
			...(options.aroundPostId ? [options.aroundPostId] : []),
		];
		for (let distance = 1; distance <= matchRadius; distance += 1) {
			const ring: string[] = [];
			for (const target of neighborhoodTargets) {
				const index = chronological.findIndex(({ id }) => id === target);
				if (index < 0) continue;
				const before = chronological[index - distance]?.id;
				const after = chronological[index + distance]?.id;
				if (before) ring.push(before);
				if (after) ring.push(after);
			}
			add(
				ring,
				distance === 1 ? "match_neighborhoods" : "match_neighborhoods_extended",
			);
		}

		if (mergeGap > 0) {
			const mergeIds = clusterMergeIds(chronological, order, mergeGap);
			add(mergeIds, "cluster_merge");
		}

		const allowStructural = options.structuralAnchors !== false;
		if (allowStructural) {
			if (shortMode) {
				add(
					structuralAnchorIds(chronological, { short: true }),
					"structural_anchors",
				);
			} else {
				const structural = structuralAnchorIds(chronological);
				add(
					inTicketWindow
						? structural.filter(
								(id) =>
									inTicketWindow.has(id) || isFileOrFencePost(byId.get(id)),
							)
						: structural,
					"structural_anchors",
				);
				const densest = densestWindowIds(chronological);
				add(
					inTicketWindow
						? densest.filter((id) => inTicketWindow.has(id))
						: densest,
					"densest_window",
				);
			}
		}

		const latestCount = shortMode
			? SHORT_LATEST_PRIORITY_COUNT
			: LATEST_PRIORITY_COUNT;
		// Keep only a short high-priority tail so gap-fill can reclaim the middle.
		add(
			chronological
				.slice(-latestCount)
				.reverse()
				.map(({ id }) => id),
			"latest_posts",
		);
	}

	const limit = options.full
		? chronological.reduce((sum, post) => sum + renderedPostUnits(post), 0)
		: Math.max(0, options.limit);
	let used = 0;
	const selected = new Set<string>();
	const preferTicketWindows = Boolean(inTicketWindow) && !options.full;
	const rootId = chronological[0]?.id;
	const latestIds = new Set(
		chronological.slice(-LATEST_PRIORITY_COUNT).map(({ id }) => id),
	);
	const prioritizedOrder =
		preferTicketWindows && inTicketWindow
			? [
					...order.filter((id) => inTicketWindow.has(id)),
					// Keep only intentional off-window anchors (root / files / fences /
					// latest), never densest-window chatter from an off-topic gap.
					...order.filter(
						(id) =>
							!inTicketWindow.has(id) &&
							(id === rootId ||
								isFileOrFencePost(byId.get(id)) ||
								latestIds.has(id)),
					),
				]
			: order;
	for (const id of prioritizedOrder) {
		const post = byId.get(id);
		if (!post) continue;
		const units = renderedPostUnits(post);
		if (used + units > limit) continue;
		selected.add(id);
		used += units;
	}

	const gapFillEnabled =
		options.gapFill !== false && !options.full && !shortMode;
	if (gapFillEnabled) {
		const filled = fillLargestInternalGaps(
			chronological,
			byId,
			selected,
			used,
			limit,
			inTicketWindow,
		);
		used = filled.used;
		if (filled.added) strategies.push("gap_fill");
	}

	if (!options.full && !shortMode) {
		let extended = false;
		for (const post of chronological.slice().reverse()) {
			if (selected.has(post.id)) continue;
			if (inTicketWindow && !inTicketWindow.has(post.id)) continue;
			const units = renderedPostUnits(post);
			if (used + units > limit) continue;
			selected.add(post.id);
			used += units;
			extended = true;
		}
		if (extended) strategies.push("latest_posts_extended");
	}

	const returned = chronological
		.filter(({ id }) => selected.has(id))
		.map((post) => ({ ...post, renderedUnits: renderedPostUnits(post) }));
	const omitted = chronological.filter(({ id }) => !selected.has(id));
	const allOmittedAttachments = omitted.flatMap(
		({ attachments }) => attachments,
	);
	const reportedOmittedAttachments: EvidenceAttachment[] = [];
	for (const attachment of allOmittedAttachments) {
		const units = renderedAttachmentUnits(attachment);
		if (used + units > limit) continue;
		reportedOmittedAttachments.push(attachment);
		used += units;
	}
	return {
		threadId,
		selectionStrategy: strategies,
		totalPosts: chronological.length,
		returnedPosts: returned.length,
		omittedPosts: omitted.length,
		returnedAttachments: returned.reduce(
			(sum, post) => sum + post.attachments.length,
			0,
		),
		totalOmittedAttachments: allOmittedAttachments.length,
		omittedAttachments: reportedOmittedAttachments,
		unreportedOmittedAttachments:
			allOmittedAttachments.length - reportedOmittedAttachments.length,
		budget: {
			measurement: "unicode_code_points_in_rendered_post",
			limit,
			used,
		},
		posts: returned,
		timeline: buildTimeline(chronological, selected, returned, {
			ticketMetrics,
			inTicketWindow,
		}),
	};
}

/** Build chronological timeline with skip markers for omitted spans. */
export function buildTimeline(
	chronological: readonly EvidencePost[],
	selected: ReadonlySet<string>,
	returned: readonly PackedPost[],
	options: {
		ticketMetrics?: ReturnType<typeof segmentThreadByTicketProximity>;
		inTicketWindow?: ReadonlySet<string>;
	} = {},
): PackTimelineItem[] {
	const byId = new Map(returned.map((post) => [post.id, post]));
	const timeline: PackTimelineItem[] = [];
	let skipCount = 0;
	let skipAfter: string | undefined;
	let skipIds: string[] = [];
	let lastEmittedId: string | undefined;

	const flushSkip = (before?: string) => {
		if (skipCount <= 0) return;
		timeline.push({
			kind: "skip",
			skip: {
				posts: skipCount,
				...(skipAfter ? { after: skipAfter } : {}),
				...(before ? { before } : {}),
				...(classifySkipReason(skipIds, options)
					? { reason: classifySkipReason(skipIds, options) }
					: {}),
			},
		});
		skipCount = 0;
		skipAfter = undefined;
		skipIds = [];
	};

	for (const post of chronological) {
		if (selected.has(post.id)) {
			const packed = byId.get(post.id);
			if (!packed) continue;
			flushSkip(post.id);
			timeline.push({ kind: "post", post: packed });
			lastEmittedId = post.id;
			continue;
		}
		if (skipCount === 0) skipAfter = lastEmittedId;
		skipCount += 1;
		skipIds.push(post.id);
	}
	flushSkip();
	return timeline;
}

/** Largest contiguous omitted span in a packed timeline. */
export function largestTimelineSkip(
	timeline: readonly PackTimelineItem[],
): number {
	let largest = 0;
	for (const item of timeline) {
		if (item.kind === "skip") largest = Math.max(largest, item.skip.posts);
	}
	return largest;
}

function clusterMergeIds(
	chronological: readonly EvidencePost[],
	alreadyOrdered: readonly string[],
	mergeGap: number,
): string[] {
	const selected = new Set(alreadyOrdered);
	const indices = chronological
		.map((post, index) => (selected.has(post.id) ? index : -1))
		.filter((index) => index >= 0);
	const fill: string[] = [];
	for (let cursor = 0; cursor < indices.length - 1; cursor += 1) {
		const left = indices[cursor];
		const right = indices[cursor + 1];
		if (left === undefined || right === undefined) continue;
		const gap = right - left - 1;
		if (gap <= 0 || gap > mergeGap) continue;
		for (let index = left + 1; index < right; index += 1) {
			const post = chronological[index];
			if (!post || selected.has(post.id)) continue;
			fill.push(post.id);
			selected.add(post.id);
		}
	}
	return fill;
}

/**
 * Spend leftover budget on the largest skip between already-selected clusters,
 * preferring structural posts, then posts that reconnect cluster edges.
 * When ticket windows are known, fill those gaps before off-topic spans.
 */
function fillLargestInternalGaps(
	chronological: readonly EvidencePost[],
	byId: ReadonlyMap<string, EvidencePost>,
	selected: Set<string>,
	used: number,
	limit: number,
	inTicketWindow?: ReadonlySet<string>,
): { used: number; added: boolean } {
	let currentUsed = used;
	let added = false;
	while (currentUsed < limit) {
		const gapIds = largestInternalGapIds(
			chronological,
			selected,
			inTicketWindow,
		);
		if (!gapIds.length) break;
		const gapPosts = gapIds
			.map((id) => byId.get(id))
			.filter((post): post is EvidencePost => Boolean(post));
		const preferred = [
			...gapPosts.filter((post) => isStructuralPost(post)),
			...edgeInwardOrder(gapIds)
				.map((id) => byId.get(id))
				.filter((post): post is EvidencePost => Boolean(post)),
		];
		const seen = new Set<string>();
		let progressed = false;
		for (const post of preferred) {
			if (selected.has(post.id) || seen.has(post.id)) continue;
			seen.add(post.id);
			const units = renderedPostUnits(post);
			if (currentUsed + units > limit) continue;
			selected.add(post.id);
			currentUsed += units;
			added = true;
			progressed = true;
		}
		if (!progressed) break;
	}
	return { used: currentUsed, added };
}

/** Unselected spans that sit between two selected posts (not leading/trailing). */
function largestInternalGapIds(
	chronological: readonly EvidencePost[],
	selected: ReadonlySet<string>,
	inTicketWindow?: ReadonlySet<string>,
): string[] {
	const gaps: string[][] = [];
	let current: string[] = [];
	let seenSelected = false;
	for (const post of chronological) {
		if (selected.has(post.id)) {
			if (seenSelected && current.length) gaps.push(current);
			current = [];
			seenSelected = true;
			continue;
		}
		if (seenSelected) current.push(post.id);
	}
	if (!gaps.length) return [];
	const ranked = [...gaps].sort((left, right) => {
		if (inTicketWindow) {
			const leftIn = left.filter((id) => inTicketWindow.has(id)).length;
			const rightIn = right.filter((id) => inTicketWindow.has(id)).length;
			if (leftIn !== rightIn) return rightIn - leftIn;
		}
		return right.length - left.length;
	});
	// Prefer a ticket-window gap; never gap-fill a fully off-topic span.
	const preferred = ranked.find((gap) =>
		inTicketWindow ? gap.some((id) => inTicketWindow.has(id)) : true,
	);
	if (!preferred?.length) return [];
	if (!inTicketWindow) return preferred;
	// Only spend budget on posts that actually sit inside the ticket window.
	return preferred.filter((id) => inTicketWindow.has(id));
}

function classifySkipReason(
	skipIds: readonly string[],
	options: {
		ticketMetrics?: ReturnType<typeof segmentThreadByTicketProximity>;
		inTicketWindow?: ReadonlySet<string>;
	},
): PackSkipReason | undefined {
	if (!skipIds.length) return undefined;
	if (!options.inTicketWindow && !options.ticketMetrics) return undefined;
	const omitted = options.ticketMetrics?.segments.find(
		(segment) =>
			segment.reason === "omitted_gap" &&
			skipIds.includes(segment.startPostId) &&
			skipIds.includes(segment.endPostId),
	);
	if (omitted) return "omitted_gap";
	if (
		options.inTicketWindow &&
		skipIds.every((id) => !options.inTicketWindow?.has(id))
	) {
		return "outside_ticket_window";
	}
	return "budget";
}

function edgeInwardOrder(ids: readonly string[]): string[] {
	const ordered: string[] = [];
	let left = 0;
	let right = ids.length - 1;
	while (left <= right) {
		const leftId = ids[left];
		if (leftId) ordered.push(leftId);
		left += 1;
		if (left > right) break;
		const rightId = ids[right];
		if (rightId) ordered.push(rightId);
		right -= 1;
	}
	return ordered;
}

function structuralAnchorIds(
	chronological: readonly EvidencePost[],
	options: { short?: boolean } = {},
): string[] {
	return chronological
		.filter((post) => isStructuralPost(post, options))
		.map(({ id }) => id);
}

function isStructuralPost(
	post: EvidencePost,
	options: { short?: boolean } = {},
): boolean {
	if (post.attachments.some((attachment) => !attachment.deleteAt)) return true;
	if (/```/.test(post.message)) return true;
	if (extractTicketKeys(post.message).length >= 2) return true;
	if (options.short) return false;
	if ([...post.message].length >= STRUCTURAL_LONG_MESSAGE_UNITS) return true;
	return false;
}

function isFileOrFencePost(post: EvidencePost | undefined): boolean {
	if (!post) return false;
	if (post.attachments.some((attachment) => !attachment.deleteAt)) return true;
	if (/```/.test(post.message)) return true;
	return false;
}

function densestWindowIds(chronological: readonly EvidencePost[]): string[] {
	if (chronological.length < DENSE_WINDOW_MIN_POSTS) return [];
	let bestStart = 0;
	let bestEnd = 0;
	let bestCount = 0;
	let right = 0;
	for (let left = 0; left < chronological.length; left += 1) {
		const leftPost = chronological[left];
		if (!leftPost) continue;
		while (right < chronological.length) {
			const rightPost = chronological[right];
			if (!rightPost) break;
			if (rightPost.createAt - leftPost.createAt > DENSE_WINDOW_MS) break;
			right += 1;
		}
		const count = right - left;
		if (count > bestCount) {
			bestCount = count;
			bestStart = left;
			bestEnd = right;
		}
	}
	if (bestCount < DENSE_WINDOW_MIN_POSTS) return [];
	// A window that covers the whole thread is not a useful local anchor.
	if (bestCount >= chronological.length) return [];
	return chronological.slice(bestStart, bestEnd).map(({ id }) => id);
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

function renderedAttachmentText(attachment: EvidenceAttachment): string {
	return `${attachment.name}|${attachment.mimeType}|${attachment.size}|${attachment.id}|${attachment.postId}`;
}
