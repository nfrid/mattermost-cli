import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { MattermostConfig } from "./config.ts";
import { getMattermostContext, searchMattermost } from "./context.ts";
import type { MattermostPost } from "./mattermost/schemas.ts";
import { MattermostStore } from "./storage.ts";

const conversationSchema = z.object({
	id: z.string().min(1),
	alias: z.string().min(1),
	kind: z.enum(["channel", "direct_message"]),
	name: z.string().min(1),
	description: z.string(),
	priority: z.number().int().default(0),
	repositories: z.array(z.string()).default([]),
	scopes: z.array(z.string()).default([]),
});

const postSchema = z.object({
	id: z.string().min(1),
	rootId: z.string().default(""),
	conversationId: z.string().min(1),
	userId: z.string().default("benchmark-user"),
	createAt: z.number().int().nonnegative(),
	message: z.string(),
});

const expectedThreadSchema = z.object({
	threadId: z.string().min(1),
	grade: z.number().int().positive().optional(),
});

const caseSchema = z
	.object({
		id: z.string().min(1),
		queryClass: z.string().min(1),
		subject: z.string().optional(),
		ticket: z.string().optional(),
		queries: z.array(z.string()).default([]),
		repositories: z.array(z.string()).default([]),
		scopes: z.array(z.string()).default([]),
		channels: z.array(z.string()).default([]),
		expectedThreads: z.array(expectedThreadSchema).min(1),
		notes: z.string().min(1),
	})
	.refine((value) => value.subject || value.ticket || value.queries.length, {
		message: "A benchmark case requires a subject, ticket, or query.",
	});

export const retrievalBenchmarkFixtureSchema = z
	.object({
		schemaVersion: z.literal(1),
		name: z.string().min(1),
		synonyms: z
			.record(z.string().min(2), z.array(z.string().min(2)).max(8))
			.default({}),
		concepts: z
			.record(
				z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
				z.array(z.string().min(2).max(120)).min(2).max(8),
			)
			.default({}),
		conversations: z.array(conversationSchema).min(1),
		posts: z.array(postSchema).min(1),
		ticketRelationships: z
			.array(
				z.object({
					ticketKey: z.string().min(1),
					threadId: z.string().min(1),
					sourcePostId: z.string().min(1),
					origin: z.enum(["discovered", "explicit"]),
				}),
			)
			.default([]),
		cases: z.array(caseSchema).min(1),
	})
	.superRefine((fixture, context) => {
		checkUnique(
			fixture.conversations.map(({ id }) => id),
			"conversation ID",
			context,
		);
		checkUnique(
			fixture.conversations.map(({ alias }) => alias),
			"conversation alias",
			context,
		);
		checkUnique(
			fixture.posts.map(({ id }) => id),
			"post ID",
			context,
		);
		checkUnique(
			fixture.cases.map(({ id }) => id),
			"case ID",
			context,
		);
		const conversationIds = new Set(fixture.conversations.map(({ id }) => id));
		const postIds = new Set(fixture.posts.map(({ id }) => id));
		const rootIds = new Set(
			fixture.posts.filter(({ rootId }) => !rootId).map(({ id }) => id),
		);
		for (const post of fixture.posts) {
			if (!conversationIds.has(post.conversationId)) {
				context.addIssue({
					code: "custom",
					message: `Post ${post.id} references an unknown conversation.`,
				});
			}
			if (post.rootId && !rootIds.has(post.rootId)) {
				context.addIssue({
					code: "custom",
					message: `Post ${post.id} references an unknown root.`,
				});
			}
		}
		for (const benchmarkCase of fixture.cases) {
			for (const expected of benchmarkCase.expectedThreads) {
				if (!rootIds.has(expected.threadId)) {
					context.addIssue({
						code: "custom",
						message: `Case ${benchmarkCase.id} expects an unknown thread.`,
					});
				}
			}
		}
		for (const relationship of fixture.ticketRelationships) {
			if (
				!rootIds.has(relationship.threadId) ||
				!postIds.has(relationship.sourcePostId)
			) {
				context.addIssue({
					code: "custom",
					message: `Ticket relationship ${relationship.ticketKey} references unknown evidence.`,
				});
			}
		}
	});

export type RetrievalBenchmarkFixture = z.infer<
	typeof retrievalBenchmarkFixtureSchema
>;
export type RetrievalBenchmarkCase = RetrievalBenchmarkFixture["cases"][number];

