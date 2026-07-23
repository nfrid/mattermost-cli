import {
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
} from "../search/extract.ts";

export type TicketSegmentReason =
	| "ticket_window"
	| "match_window"
	| "off_topic_gap"
	| "omitted_gap";

export interface TicketSegment {
	startPostId: string;
	endPostId: string;
	posts: number;
	reason: TicketSegmentReason;
	recommendHydrate?: boolean;
}

export interface TicketProximityMetrics {
	ticketDensity: number;
	nearestTicketDistance: number | null;
	ticketInRoot: boolean;
	/**
	 * Subject ticket appears in the root and nowhere later — treat the whole
	 * reply chain as on-topic (duty/support threads), not as off-topic gaps.
	 */
	rootAnchoredFocused: boolean;
	ticketWindowPostCount: number;
	threadPostCount: number;
	ticketHitPostIds: string[];
	segments: TicketSegment[];
}

export interface SegmentThreadOptions {
	subjectTicket?: string;
	matchingPostIds?: readonly string[];
	/** Inclusive radius around subject-ticket mentions. Default 8. */
	ticketRadius?: number;
	/** Inclusive radius around non-ticket match hits. Default 2. */
	matchRadius?: number;
	/** Merge windows when the gap between them is at most this. Default 2. */
	clusterMergeGap?: number;
	/**
	 * Gaps at least this large between ticket/match windows get
	 * `omitted_gap` + `recommendHydrate`. Default 10.
	 */
	omittedGapHydrateThreshold?: number;
}

export const DEFAULT_TICKET_RADIUS = 8;
export const DEFAULT_MATCH_RADIUS = 2;
export const DEFAULT_CLUSTER_MERGE_GAP = 2;
const DEFAULT_OMITTED_GAP_HYDRATE = 10;

export { MULTI_TICKET_BULLETIN_MIN_KEYS };

/**
 * Slice a chronological thread into subject-ticket / match windows and
 * off-topic gaps using structural rules only (no LLM).
 */
export function segmentThreadByTicketProximity(
	posts: readonly { id: string; message: string }[],
	options: SegmentThreadOptions = {},
): TicketProximityMetrics {
	const chronological = posts;
	const threadPostCount = chronological.length;
	if (!threadPostCount) {
		return {
			ticketDensity: 0,
			nearestTicketDistance: null,
			ticketInRoot: false,
			rootAnchoredFocused: false,
			ticketWindowPostCount: 0,
			threadPostCount: 0,
			ticketHitPostIds: [],
			segments: [],
		};
	}

	const subject = options.subjectTicket?.toUpperCase();
	const ticketRadius = Math.max(
		0,
		options.ticketRadius ?? DEFAULT_TICKET_RADIUS,
	);
	const matchRadius = Math.max(0, options.matchRadius ?? DEFAULT_MATCH_RADIUS);
	const mergeGap = Math.max(
		0,
		options.clusterMergeGap ?? DEFAULT_CLUSTER_MERGE_GAP,
	);
	const hydrateThreshold = Math.max(
		1,
		options.omittedGapHydrateThreshold ?? DEFAULT_OMITTED_GAP_HYDRATE,
	);
	const matchIds = new Set(options.matchingPostIds ?? []);

	const ticketHitIndexes: number[] = [];
	const matchHitIndexes: number[] = [];
	for (let index = 0; index < chronological.length; index += 1) {
		const post = chronological[index];
		if (!post) continue;
		const keys = extractTicketKeys(post.message);
		const hasSubject = Boolean(subject && keys.includes(subject));
		if (hasSubject) ticketHitIndexes.push(index);
		else if (matchIds.has(post.id)) matchHitIndexes.push(index);
	}

	const root = chronological[0];
	const ticketInRoot = Boolean(
		root && subject && extractTicketKeys(root.message).includes(subject),
	);
	// Support/duty pattern: key only in the announce root, then a long reply chain.
	const rootAnchoredFocused =
		ticketInRoot && ticketHitIndexes.every((index) => index === 0);

	const coverage = new Array<"ticket" | "match" | undefined>(
		threadPostCount,
	).fill(undefined);
	if (rootAnchoredFocused) {
		for (let index = 0; index < coverage.length; index += 1) {
			coverage[index] = "ticket";
		}
	} else {
		paintWindows(coverage, ticketHitIndexes, ticketRadius, "ticket");
		paintWindows(coverage, matchHitIndexes, matchRadius, "match");
	}

	const windowRanges = mergeCoveredRanges(coverage, mergeGap);
	const ticketWindowPostCount = coverage.filter(Boolean).length;
	const ticketDensity =
		threadPostCount > 0
			? Math.round((ticketWindowPostCount / threadPostCount) * 100) / 100
			: 0;

	let nearestTicketDistance: number | null = null;
	if (ticketHitIndexes.length) {
		nearestTicketDistance = 0;
		for (const matchIndex of matchHitIndexes) {
			for (const ticketIndex of ticketHitIndexes) {
				const distance = Math.abs(matchIndex - ticketIndex);
				if (
					nearestTicketDistance === null ||
					distance < nearestTicketDistance
				) {
					nearestTicketDistance = distance;
				}
			}
		}
		if (!matchHitIndexes.length) nearestTicketDistance = 0;
	}

	const segments = buildSegments(
		chronological,
		coverage,
		windowRanges,
		hydrateThreshold,
	);

	return {
		ticketDensity,
		nearestTicketDistance,
		ticketInRoot,
		rootAnchoredFocused,
		ticketWindowPostCount,
		threadPostCount,
		ticketHitPostIds: ticketHitIndexes
			.map((index) => chronological[index]?.id)
			.filter((id): id is string => Boolean(id)),
		segments,
	};
}

