import type { MattermostConfig } from "../config/config.ts";
import type {
	MattermostSubject,
	RoutedConversation,
	RoutingResult,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import {
	consolidateLocalFallbackWarnings,
	probeWarnings,
	routingHintWarnings,
} from "./helpers.ts";
import type {
	ContextResult,
	FreshnessEvidence,
	ProbeCoverage,
} from "./types.ts";

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

/**
 * Every packet-level warning derived after packing, in the order
 * `getMattermostContext` emitted them.
 *
 * Collected here rather than inline so the orchestrator reads as phases. Order
 * is contract-visible, so it is preserved exactly.
 */
export function collectContextWarnings(input: {
	freshenWarnings: readonly Warning[];
	remoteSearchWarnings: readonly Warning[];
	packingWarnings: readonly Warning[];
	searchIncomplete: boolean;
	hydrationFailures: number;
	hydrationBudgetSpent: boolean;
	navigate: boolean;
	navigateBudgetDropped: number;
	packedThreads: number;
	maxThreads: number;
	local: boolean;
	freshness: readonly FreshnessEvidence[];
	hasExplicitProbes: boolean;
	subjectKind: MattermostSubject["kind"];
	routing: RoutingResult;
	config: MattermostConfig;
	probeCoverage: readonly ProbeCoverage[];
}): Warning[] {
	const warnings: Warning[] = consolidateLocalFallbackWarnings([
		...input.freshenWarnings,
		...input.remoteSearchWarnings,
		...input.packingWarnings,
	]);
	if (input.searchIncomplete) warnings.push(SEARCH_DEADLINE_WARNING);
	if (input.hydrationFailures) {
		warnings.push({
			kind: "candidate_hydrate_failed",
			message: `${input.hydrationFailures} candidate thread(s) could not be retrieved and were dropped from selection.`,
		});
	}
	if (input.hydrationBudgetSpent) {
		warnings.push({
			kind: "hydration_budget",
			message:
				"The per-request thread hydration budget was spent; later candidates used locally indexed evidence only.",
		});
	}
	if (
		input.navigate &&
		input.navigateBudgetDropped > 0 &&
		input.packedThreads < input.maxThreads
	) {
		warnings.push({
			kind: "navigate_truncated_threads",
			message: `Navigate packing kept ${input.packedThreads} of up to ${input.maxThreads} thread slots; ${input.navigateBudgetDropped} candidate(s) were dropped by budget. Re-run without --navigate, or with fewer fat neighbors, to see the omitted threads.`,
		});
	}
	if (input.local && input.freshness.some(({ stale }) => stale)) {
		warnings.push({
			kind: "stale_local_index",
			message:
				"Local mode used stale conversation evidence without network reconciliation.",
		});
	}
	if (input.hasExplicitProbes && input.subjectKind !== "ticket") {
		// Ticket subjects keep probe hits in background[]; free-text/post
		// subjects let --query reshape ranking. Warn so agents do not treat a
		// probed packet as a superset of the unprobed one.
		warnings.push({
			kind: "probe_reranked_packet",
			severity: "informational",
			message:
				"--query probes can change which threads are selected and how they are packed; this packet is not a superset of the same request without --query.",
		});
	}
	if (input.freshness.some(({ coverageComplete }) => !coverageComplete)) {
		warnings.push(incompleteHistoryWarning(input.freshness));
	}
	if (!input.packedThreads) {
		warnings.push({
			kind: "no_results",
			message: "No matching Mattermost thread was found.",
		});
	}
	warnings.push(...routingHintWarnings(input.routing, input.config));
	warnings.push(...probeWarnings(input.probeCoverage));
	return warnings;
}
