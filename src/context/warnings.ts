import type { RoutedConversation } from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import type { ContextResult, FreshnessEvidence } from "./types.ts";

/** Named aliases appended to `incomplete_history` prose (opaque by contract). */
const MAX_NAMED_CUTOFF_CONVERSATIONS = 3;

/**
 * `": b2b-team, backend-zone"` (or `" +2 more"` beyond the cap) for the
 * conversations whose indexed history is cutoff-bounded; empty when none are.
 */
export function cutoffBoundedAliasSuffix(
	freshness: readonly FreshnessEvidence[],
): string {
	const aliases = [
		...new Set(
			freshness
				.filter(({ coverageComplete }) => !coverageComplete)
				.map(({ alias }) => alias)
				.filter((alias) => alias.length > 0),
		),
	];
	if (!aliases.length) return "";
	const named = aliases.slice(0, MAX_NAMED_CUTOFF_CONVERSATIONS).join(", ");
	const remaining = aliases.length - MAX_NAMED_CUTOFF_CONVERSATIONS;
	return remaining > 0 ? `: ${named} +${remaining} more` : `: ${named}`;
}

export const SEARCH_DEADLINE_WARNING: Warning = {
	kind: "search_deadline",
	message:
		"Local search stopped early after the soft deadline; returned evidence may be incomplete.",
};

/** Emitted when any searched conversation is only indexed back to a cutoff. */
export function incompleteHistoryWarning(
	freshness: readonly FreshnessEvidence[],
): Warning {
	return {
		kind: "incomplete_history",
		message: `At least one searched conversation has cutoff-bounded history${cutoffBoundedAliasSuffix(freshness)}.`,
	};
}

export function remoteSearchFailureWarning(failures: number): Warning {
	return {
		kind: "remote_search_failed",
		message: `${failures} bounded Mattermost search request(s) failed; local evidence remains available.`,
	};
}

/** The routing-evidence view of searched conversations carried in results. */
export function summarizeConversations(
	conversations: readonly RoutedConversation[],
): ContextResult["searchedConversations"] {
	return conversations.map((conversation) => ({
		id: conversation.id,
		alias: conversation.alias,
		kind: conversation.kind,
		evidence: conversation.evidence,
	}));
}
