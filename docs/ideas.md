# Ideas backlog

Lightweight notes from agent trials and design discussion. Not a roadmap and not
an implementation plan. Prefer fixing ticket-driven packing, selection, and
evidence status before anything here.

Related decision records:

- [Rejected local reranker](../experiments/reranker.md)
- [Deferred hybrid semantic retrieval](../experiments/semantic-search.md)

---

## Simplify free-text / lexical retrieval

**Status:** deferred (separate session)

**Problem.** Ticket `context` works well. Free-text `context` without a tracker
key is weak: network runs can hang for minutes; local runs can surface hundreds
of candidates and still return zero threads. Meanwhile plain `search` often finds
the right thread quickly. The stack tries to approximate semantic / linguistic
coverage (many fusion channels, expansions, morphology, typo/trigram fallbacks)
and pays for that with too many queries and CPU-bound work.

**Direction to explore later.**

- Prefer fewer, stronger lexical paths over more weak channels.
- Early abort / soft deadline for network free-text `context`, with diagnostics
  that explain partial work.
- When free-text `context` fails despite ranked candidates, fall back toward
  search-style ranking or return ranked pointers instead of an empty packet.
- Skill guidance: without a ticket key, start with `search` → `thread` /
  `context` on a chosen id, not unbounded free-text `context`.
- Do not solve this by reintroducing embeddings or a cross-encoder; see the
  experiment docs above.

**Partly addressed from the other side.** A ticket subject routes only to
conversations already linked to that ticket, so agents were falling back to
free-text `context` purely to reach a design thread in another channel.
`background[]` (`context.ts`) now answers that need with pointers from the
non-routed conversations when explicit `--query` probes are passed, without
touching selection — which removes one of the main reasons to run free-text
`context` at all. The weaknesses above still stand for genuine free-text use.

---

## More useful mechanical anchors

**Status:** partial (`--navigate` anchors/clusters/skips + `technicalEntities` +
advisory `signals` candidate spans / `roleHints` / mechanical `outcome_window`).
Phase 5 recalibrated the decision side against a real four-ticket session:
first-person commitment cues plus short-ack pairing, a sentence-level
interrogative guard, `open_question` split out of `debugging`, a tail-anchored
outcome window, and `brief.decisions[]` with inlined text.

**Problem.** Agents want “decision / proposal / unresolved” markers. Fake
semantics (keyword heuristics or LLM labels) would be non-deterministic and easy
to over-trust.

**Direction to explore later.**

Stay mechanical and evidence-backed, with post ids only — no prose summaries:

- first / last subject-ticket mention ± neighborhood;
- densest activity window *inside* the ticket window (not whole-thread chatter);
- posts with attachments or code fences in the ticket window;
- long posts in the ticket window;
- multi-ticket bulletin roots (already demoted; may deserve a clearer anchor);
- “outcome window”: posts after the last subject-ticket mention inside the
  returned set — shipped as `signals.outcomeWindow` (`label: "outcome_window"`),
  still bounded and labeled as a window, not as a verified decision.

Expose anchors / `signals` as pointers agents can hydrate; never as authoritative
outcomes. `--agent` threads may include capped advisory `signals.candidateSpans`
(`*candidate*` kinds only), multi-label `roleHints`, and the mechanical outcome
window — cite packed `postId`s only; do not replace `role` primary/secondary.
`--navigate` already returns lean anchors/clusters/skips plus capped
`technicalEntities` from packed posts. Full `decisionFlow` / late-confirmation
reply graphs remain deferred.

---

## Attachments without OCR / vision

**Status:** partial — explicit download + bounded `.xlsx` preview shipped;
opt-in pluggable OCR via `MATTERMOST_OCR_MODULE`; on Darwin, built-in Vision
OCR when that env is unset (disable with `MATTERMOST_OCR_DISABLE_MACOS=1`).
Both yield low-trust `text_extracted` only.

**Problem.** UI and support threads often need screenshots. Metadata and
`mm file` already work; auto-OCR or image captions need heavy tooling and invite
treating model text as evidence.

**Direction.**

- Skill rule: a message with `files[]` is incomplete until the agent downloads
  and inspects the attachment (`mm file` / `mm files` + Read); prefer
  `downloadCommand` argv for one-offs and `mm files --thread|--post --out-dir`
  for bounded batches.
- Batch download is an explicit command with safety limits; attachments are
  still not inlined into the context packet.
- Do not auto-download on `context` / `sync`.
- Prefer `MATTERMOST_OCR_MODULE` or the built-in macOS Vision path; do not
  invent captions. Treat OCR as low-trust pointers only.

---

## Batch `mm context A B C`

**Status:** deferred (declined during Phase 5)

**Problem.** Preparing for a grooming session means four ticket packets, which
today costs four processes, four remote searches, and four index warm-ups while
the retrieval budget is entirely shared. Threads also repeat across subjects
(two tickets often live in the same team channel), so the same posts are packed
and paid for more than once.

