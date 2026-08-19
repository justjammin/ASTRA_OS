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
