/**
 * Leaf values shared by more than one envelope builder.
 *
 * Both lived in `context.ts`, which made `search.ts` and `summary.ts` import
 * the largest module in the projection just to reach a status word and a status
 * set.
 */
import type { PermalinkResolution } from "../../../context/types.ts";
import type { AgentStatus } from "../types.ts";

export const BLOCKED_PERMALINK_STATUSES = new Set<
	PermalinkResolution["status"]
>(["not_allowed", "unresolved", "invalid"]);

export function status(
	freshnessMode: "local" | "network" | "forced",
): AgentStatus {
	return {
		freshness: freshnessMode === "local" ? "local" : "network",
	};
}
