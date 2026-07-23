# Deferred hybrid semantic retrieval experiment

## Status

Deferred. Embeddings and a vector index are not part of the product until this proposal passes the decision gate below.

## Motivation

The current morphology, configured concepts, keyboard-layout/transliteration correction, typo fallback, and proximity signals cover known and explainable query variants. They do not guarantee retrieval for:

- previously unseen paraphrases with little lexical overlap;
- cross-language formulations outside configured concepts;
- symptom descriptions instead of known causes;
- new domain synonyms and terminology.

Unlike the rejected cross-encoder reranker, semantic retrieval should add candidates absent from lexical retrieval rather than merely reorder candidates already found.

## Proposed experiment

1. Use a fully local multilingual bi-encoder and compute document embeddings during sync.
2. Index roots and bounded reply chunks instead of one vector for a long, multi-topic thread.
3. Retrieve a bounded top-K set of semantic chunks and aggregate them into thread candidates.
4. Add dense retrieval as an independent, low-weight source in the existing weighted rank fusion.
5. Prevent semantic evidence from displacing ticket, structured-entity, and exact-phrase evidence.
6. Evaluate whether semantic retrieval should always run or act only as a fallback when exact and structured lexical coverage is weak.
7. Keep model, query, chunk, candidate, latency, index-size, and sync-cost bounds explicit in diagnostics.

A bi-encoder is preferred over cross-encoder reranking because documents can be encoded once during sync and each search requires only one query embedding. This moves most inference cost away from the interactive path while allowing semantic retrieval to improve recall.

## Validation set

Before implementation, create a blind semantic validation set that was not used to select the model or fusion weights. It should include:

- realistic paraphrases without substantial lexical overlap;
- unseen aliases for existing domain concepts;
- Russian/English cross-language queries;
- symptom-to-cause formulations;
- hard negatives from adjacent engineering topics;
- long and multi-topic threads where whole-thread embeddings are likely to fail.

Existing concept aliases must not be reused as the only semantic evaluation data.

## Decision gate

Keep the experiment only if all of the following hold on the independent validation set:

- Recall@5 improves materially on the semantic holdout, with a target of at least 3–5 percentage points;
- exact, ticket, and structured-entity cases have no significant regression;
- top-5 noise is reduced or unchanged;
- p95 query latency is acceptable for an interactive CLI;
- sync cost, model footprint, and vector-index size remain acceptable;
- operation remains fully local, bounded, deterministic in fusion, and explainable in diagnostics;
- no daemon, Python sidecar, or external API is required.

If these conditions are not met, retain the lexical/concept pipeline and do not add embeddings or a vector index.
