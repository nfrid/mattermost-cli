/**
 * Candidate retrieval for `context`: resolve a subject to ranked thread
 * candidates, widening and freshening as the subject kind requires.
 *
 * Split out of `getMattermostContext`, which had grown into one 600-line
 * function. This is the first of its phases and the only one that decides
 * *which* threads are eligible; packing, diagnostics, and assembly follow.
 */
import type { MattermostConfig } from "../config/config.ts";
import {
	directCandidate,
	type MattermostSubject,
	type RoutedConversation,
	type RoutingResult,
	type ThreadCandidate,
	widenedRouting,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import {
	ConfigError,
	conversationNotAllowedDetails,
} from "../shared/errors.ts";
import type { MattermostStore, ThreadSearchFilters } from "../store/index.ts";
import {
	freshen,
	resolveContextConversations,
	selectFreshenConversations,
} from "./freshen.ts";
import { resolveDirectTarget } from "./hydrate.ts";
import type { ThreadSearcher } from "./thread-search.ts";
import type { ContextClient, ContextInput } from "./types.ts";

export interface RetrievedCandidates {
	/** Routing as finally used — widened when widening happened. */
	routing: RoutingResult;
	candidates: ThreadCandidate[];
	performedWidening: boolean;
	/** Routing kept aside for a second widening attempt after packing. */
	fallbackRouting: RoutingResult | undefined;
	freshenedConversationCount: number;
}

export interface RetrieveInput {
	config: MattermostConfig;
	store: MattermostStore;
	client: ContextClient | undefined;
	input: ContextInput;
	subject: MattermostSubject;
	routing: RoutingResult;
	all: readonly RoutedConversation[];
	storageFilters: ThreadSearchFilters;
	searcher: ThreadSearcher;
	searched: Map<string, RoutedConversation>;
	warnings: Warning[];
	observedAt: number;
}

export async function retrieveCandidates(
	options: RetrieveInput,
): Promise<RetrievedCandidates> {
	return options.subject.kind === "post"
		? await retrieveDirectPost(options)
		: await retrieveRouted(options);
}

/**
 * A `--permalink`-style post subject. Resolved against every *configured*
 * conversation, not the `--channel` subset: a post excluded by the caller's own
 * restriction must be reported as that, not as missing from the config.
 */
async function retrieveDirectPost(
	options: RetrieveInput,
): Promise<RetrievedCandidates> {
	const { config, store, client, input, subject, all } = options;
	if (subject.kind !== "post") throw new Error("Direct post subject expected.");
	const configured = resolveContextConversations(config, store);
	const direct = await resolveDirectTarget(
		subject.postId,
		store,
		client,
		new Set(configured.map(({ id }) => id)),
		{ preferLocal: !input.fresh, warnings: options.warnings },
	);
	const conversation = all.find(({ id }) => id === direct.conversationId);
	if (!conversation) {
		// Reachable only under an explicit restriction: without one, `all` is
		// the same set the post already resolved against.
		const restricted = input.channels?.length
			? { reason: "channel_restriction" as const, restrictedTo: input.channels }
			: { reason: "not_configured" as const };
		throw new ConfigError(
			restricted.reason === "channel_restriction"
				? "The direct post is outside the explicit channel restriction."
				: "The direct post is outside configured conversations.",
			"conversation_not_allowed",
			undefined,
			conversationNotAllowedDetails({
				...restricted,
				postId: subject.postId,
				conversationId: direct.conversationId,
			}),
		);
	}
	const routing: RoutingResult = {
		conversations: [
			{
				...conversation,
				evidence: input.channels?.length
					? [{ type: "explicit_channel", value: conversation.alias }]
					: [{ type: "all_configured", value: "direct_post" }],
			},
		],
		explicitChannelPolicy: "restrict",
		unmatchedHints: options.routing.unmatchedHints,
		reason: input.channels?.length ? "explicit_channels" : "all_configured",
		canWiden: false,
	};
	await freshen(
		config,
		store,
		client,
		routing.conversations,
		Boolean(input.fresh),
		options.warnings,
	);
	const directConversation = routing.conversations[0];
	if (!directConversation) {
		throw new ConfigError("Direct post routing failed.", "routing_failed");
	}
	return {
		routing,
		candidates: store.threadMatchesFilters(
			direct.threadId,
			options.storageFilters,
		)
			? [directCandidate(direct, directConversation)]
			: [],
		performedWidening: false,
		fallbackRouting: undefined,
		freshenedConversationCount: 0,
	};
}

/** Ticket and free-text subjects: search routed conversations, widen if empty. */
async function retrieveRouted(
	options: RetrieveInput,
): Promise<RetrievedCandidates> {
	const {
		config,
		store,
		client,
		input,
		subject,
		all,
		searcher,
		searched,
		observedAt,
	} = options;
	let routing = options.routing;
	let performedWidening = false;
	const fallbackRouting = routing.canWiden ? routing : undefined;
	let candidates = searcher.search(routing);

	if (!candidates.length && routing.canWiden) {
		const widened = widenedRouting(all, routing);
		if (widened.conversations.length) {
			performedWidening = true;
			for (const conversation of routing.conversations) {
				searched.set(conversation.id, conversation);
			}
			routing = widened;
			candidates = searcher.search(widened);
		}
	}

	const freshenTargets = selectFreshenConversations(
		config,
		store,
		routing,
		subject,
		candidates,
		Boolean(input.fresh),
		observedAt,
	);
	await freshen(
		config,
		store,
		client,
		freshenTargets,
		Boolean(input.fresh),
		options.warnings,
	);
	if (freshenTargets.length) {
		searcher.invalidate();
		candidates = searcher.search(routing);
	}

	return {
		routing,
		candidates,
		performedWidening,
		fallbackRouting,
		freshenedConversationCount: freshenTargets.length,
	};
}