**Why it was not taken with the rest of the field report.** Every other request
in that report was a projection or a bounded cue change. This one needs a shared
budget, cross-subject thread dedup, and per-subject attribution inside one
packet — that is `runtime` / `selection` / `packing`, the hot path the retrieval
benchmark exists to protect. The cheap 80% (running the four calls in parallel)
already exists outside the tool.

**Direction to explore later.**

- One routing pass over the union of subjects, then per-subject ranking against
  a single candidate pool.
- Dedup selected threads, attributing each to every subject that selected it,
  rather than emitting a thread twice.
- Divide the global budget across subjects with the same reclaim rules already
  used for threads; report per-subject budget in `evidence`.
- Keep single-subject output byte-identical when only one subject is passed.

---

## Decisions acknowledged far downthread

**Status:** done (Phase C) — `brief.lateAcknowledgement`
(`kind: "late_thread_acknowledgement"`) with its own confidence; adjacency
`DECISION_ACK_LOOKAHEAD` is unchanged.

**Problem.** Ack pairing bounds the acknowledgement to the next few posts by
other authors, which is right for a terse exchange. But in TECHSUPP-109 the
commitment («будем не запрещать…») is acknowledged eleven posts later, after the
decider elaborates and the other party asks two clarifying questions. The pair
the field report described is real, just not adjacent, so no adjacency window
that stays meaningful can bridge it.

**What shipped.** A separate late-thread acknowledgement signal: a short
affirming ack among the final packed posts confirms the strongest preceding
decision candidate when more than the adjacency window of other-author posts
sits between them.

---

## Attachment metadata outside the post budget

**Status:** open (found while shipping the Phase 5 attachment index)

**Problem.** `omittedAttachments` shares the packing budget with post text
(`packing.ts`), so a text-heavy truncated thread reports zero omitted attachment
records and only a count. The agent then knows a skip swallowed four files but
cannot name or download them individually, and has to fall back to
`mm files --thread`.

**Direction to explore later.** Reserve a small allowance for omitted-attachment
metadata outside the post budget, or account attachment records separately from
rendered post units. This changes packing budget semantics, which is a program
invariant — it needs a deliberate decision, not a quiet tweak.

---

## `purposeHints` miss long technical threads

**Status:** resolved — reverified against the live index on 2026-07-26

**What it claimed.** On BTB-2113 the `backend-zone` thread — 25 packed messages
arguing `capabilities` vs `skipValidations` — got `purposeHints: []` while a
one-line DM in the same packet got `noise@0.6`, suggesting the cues fire on
short conversational threads and miss long technical ones.

**What re-running it shows.** The packet no longer behaves that way.
`backend-zone` yields `decision@0.55` + `open_question@0.6`, the `b2b-team`
thread is primary with `decision@0.78`, and the DM keeps `noise@0.6` at rank 3
— the ordering the item asked for. The Phase 5 first-person commitment cues and
the tail-question gate closed it; nobody updated this entry.

**The general claim is also false.** Measured over 14,806 indexed threads,
`purposeHints` coverage *improves* with length rather than degrading: 76% of
one-post threads get no hint at all, against 19% at 9–20 posts and 1% at 21+.
Long threads carrying a code fence are empty 1% of the time. The 55 long
threads that do come back empty are uniformly low-density chatter (30–100
characters per post), not technical argument.

**What to take from it.** Nothing needs fixing here. The real calibration
problem in this layer is the one below, which the original item was close to
but described backwards.

---

## `open_question` rests almost entirely on the bare `?`

**Status:** done — corroboration gate shipped; `bun run questions` guards it

**Problem.** The bare `?` is not one cue among many — it is the layer. Over the
local index it accounts for 5,647 of roughly 7,900 total cue matches, and it is
the *only* reported cue on 94% of `open_question_candidate` spans and 95% of
inlined `brief.openQuestions`. Among questions reported
`resolution: "unanswered"` — the ones an agent is most likely to act on — 98%
rest on `?` alone. Every other entry in `OPEN_QUESTION_CUES` combined decides
about one question in twenty.

The gates make this structural rather than incidental. A bare `?` scores exactly
`OPEN_QUESTION_INLINE_FLOOR` (0.4), so it always inlines, while never reaching
`OPEN_QUESTION_CONFIDENCE_FLOOR` (0.5) on its own. The hint therefore fires
through `OPEN_QUESTION_MIN_POSTS` (three posts containing `?`) or the tail
gate — and three posts containing a question mark is near-certain in any thread
of nine or more posts. 77% of threads that size get an `open_question` hint,
and only 20% of those would still get one without `?`.

