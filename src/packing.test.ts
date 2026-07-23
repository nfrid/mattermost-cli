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

		const full = packThread("root", [root, oversized], {
			limit: 1,
			full: true,
		});
		expect(full.returnedPosts).toBe(2);
		expect(full.omittedPosts).toBe(0);
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
