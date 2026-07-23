# Mattermost CLI Search Improvements

## Goal

Improve `mattermost-cli` search recall and ranking while preserving its current strengths:

* local, disposable SQLite index;
* deterministic and explainable retrieval;
* curated conversation boundaries;
* thread-level results;
* bounded context packets;
* minimal runtime and deployment complexity.

The implementation should improve lexical and structured retrieval first. Semantic/vector search should be added as an optional retrieval source only after the lexical pipeline is measurable and working well.

Avoid replacing the current architecture with a generic RAG framework or introducing a daemon.

---

## Guiding principles

1. **Retrieve broadly, rank carefully.** Candidate generation should favor recall. Final thread ranking should favor precision.
2. **Threads are the retrieval unit.** Posts provide matches, but the user ultimately wants relevant conversations.
3. **Keep independent signals independent.** Do not collapse all queries into one strict conjunction too early.
4. **Prefer rank fusion over arbitrary score normalization.**
5. **Structured engineering identifiers matter more than vague semantic similarity.**
6. **Every result should remain explainable.**
7. **Vector search must be optional and must not weaken exact lexical retrieval.**
8. **Preserve the current security, allowlist, freshness, and bounded-output guarantees.**

---

## Phase 1: Establish a retrieval benchmark

Before changing ranking behavior, create a small evaluation harness based on realistic Mattermost searches.

Use a versioned fixture format containing:

* search subject and additional probes;
* repository, scope, and channel hints;
* expected relevant thread IDs;
* optional relevance grades;
* notes explaining why each thread is relevant.

Cover at least these query classes:

* exact ticket IDs and identifiers;
* exact phrases;
* terms distributed across several replies;
* repository, function, file, package, and service names;
* Russian inflections;
* Russian and English terminology referring to the same concept;
* misspellings and incomplete identifiers;
* vague paraphrases;
* old relevant threads competing with newer irrelevant ones;
* threads containing several unrelated subtopics.

Measure:

* Recall@5 and Recall@10;
* reciprocal rank of the first relevant result;
* irrelevant threads selected for hydration;
* context budget spent before the first relevant thread;
* deterministic stability across repeated runs.

The benchmark does not need to be large initially. It should be easy to expand with failures found during real usage.

---

## Phase 2: Preserve lexical ranking evidence

The current FTS query uses BM25 to order posts, but that ranking evidence is lost before thread ranking.

Change the storage search API to return lexical hits rather than plain posts. Each hit should expose enough information for later fusion and diagnostics, including:

* post;
* lexical retrieval source;
* rank within that source;
* BM25 value where available;
* a real match-centered snippet.

Do not rely on raw BM25 values across unrelated query forms. Preserve them for debugging, but use source-local ranks for ranking fusion.

Use FTS `snippet()` or equivalent match-aware extraction rather than returning the first characters of the post.

Expose lexical evidence in internal candidate diagnostics and, where compatible with the existing JSON contract, in result ranking reasons or additive metadata.

---

## Phase 3: Improve candidate generation

Replace the single strict FTS probe with multiple complementary lexical retrieval strategies.

For every independent retrieval probe, generate candidates from some combination of:

1. exact phrase search;
2. strict all-term search;
3. broad OR search;
4. separate searches for significant terms;
5. prefix search for suitable tokens;
6. trigram or substring fallback when stronger searches return insufficient candidates.

The exact query-generation rules can be refined during implementation. The important requirement is that a thread must be discoverable when different query terms occur in different posts.

Merge matching posts by thread before final ranking.

Keep each repeated `--query` as an independent retrieval signal. Do not concatenate all probes into one query that requires unrelated concepts to coexist in a single post.

Avoid flooding candidate generation with weak terms. Continue using normalization and stop-word filtering, and introduce sensible minimum lengths for prefix and trigram fallback.

---

## Phase 4: Rank complete threads

Once candidate thread IDs are known, load the complete locally indexed thread and evaluate relevance across the thread rather than only within the originally matching post.

