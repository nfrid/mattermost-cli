import type { MattermostConfig } from "../config/config.ts";
import {
	configuredConversations,
	type MattermostSubject,
	type RoutedConversation,
	type RoutingResult,
	type ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { ConfigError } from "../shared/errors.ts";
import {
	FRESHEN_LOCK_STALE_MS,
	FRESHEN_LOCK_TIMEOUT_MS,
} from "../shared/limits.ts";
import { freshenLockPath, withFileLock } from "../shared/lock.ts";
import type { MattermostStore } from "../store/index.ts";
import { inspectFreshness, syncConfiguredConversations } from "../sync/sync.ts";
import { isRecoverableRemoteError } from "./helpers.ts";
import type { ContextClient } from "./types.ts";

const MAX_CONTEXT_FRESHEN_CONVERSATIONS = 8;

export async function freshen(
	config: MattermostConfig,
	store: MattermostStore,
	client: ContextClient | undefined,
	conversations: readonly RoutedConversation[],
	force: boolean,
	warnings: Warning[] = [],
): Promise<void> {
	if (!client || !conversations.length) return;
	const aliases = force
		? conversations.map(({ alias }) => alias)
		: inspectFreshness(config, store, conversations)
				.filter(({ stale }) => stale)
				.map(({ alias }) => alias);
	if (!aliases.length) return;

	const run = async () => {
		try {
			await syncConfiguredConversations(config, client, store, { aliases });
		} catch (error) {
			if (isRecoverableRemoteError(error)) {
				warnings.push({
					kind: "remote_freshen_failed",
					message:
						"Network reconciliation failed; continuing with local evidence.",
				});
				return;
			}
			throw error;
		}
	};
	const lockPath = freshenLockPath(config.databasePath);
	if (!lockPath) {
		await run();
		return;
	}
	const locked = await withFileLock(lockPath, run, {
		timeoutMs: FRESHEN_LOCK_TIMEOUT_MS,
		staleMs: FRESHEN_LOCK_STALE_MS,
	});
	if (!locked.acquired) {
		warnings.push({
			kind: "freshen_lock_busy",
			message:
				"Skipped network reconciliation because another mm process holds the freshen lock; using local evidence.",
		});
	}
}

export function resolveContextConversations(
	config: MattermostConfig,
	store: MattermostStore,
	aliases?: readonly string[],
): RoutedConversation[] {
	const all = configuredConversations(config, store);
	if (!aliases?.length) return all;
	const allowed = new Set(aliases);
	const selected = all.filter(({ alias }) => allowed.has(alias));
	const missing = aliases.filter(
		(alias) => !selected.some((conversation) => conversation.alias === alias),
	);
	if (missing.length) {
		throw new ConfigError(
			`Unknown or unresolved configured conversation alias: ${missing.join(", ")}.`,
			"unknown_conversation",
		);
	}
	return selected;
}

/**
 * Freshen only what retrieval needs. When local search already found
 * candidates, skip channel sync — selected threads are refreshed via hydrate.
 * Otherwise refresh a capped stale set (or ticket-related conversations) so a
 * cold index can discover new hits, unless --fresh forces the scoped set.
 */
export function selectFreshenConversations(
	config: MattermostConfig,
	store: MattermostStore,
	routing: RoutingResult,
	subject: MattermostSubject,
	candidates: readonly ThreadCandidate[],
	force: boolean,
	now: number,
): RoutedConversation[] {
	const limit = (conversations: readonly RoutedConversation[]) =>
		force
			? [...conversations]
			: conversations.slice(0, MAX_CONTEXT_FRESHEN_CONVERSATIONS);

	if (force) {
		return limit(narrowTicketConversations(store, routing, subject));
	}
	if (candidates.length) {
		return [];
	}
	const staleIds = new Set(
		inspectFreshness(config, store, routing.conversations, now)
			.filter(({ stale }) => stale)
			.map(({ conversationId }) => conversationId),
	);
	if (!staleIds.size) return [];

	const staleRouted = routing.conversations.filter(({ id }) =>
		staleIds.has(id),
	);
	if (subject.kind === "ticket") {
		const related = narrowTicketConversations(
			store,
			{ ...routing, conversations: staleRouted },
			subject,
		);
		if (related.length) return limit(related);
	}
	return limit(staleRouted);
}

export function narrowTicketConversations(
	store: MattermostStore,
	routing: RoutingResult,
	subject: MattermostSubject,
): RoutedConversation[] {
	if (subject.kind !== "ticket") return [...routing.conversations];
	const relatedIds = new Set(
		store.getConversationIdsForTicket(subject.ticketKey),
	);
	if (!relatedIds.size) return [...routing.conversations];
	const narrowed = routing.conversations.filter(({ id }) => relatedIds.has(id));
	return narrowed.length ? narrowed : [...routing.conversations];
}
