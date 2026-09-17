// Context occupancy is per session; cumulative run spend must never trigger compaction.
export function workerCompaction(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("worker compaction must be an object");
  const ratio = input.ratio ?? 0.5;
  const contextWindow = input.contextWindow ?? null;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0.01 || ratio > 0.9) {
    throw new TypeError("worker compaction ratio must be between 0.01 and 0.9");
  }
  if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow < 1000)) {
    throw new TypeError("worker contextWindow must be an integer of at least 1000 tokens");
  }
  return { ratio, contextWindow };
}

export function compactionPolicy(adapter, input) {
  if (input === undefined) return null;
  const request = workerCompaction(input);
  const tokenLimit = request.contextWindow === null ? null : Math.floor(request.contextWindow * request.ratio);
  if (adapter === "claude" && request.contextWindow !== null && (request.contextWindow < 100000 || request.contextWindow > 1000000)) {
    return { ...request, tokenLimit: null, status: "native-default", warning: "Claude custom auto-compact windows support 100000–1000000 tokens; retaining native defaults." };
  }
  if (adapter === "claude" || adapter === "pi" || (adapter === "codex" && tokenLimit !== null)) {
    return { ...request, tokenLimit, status: adapter === "pi" ? "pending-model" : "configured" };
  }
  return {
    ...request, tokenLimit: null, status: "native-default",
    warning: adapter === "codex"
      ? "Codex worker compaction uses native defaults: supply its known contextWindow to configure a token threshold."
      : `${adapter} worker compaction uses native defaults: Astra has no verified per-session threshold control.`,
  };
}

// Mutate only this launch's argv/environment/settings, never the user's host config.
export function applyCliCompaction(adapter, spec, policy) {
  if (policy?.status !== "configured") return;
  if (adapter === "claude") {
    const env = {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(policy.ratio * 100),
      ...(policy.contextWindow === null ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(policy.contextWindow) }),
    };
    spec.env = { ...spec.env, ...env };
    // A CLI settings env overrides inherited env in Claude Code.
    const index = spec.argv.indexOf("--settings");
    const settings = index < 0 ? {} : JSON.parse(spec.argv[index + 1]);
    settings.env = { ...settings.env, ...env };
    if (index < 0) spec.argv.splice(0, 0, "--settings", JSON.stringify(settings));
    else spec.argv[index + 1] = JSON.stringify(settings);
  } else if (adapter === "codex") {
    spec.argv.splice(0, 0, "-c", `model_auto_compact_token_limit=${policy.tokenLimit}`);
  }
}

export function applyPiCompaction(settings, model, request) {
  const policy = compactionPolicy("pi", request);
  const capacity = model?.contextWindow;
  if (!Number.isSafeInteger(capacity) || capacity < 1000) {
    return { ...policy, status: "native-default", warning: "Pi model context capacity unavailable; retaining native compaction defaults." };
  }
  const window = Math.min(capacity, policy.contextWindow ?? capacity);
  const tokenLimit = Math.floor(window * policy.ratio);
  settings.applyOverrides({ compaction: {
    enabled: true,
    reserveTokens: capacity - tokenLimit,
    keepRecentTokens: Math.min(settings.getCompactionKeepRecentTokens(), Math.floor(tokenLimit / 2)),
  } });
  return { ...policy, contextWindow: window, tokenLimit, status: "configured" };
}
