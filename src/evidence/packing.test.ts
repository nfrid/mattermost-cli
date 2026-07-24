import { describe, expect, test } from "bun:test";
import { ConfigError } from "../shared/errors.ts";
import {
	clampAroundSidePosts,
	type EvidencePost,
	hasInternalBudgetSkipInCore,
	MAX_AROUND_SIDE_POSTS,
	packThread,
	renderedPostUnits,
	ticketCorePostIds,
} from "./packing.ts";

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

	test("prefers subject-ticket windows and labels outside skips", () => {
		const posts = [
			evidence("lead", 0, "unrelated preamble"),
			evidence("p0", 1, "TECHSUPP-109 announce"),
			...Array.from({ length: 4 }, (_, index) =>
				evidence(`n${index}`, index + 2, `near ${index}`),
			),
			...Array.from({ length: 12 }, (_, index) =>
				evidence(`g${index}`, index + 6, `decision middle ${index}`),
			),
			evidence("p1", 18, "TECHSUPP-109 thanks"),
			evidence("p2", 19, "latest ack"),
		];
		const packed = packThread("lead", posts, {
			subjectTicketKey: "TECHSUPP-109",
			matchingPostIds: ["p0"],
			ticketNeighborhoodRadius: 0,
			neighborhoodRadius: 1,
			clusterMergeGap: 1,
			structuralAnchors: false,
			gapFill: true,
			limit: 50_000,
		});
		expect(packed.selectionStrategy).toContain("ticket_mentions");
		// Continuous first→last ticket span includes the decision middle.
		expect(packed.posts.some(({ id }) => id === "g5")).toBe(true);
		expect(packed.posts.some(({ id }) => id === "lead")).toBe(true);
		expect(
			packed.timeline.some(
				(item) =>
					item.kind === "skip" && item.skip.reason === "outside_ticket_window",
			),
		).toBe(false);
		expect(packed.posts.map(({ id }) => id)).toContain("p0");
		expect(packed.posts.map(({ id }) => id)).toContain("p1");
	});

	test("gap-fills decision middle inside a continuous ticket span under budget", () => {
		const posts = [
			evidence("p0", 0, "TECHSUPP-109 start"),
			...Array.from({ length: 20 }, (_, index) =>
				evidence(`m${index}`, index + 1, `argument ${index}`),
			),
			evidence("p1", 21, "TECHSUPP-109 agreed"),
		];
		const unitsFor = (...indexes: number[]) =>
			indexes.reduce((sum, index) => {
				const post = posts.at(index);
				if (!post) throw new Error(`missing post ${index}`);
				return sum + renderedPostUnits(post);
			}, 0);
		const limit = unitsFor(0, 21, 1, 2, 19, 20);
		const packed = packThread("p0", posts, {
			subjectTicketKey: "TECHSUPP-109",
			matchingPostIds: ["p0", "p1"],
			ticketNeighborhoodRadius: 0,
			neighborhoodRadius: 1,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: true,
			limit,
		});
		expect(packed.selectionStrategy).toContain("gap_fill");
		expect(packed.posts.map(({ id }) => id)).toContain("m0");
		expect(packed.posts.map(({ id }) => id)).toContain("m19");
		expect(
			packed.timeline.some(
				(item) =>
					item.kind === "skip" && item.skip.reason === "outside_ticket_window",
			),
		).toBe(false);
	});

	test("does not gap-fill or densest-pack leading off-topic chatter before the first ticket hit", () => {
		const posts = [
			evidence("p0", 0, "dark theme?"),
			...Array.from({ length: 12 }, (_, index) =>
				evidence(`h${index}`, index + 1, `hermes pi chatter ${index}`),
			),
			evidence("p1", 13, "BTB-2112 link and decision"),
			evidence("p2", 14, "BTB-2112 follow-up"),
			evidence("p3", 15, "thanks"),
		];
		const packed = packThread("p0", posts, {
			subjectTicketKey: "BTB-2112",
			matchingPostIds: ["p1"],
			ticketNeighborhoodRadius: 1,
			neighborhoodRadius: 1,
			clusterMergeGap: 1,
			structuralAnchors: true,
			gapFill: true,
			limit: 50_000,
		});
		// Near-ticket edge posts may enter the window; deep leading offtopic must not.
		expect(packed.posts.some(({ id }) => id === "h3")).toBe(false);
		expect(packed.posts.some(({ id }) => id === "h6")).toBe(false);
		expect(packed.posts.map(({ id }) => id)).toContain("p1");
		expect(
			packed.timeline.some(
				(item) =>
					item.kind === "skip" &&
					item.skip.reason === "outside_ticket_window" &&
					item.skip.posts >= 8,
			),
		).toBe(true);
	});

	test("short mode keeps root, ticket/file anchors, and latest without gap-fill", () => {
		const posts = [
			evidence("p0", 0, "TECHSUPP-109 root"),
			...Array.from({ length: 8 }, (_, index) =>
				evidence(`m${index}`, index + 1, `middle ${index}`),
			),
			evidence("p3", 9, "file drop"),
			evidence("p4", 10, "tail"),
		];
		const filePost = posts.find((post) => post.id === "p3");
		if (!filePost) throw new Error("missing file post");
		filePost.attachments = [
			{
				id: "file-1",
				postId: "p3",
				name: "schema.png",
				extension: "png",
				size: 10,
				mimeType: "image/png",
				deleteAt: 0,
			},
		];
		const packed = packThread("p0", posts, {
			subjectTicketKey: "TECHSUPP-109",
			matchingPostIds: [],
			ticketNeighborhoodRadius: 0,
			neighborhoodRadius: 1,
			mode: "short",
			structuralAnchors: true,
			limit: 10_000,
		});
		expect(packed.selectionStrategy).not.toContain("gap_fill");
		expect(packed.selectionStrategy).not.toContain("densest_window");
		expect(packed.posts.map(({ id }) => id)).toEqual(["p0", "p3", "p4"]);
	});

	test("contiguousTicketCore avoids internal budget skips inside the ticket core", () => {
		const posts = [
			evidence("p0", 0, "TECHSUPP-109 start"),
			...Array.from({ length: 20 }, (_, index) =>
				evidence(`m${index}`, index + 1, `argument ${index}`),
			),
			evidence("p1", 21, "TECHSUPP-109 agreed"),
		];
		const unitsFor = (...indexes: number[]) =>
			indexes.reduce((sum, index) => {
				const post = posts.at(index);
				if (!post) throw new Error(`missing post ${index}`);
				return sum + renderedPostUnits(post);
			}, 0);
		const limit = unitsFor(0, 21, 1, 2, 19, 20);
		const packed = packThread("p0", posts, {
			subjectTicketKey: "TECHSUPP-109",
			matchingPostIds: ["p0", "p1"],
			ticketNeighborhoodRadius: 0,
			neighborhoodRadius: 1,
			clusterMergeGap: 0,
			structuralAnchors: false,
			contiguousTicketCore: true,
			limit,
		});
		expect(packed.selectionStrategy).toContain("contiguous_ticket_core");
		const selected = packed.posts.map(({ id }) => id);
		const first = selected[0];
		const last = selected[selected.length - 1];
		expect(first).toBeDefined();
		expect(last).toBeDefined();
		const coreSpan = posts
			.map(({ id }) => id)
			.slice(
				posts.findIndex((post) => post.id === first),
				posts.findIndex((post) => post.id === last) + 1,
			);
		expect(selected).toEqual(coreSpan);
		expect(
			hasInternalBudgetSkipInCore(
				packed.timeline,
				ticketCorePostIds(posts, ["p0", "p1"], false),
			),
		).toBe(false);
	});

	test("contiguousTicketCore may omit a noisy off-topic root while keeping the ticket core", () => {
		const posts = [
			evidence("root", 0, "unrelated standup noise"),
			...Array.from({ length: 4 }, (_, index) =>
				evidence(`noise${index}`, index + 1, `noise ${index}`),
			),
			evidence("t0", 5, "BTB-2112 starts"),
			evidence("mid", 6, "decision detail"),
			evidence("t1", 7, "BTB-2112 done"),
			evidence("tail", 8, "thanks"),
		];
		const coreUnits =
			renderedPostUnits(posts[5]!) +
			renderedPostUnits(posts[6]!) +
			renderedPostUnits(posts[7]!);
		const packed = packThread("root", posts, {
			subjectTicketKey: "BTB-2112",
			matchingPostIds: ["t0"],
			ticketNeighborhoodRadius: 0,
			neighborhoodRadius: 1,
			clusterMergeGap: 0,
			structuralAnchors: false,
			contiguousTicketCore: true,
			limit: coreUnits,
		});
		expect(packed.posts.map(({ id }) => id)).toEqual(["t0", "mid", "t1"]);
		expect(packed.posts.some(({ id }) => id === "root")).toBe(false);
		expect(
			packed.timeline.some(
				(item) =>
					item.kind === "skip" && item.skip.reason === "outside_ticket_window",
			),
		).toBe(true);
	});

	test("contiguousTicketCore keeps mid-thread replies for root-anchored support threads", () => {
		const posts = [
			evidence("p0", 0, "BTB-99 duty announce"),
			...Array.from({ length: 10 }, (_, index) =>
				evidence(`r${index}`, index + 1, `duty reply ${index}`),
			),
			evidence("tail", 11, "ack"),
		];
		const unitsFor = (...indexes: number[]) =>
			indexes.reduce((sum, index) => {
				const post = posts.at(index);
				if (!post) throw new Error(`missing post ${index}`);
				return sum + renderedPostUnits(post);
			}, 0);
		// Fits root + a contiguous mid slice, but not the full chain.
		const limit = unitsFor(0, 4, 5, 6, 7, 8);
		const packed = packThread("p0", posts, {
			subjectTicketKey: "BTB-99",
			matchingPostIds: ["p0"],
			ticketNeighborhoodRadius: 0,
			neighborhoodRadius: 1,
			clusterMergeGap: 0,
			structuralAnchors: false,
			contiguousTicketCore: true,
			limit,
		});
		expect(packed.selectionStrategy).toContain("contiguous_ticket_core");
		expect(packed.posts.some(({ id }) => id === "p0")).toBe(true);
		const selected = packed.posts.map(({ id }) => id);
		const first = selected[0];
		const last = selected[selected.length - 1];
		const span = posts
			.map(({ id }) => id)
			.slice(
				posts.findIndex((post) => post.id === first),
				posts.findIndex((post) => post.id === last) + 1,
			);
		expect(selected).toEqual(span);
		expect(selected.some((id) => id.startsWith("r"))).toBe(true);
	});

	test("around uses asymmetric before/after counts and defaults to match radius", () => {
		const posts = Array.from({ length: 10 }, (_, index) =>
			evidence(`p${index}`, index),
		);
		const units = (...indexes: number[]) =>
			indexes.reduce((sum, index) => {
				const post = posts.at(index);
				if (!post) throw new Error(`missing post ${index}`);
				return sum + renderedPostUnits(post);
			}, 0);

		const asymmetric = packThread("p0", posts, {
			matchingPostIds: [],
			aroundPostId: "p5",
			beforePosts: 1,
			afterPosts: 3,
			neighborhoodRadius: 2,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: false,
			limit: units(0, 4, 5, 6, 7, 8),
		});
		expect(asymmetric.selectionStrategy).toEqual([
			"root",
			"around_post",
			"around_neighborhood",
			"latest_posts",
		]);
		expect(asymmetric.posts.map(({ id }) => id)).toEqual([
			"p0",
			"p4",
			"p5",
			"p6",
			"p7",
			"p8",
		]);
		expect(asymmetric.timeline.filter((item) => item.kind === "skip")).toEqual([
			{ kind: "skip", skip: { posts: 3, after: "p0", before: "p4" } },
			{ kind: "skip", skip: { posts: 1, after: "p8" } },
		]);

		const defaults = packThread("p0", posts, {
			matchingPostIds: [],
			aroundPostId: "p5",
			neighborhoodRadius: 2,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: false,
			limit: units(0, 3, 4, 5, 6, 7),
		});
		expect(defaults.posts.map(({ id }) => id)).toEqual([
			"p0",
			"p3",
			"p4",
			"p5",
			"p6",
			"p7",
		]);
	});

	test("around clamps side counts and rejects missing around posts", () => {
		expect(clampAroundSidePosts(undefined, 2)).toBe(2);
		expect(clampAroundSidePosts(0, 2)).toBe(0);
		expect(clampAroundSidePosts(MAX_AROUND_SIDE_POSTS + 10, 2)).toBe(
			MAX_AROUND_SIDE_POSTS,
		);
		expect(clampAroundSidePosts(-3, 2)).toBe(0);

		const posts = Array.from({ length: 6 }, (_, index) =>
			evidence(`p${index}`, index),
		);
		const huge = packThread("p0", posts, {
			matchingPostIds: [],
			aroundPostId: "p2",
			beforePosts: 100,
			afterPosts: 100,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: false,
			limit: 10_000,
		});
		expect(huge.posts.map(({ id }) => id)).toEqual([
			"p0",
			"p1",
			"p2",
			"p3",
			"p4",
			"p5",
		]);

		expect(() =>
			packThread("p0", posts, {
				aroundPostId: "missing",
				limit: 1_000,
			}),
		).toThrow(ConfigError);
		try {
			packThread("p0", posts, {
				aroundPostId: "missing",
				limit: 1_000,
			});
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as ConfigError).kind).toBe("around_post_not_in_thread");
		}
	});

	test("around still honors character budget and emits skips", () => {
		const posts = Array.from({ length: 8 }, (_, index) =>
			evidence(`p${index}`, index, `body-${index}`),
		);
		const units = (...indexes: number[]) =>
			indexes.reduce((sum, index) => {
				const post = posts.at(index);
				if (!post) throw new Error(`missing post ${index}`);
				return sum + renderedPostUnits(post);
			}, 0);
		const packed = packThread("p0", posts, {
			matchingPostIds: [],
			aroundPostId: "p4",
			beforePosts: 3,
			afterPosts: 3,
			clusterMergeGap: 0,
			structuralAnchors: false,
			gapFill: false,
			limit: units(0, 3, 4, 5),
		});
		expect(packed.returnedPosts).toBeLessThan(packed.totalPosts);
		expect(packed.omittedPosts).toBeGreaterThan(0);
		expect(packed.posts.some(({ id }) => id === "p4")).toBe(true);
		expect(packed.timeline.some((item) => item.kind === "skip")).toBe(true);
		expect(packed.selectionStrategy).not.toContain("full_thread");
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
