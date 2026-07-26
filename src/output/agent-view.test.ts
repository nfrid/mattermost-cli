import { describe, expect, test } from "bun:test";
import {
	getMattermostContext,
	getMattermostThread,
	searchMattermost,
} from "../context/index.ts";
import { commandSuccess } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { projectAgentResult } from "./agent-view.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("agent projection", () => {
	test("projects context evidence as consecutive author groups with file ids", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);

		expect(result).toMatchObject({
			command: "context",
			schemaVersion: 5,
			success: true,
			subject: "payment evidence",
			status: {
				freshness: "local",
			},
			people: [{ username: "alice" }],
			evidence: expect.objectContaining({
				adequacy: "usable",
				currency: "local_only",
				verdict: {
					canAnswerFromSelectedEvidence: true,
					// `local_only` discovery cannot claim it saw everything.
					mayHaveMissedOtherThreads: true,
					mayHaveMissedReason: "local_discovery",
					selectedEvidenceMayBeStale: true,
					recommendedActionRequired: false,
					noActionAvailable: true,
					noActionReason: expect.stringMatching(/local index|refresh/i),
				},
				completeness: {
					selectedThreads: "complete",
					selection: "complete",
					indexHistory: "full",
					discovery: "local_only",
				},
				packing: expect.objectContaining({
					omittedPosts: 0,
					recommendFullThreadIds: [],
				}),
			}),
			threads: [
				{
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					rank: 1,
					role: "primary",
					filesPresent: true,
					omitted: { posts: 0, attachments: 0 },
					messageCount: 2,
					totalPosts: 2,
					latestAt: "1970-01-01T00:00:00.020Z",
					attachments: [
						{
							id: "file-1",
							name: "trace.txt",
							postId: REPLY,
							mimeType: "text/plain",
							size: 42,
							inPacket: true,
							downloadCommand: ["mm", "file", "file-1", "--agent"],
						},
					],
					posts: [
						{
							author: "alice",
							messages: [
								{
									id: ROOT,
									text: "synthetic payment evidence",
									at: "1970-01-01T00:00:00.010Z",
								},
								{
									id: REPLY,
									text: "payment evidence confirmed",
									at: "1970-01-01T00:00:00.020Z",
									files: [
										{
											id: "file-1",
											name: "trace.txt",
											mimeType: "text/plain",
											size: 42,
											downloadCommand: ["mm", "file", "file-1", "--agent"],
										},
									],
								},
							],
						},
					],
				},
			],
			warnings: [],
		});
		expect(
			(
				result as unknown as {
					threads: Array<{
						signals?: unknown;
						technicalEntities?: unknown;
						brief?: unknown;
					}>;
				}
			).threads[0]?.signals,
		).toBeUndefined();
		expect(
			(
				result as unknown as {
					threads: Array<{
						signals?: unknown;
						technicalEntities?: unknown;
						brief?: unknown;
					}>;
				}
			).threads[0]?.technicalEntities,
		).toBeUndefined();
		expect(
			(
				result as unknown as {
					threads: Array<{ brief?: unknown }>;
				}
			).threads[0]?.brief,
		).toBeUndefined();
		expect(JSON.stringify(result)).not.toMatch(
			/"data"|rootId|userId|renderedUnits|scoreVector|matchingPostIds|displayName|"from"|"to"|"why"/,
		);
		store.close();
	});

	test("projects a direct thread and emits only meaningful post state", async () => {
		const store = await seededStore();
		const thread = await getMattermostThread(
			{ target: ROOT, local: true, full: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const first = thread.thread.posts[0];
		const second = thread.thread.posts[1];
		if (!first || !second) throw new Error("Expected two fixture posts.");
		first.updateAt = 30;
		second.deleteAt = 40;
		second.message = "";

		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		);

		expect(result).toMatchObject({
			command: "thread",
			subject: ROOT,
			status: {
				freshness: "local",
			},
			evidence: expect.objectContaining({
				adequacy: "usable",
				currency: "local_only",
				completeness: expect.objectContaining({
					selectedThreads: "complete",
				}),
			}),
			threads: [
				{
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					posts: [
						{
							author: "alice",
							messages: [
								{ id: ROOT, editedAt: "1970-01-01T00:00:00.030Z" },
								{ id: REPLY, text: "", deleted: true },
							],
						},
					],
				},
			],
		});
		expect(result).not.toHaveProperty("thread");
		// `resolved.from` is a legitimate field; the guard targets raw post state.
		expect(JSON.stringify(result)).not.toMatch(
			/"updateAt"|"deleteAt"|"to"|displayName|"why"/,
		);
		store.close();
	});

	test("marks a window-only thread as completed gap recovery", async () => {
		const store = await seededStore();
		const thread = await getMattermostThread(
			{
				target: ROOT,
				local: true,
				around: REPLY,
				beforePosts: 0,
				afterPosts: 0,
				windowOnly: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		);
		expect(result).toMatchObject({
			retrieval: {
				mode: "gap_window",
				requestedPosts: 1,
				returnedPosts: 1,
				requestedRangeComplete: true,
			},
			evidence: {
				scope: "gap_recovery",
				verdict: { recommendedActionRequired: false },
				completeness: { selectedThreads: "complete" },
				gapRecovery: {
					requestedRangeComplete: true,
					remainingPostsOutsideRange: 1,
				},
				next: [],
			},
			threads: [{ messageCount: 1, totalPosts: 2 }],
		});
		store.close();
	});

	test("does not turn an incomplete bounded delta into a full-thread retry", async () => {
		const store = await seededStore();
		const config = configFixture();
		config.budgets.defaultPerThreadCharacters = 1;
		const thread = await getMattermostThread(
			{
				target: ROOT,
				local: true,
				around: REPLY,
				beforePosts: 0,
				afterPosts: 0,
				windowOnly: true,
			},
			{ config, store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		);
		expect(result).toMatchObject({
			retrieval: { requestedRangeComplete: false, returnedPosts: 0 },
			evidence: {
				scope: "gap_recovery",
				verdict: { recommendedActionRequired: false },
				gapRecovery: {
					requestedRangeComplete: false,
					noActionAvailable: true,
				},
				next: [],
			},
		});
		expect(JSON.stringify(result)).not.toContain("thread_full");
		store.close();
	});

	test("pages an incomplete gap window instead of leaving a dead-end", async () => {
		const store = await MattermostStore.open(":memory:");
		const posts = [
			postFixture({
				id: ROOT,
				message: "gap root with enough text to spend budget characters",
				create_at: 10,
			}),
			...Array.from({ length: 12 }, (_, index) =>
				postFixture({
					id: `${String.fromCharCode(98 + index)}${"b".repeat(25)}`,
					root_id: ROOT,
					message: `gap body ${index} ${"x".repeat(40)}`,
					create_at: 20 + index,
				}),
			),
		];
		const anchor = posts[posts.length - 1];
		if (!anchor) throw new Error("expected anchor");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts,
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: anchor.id,
				newestPostAt: anchor.create_at,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const config = configFixture();
		config.budgets.defaultPerThreadCharacters = 120;
		const thread = await getMattermostThread(
			{
				target: ROOT,
				local: true,
				around: anchor.id,
				beforePosts: 10,
				afterPosts: 0,
				windowOnly: true,
			},
			{ config, store, now: () => 1_000 },
		);
		expect(thread.retrieval?.requestedRangeComplete).toBe(false);
		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		) as unknown as {
			retrieval: { requestedBefore: number };
			evidence: {
				gapRecovery: { noActionAvailable?: true };
				next: Array<{
					action: string;
					priority: string;
					command?: string[];
				}>;
				verdict: { recommendedActionRequired: boolean };
			};
		};
		expect(result.evidence.gapRecovery.noActionAvailable).toBeUndefined();
		expect(result.evidence.next[0]).toMatchObject({
			action: "thread_around",
			priority: "recommended",
		});
		expect(result.evidence.verdict.recommendedActionRequired).toBe(true);
		const beforeFlag =
			result.evidence.next[0]?.command?.indexOf("--before-posts");
		expect(beforeFlag).toBeGreaterThanOrEqual(0);
		const beforeCount = Number(
			result.evidence.next[0]?.command?.[(beforeFlag ?? 0) + 1],
		);
		expect(beforeCount).toBe(5);
		expect(beforeCount).toBeLessThan(result.retrieval.requestedBefore);
		expect(JSON.stringify(result)).not.toContain("thread_full");
		store.close();
	});

	test("keeps attachment inspection recommendations inside a recovered delta", async () => {
		const store = await seededStore();
		const thread = await getMattermostThread(
			{
				target: ROOT,
				local: true,
				around: REPLY,
				beforePosts: 0,
				afterPosts: 0,
				windowOnly: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const recovered = thread.thread.posts[0];
		if (!recovered) throw new Error("Expected recovered post.");
		recovered.message = "";
		recovered.attachments = [
			{
				id: "file-delta",
				postId: recovered.id,
				name: "evidence.png",
				extension: "png",
				size: 128,
				mimeType: "image/png",
				deleteAt: 0,
			},
		];
		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		) as unknown as {
			evidence: {
				verdict: { recommendedActionRequired: boolean };
				next: Array<{ action: string }>;
			};
		};
		expect(result.evidence.verdict.recommendedActionRequired).toBe(true);
		expect(result.evidence.next).toContainEqual(
			expect.objectContaining({
				action: "read_attachments",
				priority: "recommended",
				impact: "requires_external_reader",
			}),
		);
		store.close();
	});

	test("projects compact search candidates without why or detailed freshness evidence", async () => {
		const store = await seededStore({ stale: true, complete: false });
		const search = await searchMattermost(
			{
				subject: "payment evidence",
				channels: ["payments"],
			},
			{ config: configFixture(), store, now: () => 8_200_000 },
		);
		const result = projectAgentResult(
			commandSuccess("search", search, search.warnings),
		);

		expect(result).toMatchObject({
			command: "search",
			subject: "payment evidence",
			status: {
				freshness: "local",
			},
			candidates: [
				{
					rank: 1,
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					latestAt: "1970-01-01T00:00:00.020Z",
					reasons: expect.arrayContaining(["all_terms_in_thread"]),
					contributingProbes: ["payment evidence"],
					excerpts: [
						"synthetic payment evidence",
						"payment evidence confirmed",
					],
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/rootPostId|conversationId|priority|scoreVector|postId|probes|evidenceIssues|"complete"|"why"/,
		);
		store.close();
	});

	test("caps search excerpts and reports the remainder", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: ROOT,
					message: "payment evidence root",
					create_at: 10,
				}),
				...Array.from({ length: 5 }, (_, index) =>
					postFixture({
						id: `${String.fromCharCode(99 + index)}${"c".repeat(25)}`,
						root_id: ROOT,
						message: `payment evidence detail ${index + 1}`,
						create_at: 20 + index,
					}),
				),
			],
		});
		const search = await searchMattermost(
			{ subject: "payment evidence", channels: ["payments"], excerpts: 2 },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("search", search, search.warnings),
		) as unknown as {
			candidates: Array<{ excerpts: string[]; omittedExcerpts?: number }>;
		};
		const candidate = result.candidates[0];
		expect(candidate?.excerpts).toHaveLength(2);
		expect(candidate?.omittedExcerpts).toBeGreaterThan(0);
		store.close();
	});

	test("reconciles a permalink subject with the thread it resolved into", async () => {
		const store = await seededStore();
		const thread = await getMattermostThread(
			{ target: `https://chat.example.test/mg/pl/${REPLY}`, local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("thread", thread, thread.warnings),
		) as unknown as {
			resolved?: unknown;
			threads: Array<{
				posts?: Array<{ messages?: Array<{ id: string; anchor?: true }> }>;
			}>;
		};
		expect(result.resolved).toEqual({
			postId: REPLY,
			from: "permalink",
			threadId: ROOT,
			inPacket: true,
		});
		const anchored = result.threads[0]?.posts
			?.flatMap((group) => group.messages ?? [])
			.filter((message) => message.anchor);
		expect(anchored?.map(({ id }) => id)).toEqual([REPLY]);
		store.close();
	});

	test("surfaces packing completeness hints and related tracker keys", async () => {
		const store = await MattermostStore.open(":memory:");
		const longRoot = ROOT;
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: longRoot,
					message: "TECHSUPP-109 kickoff; also see BTBOLD-238",
					create_at: 10,
				}),
				...Array.from({ length: 10 }, (_, index) =>
					postFixture({
						id: `${String.fromCharCode(98 + index)}${"b".repeat(25)}`,
						root_id: longRoot,
						message: `decision detail ${index + 1} for the rollout`,
						create_at: 20 + index,
					}),
				),
			],
		});
		const context = await getMattermostContext(
			{ subject: "TECHSUPP-109", channels: ["payments"], local: true },
			{
				config: configFixture({
					budgets: {
						...configFixture().budgets,
						defaultPerThreadCharacters: 220,
						defaultMaxCharacters: 220,
						defaultMaxThreads: 1,
					},
				}),
				store,
				now: () => 1_000,
			},
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		expect(result).toMatchObject({
			command: "context",
			subject: "TECHSUPP-109",
			evidence: expect.objectContaining({
				adequacy: "usable",
				completeness: expect.objectContaining({
					selectedThreads: "truncated",
				}),
				packing: expect.objectContaining({
					recommendedHydrationThreadIds: expect.arrayContaining([longRoot]),
					recommendFullThreadIds: expect.arrayContaining([longRoot]),
				}),
				next: expect.arrayContaining([
					expect.objectContaining({
						action: "thread_around",
						threadId: longRoot,
						priority: "recommended",
						impact: "may_recover_omitted_core",
						command: expect.arrayContaining([
							"mm",
							"thread",
							longRoot,
							"--around",
							"--agent",
						]),
					}),
				]),
			}),
			relatedTickets: [
				expect.objectContaining({
					key: "BTBOLD-238",
				}),
			],
		});
		const thread = (
			result as unknown as {
				threads: Array<{
					recommendFull?: boolean;
					largestSkip?: number;
					omittedRatio?: number;
					omitted: { posts: number };
					ticketDensity?: number;
				}>;
			}
		).threads[0];
		expect(thread?.omitted.posts).toBeGreaterThan(0);
		expect(thread?.recommendFull).toBe(true);
		expect(thread?.largestSkip).toBeGreaterThanOrEqual(5);
		expect(thread?.omittedRatio).toBeGreaterThan(0);
		expect(thread?.ticketDensity).toBeGreaterThanOrEqual(0);
		store.close();
	});

	test("indexes attachments hidden inside skip spans and counts them per skip", async () => {
		const store = await MattermostStore.open(":memory:");
		const ids = Array.from(
			{ length: 10 },
			(_, index) => `${String.fromCharCode(98 + index)}${"b".repeat(25)}`,
		);
		const filePostIndexes = [2, 4, 6, 8];
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			files: filePostIndexes.map((index) => ({
				id: `file-${index}`,
				user_id: "user-1",
				post_id: ids[index] as string,
				create_at: 20 + index,
				update_at: 20 + index,
				delete_at: 0,
				name: `screenshot-${index}.png`,
				extension: "png",
				size: 128,
				mime_type: "image/png",
			})),
			posts: [
				postFixture({
					id: ROOT,
					message: "TECHSUPP-109 kickoff",
					create_at: 10,
				}),
				...ids.map((id, index) =>
					postFixture({
						id,
						root_id: ROOT,
						message: `decision detail ${index + 1} for the rollout`,
						create_at: 20 + index,
						...(filePostIndexes.includes(index)
							? { file_ids: [`file-${index}`] }
							: {}),
					}),
				),
			],
		});
		const context = await getMattermostContext(
			{ subject: "TECHSUPP-109", channels: ["payments"], local: true },
			{
				config: configFixture({
					budgets: {
						...configFixture().budgets,
						defaultPerThreadCharacters: 700,
						defaultMaxCharacters: 700,
						defaultMaxThreads: 1,
					},
				}),
				store,
				now: () => 1_000,
			},
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const thread = (
			result as unknown as {
				threads: Array<{
					omitted: { posts: number; unreportedAttachments?: number };
					attachments?: Array<{
						id: string;
						postId: string;
						inPacket: boolean;
						downloadCommand: string[];
					}>;
					posts?: Array<{ skip?: { posts: number; files?: number } }>;
				}>;
			}
		).threads[0];

		// An attachment whose post never made the packet must still be reachable.
		const buried = thread?.attachments?.filter(({ inPacket }) => !inPacket);
		expect(buried?.length).toBeGreaterThan(0);
		expect(buried?.[0]).toMatchObject({
			inPacket: false,
			downloadCommand: expect.arrayContaining(["mm", "file", "--agent"]),
		});
		expect(thread?.attachments?.some(({ inPacket }) => inPacket)).toBe(true);

		// The hole itself states how many attachments it swallowed.
		const skipsWithFiles = (thread?.posts ?? []).filter(
			(item) => (item.skip?.files ?? 0) > 0,
		);
		expect(skipsWithFiles.length).toBeGreaterThan(0);

		// And the index admits when it is itself incomplete.
		expect(thread?.omitted.unreportedAttachments).toBeGreaterThan(0);
		store.close();
	});

	test("inlines decision text so the brief is readable without the timeline", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture(), userFixture({ id: "user-2", username: "bob" })],
			posts: [
				postFixture({ id: ROOT, message: "BTB-2080 импорт", create_at: 10 }),
				postFixture({
					id: REPLY,
					root_id: ROOT,
					user_id: "user-2",
					message: "просто выпилю нафиг эту логику двухсотки",
					create_at: 20,
				}),
				postFixture({
					id: `c${"c".repeat(25)}`,
					root_id: ROOT,
					message: "хорошо",
					create_at: 30,
				}),
			],
		});
		const context = await getMattermostContext(
			{ subject: "BTB-2080", channels: ["payments"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const brief = (
			result as unknown as {
				threads: Array<{
					brief?: {
						decisionPostIds: string[];
						decisions?: Array<{
							id: string;
							author: string;
							at: string;
							text: string;
							ackPostId?: string;
							acknowledgement?: {
								id: string;
								author: string;
								at: string;
								text: string;
							};
						}>;
					};
				}>;
			}
		).threads[0]?.brief;
		expect(brief?.decisionPostIds).toContain(REPLY);
		expect(brief?.decisions?.[0]).toMatchObject({
			id: REPLY,
			author: "bob",
			at: "1970-01-01T00:00:00.020Z",
			// «хорошо» from another author affirms the personal commitment.
			kind: "approved_decision",
			text: "просто выпилю нафиг эту логику двухсотки",
			ackPostId: `c${"c".repeat(25)}`,
			acknowledgement: {
				id: `c${"c".repeat(25)}`,
				author: "alice",
				at: "1970-01-01T00:00:00.030Z",
				text: "хорошо",
			},
		});
		store.close();
	});

	test("marks a decision whose text the packet had to cut", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture(), userFixture({ id: "user-2", username: "bob" })],
			posts: [
				postFixture({ id: ROOT, message: "BTB-2080 импорт", create_at: 10 }),
				postFixture({
					id: REPLY,
					root_id: ROOT,
					user_id: "user-2",
					message: `решили выпилить логику ${"с очень длинным обоснованием ".repeat(30)}`,
					create_at: 20,
				}),
			],
		});
		const context = await getMattermostContext(
			{ subject: "BTB-2080", channels: ["payments"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const decision = (
			result as unknown as {
				threads: Array<{
					brief?: {
						decisions?: Array<{ text: string; textTruncated?: true }>;
					};
				}>;
			}
		).threads[0]?.brief?.decisions?.[0];

		expect(decision?.textTruncated).toBe(true);
		expect(decision?.text.endsWith("…")).toBe(true);
		store.close();
	});

	test("marks an untruncated thread that stops on a question", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({ id: ROOT, message: "BTB-2080 import", create_at: 10 }),
				postFixture({
					id: REPLY,
					root_id: ROOT,
					message: "кинул в тест, а юнит тесты не проходят",
					create_at: 20,
				}),
			],
		});
		const context = await getMattermostContext(
			{ subject: "BTB-2080", channels: ["payments"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const thread = (
			result as unknown as {
				threads: Array<{
					latestAt?: string;
					tail?: { kind: string; postId: string };
					omitted: { posts: number };
				}>;
			}
		).threads[0];
		expect(thread?.omitted.posts).toBe(0);
		expect(thread?.latestAt).toBe("1970-01-01T00:00:00.020Z");
		expect(thread?.tail).toMatchObject({ kind: "error", postId: REPLY });
		store.close();
	});

	test("navigate packs on the default budget, unlike short", async () => {
		const store = await MattermostStore.open(":memory:");
		const posts = Array.from({ length: 40 }, (_, index) =>
			postFixture({
				id: `p${index}`.padEnd(26, "p"),
				...(index === 0 ? {} : { root_id: "p0".padEnd(26, "p") }),
				message: `BTB-2112 decision detail ${index} ${"подробности ".repeat(20)}`,
				create_at: 10 + index,
			}),
		);
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts,
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: posts.at(-1)?.id ?? null,
				newestPostAt: 50,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const pack = async (mode: "default" | "navigate" | "short") =>
			await getMattermostContext(
				{
					subject: "BTB-2112",
					channels: ["payments"],
					local: true,
					...(mode === "navigate" ? { navigate: true } : {}),
					...(mode === "short" ? { short: true } : {}),
				},
				{ config: configFixture(), store, now: () => 1_000 },
			);
		const [base, navigate, short] = await Promise.all([
			pack("default"),
			pack("navigate"),
			pack("short"),
		]);

		// Navigate is a projection choice, not a smaller packet: it must not force
		// a follow-up `thread --full` that costs more than the view saves.
		expect(navigate.threads[0]?.returnedPosts).toBe(
			base.threads[0]?.returnedPosts,
		);
		expect(navigate.threads[0]?.omittedPosts).toBe(
			base.threads[0]?.omittedPosts,
		);
		expect(short.threads[0]?.returnedPosts).toBeLessThan(
			base.threads[0]?.returnedPosts ?? 0,
		);
		store.close();
	});

	test("brief keeps decisions and reports every withheld post", async () => {
		const store = await MattermostStore.open(":memory:");
		const tail = "dddddddddddddddddddddddddd";
		const middle = Array.from({ length: 6 }, (_, index) =>
			postFixture({
				id: `m${index}`.padEnd(26, "m"),
				root_id: ROOT,
				message: `intermediate debugging step ${index}`,
				create_at: 20 + index,
			}),
		);
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: ROOT,
					message: "BTB-2112 роли конфликтуют в координации",
					create_at: 10,
				}),
				...middle,
				postFixture({
					id: REPLY,
					root_id: ROOT,
					message: "BTB-2112 решили: координатор будет выше КС",
					create_at: 40,
				}),
				postFixture({
					id: tail,
					root_id: ROOT,
					message: "хорошо, спасибо",
					create_at: 50,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: tail,
				newestPostAt: 50,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
				brief: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as {
			projection?: string;
			messages?: unknown[];
			threads: Array<{
				messageCount: number;
				surround?: unknown[];
				brief?: { decisionPostIds?: string[] };
				posts?: Array<
					| { skip: { posts: number; reason?: string } }
					| { author: string; messages: Array<{ id: string }> }
				>;
			}>;
		};
		const thread = result.threads[0];
		if (!thread) throw new Error("Expected a thread.");

		expect(result.projection).toBe("brief");
		expect(result.messages).toBeUndefined();
		expect(thread.brief?.decisionPostIds?.length).toBeGreaterThan(0);
		const shown = thread.posts?.flatMap((item) =>
			"skip" in item ? [] : item.messages.map(({ id }) => id),
		);
		const withheld = thread.posts?.reduce(
			(sum, item) =>
				"skip" in item && item.skip.reason === "brief_projection"
					? sum + item.skip.posts
					: sum,
			0,
		);
		// Every packed post is either shown or counted as withheld — a brief
		// packet must not read as a complete transcript.
		expect((shown?.length ?? 0) + (withheld ?? 0)).toBe(thread.messageCount);
		expect(shown?.length).toBeLessThan(thread.messageCount);
		expect(
			thread.posts?.some(
				(item) => "skip" in item && item.skip.reason === "brief_projection",
			),
		).toBe(true);
		store.close();
	});

	test("emits top-level merged brief under --brief with threadId on each entry", async () => {
		const store = await MattermostStore.open(":memory:");
		const ack = "cccccccccccccccccccccccccc";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture(), userFixture({ id: "user-2", username: "bob" })],
			posts: [
				postFixture({
					id: ROOT,
					message: "BTB-2112 роли конфликтуют",
					create_at: 10,
				}),
				postFixture({
					id: REPLY,
					root_id: ROOT,
					user_id: "user-2",
					message: "BTB-2112 решили: координатор будет выше КС",
					create_at: 20,
				}),
				postFixture({
					id: ack,
					root_id: ROOT,
					message: "хорошо",
					create_at: 30,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: ack,
				newestPostAt: 30,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
				brief: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as {
			projection?: string;
			brief?: {
				decisions?: Array<{ id: string; threadId: string; kind: string }>;
				openQuestions?: Array<{ id: string; threadId: string }>;
			};
			researchSummary?: {
				primaryThreadId?: string;
				decisionThreadIds: string[];
				decisionsByKind?: Record<string, number>;
				unresolvedOpenQuestions: number;
				recommendedNext: string[];
			};
			threads: Array<{
				threadId: string;
				role?: string;
				brief?: { decisions?: Array<{ id: string; kind: string }> };
			}>;
		};

		expect(result.projection).toBe("brief");
		expect(result.brief?.decisions?.length).toBeGreaterThan(0);
		expect(result.brief?.decisions?.[0]).toMatchObject({
			id: REPLY,
			threadId: ROOT,
			kind: "approved_decision",
		});
		// Per-thread brief stays for locality.
		expect(result.threads[0]?.brief?.decisions?.[0]?.id).toBe(REPLY);
		expect(result.researchSummary?.primaryThreadId).toBe(ROOT);
		expect(result.researchSummary?.decisionThreadIds).toEqual([ROOT]);
		expect(result.researchSummary?.decisionsByKind?.approved_decision).toBe(1);
		expect(result.researchSummary?.recommendedNext).toEqual([]);
		store.close();
	});

	test("inlines responseExcerpts on possibly_answered open questions", async () => {
		const store = await MattermostStore.open(":memory:");
		const answer = "cccccccccccccccccccccccccc";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture(), userFixture({ id: "user-2", username: "bob" })],
			posts: [
				postFixture({
					id: ROOT,
					message: "BTB-1 давайте решим: capabilities или отдельный роут?",
					create_at: 10,
				}),
				postFixture({
					id: answer,
					root_id: ROOT,
					user_id: "user-2",
					message: "я за отдельный роут",
					create_at: 20,
				}),
				postFixture({
					id: REPLY,
					root_id: ROOT,
					message: "надо будет с Аней обсудить",
					create_at: 30,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: REPLY,
				newestPostAt: 30,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{ subject: "BTB-1", channels: ["payments"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as {
			brief?: unknown;
			researchSummary?: { unresolvedOpenQuestions: number };
			threads: Array<{
				brief?: {
					openQuestions?: Array<{
						id: string;
						resolution?: string;
						responsePostIds?: string[];
						responseExcerpts?: Array<{
							id: string;
							author: string;
							at: string;
							text: string;
						}>;
					}>;
				};
			}>;
		};

		// Top-level brief is brief-projection only.
		expect(result.brief).toBeUndefined();
		const question = result.threads[0]?.brief?.openQuestions?.find(
			({ id }) => id === ROOT,
		);
		expect(question?.resolution).toBe("possibly_answered");
		expect(question?.responsePostIds).toEqual([answer]);
		expect(question?.responseExcerpts).toEqual([
			{
				id: answer,
				author: "bob",
				at: "1970-01-01T00:00:00.020Z",
				text: "я за отдельный роут",
			},
		]);
		expect(
			result.researchSummary?.unresolvedOpenQuestions,
		).toBeGreaterThanOrEqual(0);
		store.close();
	});

	test("researchSummary counts unresolved open questions and recommended next", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: ROOT,
					message: "BTB-2 смотрим отчёт",
					create_at: 10,
				}),
				postFixture({
					id: REPLY,
					root_id: ROOT,
					message: "а по координаторам что делаем?",
					create_at: 20,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: REPLY,
				newestPostAt: 20,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{ subject: "BTB-2", channels: ["payments"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as {
			researchSummary?: {
				primaryThreadId?: string;
				decisionThreadIds: string[];
				unresolvedOpenQuestions: number;
				recommendedNext: string[];
				blockedOrUnresolvedPermalinks?: string[];
			};
			threads: Array<{
				brief?: {
					openQuestions?: Array<{ resolution?: string }>;
				};
			}>;
		};

		expect(result.researchSummary?.primaryThreadId).toBe(ROOT);
		expect(result.researchSummary?.decisionThreadIds).toEqual([]);
		expect(result.researchSummary?.unresolvedOpenQuestions).toBeGreaterThan(0);
		expect(
			result.threads[0]?.brief?.openQuestions?.some(
				({ resolution }) =>
					resolution === "unanswered" || resolution === "unknown",
			),
		).toBe(true);
		expect(result.researchSummary?.recommendedNext).toEqual(expect.any(Array));
		expect(
			result.researchSummary?.blockedOrUnresolvedPermalinks,
		).toBeUndefined();
		store.close();
	});

	test("researchSummary orients to decision thread over noise role=primary", async () => {
		const store = await MattermostStore.open(":memory:");
		const noiseRoot = ROOT;
		const decisionRoot = "cccccccccccccccccccccccccc";
		const decisionPost = "dddddddddddddddddddddddddd";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture(), userFixture({ id: "user-2", username: "bob" })],
			posts: [
				postFixture({
					id: noiseRoot,
					message: "TECHSUPP-109",
					create_at: 10,
				}),
				postFixture({
					id: REPLY,
					root_id: noiseRoot,
					message: "ok",
					create_at: 20,
				}),
				postFixture({
					id: decisionRoot,
					message: "TECHSUPP-109: option A vs B?",
					create_at: 30,
				}),
				postFixture({
					id: decisionPost,
					root_id: decisionRoot,
					user_id: "user-2",
					message: "TECHSUPP-109 итого: решили option B, фиксируем",
					create_at: 40,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: decisionPost,
				newestPostAt: 40,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{
				subject: "TECHSUPP-109",
				channels: ["payments"],
				local: true,
				brief: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const noise = context.threads.find(
			(thread) => thread.threadId === noiseRoot,
		);
		const decision = context.threads.find(
			(thread) => thread.threadId === decisionRoot,
		);
		if (!noise || !decision) {
			store.close();
			throw new Error("Expected both noise and decision threads.");
		}
		// Force the TECHSUPP-109 shape: thin noise stub keeps role=primary while
		// the decision lives on a secondary substantive thread.
		context.threads = [
			{
				...noise,
				reasons: ["ticket_in_root"],
				rootAnchoredFocused: true,
				exclusiveSubjectKey: true,
				ticketDensity: 1,
				totalPosts: 2,
			},
			{
				...decision,
				reasons: ["exact_phrase", "substantive_thread_depth"],
				rootAnchoredFocused: false,
				exclusiveSubjectKey: false,
				ticketDensity: 0.2,
				totalPosts: 95,
			},
		];
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		) as unknown as {
			researchSummary?: {
				primaryThreadId?: string;
				decisionThreadIds: string[];
				decisionsByKind?: Record<string, number>;
			};
			threads: Array<{
				threadId: string;
				role?: string;
				brief?: {
					purposeHints?: Array<{ label: string }>;
					decisions?: Array<{ kind: string }>;
				};
			}>;
		};

		const noiseProjected = result.threads.find(
			(thread) => thread.threadId === noiseRoot,
		);
		const decisionProjected = result.threads.find(
			(thread) => thread.threadId === decisionRoot,
		);
		expect(noiseProjected?.role).toBe("primary");
		expect(decisionProjected?.role).toBe("secondary");
		expect(decisionProjected?.brief?.decisions?.length).toBeGreaterThan(0);
		expect(result.researchSummary?.decisionThreadIds).toEqual([decisionRoot]);
		expect(result.researchSummary?.primaryThreadId).toBe(decisionRoot);
		expect(result.researchSummary?.decisionsByKind).toBeDefined();
		store.close();
	});

	test("collapses one post into a single anchor carrying every kind", async () => {
		const store = await MattermostStore.open(":memory:");
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: ROOT,
					// Root + subject mention + match hit + codeish, all one post.
					message: "BTB-2112 fails in `reconcilePayment`",
					create_at: 10,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: ROOT,
				newestPostAt: 10,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
				navigate: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const anchors = (
			projectAgentResult(
				commandSuccess("context", context, context.warnings),
			) as unknown as {
				threads: Array<{
					anchors?: Array<{ kinds: string[]; postId: string; text?: string }>;
				}>;
			}
		).threads[0]?.anchors;

		expect(anchors?.filter(({ postId }) => postId === ROOT)).toHaveLength(1);
		const anchor = anchors?.find(({ postId }) => postId === ROOT);
		expect(anchor?.kinds).toEqual(
			expect.arrayContaining([
				"root",
				"ticket_mention",
				"match_hit",
				"codeish",
			]),
		);
		expect(anchor?.text).toBe("BTB-2112 fails in `reconcilePayment`");
		store.close();
	});

	test("short keeps card timeline and messages; navigate omits dense posts", async () => {
		const store = await MattermostStore.open(":memory:");
		const root = ROOT;
		const reply = REPLY;
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			files: [
				{
					id: "file-nav",
					user_id: "user-1",
					post_id: reply,
					create_at: 20,
					update_at: 20,
					delete_at: 0,
					name: "stack.log",
					extension: "log",
					size: 12,
					mime_type: "text/plain",
				},
			],
			posts: [
				postFixture({
					id: root,
					message: "BTB-2112 navigate fixture with `reconcilePayment`",
					create_at: 10,
				}),
				postFixture({
					id: reply,
					root_id: root,
					message: "BTB-2112 confirmed; see service: payments",
					file_ids: ["file-nav"],
					create_at: 20,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: reply,
				newestPostAt: 20,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const shortContext = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
				short: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const navigateContext = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
				navigate: true,
				signals: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		expect(shortContext.short).toBe(true);
		expect(shortContext.navigate).toBeUndefined();
		expect(navigateContext.navigate).toBe(true);
		expect(navigateContext.signals).toBe(true);
		expect(navigateContext.short).toBeUndefined();

		const shortResult = projectAgentResult(
			commandSuccess("context", shortContext, shortContext.warnings),
		);
		const navigateResult = projectAgentResult(
			commandSuccess("context", navigateContext, navigateContext.warnings),
		);

		const shortThread = (
			shortResult as unknown as {
				messages?: unknown[];
				threads: Array<{
					posts?: unknown[];
					skips?: unknown[];
					anchors?: unknown[];
					technicalEntities?: Array<{
						kind: string;
						value: string;
						sourcePostIds: string[];
					}>;
				}>;
			}
		).threads[0];
		const navigateThread = (
			navigateResult as unknown as {
				messages?: unknown[];
				threads: Array<{
					posts?: unknown[];
					skips?: unknown[];
					anchors?: Array<{
						kinds: string[];
						files?: Array<{ downloadCommand?: string[] }>;
					}>;
					technicalEntities?: Array<{
						kind: string;
						value: string;
						sourcePostIds: string[];
					}>;
				}>;
			}
		).threads[0];

		expect(shortResult).toMatchObject({
			messages: expect.any(Array),
		});
		expect(shortThread?.posts?.length).toBeGreaterThan(0);
		expect(shortThread?.skips).toBeUndefined();
		expect(shortThread?.anchors?.length).toBeGreaterThan(0);

		expect(
			(navigateResult as { messages?: unknown[] }).messages,
		).toBeUndefined();
		expect(navigateThread?.posts).toBeUndefined();
		expect(navigateThread?.anchors?.length).toBeGreaterThan(0);
		expect(
			navigateThread?.anchors?.some((anchor) =>
				anchor.files?.some(
					(file) =>
						Array.isArray(file.downloadCommand) &&
						file.downloadCommand[0] === "mm" &&
						file.downloadCommand[1] === "file",
				),
			),
		).toBe(true);
		expect(navigateThread?.technicalEntities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "ticket",
					value: "BTB-2112",
					sourcePostIds: expect.arrayContaining([root]),
				}),
				expect.objectContaining({
					kind: "symbol",
					value: "reconcilePayment",
					sourcePostIds: [root],
				}),
				expect.objectContaining({
					kind: "attachment_filename",
					value: "stack.log",
					sourcePostIds: [reply],
				}),
				expect.objectContaining({
					kind: "service",
					value: "payments",
					sourcePostIds: [reply],
				}),
			]),
		);
		store.close();
	});

	test("emits advisory thread signals from packed posts only", async () => {
		const store = await MattermostStore.open(":memory:");
		const root = "cccccccccccccccccccccccccc";
		const reject = "dddddddddddddddddddddddddd";
		const decide = "eeeeeeeeeeeeeeeeeeeeeeeeee";
		const outcome = "ffffffffffffffffffffffffff";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			files: [],
			posts: [
				postFixture({
					id: root,
					message: "TECHSUPP-109: option A vs B?",
					create_at: 10,
				}),
				postFixture({
					id: reject,
					root_id: root,
					message: "Rather than A — rejected; not going with rewrite",
					create_at: 20,
				}),
				postFixture({
					id: decide,
					root_id: root,
					message: "TECHSUPP-109 итого: решили option B, фиксируем",
					create_at: 30,
				}),
				postFixture({
					id: outcome,
					root_id: root,
					message: "QA reproduce after deploy; merged MR",
					create_at: 40,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: outcome,
				newestPostAt: 40,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const context = await getMattermostContext(
			{
				subject: "TECHSUPP-109",
				channels: ["payments"],
				local: true,
				signals: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		expect(context.signals).toBe(true);
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const thread = (
			result as unknown as {
				threads: Array<{
					role?: string;
					signals?: {
						candidateSpans: Array<{
							kind: string;
							postId: string;
							excerpt: string;
							cues: string[];
							confidence: number;
						}>;
						outcomeWindow?: {
							label: string;
							afterPostId: string;
							postIds: string[];
						};
						roleHints: Array<{
							label: string;
							evidencePostIds: string[];
							cues: string[];
						}>;
					};
					brief?: {
						purposeHints: Array<{ label: string }>;
						decisionPostIds: string[];
						outcomeWindow?: { afterPostId: string };
					};
					posts?: Array<{
						messages: Array<{ id: string }>;
					}>;
					omitted: { posts: number };
				}>;
			}
		).threads[0];
		expect(thread?.role).toBe("primary");
		expect(thread?.signals).toBeDefined();
		expect(thread?.brief).toBeDefined();
		expect(thread?.brief?.decisionPostIds.length).toBeGreaterThan(0);
		expect(
			thread?.brief?.purposeHints.some((hint) => hint.label === "decision"),
		).toBe(true);
		const includedIds = new Set(
			(thread?.posts ?? []).flatMap((group) =>
				group.messages.map((message) => message.id),
			),
		);
		for (const span of thread?.signals?.candidateSpans ?? []) {
			expect(span.kind).toContain("candidate");
			expect(includedIds.has(span.postId)).toBe(true);
			expect(span.excerpt.length).toBeGreaterThan(0);
			expect(span.cues.length).toBeGreaterThan(0);
		}
		expect(
			thread?.signals?.candidateSpans.some(
				(span) => span.kind === "decision_candidate",
			),
		).toBe(true);
		expect(thread?.signals?.outcomeWindow?.label).toBe("outcome_window");
		expect(thread?.signals?.outcomeWindow?.afterPostId).toBe(decide);
		expect(thread?.brief?.outcomeWindow?.afterPostId).toBe(decide);
		for (const id of thread?.signals?.outcomeWindow?.postIds ?? []) {
			expect(includedIds.has(id)).toBe(true);
		}
		for (const hint of thread?.signals?.roleHints ?? []) {
			for (const id of hint.evidencePostIds) {
				expect(includedIds.has(id)).toBe(true);
			}
		}
		expect(thread?.omitted.posts).toBe(0);
		store.close();
	});

	test("omits signals and technicalEntities unless context.signals is set", async () => {
		const store = await seededStore();
		const without = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const withSignals = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
				signals: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const defaultThread = (
			projectAgentResult(
				commandSuccess("context", without, without.warnings),
			) as unknown as {
				threads: Array<{
					signals?: unknown;
					technicalEntities?: unknown;
					brief?: unknown;
					filesPresent?: true;
				}>;
			}
		).threads[0];
		const signaledThread = (
			projectAgentResult(
				commandSuccess("context", withSignals, withSignals.warnings),
			) as unknown as {
				threads: Array<{
					signals?: unknown;
					technicalEntities?: Array<{ kind: string; value: string }>;
					brief?: unknown;
					filesPresent?: true;
				}>;
			}
		).threads[0];
		expect(without.signals).toBeUndefined();
		expect(withSignals.signals).toBe(true);
		expect(defaultThread?.signals).toBeUndefined();
		expect(defaultThread?.technicalEntities).toBeUndefined();
		expect(defaultThread?.filesPresent).toBe(true);
		expect(signaledThread?.filesPresent).toBe(true);
		expect(signaledThread?.technicalEntities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "attachment_filename",
					value: "trace.txt",
				}),
			]),
		);
		store.close();
	});

	test("default agent attaches lean brief; --signals keeps brief with full signals", async () => {
		const store = await MattermostStore.open(":memory:");
		const root = "cccccccccccccccccccccccccc";
		const decide = "dddddddddddddddddddddddddd";
		store.writePage({
			conversation: conversationFixture(),
			users: [userFixture()],
			posts: [
				postFixture({
					id: root,
					message: "TECHSUPP-109: option A vs B?",
					create_at: 10,
				}),
				postFixture({
					id: decide,
					root_id: root,
					message: "TECHSUPP-109 итого: решили option B, фиксируем",
					create_at: 20,
				}),
			],
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: decide,
				newestPostAt: 20,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const without = await getMattermostContext(
			{
				subject: "TECHSUPP-109",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const withSignals = await getMattermostContext(
			{
				subject: "TECHSUPP-109",
				channels: ["payments"],
				local: true,
				signals: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const defaultThread = (
			projectAgentResult(
				commandSuccess("context", without, without.warnings),
			) as unknown as {
				threads: Array<{
					signals?: unknown;
					technicalEntities?: unknown;
					brief?: {
						purposeHints: Array<{ label: string }>;
						decisionPostIds: string[];
					};
					filesPresent?: true;
				}>;
			}
		).threads[0];
		const signaledThread = (
			projectAgentResult(
				commandSuccess("context", withSignals, withSignals.warnings),
			) as unknown as {
				threads: Array<{
					signals?: { candidateSpans: unknown[] };
					technicalEntities?: unknown;
					brief?: {
						purposeHints: Array<{ label: string }>;
						decisionPostIds: string[];
					};
				}>;
			}
		).threads[0];

		expect(defaultThread?.signals).toBeUndefined();
		expect(defaultThread?.technicalEntities).toBeUndefined();
		expect(defaultThread?.brief?.decisionPostIds).toEqual(
			expect.arrayContaining([decide]),
		);
		expect(
			defaultThread?.brief?.purposeHints.some(
				(hint) => hint.label === "decision",
			),
		).toBe(true);
		expect(defaultThread?.filesPresent).toBeUndefined();

		expect(signaledThread?.signals?.candidateSpans.length).toBeGreaterThan(0);
		expect(signaledThread?.brief?.decisionPostIds).toEqual(
			defaultThread?.brief?.decisionPostIds,
		);
		store.close();
	});

	test("attaches surround that may relate to the subject", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "payment evidence", channels: ["payments"], local: true },
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const primary = context.threads[0];
		if (!primary) throw new Error("Expected a primary thread.");
		context.subject = { kind: "ticket", ticketKey: "BTB-100", raw: "BTB-100" };
		context.threads = [
			{
				...primary,
				surround: [
					{
						id: "ssssssssssssssssssssssssss",
						rootId: "ssssssssssssssssssssssssss",
						userId: "user-1",
						authorUsername: "alice",
						authorDisplayName: "Alice",
						message: "payment timeout still reproducing",
						createAt: 1,
						updateAt: 1,
						deleteAt: 0,
						attachments: [],
					},
				],
			},
		];
		const thread = (
			projectAgentResult(
				commandSuccess("context", context, context.warnings),
			) as unknown as {
				threads: Array<{ surround?: unknown[]; surroundRelevance?: string }>;
			}
		).threads[0];
		expect(thread?.surround).toHaveLength(1);
		expect(thread?.surroundRelevance).toBe("possible");
		store.close();
	});

	test("labels unrelated surround low and marks alreadyInPacket on related tickets", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const primary = context.threads[0];
		if (!primary) throw new Error("Expected a primary thread.");
		// Force ticket subject so surroundRelevance can score past the missing-subject default.
		context.subject = { kind: "ticket", ticketKey: "BTB-100", raw: "BTB-100" };
		context.threads = [
			{
				...primary,
				surround: [
					{
						id: "ssssssssssssssssssssssssss",
						rootId: "ssssssssssssssssssssssssss",
						userId: "user-1",
						authorUsername: "alice",
						authorDisplayName: "Alice",
						message: "unrelated standup notes about lunch",
						createAt: 1,
						updateAt: 1,
						deleteAt: 0,
						attachments: [],
					},
				],
			},
		];
		context.relatedTickets = [
			{
				key: "BTBOLD-238",
				mentions: 1,
				threadId: ROOT,
				sourceThreadId: ROOT,
				alreadyInPacket: true,
			},
			{
				key: "BTB-9999",
				mentions: 1,
				threadId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
				sourceThreadId: ROOT,
			},
		];
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const thread = (
			result as unknown as {
				threads: Array<{
					surround?: unknown[];
					surroundRelevance?: string;
				}>;
				relatedTickets?: Array<{
					key: string;
					alreadyInPacket?: true;
				}>;
			}
		).threads[0];
		expect(thread?.surround).toHaveLength(1);
		expect(thread?.surroundRelevance).toBe("low");
		const relatedTickets = (
			result as {
				relatedTickets?: Array<{
					key: string;
					alreadyInPacket?: true;
				}>;
			}
		).relatedTickets;
		expect(relatedTickets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "BTBOLD-238",
					alreadyInPacket: true,
				}),
				expect.objectContaining({
					key: "BTB-9999",
				}),
			]),
		);
		const outOfPacket = relatedTickets?.find(
			(ticket) => ticket.key === "BTB-9999",
		);
		expect(outOfPacket?.alreadyInPacket).toBeUndefined();
		store.close();
	});

	test("marks secondary multi_ticket_root threads as presentation announce", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "payment evidence",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 1_000 },
		);
		const primary = context.threads[0];
		if (!primary) throw new Error("Expected a primary thread.");
		const bulletinId = "cccccccccccccccccccccccccc";
		context.threads = [
			{
				...primary,
				reasons: ["ticket_in_root", "substantive_thread_depth"],
			},
			{
				...structuredClone(primary),
				threadId: bulletinId,
				reasons: ["exact_phrase", "multi_ticket_root"],
				totalPosts: 1,
			},
		];
		const result = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		const threads = (
			result as unknown as {
				threads: Array<{
					threadId: string;
					role?: string;
					presentation?: string;
				}>;
			}
		).threads;
		expect(threads).toHaveLength(2);
		const primaryThread = threads.find((thread) => thread.role === "primary");
		const secondary = threads.find((thread) => thread.role === "secondary");
		expect(primaryThread?.presentation).toBeUndefined();
		expect(secondary).toMatchObject({
			threadId: bulletinId,
			role: "secondary",
			presentation: "announce",
		});

		context.threads = [
			{
				...primary,
				reasons: ["exact_phrase", "multi_ticket_root"],
			},
		];
		const solo = projectAgentResult(
			commandSuccess("context", context, context.warnings),
		);
		expect(
			(
				solo as unknown as {
					threads: Array<{ role?: string; presentation?: string }>;
				}
			).threads[0],
		).toMatchObject({
			role: "primary",
		});
		expect(
			(
				solo as unknown as {
					threads: Array<{ presentation?: string }>;
				}
			).threads[0]?.presentation,
		).toBeUndefined();
		store.close();
	});

	test("projects an explicitly requested bounded file inspection", () => {
		const result = projectAgentResult(
			commandSuccess(
				"file",
				{
					id: "file-1",
					name: "trace.txt",
					mimeType: "text/plain",
					size: 4,
					path: "/tmp/mm-file-1-trace.txt",
					postId: REPLY,
					conversationId: "channel-payments",
					inspection: {
						status: "preview" as const,
						format: "text" as const,
						decoded: true as const,
						syntaxValidated: false as const,
						preview: "safe preview",
						bytesExamined: 12,
						lines: 1,
					},
				},
				[{ kind: "soft_note", message: "downloaded from remote metadata" }],
			),
		);
		expect(result).toEqual({
			command: "file",
			schemaVersion: 5,
			success: true,
			id: "file-1",
			name: "trace.txt",
			mimeType: "text/plain",
			size: 4,
			path: "/tmp/mm-file-1-trace.txt",
			postId: REPLY,
			conversationId: "channel-payments",
			inspection: {
				status: "preview",
				format: "text",
				decoded: true,
				syntaxValidated: false,
				preview: "safe preview",
				bytesExamined: 12,
				lines: 1,
			},
			warnings: [
				{ kind: "soft_note", message: "downloaded from remote metadata" },
			],
		});
		expect("data" in result).toBe(false);
		expect(JSON.stringify(result)).not.toContain("secret-bytes");
		expect(JSON.stringify(result)).not.toContain("Downloaded");
	});

	test("projects files batch metadata without content bytes", () => {
		const result = projectAgentResult(
			commandSuccess(
				"files",
				{
					outDir: "/tmp/mm-out",
					selector: { kind: "file_ids", fileIds: ["file-1"] },
					limits: { maxFiles: 20, maxTotalBytes: 52_428_800 },
					downloaded: 1,
					failed: 0,
					skipped: 0,
					totalBytes: 4,
					files: [
						{
							status: "downloaded",
							id: "file-1",
							name: "trace.txt",
							mimeType: "text/plain",
							size: 4,
							path: "/tmp/mm-out/trace.txt",
							postId: REPLY,
							conversationId: "channel-payments",
						},
					],
				},
				[],
			),
		);
		expect(result).toMatchObject({
			command: "files",
			success: true,
			downloaded: 1,
			outDir: "/tmp/mm-out",
			files: [
				{ status: "downloaded", id: "file-1", path: "/tmp/mm-out/trace.txt" },
			],
		});
		expect(JSON.stringify(result)).not.toContain("secret-bytes");
	});

	test("brief shrinks historical secondaries and labels relatedTicketKey", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture();
		const relatedRoot = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
		const focusedRoot = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
		const relatedPosts = [
			postFixture({
				id: relatedRoot,
				message: "BTB-701 historical payment outage war room",
				create_at: 10,
			}),
			...Array.from({ length: 40 }, (_, index) =>
				postFixture({
					id: `r${String(index).padStart(25, "0")}`,
					root_id: relatedRoot,
					message:
						index === 20
							? "Side note: BTB-1281 might be related later"
							: `BTB-701 retry path detail ${index} ${"подробности ".repeat(8)}`,
					create_at: 20 + index,
				}),
			),
		];
		store.writePage({
			conversation: payments,
			users: [userFixture()],
			posts: [
				...relatedPosts,
				postFixture({
					id: focusedRoot,
					message: "BTB-1281 payment timeout in reconcile",
					create_at: 200,
				}),
				postFixture({
					id: "cccccccccccccccccccccccccc",
					root_id: focusedRoot,
					message: "BTB-1281 reproduced; shipping the retry patch",
					create_at: 210,
				}),
				postFixture({
					id: "dddddddddddddddddddddddddd",
					root_id: focusedRoot,
					message: "BTB-1281 approved, merging next",
					create_at: 220,
				}),
			],
			checkpoint: {
				conversationId: payments.id,
				newestPostId: "dddddddddddddddddddddddddd",
				newestPostAt: 220,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const config = configFixture({
			budgets: {
				...configFixture().budgets,
				defaultMaxCharacters: 16_000,
				defaultPerThreadCharacters: 6_000,
			},
		});
		const dense = await getMattermostContext(
			{
				subject: "BTB-1281",
				channels: ["payments"],
				local: true,
			},
			{ config, store, now: () => 1_000 },
		);
		const brief = await getMattermostContext(
			{
				subject: "BTB-1281",
				channels: ["payments"],
				local: true,
				brief: true,
			},
			{ config, store, now: () => 1_000 },
		);
		expect(brief.threads.length).toBeGreaterThanOrEqual(2);
		expect(dense.threads.length).toBeGreaterThanOrEqual(2);
		const briefSecondary = brief.threads.find(
			(thread) => thread.threadId === relatedRoot,
		);
		const denseSecondary = dense.threads.find(
			(thread) => thread.threadId === relatedRoot,
		);
		expect(briefSecondary).toMatchObject({
			historicalNeighbor: true,
			relatedTicketKey: "BTB-701",
		});
		expect(briefSecondary?.returnedPosts).toBeLessThan(
			denseSecondary?.returnedPosts ?? Number.POSITIVE_INFINITY,
		);
		const projected = projectAgentResult(
			commandSuccess("context", brief, brief.warnings),
		) as unknown as {
			threads: Array<{
				threadId: string;
				historicalNeighbor?: true;
				relatedTicketKey?: string;
				role?: string;
			}>;
		};
		expect(
			projected.threads.find((thread) => thread.threadId === relatedRoot),
		).toMatchObject({
			historicalNeighbor: true,
			relatedTicketKey: "BTB-701",
			role: "secondary",
		});
		store.close();
	});

	test("navigate keeps multiple selected threads as stubs", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture();
		const firstRoot = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
		const secondRoot = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
		store.writePage({
			conversation: payments,
			users: [userFixture()],
			posts: [
				postFixture({
					id: firstRoot,
					message: "BTB-2112 first thread root with enough substance tokens",
					create_at: 10,
				}),
				...Array.from({ length: 30 }, (_, index) =>
					postFixture({
						id: `f${String(index).padStart(25, "0")}`,
						root_id: firstRoot,
						message: `BTB-2112 first thread detail ${index} ${"x".repeat(80)}`,
						create_at: 20 + index,
					}),
				),
				postFixture({
					id: secondRoot,
					message: "BTB-2112 second thread root",
					create_at: 200,
				}),
				postFixture({
					id: "cccccccccccccccccccccccccc",
					root_id: secondRoot,
					message: "BTB-2112 second thread decision: ship it",
					create_at: 210,
				}),
			],
			checkpoint: {
				conversationId: payments.id,
				newestPostId: "cccccccccccccccccccccccccc",
				newestPostAt: 210,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		const config = configFixture({
			budgets: {
				...configFixture().budgets,
				defaultMaxCharacters: 3_000,
				defaultPerThreadCharacters: 3_000,
				defaultMaxThreads: 3,
			},
		});
		const base = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
			},
			{ config, store, now: () => 1_000 },
		);
		const navigate = await getMattermostContext(
			{
				subject: "BTB-2112",
				channels: ["payments"],
				local: true,
				navigate: true,
			},
			{ config, store, now: () => 1_000 },
		);
		expect(base.threads.length).toBeGreaterThanOrEqual(2);
		expect(navigate.threads.length).toBe(base.threads.length);
		expect(
			navigate.warnings.some(
				({ kind }) => kind === "navigate_truncated_threads",
			),
		).toBe(false);
		const projected = projectAgentResult(
			commandSuccess("context", navigate, navigate.warnings),
		) as unknown as {
			threads: Array<{ posts?: unknown; anchors?: unknown[] }>;
		};
		expect(projected.threads).toHaveLength(navigate.threads.length);
		for (const thread of projected.threads) {
			expect(thread.posts).toBeUndefined();
			expect(thread.anchors?.length).toBeGreaterThan(0);
		}
		store.close();
	});
});

async function seededStore(
	options: { stale?: boolean; complete?: boolean } = {},
): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture(),
		users: [userFixture()],
		files: [
			{
				id: "file-1",
				user_id: "user-1",
				post_id: REPLY,
				create_at: 20,
				update_at: 20,
				delete_at: 0,
				name: "trace.txt",
				extension: "txt",
				size: 42,
				mime_type: "text/plain",
			},
		],
		posts: [
			postFixture({
				id: ROOT,
				message: "synthetic payment evidence",
				create_at: 10,
				update_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				message: "payment evidence confirmed",
				file_ids: ["file-1"],
				create_at: 20,
				update_at: 20,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: REPLY,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: options.stale ? 1_000_000 : 1_000,
			coverageComplete: options.complete ?? true,
		},
	});
	return store;
}
