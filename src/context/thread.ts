import { packThread } from "../evidence/packing.ts";
import {
	connectionFromConfig,
	MattermostClient,
} from "../mattermost/client.ts";
import { classifySubject } from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { ConfigError } from "../shared/errors.ts";
import { inspectFreshness } from "../sync/sync.ts";
import { resolveContextConversations } from "./freshen.ts";
import {
	consolidateLocalFallbackWarnings,
	freshnessEvidence,
	postLink,
} from "./helpers.ts";
import { hydrateThread, resolveDirectTarget } from "./hydrate.ts";
import { withResources } from "./resources.ts";
import type {
	ContextDependencies,
	ThreadInput,
	ThreadResult,
} from "./types.ts";
import { cutoffBoundedAliasSuffix } from "./warnings.ts";

export async function getMattermostThread(
	input: ThreadInput,
	dependencies: ContextDependencies = {},
): Promise<ThreadResult> {
	return withResources(dependencies, async (config, store, providedClient) => {
		const subject = classifySubject(input.target);
		if (subject.kind !== "post") {
			throw new ConfigError(
				"Thread target must be a post ID or permalink.",
				"invalid_post_target",
			);
		}
		if (
			(input.beforePosts !== undefined || input.afterPosts !== undefined) &&
			!input.around
		) {
			throw new ConfigError(
				"--before-posts and --after-posts require --around.",
				"invalid_around_options",
			);
		}
		const client = input.local
			? undefined
			: (providedClient ?? new MattermostClient(connectionFromConfig(config)));
		const all = resolveContextConversations(config, store);
		const warnings: Warning[] = [];
		const observedAt = dependencies.now?.() ?? Date.now();
		const target = await resolveDirectTarget(
			subject.postId,
			store,
			client,
			new Set(all.map(({ id }) => id)),
			{ preferLocal: !input.fresh, warnings },
		);
		const conversation = all.find(({ id }) => id === target.conversationId);
		if (!conversation) {
			throw new ConfigError(
				"The thread is outside configured conversations.",
				"conversation_not_allowed",
			);
		}
		const initiallyFresh = !inspectFreshness(
			config,
			store,
			[conversation],
			observedAt,
		).some(({ stale }) => stale);
		const forceRemote = Boolean(input.fresh) || !initiallyFresh;
		const usedRemote = Boolean(client) && forceRemote;
		const rootPostId = target.rootId || target.id;
		const hydrated = await hydrateThread(
			rootPostId,
			conversation,
			store,
			client,
			target.id,
			{
				forceRemote,
				freshnessSeconds: config.freshnessSeconds,
				now: observedAt,
				warnings,
			},
		);
		const packed = packThread(rootPostId, hydrated.posts, {
			matchingPostIds: [target.id],
			aroundPostId: input.around,
			beforePosts: input.beforePosts,
			afterPosts: input.afterPosts,
			neighborhoodRadius: config.budgets.matchNeighborhoodRadius,
			clusterMergeGap: config.budgets.clusterMergeGap,
			limit: config.budgets.defaultPerThreadCharacters,
			full: input.full,
		});

		const localFreshness = freshnessEvidence(
			config,
			store,
			[conversation],
			observedAt,
		)[0];
		if (!localFreshness) {
			throw new ConfigError(
				"Thread freshness could not be evaluated.",
				"routing_failed",
			);
		}
		const degradedToLocal = warnings.some(
			({ kind }) =>
				kind === "remote_hydrate_failed" ||
				kind === "remote_resolve_failed" ||
				kind === "local_index_fallback",
		);
		const stayedLocal = Boolean(input.local) || !usedRemote || degradedToLocal;
		const freshness = stayedLocal
			? localFreshness
			: {
					...localFreshness,
					observedAt,
					ageSeconds: 0,
					stale: false,
					coverageComplete: true,
				};
		if (stayedLocal && freshness.stale) {
			warnings.push({
				kind: "stale_local_index",
				message: "Local thread evidence is stale.",
			});
		}
		if (stayedLocal && !freshness.coverageComplete) {
			warnings.push({
				kind: "incomplete_history",
				message: `Local thread evidence comes from cutoff-bounded history${cutoffBoundedAliasSuffix([freshness])}.`,
			});
		}
		return {
			subject,
			freshnessMode: stayedLocal ? "local" : "network",
			complete: stayedLocal
				? !freshness.stale && freshness.coverageComplete
				: true,
			freshness,
			conversation: {
				id: conversation.id,
				alias: conversation.alias,
				kind: conversation.kind,
			},
			link: postLink(config, rootPostId),
			thread: packed,
			warnings: consolidateLocalFallbackWarnings(warnings),
			...(input.brief ? { brief: true } : {}),
			...(input.signals ? { signals: true } : {}),
		};
	});
}
