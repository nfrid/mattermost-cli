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

---

## More useful mechanical anchors

**Status:** deferred

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
- optional “outcome window”: posts after the last subject-ticket mention, still
  bounded and labeled as a window, not as a verified decision.

Expose anchors as pointers agents can hydrate; never as authoritative outcomes.

---

## Attachments without OCR / vision

**Status:** deferred (skill-first)

**Problem.** UI and support threads often need screenshots. Metadata and
`mm file` already work; auto-OCR or image captions need heavy tooling and invite
treating model text as evidence.

**Direction to explore later.**

- Skill rule: a message with `files[]` is incomplete until the agent downloads
  and inspects the attachment (`mm file` + Read).
- Optional later: bounded batch download for a selected thread’s attachments
  (explicit command, still not inlined into the context packet).
- Do not auto-download on `context` / `sync`.
- Do not add OCR or vision summarization unless product scope explicitly changes.
