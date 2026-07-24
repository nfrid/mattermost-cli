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

		expect(result).toEqual({
			command: "context",
			schemaVersion: 2,
			success: true,
			subject: "payment evidence",
			status: {
				freshness: "local",
			},
			evidence: expect.objectContaining({
				adequacy: "usable",
				currency: "local_only",
				completeness: {
					selectedThreads: "complete",
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
					role: "primary",
					filesPresent: true,
					omitted: { posts: 0, attachments: 0 },
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
											downloadCommand: ["mm", "file", "file-1"],
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
			thread: {
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
			threads: [
				expect.objectContaining({
					threadId: ROOT,
					conversation: "payments",
				}),
			],
		});
		expect(
			(result as { threads?: unknown[]; thread?: unknown }).threads?.[0],
		).toEqual((result as { thread?: unknown }).thread);
		expect(JSON.stringify(result)).not.toMatch(
			/"updateAt"|"deleteAt"|"from"|"to"|displayName|"why"/,
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
					threadId: ROOT,
					conversation: "payments",
					kind: "channel",
					url: `https://chat.example.test/_redirect/pl/${ROOT}`,
					latestAt: "1970-01-01T00:00:00.020Z",
					excerpts: [
						"synthetic payment evidence",
						"payment evidence confirmed",
					],
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/rootPostId|conversationId|priority|scoreVector|postId|probes|evidenceIssues|"complete"|rank_fusion|routing_|"why"/,
		);
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
					recommendFullThreadIds: expect.arrayContaining([longRoot]),
				}),
				next: expect.arrayContaining([
					expect.objectContaining({
						action: "thread_full",
						threadId: longRoot,
						priority: "recommended",
						impact: "may_recover_omitted_core",
						command: ["mm", "thread", longRoot, "--full", "--agent"],
					}),
				]),
			}),
			relatedTickets: [
				expect.objectContaining({
					key: "BTBOLD-238",
					hydrated: false,
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
						kind: string;
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

	test("projects surroundRelevance beside surround and alreadyInPacket on related tickets", async () => {
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
				hydrated: false,
			},
			{
				key: "BTB-9999",
				mentions: 1,
				threadId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
				sourceThreadId: ROOT,
				hydrated: false,
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
					hydrated: false;
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
					hydrated: false;
				}>;
			}
		).relatedTickets;
		expect(relatedTickets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "BTBOLD-238",
					alreadyInPacket: true,
					hydrated: false,
				}),
				expect.objectContaining({
					key: "BTB-9999",
					hydrated: false,
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

	test("projects file download metadata without content bytes", () => {
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
				},
				[{ kind: "soft_note", message: "downloaded from remote metadata" }],
			),
		);
		expect(result).toEqual({
			command: "file",
			schemaVersion: 2,
			success: true,
			id: "file-1",
			name: "trace.txt",
			mimeType: "text/plain",
			size: 4,
			path: "/tmp/mm-file-1-trace.txt",
			postId: REPLY,
			conversationId: "channel-payments",
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
