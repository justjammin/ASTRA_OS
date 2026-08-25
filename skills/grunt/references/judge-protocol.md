# Judge Protocol

## Decision standard

Ask in order:

1. Does the change solve the stated user or business outcome?
2. Is behavior correct on normal and realistic failure paths?
3. Is it the smallest design meeting acceptance criteria?
4. Can the team observe, deploy, recover, and maintain it?
5. Does each added pattern buy a named capability supported by evidence?

## Evidence ladder

Strongest first:

1. Reproduced behavior, tests, runtime traces, production measurements
2. Executed code path plus dependency/call graph
3. Configuration and documented platform guarantees
4. Ticket claim or author explanation
5. Reviewer intuition

Runtime evidence beats reviewer taste. Missing evidence produces `Investigate`, not an invented defect.

## Grounding taxonomy

The evidence ladder measures strength; grounding kind records provenance. Preserve the kind on every cited item:

| Kind | Meaning | Required grounding |
|---|---|---|
| `claim` | Statement backed by target-repo code | `location` as `file:line` or `file:start-end` |
| `citation` | External fact from a vendor, standard, or specification | `source` as a primary `http(s)` URL |
| `guess` | Inference from training data or pattern matching | `promoteTo` describing evidence that would ground it; always low confidence |

An `Apply` verdict needs at least one grounded `claim` or `citation`. Guess-only evidence yields at most `Investigate`; do not invent a defect or promote a guess silently. Carry the file-line anchor, primary URL, or promotion path into the output evidence.

## Adversarial passes

| Pass | Question |
|---|---|
| Goal | Are code and ticket solving the same problem? |
| Correctness | What input, state, concurrency, or ordering makes the result wrong? |
| Failure | What happens when a dependency is slow, unavailable, duplicated, or ambiguous? |
| Data | Can writes be lost, repeated, reordered, partially committed, stale, or unrecoverable? |
| Boundary | Is responsibility placed in the component that owns the invariant? |
| Operability | Which signal detects failure, and what can an operator do? |
| Change | Can this ship incrementally; what data or side effects prevent rollback? |
| Simplicity | Which code, service, interface, queue, cache, or control plane can disappear? |

## Pattern verdict

- `Apply`: pressure is observed, evidence supports it, and tests/operations cover its cost.
- `Reject`: pressure is absent or a simpler option meets the same criteria.
- `Investigate`: candidate is plausible but required evidence is missing.

Every candidate row names signal, canonical ID, verdict, evidence, risk, and simpler alternative.

## Guarantee guardrails

- Messaging: outbox/inbox and broker transactions have bounded scopes. Relays and consumers still need duplicate handling.
- Retries: a timeout does not prove no side effect occurred. Retry only idempotent operations, with limits, backoff, and jitter.
- Failover: health detection and promotion do not guarantee zero downtime or zero data loss. State RTO, RPO, fencing, and failback.
- Soft delete: retaining hidden data is not erasure and does not itself satisfy privacy or retention law.
- Distributed cache: replication, invalidation, eviction, and failover can return stale data or lose acknowledged cache writes.
- Rollback: code rollback does not reverse incompatible schemas, external effects, or data written by the new version.

Agentic (LLM-agent) guarantees:

- Termination: every agent loop needs multiple stop conditions (step cap, token/cost budget, wall-clock, repeated-call detection) and a defined partial result. An unbounded loop is a P0/P1-class risk, not a tuning detail.
- Guardrails: an input/action/output guard reduces risk only if it enforces something; a guard that checks nothing, or duplicates an upstream control, is theater. Guards must run cheaply and in parallel, and be tested for bypass.
- Tool use and injection: untrusted content plus tool access plus data exfiltration is the lethal trifecta. Prompt injection can turn any tool call hostile; least-privilege tools and allow-lists still need duplicate-safe, idempotent effects.
- Memory: writes are the risk. Saving everything leaks and bloats; saving nothing useful is silent failure. Stored memory can be stale, contradictory, or contain retained PII.
- Retrieval grounding: an answer with citations is not a grounded answer. Require a grounding check that the cited context actually supports the claim; agentic retrieval loops still need bounds.
- Human-in-the-loop: gate irreversible or expensive actions (payments, deletions, sends) until production evidence earns a relaxed gate. Gate fatigue turns approvals into rubber stamps.
- Non-determinism: one green run is not proof. Agent behavior varies across trajectories; require eval sets and trajectory tests, not a single happy-path trace.

## Better-approach test

Recommend an alternative only when it:

- satisfies the same acceptance criteria;
- removes a named risk or meaningful complexity;
- has an executable migration path;
- does not depend on invented requirements.

## Explain like I'm 5

Check whether the bridge reaches the right place, then shake it with weather it will actually face. Do not demand a drawbridge when a plank safely meets the need.