Thread-level evidence should include:

* exact subject or phrase in the root;
* exact subject or phrase in replies;
* all significant terms present anywhere in the thread;
* number and diversity of matching probes;
* lexical retrieval ranks;
* ticket and explicit relationships;
* repository, scope, channel, and routing evidence;
* latest relevant match time;
* latest overall thread activity;
* conversation priority.

Recency should normally be a tie-breaker or weak secondary factor. A recent weak match should not beat an older strong match simply because it is newer.

Keep direct post resolution and explicit ticket relationships dominant.

---

## Phase 5: Introduce rank fusion

Use Reciprocal Rank Fusion or a similarly simple rank-based method to combine independent candidate lists.

Potential ranked sources include:

* exact phrase results;
* strict FTS results;
* broad FTS results;
* individual query probes;
* prefix results;
* trigram fallback;
* future semantic results.

After fusion, apply deterministic structured boosts for high-confidence evidence such as:

* explicit ticket-thread relationships;
* ticket in the root post;
* exact identifiers;
* explicit channel restrictions;
* strong repository or scope routing.

Avoid creating a complicated score formula that directly mixes BM25 values, vector distances, timestamps, and manually chosen weights.

The final ranking must remain deterministic, with stable tie-breaking.

Update ranking reasons and score diagnostics so it is possible to understand why a thread was selected.

---

## Phase 6: Add structured engineering search

Extend indexing beyond undifferentiated message text.

Extract useful entities from messages and attachment metadata, including where practical:

* issue and ticket keys;
* repository names;
* pull request and commit references;
* URLs and Mattermost permalinks;
* file paths;
* package names;
* symbols such as functions, components, classes, and configuration keys;
* error codes and distinctive error fragments;
* usernames and participants;
* attachment filenames;
* service and project names.

Use conservative extraction rules. False negatives are preferable to generating large quantities of misleading metadata.

Store structured relationships separately where they can be queried and explained, following the existing ticket-thread relationship model.

Add useful CLI filters such as:

```text
--from <username>
--after <date>
--before <date>
--has-file
--file <pattern>
```

Ensure these filters are represented in the JSON contract and do not bypass configured conversation restrictions.

---

## Phase 7: Improve Russian and mixed-language retrieval

Preserve the existing normalization behavior, including case folding and `ё`/`е` equivalence.

Experiment with lightweight improvements before introducing embeddings:

* token variants or stemming suitable for Russian;
* transliteration-aware aliases where useful;
* configured or automatically discovered domain synonyms;
* common engineering synonym pairs such as Russian terminology and English technical names;
* prefix and trigram fallback for inflected words.

Keep these mechanisms bounded and observable. Do not silently expand every query into a large uncontrolled synonym set.

A small configurable synonym system may be more useful than a complex general-language pipeline because the corpus contains project-specific terminology.

---

## Phase 8: Optional server-side search fallback

Investigate Mattermost’s native post-search endpoint as an optional fallback.

Use it only when local coverage is incomplete, unusually stale, or explicitly requested.

Preserve the existing security model:

* expose a named semantic search operation, not a generic POST helper;
* validate and bound requests and responses;
* filter all returned posts against configured conversations;
* rehydrate and validate selected threads through the normal pipeline;
* mark remote-search evidence and completeness clearly.

Do not make server-side search a mandatory dependency.

Skip this phase if it provides no meaningful improvement over local synchronization and retrieval.

---

## Phase 9: Add semantic retrieval behind an abstraction — skipped

**Decision:** semantic retrieval is deferred because its runtime, indexing, and operational complexity is not currently justified. The deterministic lexical and structured pipeline remains the complete retrieval architecture for now.

Only revisit this phase if the benchmark demonstrates the remaining failures are genuinely semantic rather than lexical candidate-generation bugs.

Create a provider-independent semantic retrieval interface. Keep embeddings optional and disabled by default.

The semantic index should operate on thread chunks, not isolated one-line posts and not arbitrarily large complete threads.

