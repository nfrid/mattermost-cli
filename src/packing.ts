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

/** Gap between returned posts in chronological thread order. */
export interface PackSkip {
	posts: number;
	after?: string;
	before?: string;
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
	 * Fill chronological gaps of at most this many posts between selected
	 * clusters so micro-windows merge. Default 2.
	 */
	clusterMergeGap?: number;
	limit: number;
	full?: boolean;
}

const DEFAULT_NEIGHBORHOOD_RADIUS = 2;
const DEFAULT_CLUSTER_MERGE_GAP = 2;

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
		add(options.matchingPostIds ?? [], "matching_posts");
		const neighborhoodTargets = [
			...(options.matchingPostIds ?? []),
			...(options.aroundPostId ? [options.aroundPostId] : []),
		];
		const radius = Math.max(
			1,
			options.neighborhoodRadius ?? DEFAULT_NEIGHBORHOOD_RADIUS,
		);
		for (let distance = 1; distance <= radius; distance += 1) {
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

		const mergeGap = Math.max(
			0,
			options.clusterMergeGap ?? DEFAULT_CLUSTER_MERGE_GAP,
		);
		if (mergeGap > 0) {
			const mergeIds = clusterMergeIds(chronological, order, mergeGap);
			add(mergeIds, "cluster_merge");
		}

		add(
			chronological
				.slice()
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
	for (const id of order) {
		const post = byId.get(id);
		if (!post) continue;
		const units = renderedPostUnits(post);
		if (used + units > limit) continue;
		selected.add(id);
		used += units;
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
		timeline: buildTimeline(chronological, selected, returned),
	};
}

/** Build chronological timeline with skip markers for omitted spans. */
export function buildTimeline(
	chronological: readonly EvidencePost[],
	selected: ReadonlySet<string>,
	returned: readonly PackedPost[],
): PackTimelineItem[] {
	const byId = new Map(returned.map((post) => [post.id, post]));
	const timeline: PackTimelineItem[] = [];
	let skipCount = 0;
	let skipAfter: string | undefined;
	let lastEmittedId: string | undefined;

	const flushSkip = (before?: string) => {
		if (skipCount <= 0) return;
		timeline.push({
			kind: "skip",
			skip: {
				posts: skipCount,
				...(skipAfter ? { after: skipAfter } : {}),
				...(before ? { before } : {}),
			},
		});
		skipCount = 0;
		skipAfter = undefined;
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
	}
	flushSkip();
	return timeline;
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
