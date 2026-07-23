import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import {
	classifySubject,
	configuredConversations,
	resolveProbes,
	routeConversations,
	searchThreads,
} from "./index.ts";

describe("ranking", () => {
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
		expect(candidates[0]?.reasons).toEqual(
			expect.arrayContaining(["all_terms_in_thread", "terms_across_thread"]),
		);
		expect(candidates[0]?.rankingEvidence).toMatchObject({
			exactTermsInSamePost: 1,
			matchedTermsAcrossThread: 2,
			matchedTermsInRoot: 0,
			matchedTermsInReplies: 2,
			distinctProbeCoverage: 1,
			proximityKind: "terms_across_thread",
			minimumTokenWindow: null,
		});
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

	test("prefers a bounded same-post token window over a newer glossary list", async () => {
		const store = await MattermostStore.open(":memory:");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "proximity-investigation",
					channel_id: platform.id,
					message:
						"В цепочке timeout callback и повторное списание появились вместе",
					create_at: 10,
				}),
				postFixture({
					id: "proximity-glossary",
					channel_id: platform.id,
					message:
						"timeout в отчёте callback в документации повторное списание в словаре",
					create_at: 20,
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
		const subject = classifySubject("timeout callback повторное списание");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"proximity-investigation",
			"proximity-glossary",
		]);
		expect(candidates[0]?.reasons).toContain("exact_terms_near");
		expect(candidates[0]?.rankingEvidence).toMatchObject({
			exactTermsInSamePost: 4,
			morphTermsInSamePost: 4,
			matchedTermsInSamePost: 4,
			minimumTokenWindow: 5,
			matchedTermsAcrossThread: 4,
			matchedTermsInRoot: 4,
			matchedTermsInReplies: 0,
			distinctProbeCoverage: 1,
			proximityKind: "exact_terms_near",
		});
		expect(candidates[1]?.rankingEvidence?.minimumTokenWindow).toBe(8);
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
		expect(first[0]?.fusionContributions).toHaveLength(4);
		expect(first[1]?.fusionContributions).toHaveLength(2);
		expect(first[0]?.fusionContributions?.map(({ source }) => source)).toEqual([
			"broad_fts",
			"exact_phrase",
			"strict_fts",
			"term_fts",
		]);
		expect(
			first[0]?.fusionContributions?.find(
				({ source }) => source === "term_fts",
			),
		).toMatchObject({ weight: 0.75, rank: 2, score: 0.75 / 62 });
		expect(first[0]?.reasons).toContain("rank_fusion");
		expect(second.map(({ fusionScore }) => fusionScore)).toEqual(
			first.map(({ fusionScore }) => fusionScore),
		);
		store.close();
	});

	test("uses bounded substantive thread depth after equivalent lexical evidence", async () => {
		const store = await MattermostStore.open(":memory:");
		const platform = conversationFixture("platform", "channel-platform");
		store.writePage({
			conversation: platform,
			posts: [
				postFixture({
					id: "deep-investigation",
					channel_id: platform.id,
					message:
						"duplicate key value violates unique constraint расследование",
					create_at: 10,
				}),
				...[
					"Подтвердили влияние на создание новых профилей после импорта архива",
					"Сверили sequence с максимальным идентификатором на основной реплике",
					"Исправление выполнили внутри транзакции и проверили конкурентную запись",
					"Добавили защитную проверку и наблюдаем метрики после выкладки",
				].map((message, index) =>
					postFixture({
						id: `deep-investigation-${index}`,
						root_id: "deep-investigation",
						channel_id: platform.id,
						message,
						create_at: 11 + index,
					}),
				),
				postFixture({
					id: "shallow-alert-copy",
					channel_id: platform.id,
					message:
						"duplicate key value violates unique constraint расследование",
					create_at: 100,
				}),
				postFixture({
					id: "shallow-alert-copy-reply",
					root_id: "shallow-alert-copy",
					channel_id: platform.id,
					message: "Меняем только заголовок алерта без изменения обработчика",
					create_at: 101,
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
		const subject = classifySubject(
			"duplicate key value violates unique constraint расследование",
		);
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"deep-investigation",
			"shallow-alert-copy",
		]);
		expect(candidates[0]?.reasons).toContain("substantive_thread_depth");
		expect(candidates[0]?.rankingEvidence).toMatchObject({
			threadPostCount: 5,
			substantivePostCount: 5,
			threadDepthScore: 5,
		});
		expect(candidates[1]?.rankingEvidence).toMatchObject({
			threadPostCount: 2,
			substantivePostCount: 2,
			threadDepthScore: 0,
		});
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

	test("downranks thin URL/ticket stub threads below substantive discussion", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		const leads = {
			...conversationFixture("leads", "dm-leads"),
			kind: "direct_message" as const,
		};
		const stubRoot = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
		const discussionRoot = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
		store.writePage({
			conversation: leads,
			posts: [
				postFixture({
					id: stubRoot,
					channel_id: leads.id,
					message: "https://tracker.example.test/PROJ-2112",
					create_at: 50,
				}),
			],
		});
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: discussionRoot,
					channel_id: payments.id,
					message: "Dark theme experiment kicked off in CRM today",
					create_at: 10,
				}),
				postFixture({
					id: "cccccccccccccccccccccccccc",
					root_id: discussionRoot,
					channel_id: payments.id,
					message:
						"We should keep tokens readable and avoid maxing contrast again",
					create_at: 20,
				}),
				postFixture({
					id: "dddddddddddddddddddddddddd",
					root_id: discussionRoot,
					channel_id: payments.id,
					message:
						"Tracked as https://tracker.example.test/PROJ-2112 for the rollout",
					create_at: 30,
				}),
				postFixture({
					id: "eeeeeeeeeeeeeeeeeeeeeeeeee",
					root_id: discussionRoot,
					channel_id: payments.id,
					message: "Looks good enough to ship after another polish pass",
					create_at: 40,
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
		const subject = classifySubject("PROJ-2112");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			discussionRoot,
			stubRoot,
		]);
		expect(
			candidates.find(({ threadId }) => threadId === stubRoot)?.reasons,
		).toContain("thin_thread");
		store.close();
	});

	test("demotes multi-ticket bulletin roots below focused ticket threads", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		const bulletinRoot = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
		const combatRoot = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: bulletinRoot,
					channel_id: payments.id,
					message:
						"На завтра: BTB-2080 BTB-1870 BTB-1999 CLIENTS-1090 TECHSUPP-50",
					create_at: 10,
				}),
				postFixture({
					id: combatRoot,
					channel_id: payments.id,
					message: "BTB-2080 payment timeout in checkout",
					create_at: 20,
				}),
				postFixture({
					id: "cccccccccccccccccccccccccc",
					root_id: combatRoot,
					channel_id: payments.id,
					message:
						"We reproduced the race in the worker and will patch the retry path",
					create_at: 30,
				}),
				postFixture({
					id: "dddddddddddddddddddddddddd",
					root_id: combatRoot,
					channel_id: payments.id,
					message: "Looks good after the polish pass, shipping next",
					create_at: 40,
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
		const subject = classifySubject("BTB-2080");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			combatRoot,
			bulletinRoot,
		]);
		expect(
			candidates.find(({ threadId }) => threadId === bulletinRoot)?.reasons,
		).toContain("multi_ticket_root");
		expect(
			candidates.find(({ threadId }) => threadId === combatRoot)?.reasons,
		).not.toContain("multi_ticket_root");
		store.close();
	});
});