A chunk should generally include:

* root message as repeated context;
* a bounded window of adjacent replies;
* lightweight author and timestamp context;
* extracted identifiers;
* references back to the source thread and posts.

Store embedding metadata including:

* provider and model;
* dimensions;
* normalization method;
* content hash;
* indexing version.

Support rebuilding semantic data independently from the main post index.

Initially use the simplest implementation that can validate retrieval quality. A brute-force local similarity scan is acceptable for a limited corpus. Do not introduce native SQLite extensions or external vector infrastructure until benchmark results justify the deployment complexity.

Semantic retrieval should produce another ranked candidate list and feed it into the same rank-fusion stage.

Exact identifiers, phrases, and structured relationships must continue to outrank vague semantic similarity.

---

## Phase 10: Query expansion for agents — implemented

Make the API convenient for coding agents that already know useful surrounding context.

Support multiple independent probes such as:

* ticket title;
* ticket description fragments;
* repository name;
* changed file paths;
* symbols found in the code;
* error messages;
* service names;
* participant names.

The retrieval layer should preserve which probe matched which post or thread.

Do not require an LLM call inside `mattermost-cli`. The calling agent can generate probes itself. The CLI should remain deterministic and useful without model access.

Optionally add a structured input form to the package API so callers do not need to encode everything as CLI strings.

---

## Testing requirements

Add tests for:

* terms distributed across multiple posts;
* independent repeated queries;
* BM25 and rank evidence preservation;
* exact phrase ranking;
* broad retrieval without irrelevant result explosion;
* prefix and trigram fallbacks;
* Russian normalization and variants;
* structured entity extraction;
* filters and routing interactions;
* rank-fusion determinism;
* explicit ticket relationship dominance;
* recency not overpowering relevance;
* allowlist enforcement at every new retrieval boundary;
* stale and incomplete index reporting;
* backward-compatible contract additions;
* if phase 9 is reopened, semantic retrieval disabled, unavailable, stale, and enabled states.

Preserve existing golden contract fixtures and schema-version policy. Prefer additive fields unless semantics genuinely require a new contract version.

---

## Observability and diagnostics

Add enough diagnostics to investigate failed retrieval without exposing excessive internal noise in normal human output.

Useful diagnostics include:

* retrieval sources executed;
* candidate counts per source;
* ranks contributed by each source;
* query expansions used;
* structured matches;
* fusion score;
* final boosts;
* candidates discarded during hydration or freshness revalidation.

Consider a dedicated debug option rather than expanding normal output.

Keep JSON output deterministic.

---

## Suggested implementation order

1. Add the evaluation fixture format and benchmark runner.
2. Preserve BM25, source rank, and match-centered snippets.
3. Add broad and per-term candidate generation.
4. Evaluate terms across complete threads.
5. Introduce rank fusion.
6. Rebalance structured boosts and recency.
7. Add prefix and trigram fallback.
8. Add structured engineering entities and filters.
9. Improve Russian and mixed-language matching.
10. Evaluate optional Mattermost server-side fallback.
11. Add typed, independent agent probes and retain probe origins in diagnostics.
12. Compare the implemented variants using the benchmark and simplify anything that does not provide measurable value.

Semantic retrieval is not part of the current implementation sequence.

Each stage should leave the repository in a working, tested state.

---

## Completion criteria

The work is complete when:

* relevant threads can be retrieved when query terms appear in different replies;
* lexical relevance affects final thread ordering rather than only candidate admission;
* repeated probes contribute independently;
* exact identifiers and structured relationships remain highly reliable;
* Russian and mixed-language recall is measurably improved;
* ranking remains deterministic and explainable;
* all new retrieval paths respect configured conversation boundaries;
* context hydration remains bounded;
* benchmark results show clear improvement over the original implementation;
* semantic retrieval remains deferred unless realistic benchmark failures justify reopening it;
* the CLI remains usable without a daemon, external database, or embedding service.

