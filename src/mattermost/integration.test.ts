import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMattermostConfig } from "../config.ts";
import {
	getMattermostContext,
	getMattermostThread,
	searchMattermost,
} from "../context.ts";
import { contextResultV1Schema } from "../contracts.ts";
import { commandSuccess } from "../results.ts";
import { validateConfiguredConversations } from "../setup.ts";
import { MattermostStore } from "../storage.ts";
import { syncConfiguredConversations } from "../sync.ts";
import { MattermostClient } from "./client.ts";

const enabled = Bun.env.MATTERMOST_INTEGRATION === "1";

test.skipIf(!enabled)(
	"Mattermost 11.9 supports independent page and since channel reads",
	async () => {
		const channelId = Bun.env.MATTERMOST_SMOKE_CHANNEL_ID?.trim();
		if (!channelId) {
			throw new Error(
				"MATTERMOST_SMOKE_CHANNEL_ID must name a safe configured conversation.",
			);
		}
		const config = await loadMattermostConfig();
		const configuredIds = new Set([
			...Object.values(config.channels).flatMap(({ id }) => (id ? [id] : [])),
			...Object.values(config.directMessages).map(({ channelId }) => channelId),
		]);
		if (!configuredIds.has(channelId)) {
			throw new Error(
				"MATTERMOST_SMOKE_CHANNEL_ID is not an explicitly configured conversation ID.",
			);
		}
		const client = new MattermostClient(config);
		const [page, recent] = await Promise.all([
			client.getChannelPosts(channelId, { page: 0, perPage: 1 }),
			client.getChannelPosts(channelId, {
				since: Math.max(0, Date.now() - config.reconciliationOverlapMs),
				perPage: 1,
			}),
		]);
		expect(Array.isArray(page.order)).toBe(true);
		expect(Array.isArray(recent.order)).toBe(true);
	},
);

test.skipIf(!enabled)(
	"standalone V1 read-only smoke gate against Mattermost 11.9",
	async () => {
		const config = await loadMattermostConfig();
		const channelId = requiredEnvironment("MATTERMOST_SMOKE_CHANNEL_ID");
		const postId = requiredEnvironment("MATTERMOST_SMOKE_POST_ID");
		const query = requiredEnvironment("MATTERMOST_SMOKE_QUERY");
		const channelEntry = Object.entries(config.channels).find(
			([, channel]) => channel.id === channelId,
		);
		if (!channelEntry) {
			throw new Error(
				"MATTERMOST_SMOKE_CHANNEL_ID must be an explicitly configured channel ID.",
			);
		}
		const directMessageId = Bun.env.MATTERMOST_SMOKE_DM_ID?.trim();
		const directMessageEntry = directMessageId
			? Object.entries(config.directMessages).find(
					([, dm]) => dm.channelId === directMessageId,
				)
			: undefined;
		if (directMessageId && !directMessageEntry) {
			throw new Error(
				"MATTERMOST_SMOKE_DM_ID must be an explicitly configured direct-message ID.",
			);
		}

		const directory = await mkdtemp(join(tmpdir(), "mattermost-smoke-"));
		try {
			const smokeConfig = {
				...config,
				databasePath: join(directory, "smoke.sqlite3"),
				historyDays: 1,
				pageSize: Math.min(config.pageSize, 10),
				channels: { [channelEntry[0]]: channelEntry[1] },
				directMessages: directMessageEntry
					? { [directMessageEntry[0]]: directMessageEntry[1] }
					: {},
			};
			const client = new MattermostClient(smokeConfig);
			expect((await client.getCurrentUser()).id).toBeTruthy();
			expect((await client.getTeam(smokeConfig.teamId)).id).toBe(
				smokeConfig.teamId,
			);
			expect(
				(await validateConfiguredConversations(smokeConfig, client)).data.valid,
			).toBe(true);

			const store = await MattermostStore.open(smokeConfig.databasePath);
			try {
				const aliases = [
					channelEntry[0],
					...(directMessageEntry ? [directMessageEntry[0]] : []),
				];
				const initial = await syncConfiguredConversations(
					smokeConfig,
					client,
					store,
					{ aliases },
				);
				expect(initial.conversations).toHaveLength(aliases.length);
				const incremental = await syncConfiguredConversations(
					smokeConfig,
					client,
					store,
					{ aliases },
				);
				expect(
					incremental.conversations.every(({ mode }) => mode === "incremental"),
				).toBe(true);

				const localSearch = await searchMattermost(
					{ subject: query, channels: [channelEntry[0]] },
					{ config: smokeConfig, store },
				);
				expect(localSearch.freshnessMode).toBe("local");
				expect(localSearch.searchedConversations).toHaveLength(1);
				expect(localSearch.candidates.length).toBeGreaterThan(0);

				const thread = await getMattermostThread(
					{ target: postId },
					{ config: smokeConfig, store, client },
				);
				expect(thread.complete).toBe(true);
				expect(thread.thread.totalPosts).toBeGreaterThan(0);

				const boundedConfig = {
					...smokeConfig,
					budgets: {
						...smokeConfig.budgets,
						defaultMaxCharacters: 1,
						defaultPerThreadCharacters: 1,
						defaultMaxThreads: 1,
					},
				};
				const context = await getMattermostContext(
					{ subject: query, channels: [channelEntry[0]], local: true },
					{ config: boundedConfig, store },
				);
				contextResultV1Schema.parse(
					commandSuccess("context", context, context.warnings),
				);
				expect(context.budget.limit).toBe(1);
				expect(context.threads).toHaveLength(1);
				expect(context.threads[0]?.omittedPosts).toBeGreaterThan(0);
			} finally {
				store.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

function requiredEnvironment(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the V1 smoke gate.`);
	return value;
}
