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
	evaluateThreadEvidence,
	RETRIEVAL_SOURCE_WEIGHTS,
	reciprocalRankFusionScore,
	resolveProbes,
	routeConversations,
	searchThreads,
	weightedReciprocalRankFusionScore,
	widenedRouting,
} from "./index.ts";

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

	test("computes weighted reciprocal rank contributions deterministically", () => {
		expect(reciprocalRankFusionScore(1)).toBe(1 / 61);
		expect(reciprocalRankFusionScore(5, 10)).toBe(1 / 15);
		expect(weightedReciprocalRankFusionScore("exact_phrase", 1)).toBe(1 / 61);
		expect(weightedReciprocalRankFusionScore("morph_fts", 1)).toBe(0.45 / 61);
		expect(RETRIEVAL_SOURCE_WEIGHTS.term_fts).toBeGreaterThan(
			RETRIEVAL_SOURCE_WEIGHTS.morph_fts,
		);
		expect(RETRIEVAL_SOURCE_WEIGHTS.morph_fts).toBeGreaterThan(
			RETRIEVAL_SOURCE_WEIGHTS.prefix_fts,
		);
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

	test("bounds probe terms and proximity analysis for oversized input", () => {
		const subject = classifySubject(
			"one two three four five six seven eight nine",
		);
		const probes = resolveProbes(subject);
		expect(probes[0]?.terms).toHaveLength(8);
		expect(probes[0]?.terms).not.toContain("nine");
		const evidence = evaluateThreadEvidence(
			[
				{
					id: "root",
					message: `${"filler ".repeat(513)} one two three four five six seven eight nine`,
					createAt: 1,
					updateAt: 0,
					deleteAt: 0,
				},
			],
			"root",
			subject,
			probes,
		);
		expect(evidence).toMatchObject({
			exactTermsInSamePost: 0,
			morphTermsInSamePost: 0,
			matchedTermsInSamePost: 0,
			minimumTokenWindow: null,
		});
		expect(evidence.proximityKind).toBeUndefined();
	});

	test("bounds concept matches per probe deterministically", () => {
		const concepts = Object.fromEntries(
			Array.from({ length: 10 }, (_, index) => [
				`concept-${index}`,
				[`phrase ${index}`, `alternate ${index}`],
			]),
		);
		const subject = classifySubject(
			Array.from({ length: 10 }, (_, index) => `phrase ${index}`).join(" "),
		);
		expect(
			resolveProbes(subject, [], {}, [], concepts)[0]?.conceptMatches,
		).toEqual(
			Array.from({ length: 8 }, (_, index) => ({
				conceptId: `concept-${index}`,
				sourcePhrase: `phrase ${index}`,
			})),
		);
	});

	test("filters Russian stop words and normalizes Cyrillic case and ё", () => {
		const subject = classifySubject("Что это за платёж и почему он не прошёл");
		expect(resolveProbes(subject)).toEqual([
			{
				value: "Что это за платёж и почему он не прошёл",
				phrases: [],
				terms: ["платеж", "прошел"],
				morphTerms: ["платеж", "прошел"],
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

	test("keeps an exact Russian term above a morphology-only match", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "exact-inflection",
					channel_id: payments.id,
					message: "Зависшими платежами уже занимается команда",
					create_at: 10,
				}),
				postFixture({
					id: "morphology-only",
					channel_id: payments.id,
					message: "Зависший платеж уже проверяет команда",
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
		const subject = classifySubject("зависшими платежами");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"exact-inflection",
			"morphology-only",
		]);
		expect(
			candidates[0]?.fusionContributions?.find(
				({ source }) => source === "strict_fts",
			),
		).toMatchObject({ weight: 0.9 });
		expect(
			candidates[1]?.fusionContributions?.find(
				({ source }) => source === "morph_fts",
			),
		).toMatchObject({ weight: 0.45 });
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
		const probes = resolveProbes(subject);
		expect(probes[0]?.morphTerms).toEqual(["уведомлен", "клиент", "пришл"]);
		const candidates = searchThreads(store, subject, probes, routing);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"russian-morphology-deep",
			"russian-wording-shallow",
		]);
		expect(candidates[0]).toMatchObject({
			reasons: expect.arrayContaining([
				"all_expanded_terms_in_thread",
				"morphology_match",
				"query_expansion",
			]),
			rankingEvidence: {
				exactFullyMatchedProbeCount: 0,
				fullyMatchedProbeCount: 1,
				morphMatchedTermCount: 2,
				expandedMatchedTermCount: 1,
			},
		});
		expect(
			candidates[0]?.fusionContributions?.filter(
				({ source }) => source === "morph_fts",
			),
		).toEqual([
			expect.objectContaining({
				source: "morph_fts",
				weight: 0.45,
				score: 0.45 / 61,
			}),
		]);
		expect(
			candidates[0]?.fusionContributions?.some(
				({ source, sourceQuery }) =>
					source === "morph_fts" && sourceQuery === "пришл",
			),
		).toBe(false);
		expect(
			candidates[0]?.fusionContributions?.find(
				({ source }) => source === "synonym",
			),
		).toMatchObject({ weight: 0.35 });
		store.close();
	});

	test("retrieves layout, transliteration, and mixed-script corrections as separate weak channels", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "layout-target",
					channel_id: payments.id,
					message: "Нужен ретрай callback после таймаута",
				}),
				postFixture({
					id: "transliteration-target",
					channel_id: payments.id,
					message: "Проверили репликацию данных",
				}),
				postFixture({
					id: "mixed-script-target",
					channel_id: payments.id,
					message: "payment callback завершился",
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
		for (const [query, threadId, source, reason] of [
			[
				"htnhfq callback",
				"layout-target",
				"keyboard_layout",
				"keyboard_layout_match",
			],
			[
				"replikaciya dannyh",
				"transliteration-target",
				"transliteration",
				"transliteration_match",
			],
			[
				"paymеnt callback",
				"mixed-script-target",
				"mixed_script",
				"mixed_script_match",
			],
		] as const) {
			const subject = classifySubject(query);
			const probes = resolveProbes(subject);
			const candidates = searchThreads(store, subject, probes, routing);
			const candidate = candidates.find((item) => item.threadId === threadId);
			expect(candidate?.reasons).toContain(reason);
			expect(candidate?.fusionContributions).toContainEqual(
				expect.objectContaining({ source, weight: 0.25 }),
			);
		}
		store.close();
	});

	test("keeps literal wrong-layout text above its corrected fallback", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "literal-layout",
					channel_id: payments.id,
					message: "Диагностика htnhfq в пользовательском вводе",
				}),
				postFixture({
					id: "corrected-layout",
					channel_id: payments.id,
					message: "Настроили ретрай обработки",
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
		const subject = classifySubject("htnhfq");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"literal-layout",
			"corrected-layout",
		]);
		expect(candidates[1]?.reasons).toContain("keyboard_layout_match");
		store.close();
	});

	test("retrieves configured domain concepts as a bounded weak channel", async () => {
		const concepts = {
			"duplicate-charge": [
				"повторное списание",
				"списали дважды",
				"duplicate charge",
			],
		};
		const store = await MattermostStore.open(":memory:", { concepts });
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "concept-target",
					channel_id: payments.id,
					message:
						"После автоматического ретрая обнаружили повторное списание одного заказа",
				}),
				postFixture({
					id: "concept-target-cause",
					root_id: "concept-target",
					channel_id: payments.id,
					message:
						"Проверили журнал доставки и нашли повторную обработку одного события",
				}),
				postFixture({
					id: "concept-target-fix",
					root_id: "concept-target",
					channel_id: payments.id,
					message:
						"Добавили idempotency guard и подтвердили результат на затронутых заказах",
				}),
			],
		});
		const config = configFixture({ concepts });
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{},
		);
		const subject = classifySubject("деньги списали дважды");
		const probes = resolveProbes(subject, [], {}, [], concepts);
		expect(probes[0]?.conceptMatches).toEqual([
			{
				conceptId: "duplicate-charge",
				sourcePhrase: "списали дважды",
			},
		]);
		const searchSources: string[] = [];
		const originalSearch = store.search.bind(store);
		store.search = ((...args: Parameters<typeof store.search>) => {
			searchSources.push(args[3]?.source ?? "strict_fts");
			return originalSearch(...args);
		}) as typeof store.search;
		const candidates = searchThreads(store, subject, probes, routing);
		expect(searchSources).not.toContain("prefix_fts");
		expect(searchSources).not.toContain("trigram");
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			threadId: "concept-target",
			reasons: expect.arrayContaining([
				"concept_match",
				"substantive_thread_depth",
				"rank_fusion",
			]),
			rankingEvidence: {
				substantivePostCount: 3,
				threadDepthScore: 3,
			},
		});
		expect(
			candidates[0]?.fusionContributions?.find(
				({ source }) => source === "concept_fts",
			),
		).toMatchObject({
			source: "concept_fts",
			conceptId: "duplicate-charge",
			sourcePhrase: "списали дважды",
			weight: 0.35,
			score: 0.35 / 61,
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

	test("uses Russian morphology before bounded typo fallback", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "russian-morph-root",
					channel_id: payments.id,
					message: "Уведомление о платеже не отправилось",
				}),
			],
		});
		const config = configFixture();
		const all = configuredConversations(config, store);
		const routing = routeConversations(config, store, all, {});
		const subject = classifySubject("уведомленеи платеж");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.threadId).toBe("russian-morph-root");
		expect(candidates[0]?.fusionContributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "morph_fts" }),
			]),
		);
		expect(candidates[0]?.rankingEvidence?.morphMatchedTermCount).toBe(2);
		expect(
			candidates[0]?.fusionContributions?.some(({ source }) =>
				["prefix_fts", "trigram"].includes(source),
			),
		).toBe(false);
		store.close();
	});

	test("keeps original morphology independent from configured synonyms", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "synonym-morph-root",
					channel_id: payments.id,
					message: "Разобрались с зависшими платежами",
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
		const subject = classifySubject("платеж");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject, [], { платеж: ["payment"] }),
			routing,
		);
		expect(candidates[0]?.threadId).toBe("synonym-morph-root");
		expect(candidates[0]?.fusionContributions).toContainEqual(
			expect.objectContaining({ source: "morph_fts" }),
		);
		store.close();
	});

	test("caps candidates returned by any lexical source", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: Array.from({ length: 105 }, (_, index) =>
				postFixture({
					id: `bounded-candidate-${String(index).padStart(3, "0")}`,
					channel_id: payments.id,
					message: "bounded common phrase",
					create_at: index + 1,
				}),
			),
		});
		const config = configFixture();
		const routing = routeConversations(
			config,
			store,
			configuredConversations(config, store),
			{},
		);
		const subject = classifySubject("bounded common phrase");
		expect(
			searchThreads(store, subject, resolveProbes(subject), routing, 200),
		).toHaveLength(100);
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
					is_bot: false,
				},
				{
					id: "other-user",
					username: "other",
					first_name: "",
					last_name: "",
					nickname: "",
					delete_at: 0,
					is_bot: false,
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
					message: "worker-runtime operations are healthy",
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
		const prefixSubject = classifySubject("payment worker-runtim");
		const prefix = searchThreads(
			store,
			prefixSubject,
			resolveProbes(prefixSubject),
			routing,
		);
		expect(
			prefix.some(({ threadId }) => threadId === "fallback-prefix-root"),
		).toBe(true);
		expect(
			prefix.find(({ threadId }) => threadId === "fallback-prefix-root")
				?.fusionContributions,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "prefix_fts",
					sourceQuery: "worker-runtim",
					fallbackKind: "identifier",
				}),
			]),
		);
		const typoSubject = classifySubject("scheduelRetry");
		const typo = searchThreads(
			store,
			typoSubject,
			resolveProbes(typoSubject),
			routing,
		);
		expect(typo[0]?.threadId).toBe("fallback-trigram-root");
		expect(typo[0]?.matches[0]?.lexicalSource).toBe("trigram");
		expect(typo[0]?.reasons).toContain("typo_match");
		expect(typo[0]?.fusionContributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "trigram",
					fallbackKind: "identifier",
					minimumSimilarity: 0.6,
					maximumEditDistance: 2,
				}),
			]),
		);
		const truncatedSubject = classifySubject("scheduleRetri");
		const truncated = searchThreads(
			store,
			truncatedSubject,
			resolveProbes(truncatedSubject),
			routing,
		);
		expect(truncated[0]?.threadId).toBe("fallback-trigram-root");
		expect(truncated[0]?.reasons).toContain("typo_match");
		store.close();
	});

	test("bounds Russian typo matching by length, morphology, and edit distance", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "bounded-typo-relevant",
					channel_id: payments.id,
					message: "Платежи зависли после доставки",
				}),
				postFixture({
					id: "bounded-typo-noise",
					channel_id: payments.id,
					message: "Платёжный календарь команды",
				}),
				postFixture({
					id: "bounded-long-typo",
					channel_id: payments.id,
					message: "Настройка репликации данных",
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
		const typoSubject = classifySubject("платж");
		const typo = searchThreads(
			store,
			typoSubject,
			resolveProbes(typoSubject),
			routing,
		);
		expect(typo.map(({ threadId }) => threadId)).toEqual([
			"bounded-typo-relevant",
		]);
		expect(typo[0]?.fusionContributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "trigram",
					fallbackKind: "russian_word",
					minimumSimilarity: 0.5,
					maximumEditDistance: 1,
				}),
			]),
		);
		const longTypoSubject = classifySubject("реплкация");
		const longTypo = searchThreads(
			store,
			longTypoSubject,
			resolveProbes(longTypoSubject),
			routing,
		);
		expect(longTypo[0]?.threadId).toBe("bounded-long-typo");
		expect(longTypo[0]?.fusionContributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fallbackKind: "russian_word",
					minimumSimilarity: 0.5,
					maximumEditDistance: 1,
				}),
			]),
		);
		const shortSubject = classifySubject("плт");
		expect(
			searchThreads(store, shortSubject, resolveProbes(shortSubject), routing),
		).toEqual([]);
		store.close();
	});

	test("does not add typo evidence when the same term has an exact hit", async () => {
		const store = await MattermostStore.open(":memory:");
		const payments = conversationFixture("payments", "channel-payments");
		store.writePage({
			conversation: payments,
			posts: [
				postFixture({
					id: "exact-symbol-root",
					channel_id: payments.id,
					message: "scheduleRetry exhausted",
				}),
				postFixture({
					id: "near-symbol-root",
					channel_id: payments.id,
					message: "scheduelRetry exhausted",
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
		const subject = classifySubject("scheduleRetry");
		const candidates = searchThreads(
			store,
			subject,
			resolveProbes(subject),
			routing,
		);
		expect(candidates.map(({ threadId }) => threadId)).toEqual([
			"exact-symbol-root",
		]);
		expect(candidates[0]?.reasons).not.toContain("typo_match");
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
					is_bot: false,
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
