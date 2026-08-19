import { join } from "node:path";
import { artifact } from "./paths.mjs";
import { readJson, writeJson, writeText, isNonEmptyFile, nowIso } from "./util.mjs";

const RANK = { approve: 0, revise: 1, reject: 2 };
const WORST = ["approve", "revise", "reject"];

export function personaFile(root, name) {
  return join(root, "json", `audit-${name.toLowerCase()}.json`);
}

/**
 * Merge independent persona verdicts into one audit. Resolution is arithmetic, not rhetorical:
 * an unresolved P0 rejects the gate no matter how confident the other cores are.
 */
export function resolve(personas, { mode, slug, agent }) {
  const findings = personas.flatMap((p) => p.findings.map((f) => ({ ...f, raisedBy: p.name })));
  const hasP0 = findings.some((f) => f.severity === "P0");
  const hasP1 = findings.some((f) => f.severity === "P1");

  const declared = Math.max(...personas.map((p) => RANK[p.verdict] ?? 0));
  const evidenced = hasP0 ? RANK.reject : hasP1 ? RANK.revise : RANK.approve;
  const verdict = WORST[Math.max(declared, evidenced)];

  const unanimous = new Set(personas.map((p) => p.verdict)).size === 1;
  const lowest = personas.some((p) => p.confidence === "low")
    ? "low"
    : personas.some((p) => p.confidence === "med")
      ? "med"
      : "high";
  const confidence = unanimous ? lowest : downgrade(lowest);

  const dissenters = personas.filter((p) => p.verdict !== verdict);
  const counts = tally(findings);

  return {
    meta: { mode, slug, agent, ranAt: nowIso() },
    personas,
    verdict,
    confidence,
    dissent: dissenters.length
      ? dissenters.map((p) => `${p.name} voted ${p.verdict} (${p.confidence})`).join("; ")
      : undefined,
    summary:
      `${personas.length} reviewer(s) in ${mode} mode: ` +
      `${counts.P0} P0, ${counts.P1} P1, ${counts.P2} P2 → ${verdict} (${confidence} confidence)`,
  };
}

function downgrade(level) {
  return level === "high" ? "med" : "low";
}

function tally(findings) {
  return {
    P0: findings.filter((f) => f.severity === "P0").length,
    P1: findings.filter((f) => f.severity === "P1").length,
    P2: findings.filter((f) => f.severity === "P2").length,
  };
}

/** Read whatever persona files exist, resolve them, and write audit.json + docs/audit.md. */
export async function collect(root, personaNames, { mode, slug, agent }) {
  const personas = [];
  const missing = [];

  for (const name of personaNames) {
    const path = personaFile(root, name);
    if (!(await isNonEmptyFile(path))) {
      missing.push(name);
      continue;
    }
    try {
      const data = await readJson(path);
      personas.push(normalize(data, name));
    } catch (err) {
      missing.push(`${name} (${err.message})`);
    }
  }

  if (!personas.length) {
    const err = new Error(`no audit output produced by: ${missing.join(", ")}`);
    err.exitCode = 1;
    throw err;
  }

  const audit = resolve(personas, { mode, slug, agent });
  if (missing.length) audit.summary += `; missing: ${missing.join(", ")}`;

  await writeJson(artifact(root, "auditJson"), audit);
  await writeText(artifact(root, "audit"), renderAudit(audit));
  await mergeRiskFlags(root, audit);
  return { audit, missing };
}

function normalize(data, fallbackName) {
  return {
    name: data.name ?? fallbackName,
    lens: data.lens,
    verdict: data.verdict ?? "revise",
    confidence: data.confidence ?? "low",
    findings: (data.findings ?? []).map((f) => ({
      severity: f.severity ?? "P2",
      claim: f.claim ?? "(unstated)",
      target: f.target,
      evidence: f.evidence,
      fix: f.fix,
    })),
  };
}

/** Findings are only useful next to the design they attack, so they land in the architecture artifact too. */
async function mergeRiskFlags(root, audit) {
  const path = artifact(root, "systemArchitecture");
  if (!(await isNonEmptyFile(path))) return;
  let arch;
  try {
    arch = await readJson(path);
  } catch {
    return;
  }
  arch.riskFlags = audit.personas.flatMap((p) =>
    p.findings.map((f) => ({
      severity: f.severity,
      claim: f.claim,
      raisedBy: p.name,
      ...(f.target ? { target: f.target } : {}),
      ...(f.fix ? { fix: f.fix } : {}),
      resolved: false,
    })),
  );
  await writeJson(path, arch);
}

export function renderAudit(audit) {
  const lines = [
    `# Adversarial audit — ${audit.meta.mode === "magi" ? "MAGI tribunal" : "grunt solo"}`,
    "",
    `**Verdict:** ${audit.verdict} · **Confidence:** ${audit.confidence}`,
    "",
    audit.summary,
    "",
  ];
  if (audit.dissent) lines.push(`**Dissent:** ${audit.dissent}`, "");

  for (const persona of audit.personas) {
    lines.push(`## ${persona.name} — ${persona.verdict} (${persona.confidence})`, "");
    if (persona.lens) lines.push(`_${persona.lens}_`, "");
    if (!persona.findings.length) {
      lines.push("No findings.", "");
      continue;
    }
    lines.push("| Severity | Claim | Target | Fix |", "|---|---|---|---|");
    for (const f of persona.findings) {
      lines.push(`| ${f.severity} | ${cell(f.claim)} | ${cell(f.target)} | ${cell(f.fix)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function cell(text) {
  return (text ?? "—").replace(/\|/g, "\\|").replace(/\n+/g, " ");
}
