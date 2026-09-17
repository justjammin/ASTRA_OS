# Adversarial review of token reductions

An independent solo Grunt reviewer assessed proposals 1–5 in `docs/token-cost-audit.md` at commit `771b557aaa8693bfda87c1e8dd4c4f563c1c35e0`. The reviewer made no repository edits. The controller applied the bounded change below after receiving the verdict.

The review used the judge protocol and relevant agentic catalogs. No grounded P0/P1 blocker was found. Missing compatibility or model-quality evidence remains Investigate, not an invented defect or blanket approval.

| Proposal | Verdict | Disposition |
|---|---|---|
| Compact embedded JSON schemas | Apply | Implemented; identical parsed schemas, 1,968 fewer instruction tokens |
| Remove a duplicate MCP schema representation | Investigate | Preserve current response fields pending consumer and host-context evidence |
| Cut role instructions by 50% | Investigate | Treat 50% as an unverified target; do not weaken worker instructions |
| Keep solo judging and conditional references | Apply | Retain existing defaults; no new savings claimed |
| Replace historical coverage with a smaller routing index | Investigate | Separate experiment requiring routing completeness and provenance checks |
| Lower reasoning effort or reduce task context | Investigate | Keep defaults until comparative quality and usage evidence exists |

## Approved change: compact schemas

At the reviewed commit, `lib/prompt.mjs:17-19` used `JSON.stringify(schema, null, 2)`. Removing indentation preserves all schema fields and values. `lib/gates.mjs:125-127` separately loads the schema for validation, so validation semantics are unchanged. Blast radius: rendered Gate 1–4 schema text. Reversal: restore the formatting arguments on that single line.

Both reviewer and controller reproduced parsed equality and the `o200k_base` savings: user story 294, architecture 664, program design 486, plan 524. Combined Gate 1–4 plus solo-review instruction contribution falls from **14,279 to 12,311 tokens**, a **13.8% reduction** for the audit fixture. This is not a measured reduction in total billed run cost.

The new smoke test renders all four gate prompts and compares each embedded schema with the validator schema. Existing MCP and stub-agent workflow tests exercise packet delivery and artifact handling. These checks do not measure live model readability or artifact-generation quality; that remains an evaluation follow-up before claiming unchanged model outcomes or net billing savings.

## Why the other changes remain experiments

**MCP schema deduplication.** The reviewed `lib/mcp-server.mjs:519-525` returns `contracts[].schema`; `:538-543` returns the rendered prompt. `test/mcp-server.test.mjs:59-64` explicitly expects a schema object. Removing it breaks that consumer contract. At `lib/mcp-server.mjs:781-787`, the response is also exposed as text and structured content, but host behavior determines whether both reach model context. Smallest next step: capture a real host trace, inventory consumers, and test a versioned or opt-in representation while preserving the current default. The potential 2,419-token saving is not established billing evidence.

**Role deduplication.** The measured solo role total is 6,300 tokens, but a 50% reduction has not been shown safe. `lib/adapters.mjs:532-534` concatenates role and task inputs. Roles also accompany repair and reviewer turns in `lib/pipeline.mjs:158-174`, `:199-215`, and `:345-357`. Removing a rule because it exists elsewhere can leave an isolated worker without it; extra repair turns can erase savings. Smallest next step: identify genuinely redundant rules and compare a small candidate against the original across supported hosts, measuring artifact validity, boundary violations, findings quality, repair rate, and net tokens. Preserve OOP inline examples.

**Solo and reference routing.** Solo already defaults in `lib/mcp-server.mjs:440-442`, `bin/astra.mjs:304-307`, and `lib/personas.mjs:49-50`. Three MAGI packets cost 3,531 more static tokens than one solo packet in this fixture. Conditional loading is already stated in `skills/grunt/SKILL.md:40`; the reference corpus is not automatically embedded in packets. Keeping these behaviors is approved. A smaller runtime coverage index needs a separate routing-completeness check, preserved provenance, and evidence that the index is actually loaded.

**Reasoning and context.** `lib/broker.mjs:8-15` selects Codex/Droid worker effort; `lib/pipeline.mjs:280-305` and `:337-355` pass it through. Lower effort has no measured quality result here. Context-budget reporting also does not prove compaction or enforcement. Smallest next step: compare bounded tasks at candidate effort levels, recording input/cache/output/reasoning tokens, latency, artifact validity, findings quality, and repairs. Keep raw evidence recoverable if testing context reduction. Do not lower architecture or adversarial-review effort without that evidence.

## Verification and follow-up

The controller verified complete schema equality in rendered prompts and the full repository suite after applying compaction. No MCP fields, role bodies, model settings, gate approvals, file boundaries, or OOP examples changed. Live model comparisons and the Investigate proposals remain tracked under `ASTRA_OS-ofq`; review and the applied change are tracked under `ASTRA_OS-c08`.
