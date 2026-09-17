# Stella and Astra token cost audit

Measured 2026-09-17 UTC with `js-tiktoken` 1.0.21, encoding `o200k_base`, against this repository after narrowing the Protect port to OOP research and inline examples. Counts are exact for this encoding and fixture, not provider billing measurements. Other tokenizers differ.

## Entry instructions

| File | Tokens |
|---|---:|
| `skills/stella/SKILL.md` | 351 |
| `.codex/skills/stella/SKILL.md` | 296 |
| `.claude-plugin/skills/stella/SKILL.md` | 292 |
| `.factory-plugin/skills/stella/SKILL.md` | 292 |
| `commands/astra.md` | 274 |
| `.codex/commands/astra.md` | 207 |
| `skills/grunt/SKILL.md` | 1,686 |

These are alternative host entry points, not instructions that every run loads together. Stella calls Astra's shared gate renderer, so its small entry file does not describe its total runtime cost.

## Rendered work packets

Fixture: intent `Token audit fixture`, slug `token-audit`, agent `codex`, repository cwd `/Users/jammin/Documents/GitHub/ASTRA_OS`, root `<cwd>/.astra/token-audit`. Counts include rendered schemas and the vendored role body. Combined counts use the CLI's `role + "\n\n---\n\n" + prompt` format; MCP sends role and prompt as separate fields.

| Packet | Prompt | Role | Combined |
|---|---:|---:|---:|
| Gate 1: product | 1,445 | 1,465 | 2,911 |
| Gate 2: architecture | 2,151 | 1,213 | 3,365 |
| Gate 3: contracts | 1,680 | 1,210 | 2,891 |
| Gate 4: plan | 2,065 | 1,309 | 3,375 |
| Solo Grunt review | 633 | 1,103 | 1,737 |
| MAGI Melchior review | 646 | 1,089 | 1,736 |
| MAGI Balthasar review | 669 | 1,083 | 1,753 |
| MAGI Casper review | 648 | 1,130 | 1,779 |

Gates 1–4 plus solo review contribute **14,279 static instruction tokens** when each packet is sent once. Before this change: 14,119; added OOP example instructions: **160 tokens**. MAGI's three reviewer packets total 5,268, versus 1,737 for solo: an additional **3,531**, before the extra reviewers read the same design and produce findings. Solo remains the default.

Gate 5 repeats a packet per DAG node. A tiny illustrative node measured approximately 1,427 tokens for implementation, 1,490 static verification, 1,439 unit, 1,523 integration, and 1,473 e2e. These use temporary fixture paths, one assertion, one write boundary and a short task. Real node contracts and tasks change the counts; these are not a per-node budget.

Excluded: host/system instructions, skill discovery, conversation replay, repository/artifact reads, tool responses, external research, generated artifacts, reasoning, retries, the CLI's Gate 1 scout, and optional specialist overlays. Native worker context forwarding can repeat packets. Therefore 14,279 is an instruction contribution, not total run usage or a forecast.

## Reference and transport costs

- Grunt skill + required judge protocol + coverage index: **6,173 tokens** before a domain catalog. Architecture/resilience adds 1,597; object design adds 3,458. Load only relevant domains.
- `catalog.json` alone is **10,193 tokens**. It is the canonical ID lookup, not required whole-file reading. The coverage index is **3,380** and includes historical slide provenance.
- The two new OOP guides total **2,936 tokens**, loaded only for actual object-design questions. They are not embedded in Astra packets. The entire references directory is an on-disk corpus, not default prompt context.
- Astra's serialized MCP tool definitions measure **1,821 tokens** before host wrappers. Hosts control discovery and exposure.
- `gateOperation` embeds a schema in the rendered prompt and returns it again in `contracts[].schema`. Four repeated schemas contribute **2,419 tokens**, measured separately as compact JSON. Gate 2 additionally returns the audit schema, which is not a duplicate of its architecture schema.
- `toToolResult` returns the result in both text and `structuredContent`. This duplicates transport data; whether both enter model context depends on the host. Do not claim a twofold billing cost without measuring host traces.

