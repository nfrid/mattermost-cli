import { describe, expect, test } from "bun:test";
import { MattermostApiError } from "../mattermost/client.ts";
import { formatHumanResult } from "../output/format.ts";
import { commandSuccess } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { getMattermostContext, searchMattermost } from "./index.ts";
import {
	FakeContextClient,
	list,
	PLATFORM_ROOT,
	REPLY,
	ROOT,
	SearchContextClient,
	seededStore,
	throwingClient,
} from "./test-helpers.ts";

describe("context pipeline", () => {
	test("local mode performs zero network calls and reports stale incomplete evidence", async () => {
		const store = await seededStore();
		const client = throwingClient();
		const result = await getMattermostContext(
			{
				subject: "payment timeout",
				channels: ["payments"],
				repositories: ["unknown-service"],
				local: true,
			},
			{ config: configFixture(), store, client, now: () => 1_000_000 },
		);

		expect(result.threads).toHaveLength(1);
		expect(result.threads[0]).toMatchObject({
			threadId: ROOT,
			conversationAlias: "payments",
			matchingPostIds: [ROOT, REPLY],
		});
		expect(result.searchedConversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		expect(result.complete).toBe(false);
		expect(result.searchCoverageComplete).toBe(false);
		expect(result.selectedThreadsComplete).toBe(true);
		expect(result.unmatchedHints.repositories).toEqual(["unknown-service"]);
		expect(result.warnings.map(({ kind }) => kind)).toEqual(
			expect.arrayContaining([
				"stale_local_index",
				"incomplete_history",
				"unmapped_routing_hint",
			]),
		);
		store.close();
	});

	test("preserves typed agent probe origins through candidate matches", async () => {
		const store = await seededStore({ fresh: true });
		const result = await searchMattermost(
			{
				probes: [
					{ kind: "ticket_title", value: "payment timeout" },
					{ kind: "ticket_description", value: "follow-up evidence" },
				],
				channels: ["payments"],
			},
			{ config: configFixture(), store, now: () => 100 },
		);

		expect(result.subject).toMatchObject({
			kind: "text",
			text: "payment timeout",
		});
		expect(result.probes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "ticket_title",
					value: "payment timeout",
				}),
				expect.objectContaining({
					kind: "ticket_description",
					value: "follow-up evidence",
				}),
			]),
		);
		expect(result.candidates[0]?.matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					probe: "payment timeout",
					probeKind: "ticket_title",
				}),
				expect.objectContaining({
					probe: "follow-up evidence",
					probeKind: "ticket_description",
				}),
			]),
		);
		store.close();
	});

	test("limits ranked search candidates to the requested top-N", async () => {
		const store = await seededStore({ fresh: true });
		for (let index = 0; index < 12; index += 1) {
			const rootId = `root${String(index).padStart(22, "0")}`;
			store.writePage({
				conversation: conversationFixture("payments", "channel-payments"),
				posts: [
					postFixture({
						id: rootId,
						channel_id: "channel-payments",
						message: `payment timeout variant ${index}`,
						create_at: 100 + index,
					}),
				],
			});
		}
		const limited = await searchMattermost(
			{ subject: "payment timeout", channels: ["payments"], limit: 3 },
			{ config: configFixture(), store, now: () => 100 },
		);
		expect(limited.candidates).toHaveLength(3);
		const defaults = await searchMattermost(
			{ subject: "payment timeout", channels: ["payments"] },
			{ config: configFixture(), store, now: () => 100 },
		);
		expect(defaults.candidates.length).toBeLessThanOrEqual(10);
		expect(defaults.candidates.length).toBeGreaterThanOrEqual(3);
		store.close();
	});

	test("reports unmapped hints and probes that are ranking signals without text matches", async () => {
		const store = await seededStore({ fresh: true });
		store.linkTicketThread("PROJ-2113", ROOT, ROOT, "explicit");
		const result = await searchMattermost(
			{
				subject: "PROJ-2113",
				queries: ["nonexistent.operation"],
				repositories: ["payment", "unknown-service"],
			},
			{ config: configFixture(), store, now: () => 100 },
		);

		expect(result.probes.map(({ value }) => value)).toEqual([
			"PROJ-2113",
			"nonexistent.operation",
		]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			threadId: ROOT,
			link: `https://chat.example.test/_redirect/pl/${ROOT}`,
			matches: [],
		});
		expect(result.routing.unmatchedHints.repositories).toEqual([
			"unknown-service",
		]);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "unmapped_routing_hint" }),
				expect.objectContaining({ kind: "unmatched_retrieval_probe" }),
			]),
		);

		const empty = await searchMattermost(
			{
				subject: "missing subject",
				queries: ["missing additional probe"],
				channels: ["payments"],
				noWiden: true,
			},
			{ config: configFixture(), store, now: () => 100 },
		);
		expect(empty.candidates).toHaveLength(0);
		expect(empty.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "unmatched_retrieval_probe" }),
			]),
		);
		store.close();
	});

	test("applies author, date, and attachment filters and reports them", async () => {
		const store = await seededStore({ fresh: true });
		const filteredRoot = "eeeeeeeeeeeeeeeeeeeeeeeeee";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture({ id: "user-2", username: "bob" })],
			files: [
				{
					id: "filter-file",
					user_id: "user-2",
					post_id: filteredRoot,
					create_at: 40,
					update_at: 40,
					delete_at: 0,
					name: "incident-trace.json",
					extension: "json",
					size: 42,
					mime_type: "application/json",
				},
			],
			posts: [
				postFixture({
					id: filteredRoot,
					user_id: "user-2",
					channel_id: "channel-payments",
					message: "payment timeout — приложил логи",
					file_ids: ["filter-file"],
					create_at: 40,
					update_at: 40,
				}),
			],
		});
		const input = {
			subject: "payment timeout",
			channels: ["payments"],
			from: "@bob",
			after: "1970-01-01T00:00:00.030Z",
			before: "1970-01-01T00:00:00.050Z",
			hasFile: true,
			file: "TRACE",
		} as const;
		const search = await searchMattermost(input, {
			config: configFixture(),
			store,
			now: () => 100,
		});
		expect(search.candidates.map(({ threadId }) => threadId)).toEqual([
			filteredRoot,
		]);
		expect(search.filters).toEqual({
			from: "bob",
			after: "1970-01-01T00:00:00.030Z",
			before: "1970-01-01T00:00:00.050Z",
			hasFile: true,
			file: "TRACE",
		});
		const structured = await getMattermostContext(
			{
				subject: "incident-trace.json",
				channels: ["payments"],
				from: "bob",
				file: "trace.json",
				local: true,
			},
			{ config: configFixture(), store, now: () => 100 },
		);
		expect(structured.threads[0]).toMatchObject({
			threadId: filteredRoot,
			matchingPostIds: [filteredRoot],
			reasons: expect.arrayContaining(["structured_entity_match"]),
		});
		const empty = await searchMattermost(
			{ ...input, file: "missing.csv" },
			{ config: configFixture(), store, now: () => 100 },
		);
		expect(empty.candidates).toEqual([]);
		await expect(
			searchMattermost(
				{ subject: "payment", after: "not-a-date" },
				{ config: configFixture(), store },
			),
		).rejects.toMatchObject({ kind: "invalid_search_filter" });
		for (const after of ["2026-01-01T12:00:00", "2026-01-01 12:00:00"]) {
			await expect(
				searchMattermost(
					{ subject: "payment", after },
					{ config: configFixture(), store },
				),
			).rejects.toMatchObject({ kind: "invalid_search_filter" });
		}
		store.close();
	});

	test("rejects remote search in local-only API mode", async () => {
		const store = await seededStore({ fresh: true });
		await expect(
			getMattermostContext(
				{ subject: "payment", local: true, remoteSearch: true },
				{ config: configFixture(), store },
			),
		).rejects.toMatchObject({ kind: "invalid_remote_search_mode" });
		store.close();
	});

	test("uses explicit bounded remote search without escaping routed conversations", async () => {
		const store = await seededStore({ fresh: true });
		const client = new SearchContextClient();
		const remoteRoot = "rrrrrrrrrrrrrrrrrrrrrrrrrr";
		const outsideRoot = "ssssssssssssssssssssssssss";
		const allowedPost = postFixture({
			id: remoteRoot,
			channel_id: "channel-payments",
			message: "orphaned quasar zxqv",
			create_at: 50,
		});
		const outsidePost = postFixture({
			id: outsideRoot,
			channel_id: "channel-platform",
			message: "orphaned quasar zxqv",
			create_at: 60,
		});
		client.searchResult = list(outsidePost, allowedPost);
		client.threads.set(remoteRoot, list(allowedPost));
		const result = await getMattermostContext(
			{
				subject: "orphaned quasar zxqv",
				queries: ["extra one", "extra two", "extra three", "extra four"],
				channels: ["payments"],
				remoteSearch: true,
			},
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.remoteSearch).toEqual({
			requested: true,
			performed: true,
			reason: "explicit",
			queries: [
				"orphaned quasar zxqv",
				"extra one",
				"extra two",
				"extra three",
			].map((probe) => ({
				probe,
				returnedPosts: 2,
				acceptedPosts: 1,
			})),
			candidateThreads: 1,
			failures: 0,
		});
		expect(result.threads[0]).toMatchObject({
			threadId: remoteRoot,
			reasons: expect.arrayContaining(["remote_search"]),
		});
		expect(client.threadRequests).toEqual([remoteRoot]);
		expect(client.searchRequests).toHaveLength(4);
		expect(client.searchRequests[0]).toEqual({
			teamId: "team-id",
			terms: "orphaned quasar zxqv",
			isOrSearch: false,
			page: 0,
			perPage: 20,
		});
		expect(client.searchRequests.map(({ terms }) => terms)).not.toContain(
			"extra four",
		);
		expect(store.getPost(remoteRoot)).not.toBeNull();
		expect(store.getPost(outsideRoot)).toBeNull();
		store.close();
	});

	test("keeps later independent remote probes eligible for the global cap", async () => {
		const store = await seededStore({ fresh: true });
		const client = new SearchContextClient();
		const alphaPosts = Array.from({ length: 12 }, (_, index) =>
			postFixture({
				id: `${String(index).padStart(26, "a")}`,
				channel_id: "channel-payments",
				message: "alpha remote candidate",
				create_at: 100 + index,
			}),
		);
		const omega = postFixture({
			id: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
			channel_id: "channel-payments",
			message: "omega remote candidate",
			create_at: 1_000,
		});
		client.searchResults.set("alpha", list(...alphaPosts));
		client.searchResults.set("omega", list(omega));
		for (const post of [...alphaPosts, omega]) {
			client.threads.set(post.id, list(post));
		}
		const config = configFixture({
			budgets: {
				defaultMaxCharacters: 10_000,
				defaultPerThreadCharacters: 500,
				defaultMaxThreads: 20,
				matchNeighborhoodRadius: 2,
				ticketNeighborhoodRadius: 8,
				clusterMergeGap: 2,
				conversationSurroundRoots: 5,
				shortThreadMaxReplies: 2,
			},
		});
		const result = await getMattermostContext(
			{
				subject: "alpha",
				queries: ["omega"],
				channels: ["payments"],
				remoteSearch: true,
			},
			{ config, store, client, now: () => 2_000 },
		);
		expect(result.remoteSearch.candidateThreads).toBe(12);
		expect(result.threads.some(({ threadId }) => threadId === omega.id)).toBe(
			true,
		);
		store.close();
	});

	test("keeps local evidence when automatic remote fallback fails", async () => {
		const store = await seededStore({ fresh: true });
		const client = new SearchContextClient();
		client.failSearch = true;
		const localThread = list(
			postFixture({
				id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout shared evidence",
				create_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout reply",
				create_at: 20,
			}),
		);
		client.threads.set(ROOT, localThread);
		const result = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"] },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.threads[0]?.threadId).toBe(ROOT);
		expect(result.remoteSearch).toMatchObject({
			requested: false,
			performed: true,
			reason: "incomplete_local_coverage",
			failures: 1,
		});
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ kind: "remote_search_failed" }),
		);
		store.close();
	});

	test("keeps local evidence when forced hydrate fails with Mattermost API error", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.getThread = async (postId: string) => {
			client.threadRequests.push(postId);
			throw new MattermostApiError(
				"Mattermost API request failed with 403 Forbidden.",
				403,
				"forbidden",
			);
		};
		const result = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"], fresh: true },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(result.threads[0]?.threadId).toBe(ROOT);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ kind: "remote_hydrate_failed" }),
		);
		store.close();
	});

	test("collapses repeated remote hydrate failures into one local-index warning", async () => {
		const store = await seededStore({ fresh: true });
		const secondRoot = "cccccccccccccccccccccccccc";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			posts: [
				postFixture({
					id: secondRoot,
					channel_id: "channel-payments",
					message: "payment timeout follow-up thread",
					create_at: 50,
				}),
				postFixture({
					id: "dddddddddddddddddddddddddd",
					root_id: secondRoot,
					channel_id: "channel-payments",
					message: "more payment timeout details",
					create_at: 60,
				}),
			],
		});
		const client = new FakeContextClient();
		client.getThread = async (postId: string) => {
			client.threadRequests.push(postId);
			throw new MattermostApiError(
				"Mattermost API request failed with 503 Service Unavailable.",
				503,
				"service_unavailable",
			);
		};
		const result = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"], fresh: true },
			{
				config: configFixture({
					budgets: {
						...configFixture().budgets,
						defaultMaxThreads: 2,
					},
				}),
				store,
				client,
				now: () => 100,
			},
		);
		expect(result.threads.length).toBeGreaterThanOrEqual(1);
		expect(client.threadRequests.length).toBeGreaterThanOrEqual(2);
		const fallbackWarnings = result.warnings.filter(
			({ kind }) =>
				kind === "local_index_fallback" || kind === "remote_hydrate_failed",
		);
		expect(fallbackWarnings).toEqual([
			expect.objectContaining({ kind: "local_index_fallback" }),
		]);
		store.close();
	});

	test("human context rendering includes skip markers for omitted spans", async () => {
		const store = await seededStore({ fresh: true });
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			posts: Array.from({ length: 6 }, (_, index) =>
				postFixture({
					id: `${String(index + 1).repeat(26)}`,
					root_id: ROOT,
					channel_id: "channel-payments",
					message: `middle discussion ${index + 1}`,
					create_at: 30 + index,
				}),
			),
		});
		const result = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"], local: true },
			{
				config: configFixture({
					budgets: {
						...configFixture().budgets,
						defaultPerThreadCharacters: 180,
						defaultMaxCharacters: 180,
					},
				}),
				store,
				now: () => 100,
			},
		);
		const text = formatHumanResult(
			commandSuccess("context", result, result.warnings),
		);
		expect(result.threads[0]?.omittedPosts ?? 0).toBeGreaterThan(0);
		expect(text).toMatch(/skipped \d+ message/);
		store.close();
	});

	test("retrieves Russian evidence with stop words, case folding, and ё/е normalization", async () => {
		const store = await seededStore();
		const russianRoot = "eeeeeeeeeeeeeeeeeeeeeeeeee";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			posts: [
				postFixture({
					id: russianRoot,
					channel_id: "channel-payments",
					message: "ПЛАТЁЖ снова не прошёл из-за ошибки провайдера",
					create_at: 40,
				}),
			],
		});
		const result = await getMattermostContext(
			{
				subject: "платеж не прошел",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(result.probes[0]?.terms).toEqual(["платеж", "прошел"]);
		expect(result.threads[0]?.threadId).toBe(russianRoot);
		expect(result.threads[0]?.posts[0]?.message).toBe(
			"ПЛАТЁЖ снова не прошёл из-за ошибки провайдера",
		);
		store.close();
	});

	test("uses configured mixed-language synonyms and exposes their evidence", async () => {
		const store = await seededStore({ fresh: true });
		const synonymRoot = "ffffffffffffffffffffffffff";
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			posts: [
				postFixture({
					id: synonymRoot,
					channel_id: "channel-payments",
					message: "Data replication blocked by a stale database lock",
					create_at: 45,
				}),
			],
		});
		const result = await searchMattermost(
			{ subject: "репликация", channels: ["payments"] },
			{
				config: configFixture({
					synonyms: { репликация: ["data replication"] },
				}),
				store,
				now: () => 100,
			},
		);
		expect(result.probes[0]?.expansions).toContainEqual({
			sourceTerm: "репликация",
			value: "data replication",
			kind: "synonym",
			match: "exact",
		});
		expect(result.candidates[0]).toMatchObject({
			threadId: synonymRoot,
			reasons: expect.arrayContaining([
				"all_expanded_terms_in_thread",
				"query_expansion",
			]),
		});
		store.close();
	});

	test("uses the first repeated query as the subject when positional input is absent", async () => {
		const store = await seededStore();
		const result = await getMattermostContext(
			{
				queries: ["payment timeout", "deployment rollback"],
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(result.subject).toMatchObject({
			kind: "text",
			text: "payment timeout",
		});
		expect(result.probes.map(({ value }) => value)).toEqual([
			"payment timeout",
			"deployment rollback",
		]);
		expect(result.threads[0]?.threadId).toBe(ROOT);
		store.close();
	});

	test("widens once when metadata routing misses but never escapes explicit channels", async () => {
		const store = await seededStore();
		const widened = await getMattermostContext(
			{
				subject: "deployment rollback",
				scopes: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(widened.widening.performed).toBe(true);
		expect(widened.threads[0]?.conversationAlias).toBe("platform");
		expect(widened.searchedConversations.map(({ alias }) => alias)).toEqual([
			"payments",
			"platform",
			"leads",
		]);

		const restricted = await getMattermostContext(
			{
				subject: "deployment rollback",
				channels: ["payments"],
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(restricted.threads).toEqual([]);
		expect(restricted.widening.performed).toBe(false);
		expect(restricted.searchedConversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		store.close();
	});

	test("local search cannot return a direct post outside explicit channels", async () => {
		const store = await seededStore();
		const result = await searchMattermost(
			{ subject: PLATFORM_ROOT, channels: ["payments"] },
			{ config: configFixture(), store },
		);
		expect(result.candidates).toEqual([]);
		expect(result.routing.conversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		store.close();
	});

	test("direct permalink bypasses FTS discovery and resolves a reply to its root", async () => {
		const store = await seededStore();
		const result = await getMattermostContext(
			{
				subject: `https://chat.example.test/team/pl/${REPLY}`,
				local: true,
			},
			{ config: configFixture(), store },
		);
		expect(result.subject).toMatchObject({ kind: "post", postId: REPLY });
		expect(result.threads[0]).toMatchObject({
			threadId: ROOT,
			matchingPostIds: [REPLY],
		});
		store.close();
	});

	test("fails when a directly targeted reply disappears before hydration", async () => {
		const store = await seededStore();
		const client = new FakeContextClient();
		client.posts.set(
			REPLY,
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout reply",
			}),
		);
		client.thread = list(
			postFixture({
				id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout root",
			}),
		);
		await expect(
			getMattermostContext(
				{ subject: REPLY },
				{ config: configFixture(), store, client, now: () => 8_200_000 },
			),
		).rejects.toMatchObject({ kind: "post_not_found" });
		store.close();
	});

	test("network hydration replaces stale local message content with current server evidence", async () => {
		const store = await seededStore();
		const client = new FakeContextClient();
		client.posts.set(
			ROOT,
			postFixture({ id: ROOT, message: "payment timeout old" }),
		);
		client.thread = list(
			postFixture({
				id: ROOT,
				message: "payment current server text",
				create_at: 10,
				update_at: 100,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				message: "timeout confirmed",
				create_at: 20,
			}),
		);
		const result = await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"] },
			{ config: configFixture(), store, client, now: () => 8_200_000 },
		);
		expect(result.threads[0]?.posts[0]?.message).toBe(
			"payment current server text",
		);
		expect(result.threads[0]?.reasons).not.toContain("exact_phrase");
		expect(result.threads[0]?.reasons).toContain("all_terms_in_thread");
		expect(result.evidence.currency).toBe("current");
		expect(result.evidence.completeness.discovery).toBe("possibly_stale");
		expect(result.evidence.next).not.toContainEqual(
			expect.objectContaining({ action: "fresh_or_remote" }),
		);
		expect(client.threadRequests).toEqual([ROOT]);
		store.close();
	});

	test("rejects hydrated posts that cross the routed conversation boundary", async () => {
		const store = await seededStore();
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({
				id: ROOT,
				channel_id: "channel-platform",
				message: "payment timeout",
			}),
		);
		await expect(
			getMattermostContext(
				{ subject: "payment timeout", channels: ["payments"] },
				{ config: configFixture(), store, client, now: () => 8_200_000 },
			),
		).rejects.toMatchObject({ kind: "conversation_not_allowed" });
		store.close();
	});

	test("rejects a same-channel response for a different requested thread", async () => {
		const store = await seededStore();
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({
				id: PLATFORM_ROOT,
				channel_id: "channel-payments",
				message: "payment timeout",
			}),
		);
		await expect(
			getMattermostContext(
				{ subject: "payment timeout", channels: ["payments"] },
				{ config: configFixture(), store, client, now: () => 8_200_000 },
			),
		).rejects.toMatchObject({ kind: "thread_not_found" });
		store.close();
	});

	test("continues past stale hydrated candidates and widens when none remain useful", async () => {
		const store = await seededStore();
		const client = new FakeContextClient();
		client.threads.set(
			ROOT,
			list(
				postFixture({
					id: ROOT,
					channel_id: "channel-payments",
					message: "no longer relevant",
				}),
			),
		);
		client.threads.set(
			PLATFORM_ROOT,
			list(
				postFixture({
					id: PLATFORM_ROOT,
					channel_id: "channel-platform",
					message: "shared evidence current",
				}),
			),
		);
		const result = await getMattermostContext(
			{ subject: "shared evidence", scopes: ["payments"] },
			{ config: configFixture(), store, client, now: () => 8_200_000 },
		);
		expect(result.widening.performed).toBe(true);
		expect(
			result.threads.map(({ conversationAlias }) => conversationAlias),
		).toEqual(["platform"]);
		store.close();
	});

	test("fresh mode reconciles and resolves only explicitly routed conversations", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({ id: ROOT, message: "payment timeout", create_at: 10 }),
		);
		await getMattermostContext(
			{
				subject: "payment timeout",
				channels: ["payments"],
				fresh: true,
			},
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(
			new Set(client.postRequests.map(({ channelId }) => channelId)),
		).toEqual(new Set(["channel-payments"]));
		expect(new Set(client.channelRequests)).toEqual(
			new Set(["channel-payments"]),
		);
		store.close();
	});

	test("network context uses config IDs without resolving every conversation", async () => {
		const store = await seededStore({ fresh: true });
		const client = new FakeContextClient();
		client.thread = list(
			postFixture({ id: ROOT, message: "payment timeout", create_at: 10 }),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				message: "timeout confirmed",
				create_at: 20,
			}),
		);
		await getMattermostContext(
			{ subject: "payment timeout", channels: ["payments"] },
			{ config: configFixture(), store, client, now: () => 100 },
		);
		expect(client.channelRequests).toEqual([]);
		expect(client.postRequests).toEqual([]);
		store.close();
	});

	test("reclaims unused global budget for a truncated primary thread", async () => {
		const store = await seededStore({ fresh: true });
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			posts: Array.from({ length: 6 }, (_, index) =>
				postFixture({
					id: `${String(index + 1).repeat(26)}`,
					root_id: ROOT,
					channel_id: "channel-payments",
					message: `primary decision detail ${index} ${"x".repeat(70)}`,
					create_at: 30 + index,
				}),
			),
		});
		const config = configFixture({
			budgets: {
				...configFixture().budgets,
				defaultMaxCharacters: 1_400,
				defaultPerThreadCharacters: 500,
			},
		});
		const result = await getMattermostContext(
			{ subject: "shared evidence", local: true },
			{ config, store, now: () => 100 },
		);
		const primary = result.threads.find(({ threadId }) => threadId === ROOT);
		expect(result.threads).toHaveLength(2);
		expect(primary?.omittedPosts).toBe(0);
		expect(primary?.budget.limit ?? 0).toBeGreaterThan(500);
		expect(result.budget.used).toBeLessThanOrEqual(1_400);
		store.close();
	});

	test("repacks a primary ticket thread to keep a contiguous ticket core", async () => {
		const store = await MattermostStore.open(":memory:");
		const ticketRoot = "tttttttttttttttttttttttttt";
		const posts = [
			postFixture({
				id: ticketRoot,
				channel_id: "channel-payments",
				message: "TECHSUPP-42 kickoff",
				create_at: 10,
			}),
			...Array.from({ length: 18 }, (_, index) =>
				postFixture({
					id: `m${String(index).padStart(25, "0")}`,
					root_id: ticketRoot,
					channel_id: "channel-payments",
					message: `argument middle ${index} ${"x".repeat(40)}`,
					create_at: 20 + index,
				}),
			),
			postFixture({
				id: "uuuuuuuuuuuuuuuuuuuuuuuuuu",
				root_id: ticketRoot,
				channel_id: "channel-payments",
				message: "TECHSUPP-42 resolved",
				create_at: 100,
			}),
		];
		store.writePage({
			conversation: conversationFixture("payments", "channel-payments"),
			users: [userFixture()],
			posts,
			checkpoint: {
				conversationId: "channel-payments",
				newestPostId: "uuuuuuuuuuuuuuuuuuuuuuuuuu",
				newestPostAt: 100,
				oldestCoveredAt: 10,
				lastSuccessAt: 1_000,
				coverageComplete: true,
			},
		});
		store.linkTicketThread("TECHSUPP-42", ticketRoot, ticketRoot, "explicit");
		const config = configFixture({
			budgets: {
				...configFixture().budgets,
				defaultMaxCharacters: 900,
				defaultPerThreadCharacters: 900,
				defaultMaxThreads: 1,
				ticketNeighborhoodRadius: 0,
				matchNeighborhoodRadius: 1,
				clusterMergeGap: 0,
			},
		});
		const result = await getMattermostContext(
			{ subject: "TECHSUPP-42", channels: ["payments"], local: true },
			{ config, store, now: () => 1_000 },
		);
		expect(result.threads).toHaveLength(1);
		const primary = result.threads[0];
		expect(primary?.selectionStrategy).toContain("contiguous_ticket_core");
		expect(primary?.omittedPosts).toBeGreaterThan(0);
		const selected = primary?.posts.map(({ id }) => id) ?? [];
		const first = selected[0];
		const last = selected[selected.length - 1];
		expect(first).toBeDefined();
		expect(last).toBeDefined();
		const chronological = posts.map(({ id }) => id);
		const span = chronological.slice(
			chronological.indexOf(first!),
			chronological.indexOf(last!) + 1,
		);
		expect(selected).toEqual(span);
		store.close();
	});

	test("enforces global and per-thread budgets without splitting messages", async () => {
		const store = await seededStore();
		const config = configFixture({
			budgets: {
				defaultMaxCharacters: 140,
				defaultPerThreadCharacters: 100,
				defaultMaxThreads: 3,
				matchNeighborhoodRadius: 2,
				ticketNeighborhoodRadius: 8,
				clusterMergeGap: 2,
				conversationSurroundRoots: 5,
				shortThreadMaxReplies: 2,
			},
		});
		const result = await getMattermostContext(
			{ subject: "shared evidence", local: true },
			{ config, store },
		);
		expect(result.budget.used).toBeLessThanOrEqual(140);
		expect(result.threads.every(({ budget }) => budget.used <= 140)).toBe(true);
		expect(result.threads.some(({ omittedPosts }) => omittedPosts > 0)).toBe(
			true,
		);
		store.close();
	});
});
