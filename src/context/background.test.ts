import { describe, expect, test } from "bun:test";
import { projectAgentResult } from "../output/agent-view.ts";
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

const TICKET_ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESIGN_ROOT = "cccccccccccccccccccccccccc";
const DESIGN_REPLY = "dddddddddddddddddddddddddd";

/**
 * A ticket lives in `payments`; the design discussion that predates it lives in
 * `platform`, which the ticket relationship never routes to.
 */
async function seededStore(): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture("payments", "channel-payments"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: TICKET_ROOT,
				channel_id: "channel-payments",
				message: "BTB-1 duplicate charge on retry",
				create_at: 1_000,
			}),
		],
	});
	store.writePage({
		conversation: conversationFixture("platform", "channel-platform"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: DESIGN_ROOT,
				channel_id: "channel-platform",
				message: "designing idempotency keys for retries",
				create_at: 10,
			}),
			postFixture({
				id: DESIGN_REPLY,
				root_id: DESIGN_ROOT,
				channel_id: "channel-platform",
				message: "idempotency keys must survive a retry storm",
				create_at: 20,
			}),
		],
	});
	return store;
}

describe("background threads", () => {
	test("reaches thematically close threads outside ticket routing", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				queries: ["idempotency keys"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);
		expect(
			context.threads.map(({ conversationAlias }) => conversationAlias),
		).toEqual(["payments"]);
		expect(context.background?.map(({ threadId }) => threadId)).toEqual([
			DESIGN_ROOT,
		]);
		const [pointer] = context.background ?? [];
		expect(pointer?.conversationAlias).toBe("platform");
		expect(pointer?.matchedProbes).toEqual(["idempotency keys"]);
		expect(pointer?.excerpts.length).toBeGreaterThan(0);
		store.close();
	});

	test("stays absent without explicit probes and leaves the packet untouched", async () => {
		const store = await seededStore();
		const config = configFixture();
		const plain = await getMattermostContext(
			{ subject: "BTB-1", local: true },
			{ config, store, now: () => 2_000 },
		);
		const probed = await getMattermostContext(
			{ subject: "BTB-1", queries: ["idempotency keys"], local: true },
			{ config, store, now: () => 2_000 },
		);
		expect(plain.background).toBeUndefined();
		expect(probed.threads).toEqual(plain.threads);
		expect(probed.selection).toEqual(plain.selection);
		store.close();
	});

	test("reports a background-only probe as such instead of warning", async () => {
		// The field report saw `unmatched_retrieval_probe` on every request while
		// the same probes were visibly the reason `background[]` existed.
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", queries: ["idempotency keys"], local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(context.probeCoverage).toEqual([
			{
				probe: "BTB-1",
				matchedSelectedEvidence: true,
				backgroundThreads: 0,
				status: "matched_selected",
				matchMode: "normalized_terms_or_expansions",
				retrievalCriteria: ["btb-1"],
			},
			{
				probe: "idempotency keys",
				matchedSelectedEvidence: false,
				backgroundThreads: 1,
				status: "background_only",
				matchMode: "normalized_terms_or_expansions",
				retrievalCriteria: ["idempotency", "keys"],
			},
		]);
		expect(
			context.warnings.some(({ kind }) => kind === "unmatched_retrieval_probe"),
		).toBe(false);
		store.close();
	});

	test("still warns for a probe that matched nothing anywhere", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				queries: ["совершенно отсутствующий термин"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(
			context.probeCoverage?.find(
				({ probe }) => probe === "совершенно отсутствующий термин",
			)?.status,
		).toBe("no_match");
		expect(
			context.warnings.some(({ kind }) => kind === "unmatched_retrieval_probe"),
		).toBe(true);
		store.close();
	});

	test("a filtered-out candidate never counts as matched selected evidence", async () => {
		// `packer.matchedProbeValues` records candidates the packer examined, hard
		// filters included — reporting from it let an empty packet claim a match.
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				queries: ["duplicate charge"],
				after: "2030-01-01T00:00:00.000Z",
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(context.threads).toEqual([]);
		for (const coverage of context.probeCoverage ?? []) {
			expect(coverage.matchedSelectedEvidence).toBe(false);
		}
		store.close();
	});

	test("a strong partial-term hit is not attributed as a full probe match", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", queries: ["idempotency bananas"], local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(
			context.background?.some(({ matchedProbes }) =>
				matchedProbes.includes("idempotency bananas"),
			),
		).toBeFalsy();
		expect(
			context.probeCoverage?.find(
				({ probe }) => probe === "idempotency bananas",
			)?.status,
		).toBe("no_match");
		store.close();
	});

	test("a weak lexical hit earns neither a pointer nor probe credit", async () => {
		const store = await seededStore();
		store.writePage({
			conversation: conversationFixture("platform", "channel-platform"),
			users: [userFixture()],
			posts: [
				postFixture({
					id: "ffffffffffffffffffffffffff",
					channel_id: "channel-platform",
					message: "rotating ssh keys for the build boxes",
					create_at: 30,
				}),
			],
		});
		const context = await getMattermostContext(
			{ subject: "BTB-1", queries: ["идемпотентность ретраев"], local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(
			context.background?.some(
				({ threadId }) => threadId === "ffffffffffffffffffffffffff",
			),
		).toBeFalsy();
		expect(
			context.probeCoverage?.find(
				({ probe }) => probe === "идемпотентность ретраев",
			)?.status,
		).toBe("no_match");
		store.close();
	});

	test("omits probe coverage entirely without explicit probes", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);
		expect(context.probeCoverage).toBeUndefined();
		store.close();
	});

	test("both projections carry the per-probe outcome", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{ subject: "BTB-1", queries: ["idempotency keys"], local: true },
			{ config: configFixture(), store, now: () => 2_000 },
		);
		const result = commandSuccess("context", context, context.warnings);
		const agent = projectAgentResult(result) as unknown as {
			probeCoverage?: Array<{ probe: string; status: string }>;
		};

		expect(agent.probeCoverage).toEqual(context.probeCoverage ?? []);
		const prose = formatHumanResult(result);
		expect(prose).toContain("Probe coverage:");
		expect(prose).toContain("background only (1 pointer(s))");
		store.close();
	});

	test("search has no background, so an unmatched probe still warns", async () => {
		const store = await seededStore();
		const result = await searchMattermost(
			{
				subject: "BTB-1",
				queries: ["idempotency keys"],
				channels: ["payments"],
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);

		expect(
			result.warnings.some(({ kind }) => kind === "unmatched_retrieval_probe"),
		).toBe(true);
		store.close();
	});

	test("never repeats a thread that is already selected", async () => {
		const store = await seededStore();
		const context = await getMattermostContext(
			{
				subject: "BTB-1",
				queries: ["duplicate charge"],
				local: true,
			},
			{ config: configFixture(), store, now: () => 2_000 },
		);
		const selected = new Set(context.threads.map(({ threadId }) => threadId));
		for (const pointer of context.background ?? []) {
			expect(selected.has(pointer.threadId)).toBe(false);
		}
		store.close();
	});
});
