# Retrieval benchmarks

Run the versioned baseline fixture with:

```sh
bun run benchmark
```

The optional arguments are a fixture path and repeat count:

```sh
bun run src/benchmark-cli.ts benchmarks/retrieval.v1.json 5
```

The runner validates the fixture, creates a disposable in-memory index, and reports per-case and aggregate Recall@5, Recall@10, reciprocal rank, NDCG@5, NDCG@10, irrelevant candidates in top-5, irrelevant hydrated threads, context budget spent before the first relevant thread, query latency, index size, retrieval requests per probe, and repeated-run stability. NDCG uses optional positive relevance grades and defaults ungraded expected threads to grade 1. Fixtures may define bounded top-level `synonyms` and `concepts` to exercise project-specific expansion and concept indexing.

## Comparing a candidate with the baseline

`baseline.v8.json` records the Phase 8 lexical candidate pipeline after concept/fuzzy cleanup and before optional model scoring. Generate a default lexical report and compare it with this baseline:

```sh
bun run benchmark > /tmp/retrieval-candidate.json
bun run benchmark:compare benchmarks/baseline.v8.json /tmp/retrieval-candidate.json
```

## Rejected local-reranker experiment

`baseline.v8.reranked.json` is retained as an archived negative experiment, not as a supported benchmark mode. See [the experiment report](../experiments/reranker.md) for the unrestricted and guarded results, cost analysis, and removal decision.

`baseline.v7.json` is the directly comparable pre-concept/fuzzy-cleanup depth report, `baseline.v6.json` is the pre-depth typo-cleanup report, `baseline.v5.json` is the pre-typo-cleanup proximity report, `baseline.v4.json` is the pre-proximity layout/transliteration report, `baseline.v3.json` is the pre-layout concept-FTS report, and `baseline.v2.json` is the pre-concept weighted-fusion report. `baseline.v1.json` remains the historical 26-case report for the legacy suffix-based Russian expansion; its fixture and relevance judgments differ, so it is not directly comparable with current reports.

The comparison includes the query, expected threads, old and new rankings, added and removed candidates, ranking reasons, and metric deltas for every case. Timing deltas are informative only; use ranking metrics and repeated measurements for regression decisions.

## Adding a case

Add synthetic conversations and posts to the fixture, then add a case with:

- a stable `id` and `queryClass`;
- a subject, ticket, or one or more independent queries;
- optional repository, scope, and channel hints;
- one or more expected thread IDs with optional positive relevance grades;
- a short note explaining relevance.

Cases may document known failures. The current challenge set deliberately covers domain paraphrases, retry concepts, full-phrase keyboard-layout mistakes, Latin transliteration, mixed-script confusables, short Russian typos, and same-post token proximity. Prefer realistic synthetic threads with replies, incidental mentions, and ordinary conversational noise. Relevance judgments should still follow explicit evidence such as probe coverage, root placement, identifiers, or investigation depth; review all existing threads that become relevant to a new query rather than judging only its intended target. Do not encode arbitrary stylistic preferences.

Tests protect the fixture and metric mechanics and enforce conservative aggregate regression floors. Update those floors only when a reviewed fixture change intentionally alters the relevance judgments; do not hide retrieval regressions by rewriting expectations. Keep fixture text synthetic and free of Mattermost credentials or private chat content.
