import type { TicketProximityMetrics } from "../ticket-segments.ts";

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

/**
 * A post whose entire content is an attachment: no text at all, plus at least
 * one live file. Text-only readers see such a post as empty, so its evidence is
 * unreachable without downloading the file — and can contradict the surrounding
 * text.
 */
export function isMediaOnlyPost(
	post: Pick<EvidencePost, "message" | "deleteAt" | "attachments">,
): boolean {
	if (post.deleteAt || post.message.trim().length > 0) return false;
	return post.attachments.some((attachment) => !attachment.deleteAt);
}

export type PackSkipReason = "outside_ticket_window" | "omitted_gap" | "budget";

/** Gap between returned posts in chronological thread order. */
export interface PackSkip {
	posts: number;
	after?: string;
	before?: string;
	reason?: PackSkipReason;
	/** Live attachments carried by the omitted posts; absent when none. */
	files?: number;
	/** Distinct authors of omitted posts, capped. */
	authors?: string[];
	/** ISO timestamp of the earliest omitted post. */
	fromAt?: string;
	/** ISO timestamp of the latest omitted post. */
	toAt?: string;
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
	/**
	 * Inclusive neighbor distance around each match. Default 2. Also the
	 * default for {@link beforePosts}/{@link afterPosts} when around is set.
	 */
	neighborhoodRadius?: number;
	/**
	 * Posts immediately before {@link aroundPostId} (clamped 0–
	 * `MAX_AROUND_SIDE_POSTS` in `./budget.ts`). Defaults to {@link neighborhoodRadius}.
	 */
	beforePosts?: number;
	/**
	 * Posts immediately after {@link aroundPostId} (clamped 0–
	 * `MAX_AROUND_SIDE_POSTS` in `./budget.ts`). Defaults to {@link neighborhoodRadius}.
	 */
	afterPosts?: number;
	/** Select only the explicit around range; disables all normal packing anchors. */
	windowOnly?: boolean;
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
	/**
	 * Prefer a contiguous subject-ticket core (first→last ticket hit) over
	 * priority + gap-fill. Drops cheaper off-core posts before punching a hole
	 * in the middle of the core. Used for primary ticket threads after reclaim.
	 */
	contiguousTicketCore?: boolean;
	/**
	 * Aggressive lean packing for brief historical/related secondaries: keep
	 * subject-ticket mentions, match hits, root, and a short latest tail — no
	 * radius neighborhoods, gap-fill, or structural densest windows.
	 */
	historicalNeighborBrief?: boolean;
	/** Packing projection mode. Short keeps root + ticket/file/latest anchors. */
	mode?: "default" | "short";
	limit: number;
	full?: boolean;
	/** Precomputed ticket proximity metrics to avoid re-segmentation. */
	ticketMetrics?: TicketProximityMetrics;
}
