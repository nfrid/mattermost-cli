# JSON contract

Add `--json` to emit exactly one minified JSON document on stdout. Use
`--pretty` instead for indented JSON when debugging. Progress and human
diagnostics never share JSON stdout.

For the agent-oriented projection, see [Agent output](agent-output.md).

## Envelope

Every result has:

```json
{
  "command": "context",
  "schemaVersion": 5,
  "success": true,
  "data": {},
  "warnings": []
}
```

Failures replace `data` with a stable error containing `source`, `kind`, and
`message`. Warnings appear only once at the top level.

## Retrieval contracts

Retrieval contracts include:

- freshness mode and timestamps;
- `searchCoverageComplete`, and `selectedThreadsComplete` for context packets;
- searched conversations and routing evidence, including unmatched hints;
- explicit-channel and widening state;
- deterministic ranking reasons and order;
- candidate permalinks, budgets, and omission counts.

Context packets additionally expose:

- whether bounded remote search was requested or performed, its trigger,
  per-probe accepted counts, failures, and `remote_search` selection reasons;
- an `evidence` summary — `adequacy`, selected-evidence `currency`,
  `completeness` (including separate discovery freshness), actionable `next[]`,
  selection drop counts and `droppedCandidates[]`, and packing stats;
- `selection` drop counts;
- one-hop `relatedTickets` pointers;
- per-thread ticket-window fields: `ticketDensity`, `nearestTicketDistance`,
  `segments`.

The legacy `complete` field remains an alias for search coverage.

## Evidence axes

`evidence.verdict` rolls the detailed axes into the four booleans a reader
actually decides on — `canAnswerFromSelectedEvidence`,
`mayHaveMissedOtherThreads`, `selectedEvidenceMayBeStale`,
`recommendedActionRequired`. It is derived from the axes below it; keep using
those for audit.

`mayHaveMissedOtherThreads` deliberately ignores a merely budget-bounded weak
tail. It is set by stale discovery, by bounded history on a packet that is not
otherwise trusted, or by `evidence.selection.droppedByBudgetSubjectMatched > 0`
— the unexamined candidates that actually named the subject ticket or matched it
as a phrase or structured entity, as opposed to the long morphology/typo tail
that made `budget_bounded` look alarming on every probed request.

`evidence.completeness.selectedThreads` is `complete` | `truncated` |
`not_applicable`, the last when no thread was selected at all — an empty packet
has no transcript to call truncated.

`evidence.completeness.selection` is a separate axis: `budget_bounded` means
ranked candidates were never examined because thread/character room or the
hydration ceiling ran out, so the packet cannot speak for them.
`selectedThreads: "complete"` alongside it only means nothing was dropped
*inside* the selected threads. When enough candidates went unexamined,
`evidence.next` adds an `optional` `review_candidates` step carrying
`["mm","search",<subject>,"--agent"]`.

`evidence.selection.droppedNoMatch` counts candidates that ranked but carried no
current content match. `dropReason: "unavailable"` marks a candidate whose
thread could not be retrieved, so it was never judged.

When some searched conversation is cutoff-bounded,
`evidence.history.cutoffBounded[]` names each one with `oldestIndexedAt` and
`inSelectedThreads` (capped, with `additional`).

## Probe coverage

With explicit `--query` probes, context packets carry `probeCoverage[]` — one
entry per probe with `matchedSelectedEvidence`, `backgroundThreads`, and
`status` (`matched_selected` | `background_only` | `no_match`).

`background_only` means the probe matched no selected evidence but is exactly
why a `background[]` pointer exists, which is a reportable outcome rather than a
defect. Only `no_match` also raises the `unmatched_retrieval_probe` warning, so
that warning no longer fires on every probed request.

## Schema policy

- Compatible optional or additive fields may retain the current
  `schemaVersion`.
- Removing or renaming a field, changing its meaning or type, changing required
  ordering, or changing error source/kind semantics requires a schema-version
  increment. Widening an existing enum counts, since a strict consumer cannot
  parse the new value.
- Human prose is opaque and may change without a schema-version increment.

### History

**Version 4** adds `completeness.selectedThreads: "not_applicable"` alongside
the additive `people[]`, `timeline[]`, `brief.openQuestions[]`,
`decisions[].refinements[]`, and the `people` command.

**Version 5** widens `evidence.next[].impact` with
`may_verify_quantitative_claim` and reorders `brief.decisions[]` by `kind`
before confidence, alongside the additive `evidence.verdict`,
`evidence.selection.droppedByBudgetSubjectMatched`, `probeCoverage[]`,
`permalinks[]`, per-thread `totalPosts`, `conversation_not_allowed`
`error.details`, and the `brief` decision-layer fields (`kind`,
`textTruncated`). Permalink refusal details may additionally retain the safe,
caller-supplied `postId`; `conversationId` remains restricted to a configured
conversation excluded by the caller's own `--channel`. Brief entries may also
carry additive `decisions[].acknowledgement` and packet-local
`openQuestions[].resolution` / `responsePostIds`.

## Schemas and fixtures

Zod schemas and inferred TypeScript types for every command are exported from
the package, including `commandResultV1Schema`, command-specific
`*ResultV1Schema` values, and `parseCommandResultV1`. Complete synthetic golden
documents live in `src/contracts/contracts.v1.fixture.json`.
