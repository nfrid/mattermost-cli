import { describe, expect, test } from "bun:test";
import {
	classifySubject,
	configuredConversations,
	reciprocalRankFusionScore,
	resolveProbes,
	routeConversations,
	searchThreads,
	widenedRouting,
} from "./retrieval.ts";
import { MattermostStore } from "./storage.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "./test-fixtures.ts";

describe("subject and probe resolution", () => {
	test("classifies explicit ticket, permalink, raw post ID, positional ticket, and text in order", () => {
		const postId = "abcdefghijklmnopqrstuvwx12";
		expect(
			classifySubject(`https://chat.test/team/pl/${postId}`, "proj-7"),
		).toMatchObject({
			kind: "ticket",
			ticketKey: "PROJ-7",
		});
		expect(
			classifySubject(`https://chat.test/team/pl/${postId}`),
		).toMatchObject({
			kind: "post",
			postId,
			source: "permalink",
		});
		expect(classifySubject(postId)).toMatchObject({ kind: "post", postId });
		expect(classifySubject("proj-1777")).toMatchObject({
			kind: "ticket",
			ticketKey: "PROJ-1777",
		});
		expect(classifySubject("payment timeout")).toEqual({
			kind: "text",
			text: "payment timeout",
			raw: "payment timeout",
		});
	});

	test("computes reciprocal rank contributions deterministically", () => {
		expect(reciprocalRankFusionScore(1)).toBe(1 / 61);
		expect(reciprocalRankFusionScore(5, 10)).toBe(1 / 15);
		expect(() => reciprocalRankFusionScore(0)).toThrow();
	});

	test("adds repeated probes to the subject and normalizes phrases and terms", () => {
		const subject = classifySubject("fallback text");
		expect(
			resolveProbes(subject, ['"payment timeout" API', "billing retry"]),
		).toEqual([
			{
				value: "fallback text",
				phrases: [],
				terms: ["fallback", "text"],
			},
			{
				value: '"payment timeout" API',
				phrases: ["payment timeout"],
				terms: ["payment", "timeout", "api"],
				expansions: [
					{
						sourceTerm: "timeout",
						value: "таймаут",
						kind: "synonym",
						match: "exact",
					},
				],
			},
			{
				value: "billing retry",
				phrases: [],
				terms: ["billing", "retry"],
				expansions: [
					{
						sourceTerm: "retry",
						value: "ретрай",
						kind: "synonym",
						match: "exact",
					},
				],
			},
		]);
	});

	test("accepts typed agent probes and retains their independent origins", () => {
		const subject = classifySubject("payment timeout");
		expect(
			resolveProbes(subject, [], {}, [
				{ kind: "ticket_title", value: "payment timeout" },
				{ kind: "file_path", value: "src/payments/worker.ts" },
				{ kind: "symbol", value: "reconcilePayment" },
				{ kind: "symbol", value: "reconcilePayment" },
				{ kind: "service", value: "  " },
			]),
		).toEqual([
			{
				value: "payment timeout",
				phrases: [],
				terms: ["payment", "timeout"],
				kind: "ticket_title",
				expansions: [
					{
						sourceTerm: "timeout",
						value: "таймаут",
						kind: "synonym",
						match: "exact",
					},
				],
			},
			{
				value: "src/payments/worker.ts",
				phrases: [],
				terms: ["src", "payments", "worker", "ts"],
				kind: "file_path",
				expansions: [
					{
						sourceTerm: "worker",
						value: "воркер",
						kind: "synonym",
						match: "exact",
					},
				],
			},
			{
				value: "reconcilePayment",
				phrases: [],
				terms: ["reconcilepayment"],
				kind: "symbol",
			},
		]);
	});

	test("filters Russian stop words and normalizes Cyrillic case and ё", () => {
		const subject = classifySubject("Что это за платёж и почему он не прошёл");
		expect(resolveProbes(subject)).toEqual([
			{
				value: "Что это за платёж и почему он не прошёл",
				phrases: [],
				terms: ["платеж", "прошел"],
			},
		]);
	});
});

