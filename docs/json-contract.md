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
- one-hop `relatedTickets` pointers (`trackerUrl` / `unresolvableTracker`
  when no Mattermost thread resolves);
- per-thread ticket-window fields: `ticketDensity`, `nearestTicketDistance`,
  `segments`.

The legacy `complete` field remains an alias for search coverage.

## Evidence axes

`evidence.verdict` rolls the detailed axes into the four booleans a reader
actually decides on — `canAnswerFromSelectedEvidence`,
`mayHaveMissedOtherThreads`, `selectedEvidenceMayBeStale`,
`recommendedActionRequired`. It is derived from the axes below it; keep using
those for audit. When `mayHaveMissedOtherThreads` is true, additive
`mayHaveMissedReason` names the cause (`index_cutoff` | `stale_discovery` |
`subject_matched_budget_drops` | `local_discovery`). Every `true` verdict flag
either has a covering `evidence.next` step or sets `noActionAvailable` with
`noActionReason` so agents never stall on a lit flag with an empty `next[]`.
When `recommendedActionRequired` is already true, `noActionAvailable` is
suppressed so the two flags never contradict; residual uncovered axes stay
visible via `mayHaveMissedReason` / the other verdict booleans.

`mayHaveMissedOtherThreads` deliberately ignores a merely budget-bounded weak
tail. It is set by stale or local-only discovery, by bounded history on a packet
that is not otherwise trusted, or by
`evidence.selection.droppedByBudgetSubjectMatched > 0`
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
why a non-noise `background[]` pointer exists, which is a reportable outcome
rather than a defect. `matchMode: "normalized_terms_or_expansions"` and
`retrievalCriteria[]` name the exact full-probe qualification used here; they are
not a semantic-equivalence claim. Only `no_match` also raises the
`unmatched_retrieval_probe` warning, so that warning no longer fires on every
probed request. A `no_match` may carry an informational `hint` when a Russian
probe term looks like a truncated stem (suggest a full word form); Russian
prefix search stays off by default.

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
caller-supplied `postId`; `conversationId` / `conversationAlias` remain
restricted to a configured conversation excluded by the caller's own
`--channel`, with `restrictionSource: "cli"` explicit. Brief entries may also
carry additive `decisions[].acknowledgement` and packet-local
`openQuestions[].resolution` / `responsePostIds`. Packing may expose
`recommendedHydrationThreadIds`; the historical `recommendFullThreadIds` stays
as a V1 compatibility alias even when the recommended action is bounded
`thread_around`. Version 5 already includes `thread_around` in the
`evidence.next[].action` enum; this release begins emitting it for skips with a
usable boundary. Generated commands include `--window-only`; their response
adds `retrieval.mode: "gap_window"` and `evidence.scope: "gap_recovery"`, where
`gapRecovery.requestedRangeComplete` reports delta completion independently of
the packet-local general answerability verdict. `file --inspect` additively
attaches either a bounded textual
`inspection` preview or an explicit `not_interpreted` state to the existing file
result. Preview inspection may add best-effort
`sensitiveFieldsDetected` / `redactionApplied`; attachment projections add an
`inspectCommand` alongside the download-only `downloadCommand`. Search-agent candidates may carry capped `contributingProbes[]` (match
contributors, not full-probe claims); raw JSON now retains
additional already-computed ranking evidence (`thinTicketStub`,
`multiTicketRoot`, ticket distance/density, and root focus) instead of stripping
it during schema parsing. Warnings may add `severity: "material" |
"informational"` (absence remains material), and strict no-match probe coverage
may add selected-evidence `matchedTerms`, `missingTerms`, and bounded
`partialEvidencePostIds` without changing ranking or match status.
Agent projection may additively carry a top-level merged `brief` under
`projection: "brief"`, `openQuestions[].responseExcerpts` for
`possibly_answered`, and a thin deterministic `researchSummary`.
`evidence.next[].impact` may be `cannot_verify_quantities` for workbook
attachments on decision-layer posts. `gapRecovery` remains exclusive to
`thread --window-only --agent`. Additive fields may also carry
`verdict.mayHaveMissedReason` / `verdict.noActionAvailable`,
`impact: "requires_external_reader"` for image / legacy workbook (`xls` /
`ods`) `read_attachments`, machine-readable `downloaded`/`inspected` on file
inspection, bounded OOXML `.xlsx` `inspection` previews (`format:
"spreadsheet"` with `sheets` / `headers` / `rowCount`), and opt-in OCR results
as `status: "text_extracted"` with `trust: "low"` (never the default path).
Budget-aware `thread_around` side-post counts and gap-recovery page argv appear
in `next[]` when a window overruns the character budget. Match and dropped-candidate
excerpts best-effort redact login/password/token phrases. `--out` receipts add
`canAnswer`, `recommendedActionRequired`, `blockedPermalinks`, and
`subjectMatchedThreadsDropped` without removing existing fields.
`context … --follow-recommended` (requires `--agent`) runs `priority:
"recommended"` next steps once, merges their evidence into the same packet, and
always adds `followLog[]` (argv + status; empty when nothing ran) plus optional
`followedAttachments[]` (inspect text also merges onto matching thread
attachments) and `followExhausted: true` when no further recommended next
remains. External-reader / failed-OCR inspects are skipped and
remaining recommended steps continue; never runs broad `sync`. Skip markers
may additively carry `authors` / `fromAt` / `toAt`. Brief decisions may carry
`supportingPostIds` / `supportingExcerpt` and soft `offlineOrVoiceApproval`.
Brief may also carry `lateAcknowledgement` (explicit late-thread ack, not
adjacency pairing) at top-level `brief` and per-thread. Architectural approach
cues map to `proposal` only.
Agent projection may emit `hints.readOrder` and `timelineComplete`. Informational
`probe_reranked_packet` warns when non-ticket `--query` can reshape selection.
Subject-matched / permalink threads are probe-pinned so `--query` cannot drop
them as no_match. Request-scoped `--max-threads` / `--max-characters` /
`--per-thread-characters` override config budgets without changing defaults
when omitted. Subject-matched budget drops always recommend a `review_candidates` re-run with
a higher `--max-threads`; a non-thin drop also recommends `inspect_dropped`.

## Schemas and fixtures

Zod schemas and inferred TypeScript types for every command are exported from
the package, including `commandResultV1Schema`, command-specific
`*ResultV1Schema` values, and `parseCommandResultV1`. Complete synthetic golden
documents live in `src/contracts/contracts.v1.fixture.json`.