## Cost reductions, in priority order

1. **Compact embedded JSON schemas.** `schemaText` currently pretty-prints them. Identical JSON semantics in compact form save **1,968 tokens** over Gates 1–4: product 294, architecture 664, contracts 486, plan 524. This is about 13.8% of the measured solo instruction contribution. Verify readability and artifact validity before shipping.
2. **Return one schema representation in MCP packets.** Retain machine validation while avoiding the duplicate prompt/contracts representation. Potential saving: approximately **2,419 tokens** per four gate responses, with host serialization affecting exact results. Preserve MCP consumer compatibility; do not blindly remove structured results. This saving and schema compaction require a coordinated design to avoid double-counting overlapping changes.
3. **Deduplicate role and task rules.** The five solo role blocks total **6,300 tokens**. Their operating rules, refusals and definitions of done repeat much of the gate prompt. A 50% role reduction would save about **3,150 tokens** per pass, but that is a target, not a verified safe edit. Keep write boundaries, evidence requirements, verdict discipline and acceptance checks explicit. Compare generated artifacts before/after.
4. **Keep solo judging and conditional reference loading.** This already avoids the extra 3,531 static MAGI tokens and additional reviewer reads/outputs. Replace the historical coverage table with a small runtime routing index in a future change while retaining provenance separately. Do not preload the 10,193-token canonical catalog.
5. **Bound context and reasoning by task.** `WORKER_MODELS` sets Codex/Droid workers to `gpt-5.6-luna` at `max` effort; the host-native path uses host dispatch settings. Trial lower effort for bounded verification tasks, keep stronger review where failures justify it, and measure quality alongside tokens. Reduce repeated artifact reads through scoped packets and reuse of unchanged evidence. Any saving here requires runtime measurements.

No cost optimization or model-default change was applied in this update; the requested Protect port added 160 static packet tokens and 221 Grunt entry tokens. The extended guidance stays separate and conditional.

## Actual spend and reproducibility

The existing local session snapshot has zero recorded usage and no workers; that is insufficient evidence of actual spend. Native `astra_gate` prepares packets without recording the host's worker usage. Obtain host/provider input, cached-input, output/reasoning and pricing data for a real run. Dollar cost is each billed token bucket multiplied by its applicable rate; do not add reasoning twice if included in output. API prices and subscription usage limits are different accounting systems.

The installed dependency tree currently includes `js-tiktoken`. Entry counts can be reproduced from the repo root:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { getEncoding } from 'js-tiktoken';
import { prepareGatePrompt, prepareReviewerPackets } from './lib/pipeline.mjs';
const enc = getEncoding('o200k_base');
const count = text => enc.encode(text).length;
const ctx = { cwd: process.cwd(), root: process.cwd() + '/.astra/token-audit',
  intent: 'Token audit fixture', slug: 'token-audit', agent: 'codex', judge: 'solo' };
for (const path of ['skills/stella/SKILL.md', '.codex/skills/stella/SKILL.md',
  'commands/astra.md', 'skills/grunt/SKILL.md']) {
  console.log(path, count(await readFile(path, 'utf8')));
}
for (const id of ['product', 'architecture', 'design', 'plan']) {
  const p = await prepareGatePrompt(ctx, id);
  console.log(id, count(p.prompt), count(p.role), count(p.role + '\n\n---\n\n' + p.prompt));
}
for (const p of await prepareReviewerPackets(ctx)) {
  console.log(p.name, count(p.prompt), count(p.role), count(p.role + '\n\n---\n\n' + p.prompt));
}
JS
```

The packet functions only render text; this reproduction does not start a run or invoke a model. Changing the cwd changes rendered path token counts. Implementation evidence: `lib/prompt.mjs` (`schemaText`), `lib/pipeline.mjs` (`prepareGatePrompt`, `prepareReviewerPackets`, `prepareNodePacket`, `runProductScout`), `lib/mcp-server.mjs` (`gateOperation`, `toToolResult`), `lib/rolemap.mjs` (`personaBlock`), and `lib/broker.mjs` (`WORKER_MODELS`, usage recording).
