import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import { workerCompaction, applyPiCompaction } from "../lib/compaction.mjs";
import { invoke } from "../lib/adapters.mjs";

const options = { prompt: "Verify this slice", cwd: process.cwd(), dryRun: true };

test("compaction rejects invalid policy instead of guessing capacity", () => {
  assert.deepEqual(workerCompaction(), { ratio: 0.5, contextWindow: null });
  for (const input of [null, [], { ratio: NaN }, { ratio: 0 }, { ratio: 1 }, { contextWindow: -1 }, { contextWindow: "200000" }]) {
    assert.throws(() => workerCompaction(input));
  }
});

test("concurrent Claude workers get isolated settings without changing process env", async () => {
  const before = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  const [first, second] = await Promise.all([
    invoke("claude", { ...options, compaction: { ratio: 0.3 } }),
    invoke("claude", { ...options, compaction: { ratio: 0.6, contextWindow: 200000 } }),
  ]);
  assert.equal(first.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "30");
  assert.equal(second.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "60");
  const settings = JSON.parse(second.argv[second.argv.indexOf("--settings") + 1]);
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, before);
  assert.equal(first.compaction.status, "configured");
});

test("Codex uses known per-worker capacity, independent of total spend", async () => {
  const result = await invoke("codex", { ...options, budgetTokens: 9000000, compaction: { ratio: 0.5, contextWindow: 200000 } });
  assert.ok(result.argv.includes("model_auto_compact_token_limit=100000"));
  assert.ok(!result.argv.some((arg) => arg.startsWith("model_context_window=")));
  assert.equal(result.compaction.tokenLimit, 100000);
  const unknown = await invoke("codex", { ...options, compaction: {} });
  assert.equal(unknown.compaction.status, "native-default");
  assert.match(unknown.warning, /known contextWindow/);
  assert.ok(!unknown.argv.some((arg) => arg.startsWith("model_auto_compact_token_limit=")));
});

test("unsupported adapters report native defaults without fake flags", async () => {
  for (const adapter of ["droid", "opencode", "hermes"]) {
    const result = await invoke(adapter, { ...options, compaction: { contextWindow: 200000 } });
    assert.equal(result.compaction.status, "native-default");
    assert.match(result.warning, /no verified per-session/);
    assert.ok(!result.argv.some((arg) => arg.startsWith("--compact")));
  }
});

test("Pi native compactor triggers at the worker threshold and leaves other sessions alone", () => {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 16000, keepRecentTokens: 20000 } });
  const other = SettingsManager.inMemory({ compaction: { reserveTokens: 16000 } });
  const policy = applyPiCompaction(settings, { contextWindow: 200000 }, { ratio: 0.5 });
  assert.equal(policy.tokenLimit, 100000);
  assert.equal(shouldCompact(99999, 200000, settings.getCompactionSettings()), false);
  assert.equal(shouldCompact(100001, 200000, settings.getCompactionSettings()), true);
  assert.equal(other.getCompactionReserveTokens(), 16000);
  const unknown = applyPiCompaction(other, null, {});
  assert.equal(unknown.status, "native-default");
  assert.equal(other.getCompactionReserveTokens(), 16000);
});
