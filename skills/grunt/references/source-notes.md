# Source and Verification Notes

## Corpus recovery

Playwright inspected visible carousel image alt text on 2026-07-31. Six carousels contributed:

| Carousel topic | Pattern slides |
|---|---:|
| Microservices patterns | 15 |
| Data and messaging patterns | 7 |
| Object design patterns | 18 |
| Optimization patterns | 7 |
| Advanced backend patterns | 7 |
| Observability patterns | 15 |

Total: 69 pattern occurrences. Six cover slides, three explicit CTA slides, and three closing wrap slides are non-pattern content. Machine-generated alt text contained OCR errors, so the coverage index preserves clearly visible pattern labels rather than treating descriptive prose as an exact transcript.

## Normalization

- Repeated labels share one canonical card.
- `Health Check API` and `Liveness & Readiness Probes` share `liveness-readiness`.
- The combined `Inbox-Outbox Pattern` occurrence represents consumer deduplication as `inbox-pattern`.
- The separate `Outbox Pattern` occurrence represents atomic local write plus relay as `transactional-outbox`.

## Technical verification

Primary technical documentation informed the judge cards. URLs stay out of shipped judge tables.

- Messaging documentation distinguishes at-most-once, at-least-once, and scoped exactly-once processing. Cards require idempotent effects and duplicate tests.
- Retry guidance warns that timeouts may occur after a side effect and retries can amplify overload. Cards require idempotency, bounds, backoff, and jitter.
- Cache documentation describes asynchronous replication, invalidation races, eviction, and possible failover data loss. Cards require explicit staleness and source-fallback behavior.
- Orchestrator documentation separates liveness restart actions from readiness traffic removal. Cards test fleet-wide cascade risk.
- Deployment rollback restores retained workload revisions; it does not undo incompatible data or external effects.
- Privacy erasure obligations cannot be reduced to a boolean soft-delete flag.

## Interpretation rule

Source slides supply candidates, not proof. Sideeye applies a card only when ticket and system evidence show its pressure.


## Agentic corpus

Second source: `baswe-agentic-design-patterns-guide.pdf` — a local extracted-text PDF (48 pages, self-dated 2026 edition). Read in full on 2026-08-22. Not a connector source and under one year old, so no staleness caveat applies.

| Part | Title | Role |
|---|---|---|
| 1 | Foundations | concept + vocabulary (excluded) |
| 2 | The five core patterns | patterns |
| 3 | Twenty more patterns | patterns |
| 4 | Designing agents | guidance (excluded) |
| 5 | Evaluating agents | guidance (excluded) |
| 6 | Deploying agents | guidance (excluded) |
| 7 | Putting it together | reference/closing (excluded) |

- 25 canonical concepts, all `source-verified`, grouped into five `agentic-*` domains.
- Part 3 organizes the twenty into Workflow, Reasoning, Coordination, Control, and Knowledge clusters; the five core patterns sit above them as reusable building blocks and are routed into the matching cluster domain.
- The agentic family presumes an LLM control loop (Reason→Act→Observe→Update): judge cards weigh tokens/cost, non-deterministic trajectories, and eval/guardrail infrastructure, not just static structure.
