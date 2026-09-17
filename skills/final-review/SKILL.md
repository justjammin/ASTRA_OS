---
name: final-review
description: Review a completed Astra or Stella Gate 5 feature or slice against approved requirements and actual implementation, then apply specific corrections only after human approval and verify the revised product.
---

# Final product review

Review the delivered behavior, code, and verification evidence after Gate 5 execution. Use Protect-style solo REVIEW judging. Save the record to `<run-root>/docs/final-review.md`, normally `.astra/<slug>/docs/final-review.md`. Keep successive review rounds and slice IDs in that record. This is a post-execution skill, not a sixth machine-enforced gate or permission to ship.

## Establish the fixed point

- Resolve the requested run and slice from the user's request and run artifacts. Ask only if multiple runs or slices remain ambiguous. A slice review covers its integration boundaries; it must not certify unreviewed slices or the whole run.
- Read `status.json`, `docs/01-product.md`, `json/user-story.json`, `docs/02-architecture.md`, `json/system-architecture.json`, `json/audit.json`, `docs/03-program-design.md`, `json/call-stack-types.json`, `docs/04-slices.md`, `json/plan.json`, and `json/dag-execution.json` relative to that run root. Read relevant logs, tests, and the actual changed code. For UI work, compare the running behavior with the approved UI states and available design previews.
- Confirm the selected slice's implementation and verification nodes finished, including its E2E trace. Check node coverage against the plan, not just the overall status. A skipped node is not passing evidence. Missing artifacts, required checks, or unresolved failed/blocked nodes produce `BLOCKED` with the missing prerequisite; do not invent a baseline or start another pipeline automatically.
- Record the base revision, reviewed commit, and any staged, unstaged, or untracked target changes. For uncommitted work, preserve a diff and content hashes of relevant untracked files as review evidence under the run root. Record hashes of the approved requirement/contract artifacts too. Do not commit or stash user work to create a fixed point.
- Name the acceptance criteria, affected files and callers, blast radius, and reversibility. Use available dependency/call graphs to inspect impact; otherwise trace callers directly and disclose coverage limits. A run marked complete or a green execution ledger is not proof that the current working tree matches the tested product.

## Review without modifying the target

Read the bundled [judge protocol](../grunt/references/judge-protocol.md) and [coverage index](../grunt/references/coverage-index.md), then only catalogs relevant to observed pressures. [Catalog IDs](../grunt/references/catalog.json) are canonical. Reuse these resources without invoking Grunt's Gate 2 artifact writer or overwriting the architecture audit. Do not require a separate redMage installation or `.mage/` records.

Use one solo reviewer, never auto-enable a tribunal. Separate reviewer and controller responsibilities: the reviewer inspects and reports; the controller applies an approved correction plan later. During review, write only the review record and evidence, and run checks that do not rewrite source or affect live external systems. Do not run autofix, update snapshots, or change requirements to make the implementation pass.

Judge requirement coverage, realistic normal and failure paths, state/data invariants, interface contracts, security boundaries, integration behavior, maintainability, and rollback where relevant. Exercise the actual product path; a test's existence or a worker's success message is insufficient. For UI acceptance, inspect the rendered result and interaction. If runtime access is unavailable, state exactly what remains unverified.

Prefer direct functions and cohesive modules. Research object patterns only for an observed object-design question, using the bundled [OOP guide](../grunt/references/oop-design.md) and relevant [deep dives](../grunt/references/pattern-deep-dives.md). Use appropriate primary sources for consequential platform guarantees and cite them beside decisions. Do not manufacture findings, impose patterns, or include unrelated cleanup.

For each finding record:

- Stable ID, affected slice/acceptance criterion, severity, concrete failure, and target `file:line`.
- Proof: reproduced behavior or command/result, executed code path, or a primary-source guarantee. Mark inference as low-confidence `guess` with an evidence-gathering action.
- Smallest proposed correction, exact files, expected behavior, tradeoff, and regression/acceptance checks.
- `Apply`, `Reject`, or `Investigate`: Apply requires grounded evidence; Reject names absent pressure or a simpler sufficient alternative; Investigate names missing evidence and how to obtain it.

P0 means data loss, security exposure, or unreachable acceptance. P1 means material correctness or failure-path weakness. P2 means consequential ambiguity. Missing evidence alone is not a fabricated defect. An empty findings list is valid.

Include a traceability table: acceptance criterion → implementation → observed verification → gap. Report `PASS` only when scoped acceptance has evidence and no unresolved findings remain; `CHANGES REQUIRED` for grounded corrections; `BLOCKED` when consequential missing evidence prevents judgment. Explicitly list limitations and unresolved P0/P1 blockers.

## Obtain approval for concrete corrections

Present the saved review and a bounded correction plan with finding IDs, files, behavior changes, verification, and any contract or scope changes. Ask the human to approve all or selected corrections; persist their actual response and approved IDs in the record. Findings or approval of an earlier pipeline gate do not authorize fixes. If the user already explicitly approved this exact current correction plan, use that approval without asking again.

Stop before modifying the target until approval arrives. Approval may accept, reject, defer, or request investigation; record those choices honestly. Waiving a P0/P1 does not make the review pass. Investigations authorize evidence gathering, not speculative corrections.

## Apply, verify, and review again

After approval, act as controller and recheck the fixed point. If the target, acceptance criteria, or correction scope materially changed, refresh the affected findings and obtain approval for the changed plan. Preserve unrelated user changes.

Apply only approved corrections within Gate 3 file contracts and the affected Gate 4 role write boundaries. If fixes require new paths, changed acceptance, or revised architecture/contracts, use the existing pipeline's rework route to the earliest affected gate and obtain its required human approvals before dependent implementation. Approval of a fix does not silently widen write boundaries. If a closed run cannot re-enter that route, report the required reopen/new-run decision and pause those corrections.

For Stella, use `astra_check` and the host-native MCP gate/loop workflow; never invoke the CLI or `astra_run`. For CLI-driven Astra, use its gate/loop workflow and leave human-only approval commands to the user. Never hand-edit ledger approvals, rewrite failed execution as passed, or close a run to bypass rework.

Rerun relevant static, unit, integration, and E2E checks for corrected slices and affected dependents. Capture commands, results, and the new fixed point. Recheck original findings and look for regressions in the changed paths. Mark a finding resolved only with evidence; failed or unavailable checks remain visible. Prior green evidence is stale for changed behavior; refresh affected Gate 5 execution through the owning workflow before claiming it passes.

One approval covers one bounded correction pass and its verification. Newly discovered fixes, expanded scope, or a failed correction needing a different approach return to a concrete plan for approval; do not enter an unbounded review/fix loop.

Update `docs/final-review.md` with approval, changed files, before/after evidence, resolved and remaining findings, and final scoped verdict. Present the revised product and verification for human acceptance. Do not equate approval to make corrections with acceptance of their result. Do not merge, deploy, or close the run unless separately requested.
