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

**Status:** done for explicit download (`downloadCommand` argv + `mm files` batch)
and for surfacing (`mediaOnly` on messages/attachments plus a `recommended`
`read_attachments` step when a text-free post lands after the last ticket
mention); OCR / vision remain out of scope

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
- Do not add OCR or vision summarization unless product scope explicitly changes.

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

**Status:** open (found while validating Phase 5 against the live index)

**Problem.** Ack pairing bounds the acknowledgement to the next few posts by
other authors, which is right for a terse exchange. But in TECHSUPP-109 the
commitment («будем не запрещать…») is acknowledged eleven posts later, after the
decider elaborates and the other party asks two clarifying questions. The pair
the field report described is real, just not adjacent, so no adjacency window
that stays meaningful can bridge it.

**Direction to explore later.** Consider a separate, explicitly named signal for
"the thread closes on acknowledgement": a short ack among the final posts
confirms the strongest preceding decision candidate in that thread. That is a
different claim from adjacency pairing and should not silently widen
`DECISION_ACK_LOOKAHEAD`; it needs its own field and its own confidence story.

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

**Status:** open (found while validating the Phase 6 field report against the
live index)

**Problem.** Reproducible on BTB-2113: the primary `backend-zone` thread — 25
packed messages arguing `capabilities` vs `skipValidations` — gets
`purposeHints: []`, while a one-line DM in the same packet gets `noise@0.6`.
The cues appear to fire on short conversational threads and miss long technical
ones, which inverts the ordering value the hints are supposed to provide.
`brief.decisions[]` still worked on that packet, so the miss is in the hint
classifier, not in decision detection.

**Direction to explore later.** Treat this as signal calibration, not a
projection fix: it is guarded by `ranking-regression` snapshots and the
retrieval benchmark, so any change needs a before/after benchmark run and a
concrete cue hypothesis (message length, code-fence density, and
question/commitment ratio are the obvious candidates). Do not hand-tune
thresholds against this one packet.