export interface RetrievalBenchmarkCaseResult {
	id: string;
	queryClass: string;
	query: string;
	expectedThreadIds: string[];
	rankedThreadIds: string[];
	rankingReasons: Record<string, string[]>;
	recallAt5: number;
	recallAt10: number;
	reciprocalRank: number;
	ndcgAt5: number;
	ndcgAt10: number;
	irrelevantThreadsInTop5: number;
	irrelevantThreadsHydrated: number;
	contextBudgetBeforeFirstRelevant: number;
	meanQueryDurationMs: number;
	retrievalRequestsPerProbe: number;
	stable: boolean;
}

export interface RetrievalBenchmarkReport {
	schemaVersion: 1;
	fixture: string;
	runs: number;
	cases: RetrievalBenchmarkCaseResult[];
	summary: {
		caseCount: number;
		meanRecallAt5: number;
		meanRecallAt10: number;
		meanReciprocalRank: number;
		meanNdcgAt5: number;
		meanNdcgAt10: number;
		irrelevantThreadsInTop5: number;
		irrelevantThreadsHydrated: number;
		meanContextBudgetBeforeFirstRelevant: number;
		meanQueryDurationMs: number;
		meanRetrievalRequestsPerProbe: number;
		indexSizeBytes: number;
		stable: boolean;
	};
}

export async function loadRetrievalBenchmarkFixture(
	path: string,
): Promise<RetrievalBenchmarkFixture> {
	return retrievalBenchmarkFixtureSchema.parse(
		JSON.parse(await readFile(path, "utf8")),
	);
}

