/**
 * Ranking.
 *
 * The implementation lives in `./ranking/`, split into the layers the single
 * 980-line module had grown: `proximity.ts` (term-closeness evidence),
 * `reasons.ts` (the contract-visible `reasons[]` vocabulary),
 * `thread-evidence.ts` (whether a thread's content supports the subject), and
 * `candidate.ts` (assembling one ranked candidate on top of the rest).
 *
 * This module is the stable import site; the split is internal.
 */
export { candidateFromGroup } from "./ranking/candidate.ts";
export {
	buildRankingReasons,
	type RankingReasonInput,
} from "./ranking/reasons.ts";
export { evaluateThreadEvidence } from "./ranking/thread-evidence.ts";
