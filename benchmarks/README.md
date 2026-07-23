# Retrieval benchmarks

Run the versioned baseline fixture with:

```sh
bun run benchmark
```

The optional arguments are a fixture path and repeat count:

```sh
bun run src/benchmark-cli.ts benchmarks/retrieval.v1.json 5
```

The runner validates the fixture, creates a disposable in-memory index, and reports per-case and aggregate Recall@5, Recall@10, reciprocal rank, NDCG@5, NDCG@10, irrelevant hydrated threads, context budget spent before the first relevant thread, and repeated-run stability. NDCG uses optional positive relevance grades and defaults ungraded expected threads to grade 1. Fixtures may define bounded top-level `synonyms` to exercise project-specific mixed-language expansion.

## Adding a case

Add synthetic conversations and posts to the fixture, then add a case with:

- a stable `id` and `queryClass`;
- a subject, ticket, or one or more independent queries;
- optional repository, scope, and channel hints;
- one or more expected thread IDs with optional positive relevance grades;
- a short note explaining relevance.

Cases may document known failures. Prefer realistic synthetic threads with replies, incidental mentions, and ordinary conversational noise. Relevance judgments should still follow explicit evidence such as probe coverage, root placement, identifiers, or investigation depth; do not encode arbitrary stylistic preferences.

Tests protect the fixture and metric mechanics and enforce conservative aggregate regression floors. Update those floors only when a reviewed fixture change intentionally alters the relevance judgments; do not hide retrieval regressions by rewriting expectations. Keep fixture text synthetic and free of Mattermost credentials or private chat content.
