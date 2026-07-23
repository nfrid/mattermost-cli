import { describe, expect, test } from "bun:test";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
} from "../test-fixtures.ts";
import {
	classifySubject,
	configuredConversations,
	resolveProbes,
	routeConversations,
	searchThreads,
} from "./index.ts";

describe("lexical retrieval", () => {
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
});
