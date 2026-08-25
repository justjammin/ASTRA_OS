import { join, isAbsolute, resolve } from "node:path";

export const ARTIFACT_DIR = ".astra";

export function runRoot(cwd, slug, out) {
  if (out) return isAbsolute(out) ? out : resolve(cwd, out);
  return join(cwd, ARTIFACT_DIR, slug);
}

// Artifact layout is a contract: gate validation, the visualizer, and every agent prompt
// resolve the same relative paths from the run root.
export const REL = {
  status: "00-status.md",
  ledger: "status.json",
  product: "docs/01-product.md",
  architecture: "docs/02-architecture.md",
  programDesign: "docs/03-program-design.md",
  slices: "docs/04-slices.md",
  plan: "PLAN.md",
  audit: "docs/audit.md",
  uiLayout: "json/ui-layout.json",
  systemArchitecture: "json/system-architecture.json",
  callStackTypes: "json/call-stack-types.json",
  auditJson: "json/audit.json",
  dag: "json/plan.json",
  execution: "json/dag-execution.json",
  interaction: "json/interaction.json",
  session: "json/session.json",
  logs: "logs",
};

export function artifact(root, key) {
  const rel = REL[key];
  if (!rel) throw new Error(`unknown artifact key: ${key}`);
  return join(root, rel);
}

export function logPath(root, name) {
  return join(root, REL.logs, `${name}.log`);
}
