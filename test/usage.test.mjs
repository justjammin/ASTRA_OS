import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateBudget, normalizeUsage } from "../lib/usage.mjs";

test("normalizeUsage maps provider aliases without double-counting cached input", () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 120,
    }),
    {
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      totalTokens: 120,
    },
  );
});

test("normalizeUsage accepts Pi-style counters and missing usage", () => {
  assert.deepEqual(normalizeUsage({ input: 4, output: 6, cacheRead: 2, cacheWrite: 1 }), {
    inputTokens: 4,
    outputTokens: 6,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 0,
    totalTokens: 13,
  });
  assert.deepEqual(normalizeUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  });
});

test("calculateBudget exposes spend and context headroom", () => {
  assert.deepEqual(calculateBudget({ usedTokens: 50, budgetTokens: 100, contextWindow: 200 }), {
    usedTokens: 50,
    budgetTokens: 100,
    remainingTokens: 50,
    percent: 50,
    contextWindow: 200,
    contextRemainingTokens: 150,
    contextPercent: 25,
    compressionThreshold: 0.5,
    compressionSuggested: true,
  });
});
