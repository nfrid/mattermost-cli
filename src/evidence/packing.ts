/**
 * Thread packing.
 *
 * `packThread` stays here as the one entry point; its supporting layers live in
 * `./packing/`: `types.ts` (the shapes), `budget.ts` (character arithmetic),
 * `ticket-core.ts` (which posts are the ticket's core), and `timeline.ts` (how
 * kept posts and omissions become the emitted timeline).
 *
 * This module is the stable import site; the split is internal.
 */
import { ConfigError } from "../shared/errors.ts";
import {
	clampAroundSidePosts,
	renderedAttachmentUnits,
	renderedPostUnits,
} from "./packing/budget.ts";
import {
	clusterMergeIds,
	DEFAULT_NEIGHBORHOOD_RADIUS,
	DEFAULT_TICKET_NEIGHBORHOOD_RADIUS,
	densestWindowIds,
	fillLargestInternalGaps,
	isFileOrFencePost,
	LATEST_PRIORITY_COUNT,
	SHORT_LATEST_PRIORITY_COUNT,
	selectContiguousTicketCore,
	structuralAnchorIds,
} from "./packing/ticket-core.ts";
import { buildTimeline } from "./packing/timeline.ts";
import type {
	EvidenceAttachment,
	EvidencePost,
	PackedThread,
	PackThreadOptions,
} from "./packing/types.ts";
import {
	DEFAULT_CLUSTER_MERGE_GAP,
	segmentThreadByTicketProximity,
	ticketWindowPostIds,
} from "./ticket-segments.ts";

/**
 * Public surface of thread packing, unchanged by the internal split.
 */