**Why this matters.** `?` is precise as a *question detector* and carries almost
no information as an *open question* detector. Sampling bare-`?` unanswered
questions returns «заведёшь баг?», «что за задача?», «получилось черкануть ?» —
real questions, but ordinary conversational ones, mostly answered offline or
rhetorical. `resolution: "unanswered"` compounds it: it means only that no other
author posted afterwards *inside the packet*, which for a tail question usually
just means the conversation ended.

**Direction to explore later.** This is signal calibration guarded by
`ranking-regression` and the retrieval benchmark, so it needs a before/after
benchmark run and a labeled question corpus — the counts here say `?` dominates,
not that it is wrong. Hypotheses worth testing in that order:

- Require `?` to co-occur with something (subject mention, a real cue, a
  question word, a named addressee) before it can inline, rather than lowering
  its weight, which would only shift the same population below a floor.
- Separate "a question was asked" from "a question is open": the first is
  cheap and reliable, the second currently borrows the first's evidence.
- Reconsider `OPEN_QUESTION_MIN_POSTS` as a count of *distinct question-bearing
  authors*, or of questions inside the ticket window, rather than raw posts.

Do not treat the low `soleRate` of the other cues as evidence they should be
removed: they are what makes the remaining 5% specific.

**What shipped.** The first hypothesis, as a qualification rule rather than a
weight change: a span whose only cue is `?` may be inlined in `brief` and count
toward the purpose hint only when the `?` terminates a sentence of prose *and*
the post names the subject ticket. `signals.candidateSpans` is untouched, so the
advisory layer still carries every question mark. Retrieval benchmark metrics
are unchanged (this is the brief layer, not ranking). Over the live index the
`open_question` hint fell from 23% to 20% of ticket-linked threads and from 77%
to 23% of long threads, and inlined questions marked `unanswered` fell from
1,457 to 26.

**What is still weak.** The subject-mention rescue accounts for ~45% of the
surviving inlined questions and it does admit ticket-naming chatter
(«покатились?», «можно как-нибудь в перерыве взять?») alongside real requests.
It is the only mechanical evidence available that a bare question is *about* the
subject, so it stays until something better exists — a per-question addressee or
a reply-graph signal would be the next thing to try. Recall on real data remains
unmeasured: `benchmarks/questions.v1.json` was written alongside the gate and
scores 37/37, which is weak evidence by construction.

## Candidate pools with their own budgets

**Status:** open (raised by the Phase 7 field report; the reporting half shipped)

**Problem.** The report saw 176 candidates with 173 `droppedByBudget` and could
not tell whether anything real went unexamined — the pool mixes exact ticket
mentions with morphology, transliteration and typo rescue, so `budget_bounded`
looked alarming on every probed request.

**What shipped instead.** `selection.droppedByBudgetSubjectMatched` counts the
unexamined candidates that actually named the subject (ticket reasons, exact
phrase, structured entity), and `evidence.verdict.mayHaveMissedOtherThreads`
keys off that rather than the raw count. That answers the question the agent was
asking the numbers.

**Direction to explore later.** Real per-pool budgets — a guaranteed allowance
for exact ticket mentions, then related-ticket evidence, then probe background,
then weak lexical — change `selection` and `packing`, the hot path the retrieval
benchmark exists to protect. It needs a before/after benchmark and a decision
about what a guaranteed allowance costs the other pools, not a quiet tweak.

---

## Structured spreadsheet / CSV preview

**Status:** partial (Phase C) — bounded OOXML `.xlsx` sheet/header/N-row preview
with PII redaction shipped; `.xls` / `.ods` stay `not_interpreted`

**Problem.** A decision's numbers often live only in an attached XLSX or CSV, so
the report asked for a safe in-tool preview (sheet names, columns, row counts,
first rows).

**What shipped.** CSV/TSV already had textual `--inspect`. Phase C adds a
dependency-free OOXML reader for `.xlsx` only. Download still does not imply a
full workbook audit: `inspected: true` means a bounded preview was produced.

---

## `--since` “what’s new” and dry-run budget estimate

**Status:** deferred (Phase C scoped out — separate request)

**Problem.** Agents want a cheap “what changed since T” view and a dry-run that
estimates how many threads/characters a subject would spend before packing.

**Why deferred.** Both need new retrieval semantics (`--since` is not hard
`--after`) or a parallel packing estimate path that must stay honest with the
retrieval benchmark. Prefer a focused follow-up over bundling them with inspect
and decision-layer work.

**Direction to explore later.**

- `--since` as a soft freshness filter with explicit packet labeling.
- `--dry-run` that reports candidate counts and budget pressure without
  hydrating full threads.

---

## Consuming structured `mg ticket` output

**Status:** declined for now (Phase 7 field report)

**Problem.** Mattermost links in a ticket description had to be copied by hand
into `mm`.

**What shipped instead.** A repeatable `--permalink` folds them into one packet
with per-link resolution reporting. That removes the manual reconciliation
without coupling `mm` to another tool's output format — the caller still decides
which links are worth passing, which is also the boundary that keeps `mm`
usable outside this workspace.
