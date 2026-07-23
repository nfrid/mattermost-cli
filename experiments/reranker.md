# Rejected local reranker experiment

## Decision

The local cross-encoder reranker was rejected and removed from the product. Do not reintroduce it without materially new evidence, a different cost profile, and an independent validation set.

## Setup

The experiment used Transformers.js with `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` to score up to 20 lexical thread candidates. The local model occupied approximately 486 MB.

Two ranking strategies were evaluated:

1. **Unrestricted model ordering** — sort lexical candidates directly by model score.
2. **Guarded ordering** — reorder only contiguous candidates with identical protected lexical, coverage, proximity, and thread-depth evidence. The lexical winner and the first/top-5/top-10 boundaries were protected.

The archived guarded report is [`../benchmarks/baseline.v8.reranked.json`](../benchmarks/baseline.v8.reranked.json). Its lexical baseline is [`../benchmarks/baseline.v8.json`](../benchmarks/baseline.v8.json).

## Results

### Unrestricted ordering

- Recall@5: `-0.053824`
- Irrelevant results in top-5: `+7`

This strategy was rejected immediately because model relevance scores could displace stronger exact and structured lexical evidence.

### Guarded ordering

| Metric | Delta against lexical baseline |
| --- | ---: |
| Recall@5 | `0` |
| Recall@10 | `0` |
| Irrelevant results in top-5 | `0` |
| MRR | `+0.005051` |
| nDCG@5 | `+0.009025` |
| nDCG@10 | `+0.009256` |
| Mean query time | `+80.191 ms` |
| Index size | `0` |

Mean query time increased from `2.509 ms` to `82.700 ms`, roughly 33×. Model/runtime loading was cached within the process.

The MRR and context-budget improvement came from one wrong-keyboard-layout case, where the relevant thread moved from rank 3 to rank 2. That case is better addressed by deterministic lexical ranking. Two benchmark cases regressed in nDCG, while most model-induced ordering changes had no measured relevance benefit.

## Conclusion

The guards made the reranker safe by preventing the model from changing the ranking decisions that matter most. They also left too little useful ranking freedom to justify inference. The small aggregate gain did not compensate for approximately 80 ms of mean latency, a 486 MB model, optional-runtime complexity, public API surface, and failure handling.

The CLI option, configuration, runtime adapter, dependency, public contracts, and tests were removed. The benchmark artifact remains only to prevent the experiment from being repeated without new evidence.
