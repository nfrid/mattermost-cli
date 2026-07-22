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
}

export interface PackThreadOptions {
	matchingPostIds?: readonly string[];
	aroundPostId?: string;
	limit: number;
	full?: boolean;
}

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
		const neighborhood: string[] = [];
		for (const target of neighborhoodTargets) {
			const index = chronological.findIndex(({ id }) => id === target);
			if (index < 0) continue;
			for (
				let cursor = Math.max(0, index - 1);
				cursor <= index + 1;
				cursor += 1
			) {
				const id = chronological[cursor]?.id;
				if (id) neighborhood.push(id);
			}
		}
		add(neighborhood, "match_neighborhoods");
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
	};
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