export async function runRetrievalBenchmark(
	fixture: RetrievalBenchmarkFixture,
	options: {
		runs?: number;
	} = {},
): Promise<RetrievalBenchmarkReport> {
	const parsed = retrievalBenchmarkFixtureSchema.parse(fixture);
	const runs = options.runs ?? 3;
	if (!Number.isInteger(runs) || runs < 1) {
		throw new Error("Benchmark runs must be a positive integer.");
	}
	const store = await MattermostStore.open(":memory:", {
		concepts: parsed.concepts,
	});
	try {
		seedFixture(store, parsed);
		const config = fixtureConfig(parsed);
		const cases: RetrievalBenchmarkCaseResult[] = [];
		for (const benchmarkCase of parsed.cases) {
			const input = caseInput(benchmarkCase);
			const rankings: string[][] = [];
			const durations: number[] = [];
			const requestCounts: number[] = [];
			let rankingReasons: Record<string, string[]> = {};
			for (let run = 0; run < runs; run += 1) {
				let requestCount = 0;
				const originalSearch = store.search.bind(store);
				store.search = ((...args: Parameters<typeof store.search>) => {
					requestCount += 1;
					return originalSearch(...args);
				}) as typeof store.search;
				const startedAt = performance.now();
				const result = await searchMattermost(input, {
					config,
					store,
					now: () => 1,
				});
				durations.push(performance.now() - startedAt);
				requestCounts.push(requestCount);
				store.search = originalSearch;
				rankings.push(result.candidates.map(({ threadId }) => threadId));
				if (run === 0) {
					rankingReasons = Object.fromEntries(
						result.candidates.map(({ threadId, reasons }) => [
							threadId,
							reasons,
						]),
					);
				}
			}
			const rankedThreadIds = rankings[0] ?? [];
			const relevant = new Set(
				benchmarkCase.expectedThreads.map(({ threadId }) => threadId),
			);
			const relevanceGrades = new Map(
				benchmarkCase.expectedThreads.map(({ threadId, grade }) => [
					threadId,
					grade ?? 1,
				]),
			);
			const context = await getMattermostContext(
				{ ...input, local: true, noWiden: true },
				{
					config,
					store,
					now: () => 1,
				},
			);
			const firstRelevantContextIndex = context.threads.findIndex(
				({ threadId }) => relevant.has(threadId),
			);
			const threadsBeforeRelevant =
				firstRelevantContextIndex < 0
					? context.threads
					: context.threads.slice(0, firstRelevantContextIndex);
			cases.push({
				id: benchmarkCase.id,
				queryClass: benchmarkCase.queryClass,
				query: describeCaseQuery(benchmarkCase),
				expectedThreadIds: [...relevant],
				rankedThreadIds,
				rankingReasons,
				recallAt5: recallAt(rankedThreadIds, relevant, 5),
				recallAt10: recallAt(rankedThreadIds, relevant, 10),
				reciprocalRank: reciprocalRank(rankedThreadIds, relevant),
				ndcgAt5: normalizedDiscountedCumulativeGain(
					rankedThreadIds,
					relevanceGrades,
					5,
				),
				ndcgAt10: normalizedDiscountedCumulativeGain(
					rankedThreadIds,
					relevanceGrades,
					10,
				),
				irrelevantThreadsInTop5: rankedThreadIds
					.slice(0, 5)
					.filter((threadId) => !relevant.has(threadId)).length,
				irrelevantThreadsHydrated: context.threads.filter(
					({ threadId }) => !relevant.has(threadId),
				).length,
				contextBudgetBeforeFirstRelevant: threadsBeforeRelevant.reduce(
					(total, thread) => total + thread.budget.used,
					0,
				),
				meanQueryDurationMs: roundMetric(mean(durations)),
				retrievalRequestsPerProbe: roundMetric(
					mean(requestCounts) / Math.max(1, resolveProbeCount(benchmarkCase)),
				),
				stable: rankings.every((ranking) =>
					arraysEqual(ranking, rankedThreadIds),
				),
			});
		}
		return {
			schemaVersion: 1,
			fixture: parsed.name,
			runs,
			cases,
			summary: {
				caseCount: cases.length,
				meanRecallAt5: mean(cases.map(({ recallAt5 }) => recallAt5)),
				meanRecallAt10: mean(cases.map(({ recallAt10 }) => recallAt10)),
				meanReciprocalRank: mean(
					cases.map(({ reciprocalRank: value }) => value),
				),
				meanNdcgAt5: mean(cases.map(({ ndcgAt5 }) => ndcgAt5)),
				meanNdcgAt10: mean(cases.map(({ ndcgAt10 }) => ndcgAt10)),
				irrelevantThreadsInTop5: cases.reduce(
					(total, result) => total + result.irrelevantThreadsInTop5,
					0,
				),
				irrelevantThreadsHydrated: cases.reduce(
					(total, result) => total + result.irrelevantThreadsHydrated,
					0,
				),
				meanContextBudgetBeforeFirstRelevant: mean(
					cases.map(
						({ contextBudgetBeforeFirstRelevant }) =>
							contextBudgetBeforeFirstRelevant,
					),
				),
				meanQueryDurationMs: roundMetric(
					mean(cases.map(({ meanQueryDurationMs }) => meanQueryDurationMs)),
				),
				meanRetrievalRequestsPerProbe: roundMetric(
					mean(
						cases.map(
							({ retrievalRequestsPerProbe }) => retrievalRequestsPerProbe,
						),
					),
				),
				indexSizeBytes: sqliteIndexSize(store),
				stable: cases.every(({ stable }) => stable),
			},
		};
	} finally {
		store.close();
	}
}

function seedFixture(
	store: MattermostStore,
	fixture: RetrievalBenchmarkFixture,
): void {
	for (const conversation of fixture.conversations) {
		const posts = fixture.posts
			.filter(({ conversationId }) => conversationId === conversation.id)
			.map(
				(post): MattermostPost => ({
					id: post.id,
					root_id: post.rootId,
					channel_id: post.conversationId,
					user_id: post.userId,
					create_at: post.createAt,
					update_at: post.createAt,
					delete_at: 0,
					message: post.message,
					type: "",
					props: {},
					file_ids: [],
				}),
			);
		store.writePage({
			conversation: {
				id: conversation.id,
				alias: conversation.alias,
				kind: conversation.kind,
				name: conversation.name,
				description: conversation.description,
			},
			posts,
			checkpoint: {
				conversationId: conversation.id,
				newestPostId: posts.at(-1)?.id ?? null,
				newestPostAt: posts.at(-1)?.create_at ?? null,
				oldestCoveredAt: 0,
				lastSuccessAt: 1,
				coverageComplete: true,
			},
		});
	}
	for (const relationship of fixture.ticketRelationships) {
		store.linkTicketThread(
			relationship.ticketKey,
			relationship.threadId,
			relationship.sourcePostId,
			relationship.origin,
		);
	}
}