export {
	budgetAwareAroundSidePosts,
	clampAroundSidePosts,
	DEFAULT_ESTIMATED_POST_UNITS,
	estimateAveragePostUnits,
	MAX_AROUND_SIDE_POSTS,
	maxPostsFittingBudget,
	narrowerAroundSidePosts,
	renderedPostUnits,
} from "./packing/budget.ts";
export {
	hasInternalBudgetSkipInCore,
	ticketCorePostIds,
} from "./packing/ticket-core.ts";
export { largestTimelineSkip } from "./packing/timeline.ts";
export type { PackedThread } from "./packing/types.ts";
export {
	type EvidenceAttachment,
	type EvidencePost,
	isMediaOnlyPost,
	type PackedPost,
	type PackSkip,
	type PackSkipReason,
	type PackThreadOptions,
	type PackTimelineItem,
} from "./packing/types.ts";

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
	const historicalNeighborBrief = Boolean(options.historicalNeighborBrief);
	const subjectTicket = options.subjectTicketKey?.toUpperCase();
	const matchRadius = historicalNeighborBrief
		? 0
		: Math.max(1, options.neighborhoodRadius ?? DEFAULT_NEIGHBORHOOD_RADIUS);
	const ticketRadius = historicalNeighborBrief
		? 0
		: options.ticketNeighborhoodRadius !== undefined
			? Math.max(0, options.ticketNeighborhoodRadius)
			: Math.max(matchRadius, DEFAULT_TICKET_NEIGHBORHOOD_RADIUS);
	const mergeGap = Math.max(
		0,
		options.clusterMergeGap ?? DEFAULT_CLUSTER_MERGE_GAP,
	);
	const ticketMetrics =
		options.ticketMetrics ??
		(subjectTicket
			? segmentThreadByTicketProximity(chronological, {
					subjectTicket,
					matchingPostIds: options.matchingPostIds,
					ticketRadius,
					matchRadius,
					clusterMergeGap: mergeGap,
				})
			: undefined);
	const inTicketWindow = subjectTicket
		? ticketWindowPostIds(
				chronological,
				{
					subjectTicket,
					matchingPostIds: options.matchingPostIds,
					ticketRadius,
					matchRadius,
					clusterMergeGap: mergeGap,
				},
				ticketMetrics,
			)
		: undefined;

	const useContiguousCore =
		Boolean(options.contiguousTicketCore) &&
		!options.full &&
		!options.windowOnly &&
		!shortMode &&
		!historicalNeighborBrief &&
		Boolean(subjectTicket) &&
		Boolean(ticketMetrics?.ticketHitPostIds.length) &&
		Boolean(inTicketWindow);

	if (options.windowOnly) {
		if (!options.aroundPostId) {
			throw new ConfigError(
				"Window-only packing requires an around post.",
				"invalid_around_options",
			);
		}
		const aroundIndex = chronological.findIndex(
			({ id }) => id === options.aroundPostId,
		);
		if (aroundIndex < 0) {
			throw new ConfigError(
				`Around post ${options.aroundPostId} is not in this thread.`,
				"around_post_not_in_thread",
			);
		}
		const beforeCount = clampAroundSidePosts(options.beforePosts, matchRadius);
		const afterCount = clampAroundSidePosts(options.afterPosts, matchRadius);
		add(
			chronological
				.slice(
					Math.max(0, aroundIndex - beforeCount),
					aroundIndex + 1 + afterCount,
				)
				.map(({ id }) => id),
			"around_window_only",
		);
	} else if (options.full) {
		add(
			chronological.map(({ id }) => id),
			"full_thread",
		);
	} else if (!useContiguousCore) {
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
		for (let distance = 1; distance <= matchRadius; distance += 1) {
			const ring: string[] = [];
			for (const target of options.matchingPostIds ?? []) {
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

		if (options.aroundPostId) {
			const aroundIndex = chronological.findIndex(
				({ id }) => id === options.aroundPostId,
			);
			if (aroundIndex < 0) {
				throw new ConfigError(
					`Around post ${options.aroundPostId} is not in this thread.`,
					"around_post_not_in_thread",
				);
			}
			add([options.aroundPostId], "around_post");
			const beforeCount = clampAroundSidePosts(
				options.beforePosts,
				matchRadius,
			);
			const afterCount = clampAroundSidePosts(options.afterPosts, matchRadius);
			const beforeIds = chronological
				.slice(Math.max(0, aroundIndex - beforeCount), aroundIndex)
				.map(({ id }) => id);
			const afterIds = chronological
				.slice(aroundIndex + 1, aroundIndex + 1 + afterCount)
				.map(({ id }) => id);
			add([...beforeIds, ...afterIds], "around_neighborhood");
		}

		if (mergeGap > 0 && !historicalNeighborBrief) {
			const mergeIds = clusterMergeIds(chronological, order, mergeGap);
			add(mergeIds, "cluster_merge");
		}

		const allowStructural =
			options.structuralAnchors !== false && !historicalNeighborBrief;
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

		const latestCount = historicalNeighborBrief
			? 1
			: shortMode
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
	const rootId = chronological[0]?.id;

	if (useContiguousCore && inTicketWindow && ticketMetrics) {
		const packedCore = selectContiguousTicketCore(chronological, byId, limit, {
			inTicketWindow,
			ticketHitPostIds: ticketMetrics.ticketHitPostIds,
			rootAnchoredFocused: ticketMetrics.rootAnchoredFocused,
		});
		for (const id of packedCore) selected.add(id);
		used = [...selected].reduce((sum, id) => {
			const post = byId.get(id);
			return post ? sum + renderedPostUnits(post) : sum;
		}, 0);
		strategies.push("contiguous_ticket_core");
	} else {
		// An empty Set is truthy — only prefer windows that actually cover posts.
		const preferTicketWindows =
			Boolean(inTicketWindow && inTicketWindow.size > 0) && !options.full;
		const latestIds = new Set(
			chronological.slice(-LATEST_PRIORITY_COUNT).map(({ id }) => id),
		);
		const protectedOffWindow = new Set<string>([
			...(options.matchingPostIds ?? []),
			...(options.aroundPostId ? [options.aroundPostId] : []),
		]);
		const prioritizedOrder = historicalNeighborBrief
			? order
			: preferTicketWindows && inTicketWindow
				? [
						...order.filter((id) => inTicketWindow.has(id)),
						// Keep only intentional off-window anchors (root / files / fences /
						// latest / explicit matches / around target), never densest-window
						// chatter from an off-topic gap.
						...order.filter(
							(id) =>
								!inTicketWindow.has(id) &&
								(id === rootId ||
									isFileOrFencePost(byId.get(id)) ||
									latestIds.has(id) ||
									protectedOffWindow.has(id)),
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
			options.gapFill !== false &&
			!options.full &&
			!options.windowOnly &&
			!shortMode &&
			!historicalNeighborBrief;
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

		if (
			!options.full &&
			!options.windowOnly &&
			!shortMode &&
			!historicalNeighborBrief
		) {
			let extended = false;
			for (const post of chronological.slice().reverse()) {
				if (selected.has(post.id)) continue;
				if (
					inTicketWindow &&
					inTicketWindow.size > 0 &&
					!inTicketWindow.has(post.id)
				) {
					continue;
				}
				const units = renderedPostUnits(post);
				if (used + units > limit) continue;
				selected.add(post.id);
				used += units;
				extended = true;
			}
			if (extended) strategies.push("latest_posts_extended");
		}
	}

	const returned = chronological
		.filter(({ id }) => selected.has(id))
		.map((post) => ({ ...post, renderedUnits: renderedPostUnits(post) }));
	const omitted = chronological.filter(({ id }) => !selected.has(id));
	const allOmittedAttachments = options.windowOnly
		? []
		: omitted.flatMap(({ attachments }) => attachments);
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
