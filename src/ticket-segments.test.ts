import { describe, expect, test } from "bun:test";
import { segmentThreadByTicketProximity } from "./ticket-segments.ts";

describe("ticket proximity segmentation", () => {
	test("builds ticket windows and marks large middle gaps as omitted_gap", () => {
		const posts = [
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
		];
		const metrics = segmentThreadByTicketProximity(posts, {
			subjectTicket: "BTB-2112",
			ticketRadius: 2,
			matchRadius: 1,
			clusterMergeGap: 1,
			omittedGapHydrateThreshold: 5,
		});
		expect(metrics.ticketInRoot).toBe(true);
		expect(metrics.rootAnchoredFocused).toBe(false);
		expect(metrics.ticketHitPostIds).toEqual(["p0", "p1"]);
		expect(metrics.ticketDensity).toBeGreaterThan(0);
		expect(
			metrics.segments.some(
				(segment) =>
					segment.reason === "omitted_gap" && segment.recommendHydrate,
			),
		).toBe(true);
		expect(
			metrics.segments.some((segment) => segment.reason === "ticket_window"),
		).toBe(true);
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
