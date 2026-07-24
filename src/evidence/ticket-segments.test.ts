import { describe, expect, test } from "bun:test";
import {
	segmentThreadByTicketProximity,
	ticketWindowPostIds,
} from "./ticket-segments.ts";

describe("ticket proximity segmentation", () => {
	test("bridges the span between multiple subject-ticket hits", () => {
		const posts = [
			{ id: "lead0", message: "unrelated kickoff" },
			{ id: "lead1", message: "still unrelated" },
			{ id: "p0", message: "BTB-2112 kickoff" },
			...Array.from({ length: 5 }, (_, index) => ({
				id: `a${index}`,
				message: "ticket neighborhood",
			})),
			...Array.from({ length: 12 }, (_, index) => ({
				id: `g${index}`,
				message: "off topic chatter about pi and Hermes",
			})),
			{ id: "p1", message: "see BTB-2112 follow-up" },
			...Array.from({ length: 3 }, (_, index) => ({
				id: `b${index}`,
				message: "closing notes",
			})),
			{ id: "tail0", message: "later unrelated" },
		];
		const metrics = segmentThreadByTicketProximity(posts, {
			subjectTicket: "BTB-2112",
			// Radius 0 isolates the continuous first→last bridge from edge expansion.
			ticketRadius: 0,
			matchRadius: 1,
			clusterMergeGap: 1,
			omittedGapHydrateThreshold: 5,
		});
		expect(metrics.ticketInRoot).toBe(false);
		expect(metrics.rootAnchoredFocused).toBe(false);
		expect(metrics.ticketHitPostIds).toEqual(["p0", "p1"]);
		expect(
			metrics.segments.some((segment) => segment.reason === "omitted_gap"),
		).toBe(false);
		expect(metrics.segments).toEqual([
			expect.objectContaining({
				reason: "off_topic_gap",
				startPostId: "lead0",
				endPostId: "lead1",
			}),
			expect.objectContaining({
				reason: "ticket_window",
				startPostId: "p0",
				endPostId: "p1",
			}),
			expect.objectContaining({
				reason: "off_topic_gap",
				startPostId: "b0",
				endPostId: "tail0",
			}),
		]);
		const windowIds = ticketWindowPostIds(posts, {
			subjectTicket: "BTB-2112",
			ticketRadius: 0,
		});
		expect(windowIds.has("g5")).toBe(true);
		expect(windowIds.has("lead0")).toBe(false);
		expect(windowIds.has("tail0")).toBe(false);
	});

	test("keeps a radius island for a single subject-ticket hit", () => {
		const posts = Array.from({ length: 15 }, (_, index) => ({
			id: `p${index}`,
			message: index === 7 ? "BTB-99 only hit" : "noise",
		}));
		const metrics = segmentThreadByTicketProximity(posts, {
			subjectTicket: "BTB-99",
			ticketRadius: 2,
			matchRadius: 1,
			clusterMergeGap: 0,
		});
		expect(metrics.ticketHitPostIds).toEqual(["p7"]);
		expect(metrics.segments).toEqual([
			expect.objectContaining({
				reason: "off_topic_gap",
				posts: 5,
			}),
			expect.objectContaining({
				reason: "ticket_window",
				startPostId: "p5",
				endPostId: "p9",
				posts: 5,
			}),
			expect.objectContaining({
				reason: "off_topic_gap",
				posts: 5,
			}),
		]);
	});

	test("treats non-ticket match hits with the smaller radius", () => {
		const posts = Array.from({ length: 9 }, (_, index) => ({
			id: `p${index}`,
			message: index === 4 ? "lexical hit only" : "noise",
		}));
		const metrics = segmentThreadByTicketProximity(posts, {
			subjectTicket: "BTB-1",
			matchingPostIds: ["p4"],
			ticketRadius: 3,
			matchRadius: 1,
			clusterMergeGap: 0,
		});
		expect(metrics.ticketHitPostIds).toEqual([]);
		expect(metrics.rootAnchoredFocused).toBe(false);
		expect(metrics.segments).toEqual([
			expect.objectContaining({
				reason: "off_topic_gap",
				posts: 3,
			}),
			expect.objectContaining({
				reason: "match_window",
				startPostId: "p3",
				endPostId: "p5",
				posts: 3,
			}),
			expect.objectContaining({
				reason: "off_topic_gap",
				posts: 3,
			}),
		]);
	});

	test("root-anchored support threads keep the whole reply chain on-topic", () => {
		const posts = [
			{ id: "p0", message: "TECHSUPP-109 duty announce" },
			...Array.from({ length: 20 }, (_, index) => ({
				id: `r${index}`,
				message: `discussion detail ${index}`,
			})),
		];
		const metrics = segmentThreadByTicketProximity(posts, {
			subjectTicket: "TECHSUPP-109",
			ticketRadius: 2,
			matchRadius: 1,
		});
		expect(metrics.rootAnchoredFocused).toBe(true);
		expect(metrics.ticketDensity).toBe(1);
		expect(metrics.segments).toEqual([
			expect.objectContaining({
				reason: "ticket_window",
				posts: 21,
			}),
		]);
		expect(
			metrics.segments.some((segment) => segment.reason === "off_topic_gap"),
		).toBe(false);
	});
});
