import type { MattermostConfig } from "../config/config.ts";
import {
	type AgentProbeInput,
	classifySubject,
	configuredConversations,
	type MattermostSubject,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingResult,
	resolveProbes,
	routeConversations,
} from "../search/index.ts";
import { ConfigError } from "../shared/errors.ts";
import type { MattermostStore, ThreadSearchFilters } from "../store/index.ts";
import { resolveSearchFilters } from "./filters.ts";
import { resolveContextConversations } from "./freshen.ts";
import type { SearchFilterInput, SearchFilters } from "./types.ts";

export interface PreparedSearch {
	subject: MattermostSubject;
	probes: RetrievalProbe[];
	resolvedFilters: {
		storage: ThreadSearchFilters;
		output: SearchFilters;
	};
	all: RoutedConversation[];
	routing: RoutingResult;
}

export function prepareSearch(
	input: {
		config: MattermostConfig;
		store: MattermostStore;
		subject?: string;
		ticket?: string;
		queries?: readonly string[];
		probes?: readonly AgentProbeInput[];
		channels?: readonly string[];
		scopes?: readonly string[];
		repositories?: readonly string[];
		noWiden?: boolean;
		contextConversations?: boolean;
	} & SearchFilterInput,
): PreparedSearch {
	const subject = classifySubject(
		input.subject ?? input.queries?.[0] ?? input.probes?.[0]?.value,
		input.ticket,
	);
	const probes = resolveProbes(
		subject,
		input.queries,
		input.config.synonyms,
		input.probes,
		input.config.concepts,
	);
	const resolvedFilters = resolveSearchFilters(input);
	const all = input.contextConversations
		? resolveContextConversations(input.config, input.store, input.channels)
		: configuredConversations(input.config, input.store);
	const routing = routeConversations(input.config, input.store, all, {
		channels: input.channels,
		scopes: input.scopes,
		repositories: input.repositories,
		ticketKey: subject.kind === "ticket" ? subject.ticketKey : undefined,
		noWiden: input.noWiden,
	});
	return { subject, probes, resolvedFilters, all, routing };
}

export function assertRemoteSearchAllowed(input: {
	local?: boolean;
	remoteSearch?: boolean;
	subject: MattermostSubject;
}): void {
	if (input.local && input.remoteSearch) {
		throw new ConfigError(
			"Remote search cannot be combined with local-only mode.",
			"invalid_remote_search_mode",
		);
	}
	if (input.subject.kind === "post" && input.remoteSearch) {
		throw new ConfigError(
			"Remote search requires a textual or ticket subject.",
			"invalid_remote_search_subject",
		);
	}
}