function fixtureConfig(fixture: RetrievalBenchmarkFixture): MattermostConfig {
	return {
		schemaVersion: 1,
		url: "https://benchmark.invalid",
		teamId: "benchmark-team",
		token: "benchmark-placeholder",
		databasePath: ":memory:",
		configPath: "<benchmark>",
		projectRoot: ".",
		freshnessSeconds: 300,
		reconciliationOverlapMs: 30_000,
		historyDays: 3650,
		pageSize: 100,
		synonyms: fixture.synonyms,
		concepts: fixture.concepts,
		budgets: {
			defaultMaxCharacters: 2_000,
			defaultPerThreadCharacters: 600,
			defaultMaxThreads: 5,
			moreMaxCharacters: 4_000,
			morePerThreadCharacters: 1_200,
			moreMaxThreads: 10,
		},
		channels: Object.fromEntries(
			fixture.conversations
				.filter(({ kind }) => kind === "channel")
				.map((conversation) => [
					conversation.alias,
					{
						id: conversation.id,
						name: conversation.name,
						description: conversation.description,
						tags: [],
						repositories: conversation.repositories,
						scopes: conversation.scopes,
						priority: conversation.priority,
					},
				]),
		),
		directMessages: Object.fromEntries(
			fixture.conversations
				.filter(({ kind }) => kind === "direct_message")
				.map((conversation) => [
					conversation.alias,
					{
						channelId: conversation.id,
						description: conversation.description,
						participants: [],
						tags: [],
						repositories: conversation.repositories,
						scopes: conversation.scopes,
						priority: conversation.priority,
					},
				]),
		),
	};
}

function describeCaseQuery(benchmarkCase: RetrievalBenchmarkCase): string {
	return [
		benchmarkCase.ticket ?? benchmarkCase.subject,
		...benchmarkCase.queries,
	]
		.filter((value): value is string => Boolean(value))
		.join(" | ");
}

function resolveProbeCount(benchmarkCase: RetrievalBenchmarkCase): number {
	return (
		(benchmarkCase.ticket || benchmarkCase.subject ? 1 : 0) +
		benchmarkCase.queries.length
	);
}

function sqliteIndexSize(store: MattermostStore): number {
	const pageCount = store.database
		.query<{ page_count: number }, []>("PRAGMA page_count")
		.get()?.page_count;
	const pageSize = store.database
		.query<{ page_size: number }, []>("PRAGMA page_size")
		.get()?.page_size;
	return (pageCount ?? 0) * (pageSize ?? 0);
}

function roundMetric(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function caseInput(benchmarkCase: RetrievalBenchmarkCase) {
	return {
		subject: benchmarkCase.subject,
		ticket: benchmarkCase.ticket,
		queries: benchmarkCase.queries,
		repositories: benchmarkCase.repositories,
		scopes: benchmarkCase.scopes,
		channels: benchmarkCase.channels,
		noWiden: true,
	};
}

function recallAt(
	rankedThreadIds: readonly string[],
	relevant: ReadonlySet<string>,
	limit: number,
): number {
	const found = new Set(
		rankedThreadIds
			.slice(0, limit)
			.filter((threadId) => relevant.has(threadId)),
	);
	return found.size / relevant.size;
}

function reciprocalRank(
	rankedThreadIds: readonly string[],
	relevant: ReadonlySet<string>,
): number {
	const index = rankedThreadIds.findIndex((threadId) => relevant.has(threadId));
	return index < 0 ? 0 : 1 / (index + 1);
}

export function normalizedDiscountedCumulativeGain(
	rankedThreadIds: readonly string[],
	relevanceGrades: ReadonlyMap<string, number>,
	limit: number,
): number {
	const gains = rankedThreadIds
		.slice(0, limit)
		.map((threadId) => relevanceGrades.get(threadId) ?? 0);
	const idealGains = [...relevanceGrades.values()]
		.sort((left, right) => right - left)
		.slice(0, limit);
	const ideal = discountedCumulativeGain(idealGains);
	return ideal ? discountedCumulativeGain(gains) / ideal : 0;
}

function discountedCumulativeGain(grades: readonly number[]): number {
	return grades.reduce(
		(total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2),
		0,
	);
}

function arraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function checkUnique(
	values: readonly string[],
	label: string,
	context: { addIssue(issue: { code: "custom"; message: string }): void },
): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			context.addIssue({
				code: "custom",
				message: `Duplicate ${label}: ${value}.`,
			});
		}
		seen.add(value);
	}
}

function mean(values: readonly number[]): number {
	return values.length
		? values.reduce((total, value) => total + value, 0) / values.length
		: 0;
}
