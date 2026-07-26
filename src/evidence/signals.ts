/**
 * Advisory thread signals.
 *
 * The implementation lives in `./signals/`, split along the four seams the
 * single 2200-line module had grown: `types.ts` (the emitted vocabulary and its
 * caps), `cues.ts` (the hand-calibrated cue tables — data only), `matching.ts`
 * (surface matching, sentence guards, telemetry, classification), `spans.ts`
 * (candidate spans, outcome window, role hints), and `brief.ts` (the lean
 * thread brief assembled on top).
 *
 * This module is the stable import site; the split is internal.
 */
export { briefRetainedPostIds, buildThreadBrief } from "./signals/brief.ts";
export { cueInventory } from "./signals/cues.ts";
export {
	buildThreadSignals,
	citedSignalPostIds,
	isCandidateSpanKind,
} from "./signals/spans.ts";
export type * from "./signals/types.ts";
export {
	DECISION_CONFIDENCE_FLOOR,
	MAX_BRIEF_OUTCOME_WINDOW_POSTS,
	MAX_CANDIDATE_SPANS,
	MAX_CUES_PER_SIGNAL,
	MAX_DECISION_POST_IDS,
	MAX_HINT_EVIDENCE_POST_IDS,
	MAX_OPEN_QUESTIONS,
	MAX_OUTCOME_WINDOW_POSTS,
	MAX_PURPOSE_HINTS,
	MAX_REFINEMENTS_PER_DECISION,
} from "./signals/types.ts";
