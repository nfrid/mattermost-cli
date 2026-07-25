/**
 * Public surface of the `--agent` projection. The projection itself lives in
 * `./agent/`: `result.ts` (per-command envelopes), `thread.ts` (packed thread
 * fields), `messages.ts` (timeline and message grouping), `related-tickets.ts`,
 * and `types.ts` (the emitted shapes).
 */
export { projectAgentResult } from "./agent/result.ts";
export type * from "./agent/types.ts";
