import type { segmentThreadByTicketProximity } from "../ticket-segments.ts";
import type {
	EvidencePost,
	PackedPost,
	PackSkipReason,
	PackTimelineItem,
} from "./types.ts";

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
	const byIdFull = new Map(chronological.map((post) => [post.id, post]));
	const timeline: PackTimelineItem[] = [];
	let skipCount = 0;
	let skipAfter: string | undefined;
	let skipIds: string[] = [];
	let skipFiles = 0;
	let lastEmittedId: string | undefined;

	const flushSkip = (before?: string) => {
		if (skipCount <= 0) return;
		const omitted = skipIds
			.map((id) => byIdFull.get(id))
			.filter((post): post is EvidencePost => Boolean(post));
		const authors = [
			...new Set(omitted.map((post) => post.authorUsername).filter(Boolean)),
		].slice(0, 4);
		const fromAt = omitted[0]
			? new Date(omitted[0].createAt).toISOString()
			: undefined;
		const toAt = omitted.length
			? new Date(omitted.at(-1)?.createAt ?? 0).toISOString()
			: undefined;
		timeline.push({
			kind: "skip",
			skip: {
				posts: skipCount,
				...(skipAfter ? { after: skipAfter } : {}),
				...(before ? { before } : {}),
				...(classifySkipReason(skipIds, options)
					? { reason: classifySkipReason(skipIds, options) }
					: {}),
				...(skipFiles > 0 ? { files: skipFiles } : {}),
				...(authors.length ? { authors } : {}),
				...(fromAt ? { fromAt } : {}),
				...(toAt ? { toAt } : {}),
			},
		});
		skipCount = 0;
		skipAfter = undefined;
		skipIds = [];
		skipFiles = 0;
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
		skipFiles += post.attachments.filter(({ deleteAt }) => !deleteAt).length;
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

export function classifySkipReason(
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
		options.inTicketWindow.size > 0 &&
		skipIds.every((id) => !options.inTicketWindow?.has(id))
	) {
		return "outside_ticket_window";
	}
	return "budget";
}
