import type { MattermostConfig } from "../config/config.ts";
import { ConfigError } from "../shared/errors.ts";
import type { ConversationRecord, MattermostStore } from "../store/index.ts";
import { resolveConfiguredAllowlist } from "../sync/conversations.ts";
import type {
	RankingReason,
	RoutedConversation,
	RoutingEvidenceType,
	RoutingResult,
} from "./types.ts";

export function configuredConversations(
	config: MattermostConfig,
	store: MattermostStore,
): RoutedConversation[] {
	return resolveConfiguredAllowlist(config, store).map((conversation) => ({
		...conversation,
		evidence: [],
	}));
}

export function routeConversations(
	config: MattermostConfig,
	store: MattermostStore,
	conversations: readonly RoutedConversation[],
	input: {
		channels?: readonly string[];
		scopes?: readonly string[];
		repositories?: readonly string[];
		ticketKey?: string;
		noWiden?: boolean;
	},
): RoutingResult {
	const unmatchedHints = unmatchedRoutingHints(config, input);
	const explicit = new Set(input.channels ?? []);
	if (explicit.size) {
		const known = new Set(conversations.map(({ alias }) => alias));
		const unknown = [...explicit].filter((alias) => !known.has(alias));
		if (unknown.length) {
			throw new ConfigError(
				`Unknown or unindexed conversation alias: ${unknown.join(", ")}.`,
				"unknown_conversation",
			);
		}
		return routingResult(
			conversations
				.filter(({ alias }) => explicit.has(alias))
				.map((conversation) =>
					withEvidence(conversation, "explicit_channel", conversation.alias),
				),
			"explicit_channels",
			false,
			unmatchedHints,
		);
	}

	const scopes = new Set(input.scopes ?? []);
	const scoped = conversations.flatMap((conversation) => {
		const metadata = routeMetadata(
			config,
			conversation.alias,
			conversation.kind,
		);
		const matches = metadata.scopes.filter((scope) => scopes.has(scope));
		return matches.length
			? [
					{
						...conversation,
						evidence: matches.map((value) => ({
							type: "scope" as const,
							value,
						})),
					},
				]
			: [];
	});
	if (scoped.length) {
		return routingResult(scoped, "scopes", !input.noWiden, unmatchedHints);
	}

	const repositories = new Set(input.repositories ?? []);
	const repositoryMatches = conversations.flatMap((conversation) => {
		const metadata = routeMetadata(
			config,
			conversation.alias,
			conversation.kind,
		);
		const matches = metadata.repositories.filter((repository) =>
			repositories.has(repository),
		);
		return matches.length
			? [
					{
						...conversation,
						evidence: matches.map((value) => ({
							type: "repository" as const,
							value,
						})),
					},
				]
			: [];
	});
	if (repositoryMatches.length) {
		return routingResult(
			repositoryMatches,
			"repositories",
			!input.noWiden,
			unmatchedHints,
		);
	}

	if (input.ticketKey) {
		const related = new Set(store.getConversationIdsForTicket(input.ticketKey));
		const ticketMatches = conversations
			.filter(({ id }) => related.has(id))
			.map((conversation) =>
				withEvidence(
					conversation,
					"ticket_relationship",
					input.ticketKey ?? "",
				),
			);
		if (ticketMatches.length) {
			return routingResult(
				ticketMatches,
				"ticket_relationships",
				!input.noWiden,
				unmatchedHints,
			);
		}
	}

	return routingResult(
		conversations.map((conversation) =>
			withEvidence(conversation, "all_configured", "configured"),
		),
		"all_configured",
		false,
		unmatchedHints,
	);
}

export function widenedRouting(
	all: readonly RoutedConversation[],
	initial: RoutingResult,
): RoutingResult {
	const searched = new Set(initial.conversations.map(({ id }) => id));
	return {
		conversations: all
			.filter(({ id }) => !searched.has(id))
			.map((conversation) => withEvidence(conversation, "widened", "fallback"))
			.sort(routeTieBreak),
		explicitChannelPolicy: "restrict",
		unmatchedHints: initial.unmatchedHints,
		reason: "all_configured",
		canWiden: false,
	};
}

export function routeMetadata(
	config: MattermostConfig,
	alias: string,
	kind: ConversationRecord["kind"],
) {
	const metadata =
		kind === "channel" ? config.channels[alias] : config.directMessages[alias];
	if (!metadata) {
		return { scopes: [] as string[], repositories: [] as string[] };
	}
	return metadata;
}

export function routingResult(
	conversations: RoutedConversation[],
	reason: RoutingResult["reason"],
	canWiden: boolean,
	unmatchedHints: RoutingResult["unmatchedHints"] = {
		scopes: [],
		repositories: [],
	},
): RoutingResult {
	return {
		conversations: [...conversations].sort(routeTieBreak),
		explicitChannelPolicy: "restrict",
		unmatchedHints,
		reason,
		canWiden,
	};
}

export function unmatchedRoutingHints(
	config: MattermostConfig,
	input: {
		scopes?: readonly string[];
		repositories?: readonly string[];
	},
): RoutingResult["unmatchedHints"] {
	const knownScopes = new Set<string>();
	const knownRepositories = new Set<string>();
	for (const metadata of [
		...Object.values(config.channels),
		...Object.values(config.directMessages),
	]) {
		for (const scope of metadata.scopes) knownScopes.add(scope);
		for (const repository of metadata.repositories) {
			knownRepositories.add(repository);
		}
	}
	return {
		scopes: [...new Set(input.scopes ?? [])]
			.filter((scope) => !knownScopes.has(scope))
			.sort(),
		repositories: [...new Set(input.repositories ?? [])]
			.filter((repository) => !knownRepositories.has(repository))
			.sort(),
	};
}

export function withEvidence(
	conversation: RoutedConversation,
	type: RoutingEvidenceType,
	value: string,
): RoutedConversation {
	return { ...conversation, evidence: [{ type, value }] };
}

export function routeTieBreak(
	left: Pick<RoutedConversation, "priority" | "alias">,
	right: Pick<RoutedConversation, "priority" | "alias">,
): number {
	return (
		right.priority - left.priority || left.alias.localeCompare(right.alias)
	);
}

export function routeWeight(conversation: RoutedConversation): number {
	const weights: Record<RoutingEvidenceType, number> = {
		explicit_channel: 6,
		scope: 5,
		repository: 4,
		ticket_relationship: 3,
		all_configured: 2,
		widened: 1,
	};
	return Math.max(...conversation.evidence.map(({ type }) => weights[type]), 0);
}

export function routeReason(conversation: RoutedConversation): RankingReason {
	const type = conversation.evidence[0]?.type ?? "all_configured";
	const reasons: Record<RoutingEvidenceType, RankingReason> = {
		explicit_channel: "routing_explicit_channel",
		scope: "routing_scope",
		repository: "routing_repository",
		ticket_relationship: "routing_ticket_relationship",
		all_configured: "routing_all_configured",
		widened: "routing_widened",
	};
	return reasons[type];
}
