import { describe, expect, test } from "bun:test";
import { type EvidencePost, packThread, renderedPostUnits } from "./packing.ts";

describe("thread packing", () => {
	test("selects root, matches, neighborhoods, then latest and restores chronology", () => {
		const posts = Array.from({ length: 6 }, (_, index) =>
			evidence(`p${index}`, index),
		);
		const units = posts
			.slice(0, 4)
			.reduce((sum, post) => sum + renderedPostUnits(post), 0);
		const packed = packThread("p0", posts, {
			matchingPostIds: ["p2"],
			neighborhoodRadius: 1,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: false,
			limit: units,
		});
		expect(packed.selectionStrategy).toEqual([
			"root",
			"matching_posts",
			"match_neighborhoods",
			"latest_posts",
		]);
		expect(packed.posts.map(({ id }) => id)).toEqual(["p0", "p1", "p2", "p3"]);
		expect(packed.returnedPosts).toBe(4);
		expect(packed.omittedPosts).toBe(2);
		expect(packed.timeline).toEqual([
			{ kind: "post", post: expect.objectContaining({ id: "p0" }) },
			{ kind: "post", post: expect.objectContaining({ id: "p1" }) },
			{ kind: "post", post: expect.objectContaining({ id: "p2" }) },
			{ kind: "post", post: expect.objectContaining({ id: "p3" }) },
			{ kind: "skip", skip: { posts: 2, after: "p3" } },
		]);
	});

	test("emits skip markers between selected clusters and merges tiny gaps", () => {
		const posts = Array.from({ length: 12 }, (_, index) =>
			evidence(`p${index}`, index),
		);
		const units = (...indexes: number[]) =>
			indexes.reduce((sum, index) => {
				const post = posts.at(index);
				if (!post) throw new Error(`missing post ${index}`);
				return sum + renderedPostUnits(post);
			}, 0);
		const limited = packThread("p0", posts, {
			matchingPostIds: ["p2", "p9"],
			neighborhoodRadius: 1,
			clusterMergeGap: 2,
			structuralAnchors: false,
			gapFill: false,
			limit: units(0, 1, 2, 3, 8, 9, 10),
		});
		expect(limited.posts.map(({ id }) => id)).toEqual([
			"p0",
			"p1",
			"p2",
			"p3",
			"p8",
			"p9",
			"p10",
		]);
		expect(limited.timeline.filter((item) => item.kind === "skip")).toEqual([
			{ kind: "skip", skip: { posts: 4, after: "p3", before: "p8" } },
			{ kind: "skip", skip: { posts: 1, after: "p10" } },
		]);

		const near = packThread("p0", posts, {
			matchingPostIds: ["p2", "p6"],
			neighborhoodRadius: 1,
			clusterMergeGap: 2,
			structuralAnchors: false,
			gapFill: false,
			limit: units(0, 1, 2, 3, 4, 5, 6, 7),
		});
		// windows [p1-p3] and [p5-p7]; gap p4 size 1 → merged before latest fill
		expect(near.selectionStrategy).toEqual([
			"root",
			"matching_posts",
			"match_neighborhoods",
			"cluster_merge",
			"latest_posts",
		]);
		expect(near.posts.map(({ id }) => id)).toEqual([
			"p0",
			"p1",
			"p2",
			"p3",
			"p4",
			"p5",
			"p6",
			"p7",
		]);
		expect(near.timeline.filter((item) => item.kind === "skip")).toEqual([
			{ kind: "skip", skip: { posts: 4, after: "p7" } },
		]);
	});

	test("gap-fill spends leftover budget on the largest internal skip", () => {
		const posts = Array.from({ length: 12 }, (_, index) =>
			evidence(`p${index}`, index, `body-${index}`),
		);
		// Budget fits root + last three + several gap-edge posts, but not the full thread.
		const limit =
			renderedPostUnits(posts[0]!) +
			renderedPostUnits(posts[9]!) +
			renderedPostUnits(posts[10]!) +
			renderedPostUnits(posts[11]!) +
			renderedPostUnits(posts[1]!) +
			renderedPostUnits(posts[2]!) +
			renderedPostUnits(posts[8]!);
		const packed = packThread("p0", posts, {
			matchingPostIds: [],
			neighborhoodRadius: 1,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: true,
			limit,
		});
		expect(packed.selectionStrategy).toContain("gap_fill");
		// Edge-inward reconnects root↔latest clusters before deep middle posts.
		expect(packed.posts.map(({ id }) => id)).toEqual([
			"p0",
			"p1",
			"p2",
			"p8",
			"p9",
			"p10",
			"p11",
		]);
		expect(packed.timeline.filter((item) => item.kind === "skip")).toEqual([
			{ kind: "skip", skip: { posts: 5, after: "p2", before: "p8" } },
		]);
	});

	test("full returns every message while normal packing omits an oversized message whole", () => {
		const root = evidence("root", 0, "small");
		const oversized = evidence("large", 1, "😀".repeat(100));
		oversized.attachments = [
			{
				id: "file-1",
				postId: "large",
				name: "large.txt",
				extension: "txt",
				size: 100,
				mimeType: "text/plain",
				deleteAt: 0,
			},
		];
		const selected = packThread("root", [root, oversized], {
			matchingPostIds: ["large"],
			limit: renderedPostUnits(root),
		});
		expect(selected.posts.map(({ id }) => id)).toEqual(["root"]);
		expect(selected.omittedPosts).toBe(1);
		expect(selected.totalOmittedAttachments).toBe(1);
		expect(selected.omittedAttachments).toEqual([]);
		expect(selected.unreportedOmittedAttachments).toBe(1);
		expect(selected.budget.used).toBe(renderedPostUnits(root));
		expect(selected.timeline).toEqual([
			{ kind: "post", post: expect.objectContaining({ id: "root" }) },
			{ kind: "skip", skip: { posts: 1, after: "root" } },
		]);

		const full = packThread("root", [root, oversized], {
			limit: 1,
			full: true,
		});
		expect(full.returnedPosts).toBe(2);
		expect(full.omittedPosts).toBe(0);
		expect(full.timeline.every((item) => item.kind === "post")).toBe(true);
	});

	test("bounds omitted attachment metadata and reports unrepresented counts", () => {
		const root = evidence("root", 0, "small");
		const oversized = evidence("large", 1, "x".repeat(1_000));
		oversized.attachments = Array.from({ length: 100 }, (_, index) => ({
			id: `file-${index}`,
			postId: "large",
			name: `attachment-${index}.txt`,
			extension: "txt",
			size: index,
			mimeType: "text/plain",
			deleteAt: 0,
		}));
		const packed = packThread("root", [root, oversized], {
			matchingPostIds: ["large"],
			limit: renderedPostUnits(root),
		});
		expect(packed.totalOmittedAttachments).toBe(100);
		expect(packed.omittedAttachments).toEqual([]);
		expect(packed.unreportedOmittedAttachments).toBe(100);
		expect(packed.budget.used).toBe(packed.budget.limit);
	});

	test("measures Unicode code points rather than UTF-16 code units", () => {
		const plain = evidence("plain", 0, "a");
		const emoji = evidence("emoji", 0, "😀");
		expect(renderedPostUnits(emoji)).toBe(renderedPostUnits(plain));
	});
});

function evidence(
	id: string,
	index: number,
	message = `message-${id}`,
): EvidencePost {
	return {
		id,
		rootId: index ? "p0" : "",
		userId: "user-1",
		authorUsername: "alice",
		authorDisplayName: "Alice Example",
		createAt: index * 1_000,
		updateAt: index * 1_000,
		deleteAt: 0,
		message,
		attachments: [],
	};
}