describe("routing and ranking", () => {
	test("applies hard explicit routing and one-time metadata/ticket fallbacks", async () => {
		const store = await MattermostStore.open(":memory:");
		const config = configFixture();
		seedConversation(store, "payments", "channel-payments", "channel");
		seedConversation(store, "platform", "channel-platform", "channel");
		seedConversation(store, "leads", "dm-leads", "direct_message");
		const ticketPost = postFixture({
			id: "ticketrootabcdefghijklmnop",
			channel_id: "channel-platform",
			message: "PROJ-1777 rollout",
		});
		store.writePage({
			conversation: conversationFixture("platform", "channel-platform"),
			posts: [ticketPost],
		});
		const all = configuredConversations(config, store);

		const explicit = routeConversations(config, store, all, {
			channels: ["payments"],
			scopes: ["platform", "unmapped-scope"],
		});
		expect(explicit.conversations.map(({ alias }) => alias)).toEqual([
			"payments",
		]);
		expect(explicit.canWiden).toBe(false);
		expect(explicit.explicitChannelPolicy).toBe("restrict");
		expect(explicit.unmatchedHints.scopes).toEqual(["unmapped-scope"]);

		const scoped = routeConversations(config, store, all, {
			scopes: ["platform"],
		});
		expect(scoped.conversations.map(({ alias }) => alias)).toEqual([
			"platform",
		]);
		expect(
			widenedRouting(all, scoped).conversations.map(({ alias }) => alias),
		).toEqual(["payments", "leads"]);

		const repository = routeConversations(config, store, all, {
			repositories: ["payment", "unmapped-repository"],
		});
		expect(repository.reason).toBe("repositories");
		expect(repository.conversations[0]?.alias).toBe("payments");
		expect(repository.unmatchedHints).toEqual({
			scopes: [],
			repositories: ["unmapped-repository"],
		});
		expect(widenedRouting(all, repository).unmatchedHints).toEqual(
			repository.unmatchedHints,
		);

		const ticket = routeConversations(config, store, all, {
			ticketKey: "PROJ-1777",
		});
		expect(ticket.reason).toBe("ticket_relationships");
		expect(ticket.conversations.map(({ alias }) => alias)).toEqual([
			"platform",
		]);
		store.close();
	});

	test("treats current configured IDs as authoritative over stale alias rows", async () => {
		const store = await MattermostStore.open(":memory:");
		seedConversation(store, "payments", "channel-old", "channel");
		seedConversation(store, "leads", "dm-old", "direct_message");
		const all = configuredConversations(configFixture(), store);
		expect(all.find(({ alias }) => alias === "payments")?.id).toBe(
			"channel-payments",
		);
		expect(all.find(({ alias }) => alias === "leads")?.id).toBe("dm-leads");
		expect(all.map(({ id }) => id)).not.toContain("channel-old");
		expect(all.map(({ id }) => id)).not.toContain("dm-old");
		store.close();
	});

	test("groups reply matches by thread and ranks named signals deterministically", async () => {
		const store = await MattermostStore.open(":memory:");
		const config = configFixture();
		const payments = conversationFixture("payments", "channel-payments");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: payments,
			users: [userFixture()],
			posts: [
				postFixture({
					id: "rootpaymentsabcdefghijkl",
					channel_id: payments.id,
					message: "PROJ-1777 payment timeout",
					create_at: 10,
				}),
				postFixture({
					id: "replypaymentsabcdefghijk",
					root_id: "rootpaymentsabcdefghijkl",
					channel_id: payments.id,
					message: "payment timeout reproduced",
					create_at: 20,
				}),
			],
		});
		store.linkTicketThread(
			"PROJ-1777",
			"rootpaymentsabcdefghijkl",
			"rootpaymentsabcdefghijkl",
			"explicit",
		);
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "rootplatformabcdefghijkl",
					channel_id: platform.id,
					message: "payment timeout",
					create_at: 30,
				}),
			],
		});
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("PROJ-1777");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject, ["payment timeout"]),
			routing,
		);

		expect(candidates).toHaveLength(2);
		expect(candidates[0]).toMatchObject({
			threadId: "rootpaymentsabcdefghijkl",
			matchingPostIds: ["replypaymentsabcdefghijk", "rootpaymentsabcdefghijkl"],
		});
		expect(candidates[0]?.reasons).toEqual(
			expect.arrayContaining([
				"explicit_ticket_relationship",
				"ticket_in_root",
				"exact_phrase",
				"all_terms_in_thread",
				"conversation_priority",
			]),
		);
		expect(candidates[0]?.matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceRank: expect.any(Number),
					bm25: expect.any(Number),
					lexicalEvidence: expect.arrayContaining([
						expect.objectContaining({ source: "strict_fts" }),
					]),
				}),
			]),
		);
		expect(
			candidates[0]?.matches.every(({ excerpt }) => excerpt.length > 0),
		).toBe(true);
		expect(candidates[1]?.threadId).toBe("rootplatformabcdefghijkl");
		store.close();
	});

	test("discovers terms distributed across replies and preserves independent probes", async () => {
		const store = await MattermostStore.open(":memory:");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "distributed-root",
					channel_id: platform.id,
					message: "worker investigation",
					create_at: 10,
				}),
				postFixture({
					id: "distributed-payment",
					root_id: "distributed-root",
					channel_id: platform.id,
					message: "payment processing degraded",
					create_at: 11,
				}),
				postFixture({
					id: "distributed-timeout",
					root_id: "distributed-root",
					channel_id: platform.id,
					message: "timeout observed in consumer",
					create_at: 12,
				}),
				postFixture({
					id: "single-term-noise",
					channel_id: platform.id,
					message: "payment status digest",
					create_at: 20,
				}),
			],
		});
		const all = configuredConversations(configFixture(), store);
		const routing = routeConversations(configFixture(), store, all, {});
		const subject = classifySubject("payment timeout");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates[0]).toMatchObject({
			threadId: "distributed-root",
			matchingPostIds: ["distributed-payment", "distributed-timeout"],
		});
		expect(candidates[0]?.reasons).toContain("all_terms_in_thread");
		expect(
			new Set(
				candidates[0]?.matches.flatMap(
					({ lexicalEvidence }) =>
						lexicalEvidence?.map(({ source }) => source) ?? [],
				),
			),
		).toEqual(new Set(["broad_fts", "term_fts"]));

		const independentSubject = classifySubject("payment");
		const independent = searchThreads(
			store,
			independentSubject,
			resolveProbes(independentSubject, ["timeout"]),
			routing,
		);
		const distributed = independent.find(
			({ threadId }) => threadId === "distributed-root",
		);
		expect(new Set(distributed?.matches.map(({ probe }) => probe))).toEqual(
			new Set(["payment", "timeout"]),
		);
		store.close();
	});

	test("ranks root subjects and comprehensive probe coverage above newer incidental mentions", async () => {
		const store = await MattermostStore.open(":memory:");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "deep-root-subject",
					channel_id: platform.id,
					message:
						"Connection pool exhausted: разбираем причину и план исправления",
					create_at: 10,
				}),
				postFixture({
					id: "deep-root-cause",
					root_id: "deep-root-subject",
					channel_id: platform.id,
					message:
						"Причина в releaseConnection, фикс добавили в worker-runtime",
					create_at: 11,
				}),
				postFixture({
					id: "weekly-root",
					channel_id: platform.id,
					message: "Еженедельный синк: релизы, отпуска и дежурства",
					create_at: 20,
				}),
				postFixture({
					id: "weekly-incidental-error",
					root_id: "weekly-root",
					channel_id: platform.id,
					message: "На слайде оставьте текст connection pool exhausted",
					create_at: 21,
				}),
			],
		});
		const config = configFixture();
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("connection pool exhausted");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject, ["releaseConnection", "worker-runtime"]),
			routing,
		);
		expect(candidates[0]?.threadId).toBe("deep-root-subject");
		expect(candidates[0]?.reasons).toEqual(
			expect.arrayContaining([
				"subject_in_root",
				"exact_phrase_in_root",
				"multiple_probes_in_thread",
			]),
		);
		expect(candidates[0]?.rankingEvidence).toMatchObject({
			subjectInRoot: true,
			matchedProbeCount: 3,
			fullyMatchedProbeCount: 3,
			exactPhraseInRootCount: 1,
		});
		expect(candidates[1]?.rankingEvidence).toMatchObject({
			subjectInRoot: false,
			subjectInReplies: true,
			matchedProbeCount: 1,
		});
		store.close();
	});

	test("fuses independent source-local thread ranks before weak recency", async () => {
		const store = await MattermostStore.open(":memory:");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "phrase-thread-root",
					channel_id: platform.id,
					message: "Разбираем ночной инцидент",
					create_at: 10,
				}),
				postFixture({
					id: "phrase-thread-reply",
					root_id: "phrase-thread-root",
					channel_id: platform.id,
					message: "alpha beta воспроизводится только под нагрузкой",
					create_at: 11,
				}),
				postFixture({
					id: "distributed-fusion-root",
					channel_id: platform.id,
					message: "Более новый общий тред",
					create_at: 20,
				}),
				postFixture({
					id: "distributed-alpha",
					root_id: "distributed-fusion-root",
					channel_id: platform.id,
					message: "alpha встретилась в одном логе",
					create_at: 21,
				}),
				postFixture({
					id: "distributed-beta",
					root_id: "distributed-fusion-root",
					channel_id: platform.id,
					message: "beta была в другом обсуждении",
					create_at: 22,
				}),
			],
		});
		const config = configFixture();
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("alpha beta");
		const first = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		const second = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(first.map(({ threadId }) => threadId)).toEqual([
			"phrase-thread-root",
			"distributed-fusion-root",
		]);
		expect(first[0]?.fusionScore).toBeGreaterThan(
			first[1]?.fusionScore ?? Number.POSITIVE_INFINITY,
		);
		expect(first[0]?.fusionContributions).toHaveLength(5);
		expect(first[1]?.fusionContributions).toHaveLength(3);
		expect(first[0]?.reasons).toContain("rank_fusion");
		expect(second.map(({ fusionScore }) => fusionScore)).toEqual(
			first.map(({ fusionScore }) => fusionScore),
		);
		store.close();
	});

	test("uses latest relevant match before unrelated overall activity", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "old-match-active-thread",
					channel_id: payments.id,
					message: "payment timeout",
					create_at: 10,
				}),
				postFixture({
					id: "unrelated-late-reply",
					root_id: "old-match-active-thread",
					channel_id: payments.id,
					message: "Перенесли встречу и обновили календарь",
					create_at: 100,
				}),
				postFixture({
					id: "newer-relevant-thread",
					channel_id: payments.id,
					message: "payment timeout",
					create_at: 20,
				}),
			],
		});
		const config = configFixture();
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("payment timeout");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"newer-relevant-thread",
			"old-match-active-thread",
		]);
		expect(candidates[0]?.rankingEvidence?.latestRelevantMatchAt).toBe(20);
		expect(candidates[1]).toMatchObject({
			latestActivityAt: 100,
			rankingEvidence: { latestRelevantMatchAt: 10 },
		});
		store.close();
	});

	test("ranks complete Russian inflection evidence above shallow exact wording", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "russian-morphology-deep",
					channel_id: payments.id,
					message:
						"Уведомления клиентам пока не приходят после планового обновления",
					create_at: 10,
				}),
				postFixture({
					id: "russian-wording-shallow",
					channel_id: payments.id,
					message: "В документации слово уведомление написано неверно",
					create_at: 100,
				}),
			],
		});
		const config = configFixture();
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{ channels: ["payments"] },
		);
		const subject = classifySubject("уведомление клиенту не пришло");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"russian-morphology-deep",
			"russian-wording-shallow",
		]);
		expect(candidates[0]).toMatchObject({
			reasons: expect.arrayContaining([
				"all_expanded_terms_in_thread",
				"query_expansion",
			]),
			rankingEvidence: {
				exactFullyMatchedProbeCount: 0,
				fullyMatchedProbeCount: 1,
				expandedMatchedTermCount: 3,
			},
		});
		store.close();
	});

	test("retrieves attachment filenames through structured evidence", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		const rootId = "structured-file-root";
		store.writePage({
			conversation: payments,
			files: [
				{
					id: "structured-file",
					user_id: "user-1",
					post_id: rootId,
					create_at: 1,
					update_at: 1,
					delete_at: 0,
					name: "incident-trace.json",
					extension: "json",
					size: 42,
					mime_type: "application/json",
				},
			],
			posts: [
				postFixture({
					id: rootId,
					channel_id: payments.id,
					message: "Логи приложены к сообщению",
					file_ids: ["structured-file"],
				}),
			],
		});
		const config = configFixture();
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("incident-trace.json");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			threadId: rootId,
			matchingPostIds: [rootId],
			structuredMatches: [
				{
					postId: rootId,
					probe: "incident-trace.json",
					kind: "attachment_filename",
					value: "incident-trace.json",
				},
			],
		});
		expect(candidates[0]?.reasons).toContain("structured_entity_match");
		store.close();
	});

	test("uses bounded prefix fallback only when stronger sources have no hits", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "russian-prefix-root",
					channel_id: payments.id,
					message: "Разбираемся с зависшими платежами",
				}),
			],
		});
		const config = configFixture();
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("завис платеж");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.threadId).toBe("russian-prefix-root");
		expect(
			candidates[0]?.matches.every(
				({ lexicalSource }) => lexicalSource === "prefix_fts",
			),
		).toBe(true);
		expect(
			new Set(
				candidates[0]?.matches.flatMap(
					({ lexicalEvidence }) =>
						lexicalEvidence?.map(({ sourceQuery }) => sourceQuery) ?? [],
				),
			),
		).toEqual(new Set(["завис", "платеж"]));
		store.close();
	});

	test("applies hard filters before bounded lexical candidate selection", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			users: [
				{
					id: "wanted-user",
					username: "wanted",
					first_name: "",
					last_name: "",
					nickname: "",
					delete_at: 0,
				},
				{
					id: "other-user",
					username: "other",
					first_name: "",
					last_name: "",
					nickname: "",
					delete_at: 0,
				},
			],
			posts: [
				postFixture({
					id: "wanted-filter-root",
					channel_id: payments.id,
					user_id: "wanted-user",
					message: "common candidate term",
					create_at: 1,
				}),
				...Array.from({ length: 100 }, (_, index) =>
					postFixture({
						id: `filter-decoy-${index}`,
						channel_id: payments.id,
						user_id: "other-user",
						message: "common candidate term",
						create_at: 100 + index,
					}),
				),
			],
		});
		const config = configFixture();
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{},
		);
		const subject = classifySubject("common candidate term");
		expect(
			searchThreads(store, subject, resolveProbes(subject), routing, 100, {
				username: "wanted",
			}).map(({ threadId }) => threadId),
		).toEqual(["wanted-filter-root"]);
		store.close();
	});

	test("keeps ticket evidence token-bounded and canonicalizes lowercase keys", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "true-ticket-root",
					channel_id: payments.id,
					message: "proj-1 commonword",
				}),
				postFixture({
					id: "false-ticket-root",
					channel_id: payments.id,
					message: "PROJ-12 commonword",
				}),
			],
		});
		const config = configFixture();
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{},
		);
		const subject = classifySubject(undefined, "PROJ-1");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject, ["commonword"]),
			routing,
		);
		expect(candidates[0]?.threadId).toBe("true-ticket-root");
		expect(candidates[0]?.reasons).toContain("ticket_in_root");
		expect(
			candidates.find(({ threadId }) => threadId === "false-ticket-root")
				?.reasons,
		).not.toContain("ticket_in_root");
		store.close();
	});

	test("uses per-term prefix and trigram fallback despite unrelated exact hits", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "fallback-noise-root",
					channel_id: payments.id,
					message: "payment announcement",
				}),
				postFixture({
					id: "fallback-prefix-root",
					channel_id: payments.id,
					message: "зависшими операциями занимаемся",
				}),
				postFixture({
					id: "fallback-trigram-root",
					channel_id: payments.id,
					message: "scheduleRetry exhausted",
				}),
			],
		});
		const config = configFixture();
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{},
		);
		const prefixSubject = classifySubject("payment завис");
		expect(
			searchThreads(
				store,
				prefixSubject,
				resolveProbes(prefixSubject),
				routing,
			).some(({ threadId }) => threadId === "fallback-prefix-root"),
		).toBe(true);
		const typoSubject = classifySubject("scheduelRetry");
		const typo = searchThreads(
			store,
			typoSubject,
			resolveProbes(typoSubject),
			routing,
		);
		expect(typo[0]?.threadId).toBe("fallback-trigram-root");
		expect(typo[0]?.matches[0]?.lexicalSource).toBe("trigram");
		store.close();
	});

	test("retrieves participant probes from indexed post authors", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			users: [
				{
					id: "participant-user",
					username: "alice",
					first_name: "",
					last_name: "",
					nickname: "",
					delete_at: 0,
				},
			],
			posts: [
				postFixture({
					id: "participant-root",
					channel_id: payments.id,
					user_id: "participant-user",
					message: "ordinary discussion without a mention",
				}),
			],
		});
		const config = configFixture();
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{},
		);
		const subject = classifySubject("alice");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject, [], {}, [{ kind: "participant", value: "alice" }]),
			routing,
		);
		expect(candidates[0]).toMatchObject({
			threadId: "participant-root",
			structuredMatches: [
				expect.objectContaining({ kind: "username", value: "alice" }),
			],
		});
		store.close();
	});
});

function seedConversation(
	store: MattermostStore,
	alias: string,
	id: string,
	kind: "channel" | "direct_message",
): void {
	store.writePage({
		conversation: { ...conversationFixture(alias, id), kind },
		posts: [],
	});
}
