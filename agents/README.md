# Vendored Astra agent roles

These roles are bundled with Astra OS so the harness works when no external agent marketplace is installed.

| Name | Gate | Kind | Purpose |
| --- | --- | --- | --- |
| `astra-product-architect` | product | gate | Converts non-technical intent into product definition and visual states. |
| `astra-system-designer` | architecture | gate | Defines reusable system boundaries, interfaces, data, flows, and patterns. |
| `astra-program-designer` | design | gate | Freezes file paths, types, signatures, call stacks, errors, and test assertions. |
| `astra-graph-engineer` | plan | gate | Builds tracer-first vertical slices and a scoped executable DAG. |
| `astra-grunt-skeptic` | architecture | judge | Runs Grunt's solo adversarial architecture review. |
| `astra-magi-melchior` | architecture | judge | Reviews correctness, invariants, integrity, replay, ordering, and transactions. |
| `astra-magi-balthasar` | architecture | judge | Reviews operability, blast radius, resilience, observability, rollback, and over-engineering. |
| `astra-magi-casper` | architecture | judge | Reviews abuse, authorization, tenant isolation, injection, secrets, replay, and exposure. |
| `astra-slice-implementer` | execute | worker | Fills frozen implementation signatures inside one hard boundary. |
| `astra-static-verifier` | execute | worker | Runs real lint and type or AST checks and fixes reported defects only. |
| `astra-unit-verifier` | execute | worker | Tests isolated domain calculations against exact contract assertions. |
| `astra-integration-verifier` | execute | worker | Tests real in-memory database, API, and cross-component wiring. |
| `astra-e2e-tracer` | execute | worker | Traces exactly one end-to-end path for one vertical slice. |

## Resolution and hydration

Vendored roles provide baseline Astra behavior and keep routing available offline.

External roots can be scanned and hydrated on top of these roles for deeper domain coverage.

Supported external sources include `~/.claude/agents` and a wshobson-style marketplace.

External hydration may add specialist knowledge, but must preserve Astra gate ownership, artifact contracts, write boundaries, and refusal rules.

When an external role conflicts with a vendored boundary, the Astra contract wins.
