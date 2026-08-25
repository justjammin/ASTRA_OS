/**
 * The providers do not agree on names for token counters.  The harness keeps
 * one small, provider-neutral shape and treats missing counters as zero.
 *
 * `inputTokens` is the non-cached input count.  Cache reads and writes are
 * kept separate so a caller can both display billed tokens and avoid counting
 * a cached prompt twice.
 */
export const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const INPUT_KEYS = ["inputTokens", "input_tokens", "input"];
const PROMPT_KEYS = ["promptTokens", "prompt_tokens", "prompt"];
const NO_CACHE_INPUT_KEYS = ["noCacheTokens", "no_cache_tokens", "uncachedInputTokens", "uncached_input_tokens"];
const OUTPUT_KEYS = ["outputTokens", "output_tokens", "output", "completionTokens", "completion_tokens", "completion"];
const CACHE_READ_KEYS = [
  "cacheReadTokens",
  "cache_read_tokens",
  "cacheRead",
  "cache_read",
  "cachedInputTokens",
  "cached_input_tokens",
  "cacheReadInputTokens",
  "cache_read_input_tokens",
  "cachedTokens",
  "cached_tokens",
];
const CACHE_WRITE_KEYS = [
  "cacheWriteTokens",
  "cache_write_tokens",
  "cacheWrite",
  "cache_write",
  "cacheCreationInputTokens",
  "cache_creation_input_tokens",
  "cacheCreationTokens",
  "cache_creation_tokens",
];
const REASONING_KEYS = [
  "reasoningTokens",
  "reasoning_tokens",
  "reasoning",
  "thinkingTokens",
  "thinking_tokens",
];
const TOTAL_KEYS = ["totalTokens", "total_tokens", "total"];

/**
 * Normalize a usage object from a CLI, SDK event, or provider response.
 *
 * The function is intentionally total: malformed or absent usage must not
 * make a durable session impossible to render.  Numeric strings are accepted
 * because several headless CLIs emit JSON through text streams.
 */
export function normalizeUsage(raw = {}) {
  const source = unwrapUsage(raw);
  if (!isRecord(source)) return { ...EMPTY_USAGE };

  const details = firstRecord(
    source.inputTokenDetails,
    source.input_token_details,
    source.promptTokensDetails,
    source.prompt_tokens_details,
    source.promptTokenDetails,
    source.prompt_token_details,
    source.details,
  );
  const outputDetails = firstRecord(
    source.outputTokenDetails,
    source.output_token_details,
    source.completionTokensDetails,
    source.completion_tokens_details,
    source.completionTokenDetails,
    source.completion_token_details,
  );
  const cache = firstRecord(source.cache, source.caching, details?.cache);

  const cacheReadTokens = firstNumber(
    pick(source, CACHE_READ_KEYS),
    pick(details, CACHE_READ_KEYS),
    pick(cache, CACHE_READ_KEYS),
    0,
  );
  const cacheWriteTokens = firstNumber(
    pick(source, CACHE_WRITE_KEYS),
    pick(details, CACHE_WRITE_KEYS),
    pick(cache, CACHE_WRITE_KEYS),
    0,
  );

  // Pi and Anthropic report non-cached input directly. OpenAI-style usage
  // reports `prompt_tokens` as the complete prompt, so subtract cache buckets
  // only for that spelling.
  const directInput = firstNumber(pick(source, INPUT_KEYS));
  const promptInput = firstNumber(pick(source, PROMPT_KEYS));
  const noCacheInput = firstNumber(pick(details, NO_CACHE_INPUT_KEYS), pick(cache, NO_CACHE_INPUT_KEYS));
  const inputTokens = noCacheInput !== undefined
    ? noCacheInput
    : directInput !== undefined
      ? directInput
      : promptInput !== undefined
        ? Math.max(0, promptInput - cacheReadTokens - cacheWriteTokens)
        : firstNumber(pick(details, INPUT_KEYS), 0);

  const outputTokens = firstNumber(
    pick(source, OUTPUT_KEYS),
    pick(outputDetails, OUTPUT_KEYS),
    0,
  );
  const reasoningTokens = Math.min(
    outputTokens,
    firstNumber(
      pick(source, REASONING_KEYS),
      pick(outputDetails, REASONING_KEYS),
      0,
    ),
  );
  const calculatedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedTotal = firstNumber(pick(source, TOTAL_KEYS));

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    // Prefer a provider total when present. When prompt/cache fields were
    // normalized above, the calculated total is equivalent and avoids double
    // counting cache reads for providers that omit total_tokens.
    totalTokens: reportedTotal === undefined ? calculatedTotal : reportedTotal,
  };
}

/**
 * Calculate both spend and context headroom for a session.
 *
 * `budgetTokens` is an optional run budget; `contextWindow` is the selected
 * model's context limit.  `remainingTokens` refers to the run budget, while
 * `contextRemainingTokens` refers to the model context.
 */
export function calculateBudget({ usedTokens = 0, budgetTokens = null, contextWindow = null } = {}) {
  const used = tokenCount(usedTokens);
  const budget = positiveTokenCount(budgetTokens);
  const context = positiveTokenCount(contextWindow);
  const percent = budget === null ? null : Math.min(100, (used / budget) * 100);
  const contextPercent = context === null ? null : Math.min(100, (used / context) * 100);
  const compressionSuggested = [percent, contextPercent].some((value) => value !== null && value >= 50);

  return {
    usedTokens: used,
    budgetTokens: budget,
    remainingTokens: budget === null ? null : Math.max(0, budget - used),
    percent,
    contextWindow: context,
    contextRemainingTokens: context === null ? null : Math.max(0, context - used),
    contextPercent,
    compressionThreshold: 0.5,
    compressionSuggested,
  };
}

function unwrapUsage(value) {
  if (!isRecord(value)) return value;
  if (isRecord(value.usage)) return value.usage;
  for (const key of ["data", "result", "response"]) if (isRecord(value[key]?.usage)) return value[key].usage;
  return value;
}

function pick(value, keys) {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function firstRecord(...values) {
  return values.find(isRecord);
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
  if (typeof value === "bigint") return value >= 0n ? Number(value) : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
  }
  return undefined;
}

function tokenCount(value) {
  return firstNumber(value, 0);
}

function positiveTokenCount(value) {
  const count = firstNumber(value);
  return count === undefined || count <= 0 ? null : count;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
