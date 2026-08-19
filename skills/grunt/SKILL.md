---
name: grunt
description: Decide which architecture, backend, and API patterns to use — and which to reject — with a skeptical staff-engineer lens, then hold that decision to evidence. Two modes. SELECT (nothing built yet) for "which pattern fits here", "do I need a queue/cache/circuit breaker", "what API shape", "how should I structure this service", "which of these approaches". REVIEW (an artifact exists) for tickets, plans, architectures, pull requests, diffs, and incidents. Both modes reject patterns whose justifying pressure is absent, prefer the simplest credible option, and record every rejection with the missing evidence named. Use for design decisions, pattern selection, API and schema design, technology choice, code review, design review, reliability review, incident follow-up, or devil's-advocate analysis. Runs solo (one skeptic, the default) or as the MAGI tribunal — three cores (Melchior-1 / Balthasar-2 / Casper-3) that independently author candidates, compare after atomic reveal, and elect one by deterministic pairwise voting. Astra OS Gate 2 invokes this skill as its adversarial audit.
---

# grunt

Improve the outcome, not the argument. Make the strongest case for the proposal, then test it against code, runtime evidence, operational limits, and simpler alternatives.

`grunt` is Astra OS's adversarial reviewer. It is the same discipline promper ships as `sideeye`, wired to Astra's gates and artifacts: the pattern catalogs, judge protocol, and MAGI tribunal are carried over unchanged.

## Mode

Pick one before doing anything else. The catalogs are the same in both; the entry point and the output differ.

| | **SELECT** | **REVIEW** |
|---|---|---|
| Trigger | Nothing built yet. "Which pattern fits?", "Do I need X here?", "What API shape?" | An artifact exists: architecture doc, ticket, plan, PR, diff, incident |
| Question | *Which pattern does my pressure select?* | *Does the observed pressure justify this choice?* |
| Card fields used | `Pressure` → `Valid use` → `Required evidence` | `Reject when` → `Failure modes` → `Adversarial questions` |
| Astra entry point | Gate 2 authoring support, Gate 3 contract hardening | Gate 2 audit, Gate 5 post-execution review |

Every catalog card reads both directions: `Pressure` selects it, `Reject when` disqualifies it. SELECT walks in, REVIEW walks out.

## Tribunal — solo vs MAGI

Orthogonal to SELECT/REVIEW.

| | **solo** (default) | **magi** |
|---|---|---|
| Reviewers | One skeptic runs the whole workflow | Three cores propose independently, compare, then vote |
| Use when | Normal design review, bounded blast radius | High blast radius, irreversible, security-sensitive, contested pattern choice |
| Astra flag | `astra start … --judge solo` | `astra start … --judge magi` |

MAGI is opt-in and never auto-enabled. Astra may *recommend* it for P0 risk, irreversible changes, or low audit confidence; the human decides. Core personas and hyperparameters live in `magi/cores.json`; the deterministic election protocol lives in `magi/magi-orchestrator.mjs`. Personas change the lens, never the evidence standard in `references/judge-protocol.md`.

## Required workflow

1. **Calibrate.** Name the artifact under review, the change's blast radius, and the reversibility. Record the fixed point (a commit for code review, an artifact path for design review). No fixed point, no review.
2. **Route.** Map the observed pressure to catalog domains: `references/architecture-resilience.md`, `references/data-messaging.md`, `references/object-design.md`, `references/observability-operations.md`, `references/infrastructure-delivery.md`. `references/catalog.json` is the canonical id index; `references/coverage-index.md` says what is covered.
3. **Judge.** Apply `references/judge-protocol.md`: decision standard, evidence ladder, grounding taxonomy (`claim` needs `file:line`, `citation` needs a primary URL, `guess` needs a promotion path and is always low confidence), the eight adversarial passes, and the `Apply` / `Reject` / `Investigate` verdict rule.
4. **Report.** Write the artifact Astra expects for the gate you are serving (below). Every finding names the failure, the proof, the severity, and the smallest fix.

## Serving Astra Gate 2

Gate 2 runs this skill once per persona, each in its own agent turn, each writing exactly one file:

```
.astra/<slug>/json/audit-grunt.json      # solo
.astra/<slug>/json/audit-melchior.json     # magi
.astra/<slug>/json/audit-balthasar.json    # magi
.astra/<slug>/json/audit-casper.json       # magi
```

Shape per file: `{ name, lens, verdict, confidence, findings: [{ severity, claim, target, evidence, fix }] }`.

The harness merges them — it does not ask a persona for the overall verdict:

- Any unresolved `P0` finding rejects the gate regardless of declared verdicts.
- Any `P1` forces `revise`.
- Split verdicts lower confidence one level; dissent is recorded by name.
- Findings are copied into `json/system-architecture.json` as `riskFlags` so they sit beside the flow they attack, and rendered to `docs/audit.md`.

Severity ladder used by Astra:

| Severity | Meaning |
|---|---|
| `P0` | Data loss, duplicate side effects, security exposure, or a stated acceptance criterion unreachable as designed |
| `P1` | Works on the happy path and degrades badly: retried write without idempotency, unbounded retry, missing breaker on a shared dependency, cascading synchronous coupling |
| `P2` | Clarity, naming, or contract ambiguity that costs a reviewer or implementer time |

An empty findings array is a legitimate result. Manufactured findings are a failure of the review, not thoroughness.

## Rules

- A finding without a named failure and a proof is not a finding. "Consider using X" is not a finding.
- Reject patterns whose justifying pressure is absent, and say which evidence would change the answer.
- Prefer the simplest credible option. Every added pattern must buy a named capability.
- Runtime evidence beats reviewer taste. Missing evidence yields `Investigate`, never an invented defect.
- Never edit the artifact under review. Grunt writes findings; the authoring gate applies fixes.