/** Post ids that fall inside any ticket or match window. */
export function ticketWindowPostIds(
	posts: readonly { id: string; message: string }[],
	options: SegmentThreadOptions = {},
	metrics?: TicketProximityMetrics,
): Set<string> {
	const resolved = metrics ?? segmentThreadByTicketProximity(posts, options);
	const ids = new Set<string>();
	for (const segment of resolved.segments) {
		if (
			segment.reason !== "ticket_window" &&
			segment.reason !== "match_window"
		) {
			continue;
		}
		let inside = false;
		for (const post of posts) {
			if (post.id === segment.startPostId) inside = true;
			if (inside) ids.add(post.id);
			if (post.id === segment.endPostId) inside = false;
		}
	}
	return ids;
}

function paintWindows(
	coverage: Array<"ticket" | "match" | undefined>,
	hitIndexes: readonly number[],
	radius: number,
	kind: "ticket" | "match",
): void {
	for (const hit of hitIndexes) {
		const start = Math.max(0, hit - radius);
		const end = Math.min(coverage.length - 1, hit + radius);
		for (let index = start; index <= end; index += 1) {
			if (coverage[index] === "ticket") continue;
			coverage[index] =
				kind === "ticket" ? "ticket" : (coverage[index] ?? "match");
		}
	}
}

function mergeCoveredRanges(
	coverage: readonly ("ticket" | "match" | undefined)[],
	mergeGap: number,
): Array<{ start: number; end: number; kind: "ticket" | "match" }> {
	const raw: Array<{ start: number; end: number; kind: "ticket" | "match" }> =
		[];
	let start = -1;
	let kind: "ticket" | "match" | undefined;
	for (let index = 0; index < coverage.length; index += 1) {
		const value = coverage[index];
		if (value) {
			if (start < 0) {
				start = index;
				kind = value;
			} else if (value === "ticket") {
				kind = "ticket";
			}
			continue;
		}
		if (start >= 0 && kind) {
			raw.push({ start, end: index - 1, kind });
			start = -1;
			kind = undefined;
		}
	}
	if (start >= 0 && kind) {
		raw.push({ start, end: coverage.length - 1, kind });
	}
	if (!raw.length) return [];
	const first = raw[0];
	if (!first) return [];

	const merged: Array<{
		start: number;
		end: number;
		kind: "ticket" | "match";
	}> = [{ ...first }];
	for (const range of raw.slice(1)) {
		const previous = merged[merged.length - 1];
		if (!previous) {
			merged.push({ ...range });
			continue;
		}
		const gap = range.start - previous.end - 1;
		if (gap <= mergeGap) {
			previous.end = range.end;
			if (range.kind === "ticket" || previous.kind === "ticket") {
				previous.kind = "ticket";
			}
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

function buildSegments(
	posts: readonly { id: string }[],
	coverage: readonly ("ticket" | "match" | undefined)[],
	windows: readonly { start: number; end: number; kind: "ticket" | "match" }[],
	hydrateThreshold: number,
): TicketSegment[] {
	const segments: TicketSegment[] = [];
	let cursor = 0;
	for (const window of windows) {
		if (cursor < window.start) {
			const gapPosts = window.start - cursor;
			const startPost = posts[cursor];
			const endPost = posts[window.start - 1];
			if (startPost && endPost) {
				const betweenWindows = segments.some(
					(segment) =>
						segment.reason === "ticket_window" ||
						segment.reason === "match_window",
				);
				const large = gapPosts >= hydrateThreshold;
				segments.push({
					startPostId: startPost.id,
					endPostId: endPost.id,
					posts: gapPosts,
					reason: betweenWindows && large ? "omitted_gap" : "off_topic_gap",
					...(betweenWindows && large ? { recommendHydrate: true } : {}),
				});
			}
		}
		const startPost = posts[window.start];
		const endPost = posts[window.end];
		if (startPost && endPost) {
			const kind =
				window.kind === "ticket" ||
				coverage
					.slice(window.start, window.end + 1)
					.some((value) => value === "ticket")
					? "ticket_window"
					: "match_window";
			segments.push({
				startPostId: startPost.id,
				endPostId: endPost.id,
				posts: window.end - window.start + 1,
				reason: kind,
			});
		}
		cursor = window.end + 1;
	}
	if (cursor < posts.length) {
		const startPost = posts[cursor];
		const endPost = posts[posts.length - 1];
		if (startPost && endPost) {
			segments.push({
				startPostId: startPost.id,
				endPostId: endPost.id,
				posts: posts.length - cursor,
				reason: "off_topic_gap",
			});
		}
	}
	return segments;
}
