import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { relative } from "node:path";
import { artifact, logPath, REL } from "./paths.mjs";
import { checkGate, getGate } from "./gates.mjs";
import { renderPrompt, schemaText } from "./prompt.mjs";
import { invoke } from "./adapters.mjs";
import { personasFor } from "./personas.mjs";
import { collect, personaFile } from "./tribunal.mjs";
import { createExecution } from "./execution.mjs";
import { getRuntime } from "./runtime/index.mjs";
import { personaBlock, roleForGate, roleForNode, roleForPersona, suggestSpecialist } from "./rolemap.mjs";
import { ensureDir, readJson, style } from "./util.mjs";

const SCHEMA_VARS = {
  UI_LAYOUT_SCHEMA: "ui-layout",
  SYSTEM_ARCH_SCHEMA: "system-architecture",
  CALL_STACK_SCHEMA: "call-stack-types",
  PLAN_SCHEMA: "plan",
};

/** Prompt-visible paths are relative to the repo so the agent can act on them verbatim. */
function pathVars(ctx) {
  const rel = (key) => relative(ctx.cwd, artifact(ctx.root, key)) || REL[key];
  return {
    PRODUCT_PATH: rel("product"),
    ARCHITECTURE_PATH: rel("architecture"),
    PROGRAM_DESIGN_PATH: rel("programDesign"),
    SLICES_PATH: rel("slices"),
    PLAN_PATH: rel("plan"),
    UI_LAYOUT_PATH: rel("uiLayout"),
    SYSTEM_ARCH_PATH: rel("systemArchitecture"),
    CALL_STACK_TYPES_PATH: rel("callStackTypes"),
    AUDIT_PATH: rel("auditJson"),
    DAG_PATH: rel("dag"),
  };
}

async function baseVars(ctx) {
  const vars = {
    ...pathVars(ctx),
    INTENT: ctx.intent,
    SLUG: ctx.slug,
    AGENT: ctx.agent,
    CWD: ctx.cwd,
  };
  for (const [token, schema] of Object.entries(SCHEMA_VARS)) {
    vars[token] = await schemaText(schema);
  }
  return vars;
}

/**
 * Run one design gate: single agent turn, verify artifacts from disk, then at most one repair
 * turn quoting the exact validation failures. Never reports success on the agent's word.
 */
export async function runDesignGate(ctx, gateId, { log = console.log } = {}) {
  const gate = getGate(gateId);
  const vars = await baseVars(ctx);
  const role = await roleForGate(gateId);
  const prompt = await renderPrompt(gate.prompt, vars);

  await ensureDir(artifact(ctx.root, "logs").replace(/\/[^/]*$/, "/logs"));
  const file = logPath(ctx.root, `gate-${gate.n}-${gate.id}`);

  log(`${style.magenta("▚")} gate ${gate.n} ${style.bold(gate.name)} — ${ctx.agent} as ${role?.name ?? gate.role}`);
  let turn = await invoke(ctx.agent, {
    prompt,
    role: personaBlock(role),
    cwd: ctx.cwd,
    workDir: ctx.root,
    logFile: file,
    dryRun: ctx.dryRun,
    timeoutMs: ctx.timeoutMs,
  });
  if (ctx.dryRun) return { ok: true, dryRun: true, argv: turn.argv, prompt };

  if (gate.judge) await runJudges(ctx, { log });

  let verdict = await checkGate(ctx.root, gateId);
  if (!verdict.ok) {
    const failures = verdict.checks.filter((c) => !c.ok);
    log(`${style.amber("↻")} repair turn — ${failures.length} artifact problem(s)`);
    const repair = [
      `Your previous turn on Astra Gate ${gate.n} (${gate.name}) left artifacts that fail validation.`,
      "",
      "Failures:",
      ...failures.map((f) => `- \`${f.path}\` — ${f.detail}`),
      "",
      "Fix exactly these files. Do not restart the gate, do not rewrite passing artifacts, and do not",
      "touch anything else. The schema is authoritative: unexpected properties and missing required",
      "fields both fail. Then print the corrected file paths.",
      "",
      "Original gate instructions follow.",
      "",
      prompt,
    ].join("\n");

    turn = await invoke(ctx.agent, {
      prompt: repair,
      role: personaBlock(role),
      cwd: ctx.cwd,
      workDir: ctx.root,
      logFile: file,
      timeoutMs: ctx.timeoutMs,
    });
    if (gate.judge) await runJudges(ctx, { log });
    verdict = await checkGate(ctx.root, gateId);
  }

  return { ok: verdict.ok, checks: verdict.checks, exitCode: turn.code, logFile: file };
}

/** Gate 2 adversarial pass: solo grunt, or the three MAGI cores run independently. */
export async function runJudges(ctx, { log = console.log } = {}) {
  const mode = ctx.judge ?? "solo";
  const personas = personasFor(mode);
  const vars = await baseVars(ctx);

  for (const persona of personas) {
    const role = await roleForPersona(persona.name);
    const out = personaFile(ctx.root, persona.name);
    const prompt = await renderPrompt("gate2-judge.md", {
      ...vars,
      PERSONA_NAME: persona.name,
      PERSONA_LENS: persona.lens,
      PERSONA_BRIEF: persona.brief,
      OUT_PATH: relative(ctx.cwd, out),
    });
    log(`${style.cyan("◆")} judge ${persona.name} (${mode})`);
    await invoke(ctx.agent, {
      prompt,
      role: personaBlock(role),
      cwd: ctx.cwd,
      workDir: ctx.root,
      logFile: logPath(ctx.root, `gate-2-judge-${persona.name.toLowerCase()}`),
      dryRun: ctx.dryRun,
      timeoutMs: ctx.timeoutMs,
    });
  }

  if (ctx.dryRun) return null;
  const { audit, missing } = await collect(ctx.root, personas.map((p) => p.name), {
    mode,
    slug: ctx.slug,
    agent: ctx.agent,
  });
  log(`${style.cyan("◆")} audit: ${audit.summary}`);
  if (missing.length) log(`${style.amber("!")} no output from: ${missing.join(", ")}`);
  return audit;
}

/** Gate 5: run the DAG through the selected runtime, streaming state to json/dag-execution.json. */
export async function runExecution(ctx, { log = console.log } = {}) {
  const full = await readJson(artifact(ctx.root, "dag"));
  const plan = ctx.slice ? sliceOnly(full, ctx.slice) : full;
  const runtime = getRuntime(ctx.runtime ?? "local");
  const exec = createExecution(ctx.root, plan, {
    agent: ctx.agent,
    concurrency: ctx.concurrency ?? 2,
    runtime: runtime.id,
  });
  const vars = await baseVars(ctx);
  const sliceById = new Map(plan.slices.map((s) => [s.id, s]));

  await exec.event("info", `execution started on ${runtime.label} with ${ctx.agent}`);
  if (ctx.slice) {
    await exec.event("warn", `scoped to slice ${plan.meta.sliceFilter} — ${full.nodes.length - plan.nodes.length} node(s) held back`);
  }
  log(`${style.magenta("▚")} gate 5 execution — runtime ${runtime.id}, concurrency ${ctx.concurrency ?? 2}${ctx.slice ? `, slice ${plan.meta.sliceFilter}` : ""}`);

  const result = await runtime.runGraph({
    plan,
    concurrency: ctx.concurrency ?? 2,
    maxAttempts: ctx.maxAttempts ?? 2,
    hooks: {
      onWave: async (n, total, wave) => {
        await exec.event("info", `wave ${n}/${total}: ${wave.map((w) => w.id).join(", ")}`);
        log(`${style.dim(`  wave ${n}/${total}`)} ${wave.map((w) => `${w.id}:${w.kind}`).join(" ")}`);
      },
      onNodeStart: async (node, attempt) => {
        await exec.update(node.id, { status: "running", attempts: attempt, startedAt: new Date().toISOString() });
        await exec.event("info", `${node.id} ${node.title} (attempt ${attempt})`, node.id);
      },
      onNodeRetry: async (node, attempt, res) => {
        await exec.event("warn", `${node.id} attempt ${attempt} failed: ${res.summary ?? "no summary"}`, node.id);
      },
      onNodeBlocked: async (node, dep) => {
        await exec.update(node.id, { status: "blocked", summary: `blocked by ${dep}` });
        await exec.event("warn", `${node.id} blocked by ${dep}`, node.id);
        log(`${style.amber("  ⊘")} ${node.id} blocked by ${dep}`);
      },
      onNodeEnd: async (node, res) => {
        await exec.update(node.id, {
          status: res.ok ? "passed" : res.blocked ? "blocked" : "failed",
          finishedAt: new Date().toISOString(),
          durationMs: res.durationMs ?? 0,
          exitCode: res.exitCode ?? 0,
          summary: res.summary ?? "",
          logPath: res.logPath ?? "",
        });
        await exec.event(res.ok ? "info" : "error", `${node.id} ${res.ok ? "passed" : "failed"}: ${res.summary ?? ""}`, node.id);
        log(`${res.ok ? style.lime("  ✓") : style.red("  ✗")} ${node.id} ${node.title}${res.ok ? "" : ` — ${res.summary ?? ""}`}`);
      },
    },
    execute: (node) => runNode(ctx, { node, plan, vars, slice: sliceById.get(node.slice), exec }),
  });

  const status = await exec.finish();
  log(`${status === "passed" ? style.lime("▪") : style.red("▪")} execution ${status}`);
  return { status, runtimeStatus: result.status };
}

/**
 * Narrow a plan to one slice so a run can be demoed, or a single slice re-driven, without
 * executing the whole graph. `tracer` selects the plan's tracer slice. Dependencies that point
 * outside the slice are dropped: the nodes they name are not part of this pass, so keeping them
 * would block every node behind them.
 */
export function sliceOnly(plan, wanted) {
  const slice =
    wanted === "tracer"
      ? plan.slices.find((s) => s.tracer)
      : plan.slices.find((s) => s.id === wanted || s.title === wanted);
  if (!slice) {
    const err = new Error(
      `no slice "${wanted}" in the plan — choose one of: ${plan.slices.map((s) => s.id).join(", ")}`,
    );
    err.exitCode = 1;
    throw err;
  }

  const kept = new Set(plan.nodes.filter((n) => n.slice === slice.id).map((n) => n.id));
  return {
    ...plan,
    meta: { ...plan.meta, sliceFilter: slice.id },
    slices: [slice],
    nodes: plan.nodes
      .filter((n) => kept.has(n.id))
      .map((n) => ({ ...n, deps: n.deps.filter((d) => kept.has(d)) })),
  };
}

async function runNode(ctx, { node, vars, slice, exec }) {
  const file = logPath(ctx.root, `node-${node.id}`);
  const started = Date.now();

  if (node.command) {
    const res = await runCommand(node.command, ctx.cwd, file, ctx.dryRun);
    return {
      ok: res.code === 0,
      exitCode: res.code,
      durationMs: Date.now() - started,
      summary: res.code === 0 ? `\`${node.command}\` ok` : `\`${node.command}\` exited ${res.code}`,
      logPath: relative(ctx.cwd, file),
    };
  }

  const role = await roleForNode(node.kind);
  const specialist = ctx.specialists === false ? null : await suggestSpecialist(`${node.title} ${node.role.name} ${node.task ?? ""}`);
  const prompt = await renderPrompt("gate5-node.md", {
    ...vars,
    ROLE_PROMPT: node.role.systemPrompt,
    NODE_ID: node.id,
    NODE_TITLE: node.title,
    NODE_KIND: node.kind,
    SLICE_ID: node.slice,
    SLICE_TITLE: slice?.title ?? node.slice,
    SLICE_CRITERIA: (slice?.criteria ?? []).map((c) => `- ${c}`).join("\n") || "- (none recorded)",
    NODE_TASK: node.task ?? node.title,
    WRITE_BOUNDARY: node.role.writeBoundary.map((p) => `- \`${p}\``).join("\n"),
    ASSERTIONS: (node.assertions ?? []).map((a) => `- ${a}`).join("\n") || "- The contract's assertions for this node's layer hold.",
  });

  const before = await changedPaths(ctx.cwd);
  const turn = await invoke(ctx.agent, {
    prompt,
    role: personaBlock(role, specialist?.body),
    cwd: ctx.cwd,
    workDir: ctx.root,
    logFile: file,
    dryRun: ctx.dryRun,
    timeoutMs: ctx.timeoutMs,
  });
  if (ctx.dryRun) return { ok: true, exitCode: 0, durationMs: 0, summary: "dry run", logPath: relative(ctx.cwd, file) };

  const declaredFail = /^RESULT:\s*fail/im.test(turn.stdout);
  const blocked = /^BLOCKED:/im.test(turn.stdout);
  const after = await changedPaths(ctx.cwd);
  const violations = outOfBounds(before, after, node.role.writeBoundary);

  if (violations.length) {
    await exec.event("error", `${node.id} wrote outside its boundary: ${violations.slice(0, 5).join(", ")}`, node.id);
  }

  const ok = turn.ok && !declaredFail && !blocked && violations.length === 0;
  return {
    ok,
    blocked,
    exitCode: turn.code,
    durationMs: turn.durationMs,
    logPath: relative(ctx.cwd, file),
    summary: violations.length
      ? `write boundary violation: ${violations.slice(0, 3).join(", ")}`
      : blocked
        ? firstLine(turn.stdout, /^BLOCKED:.*/im)
        : declaredFail
          ? firstLine(turn.stdout, /^RESULT:\s*fail.*/im)
          : ok
            ? "passed"
            : `agent exited ${turn.code}`,
  };
}

export function runCommand(command, cwd, file, dryRun = false) {
  if (dryRun) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  return new Promise((resolvePromise) => {
    const log = createWriteStream(file, { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} sh -c ${command}\n`);
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += c;
      log.write(c);
    });
    child.stderr.on("data", (c) => log.write(c));
    child.on("error", (err) => {
      log.end();
      resolvePromise({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      log.end();
      resolvePromise({ code: code ?? 1, stdout, stderr: "" });
    });
  });
}

/** Git is the only cheap witness of what a node actually touched. No repo, no enforcement. */
async function changedPaths(cwd) {
  const res = await new Promise((resolvePromise) => {
    const child = spawn("git", ["status", "--porcelain", "-uall"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? out : null));
  });
  if (res === null) return null;
  return new Set(
    res
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p)),
  );
}

export function outOfBounds(before, after, boundary) {
  if (!before || !after) return [];
  const fresh = [...after].filter((p) => !before.has(p));
  return fresh.filter((path) => !path.startsWith(".astra/") && !boundary.some((rule) => matches(path, rule)));
}

function matches(path, rule) {
  const clean = rule.replace(/^\.\//, "").replace(/\/$/, "");
  if (clean === path) return true;
  if (clean.includes("*")) {
    const pattern = clean
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${pattern}$`).test(path);
  }
  return path.startsWith(`${clean}/`);
}

function firstLine(text, pattern) {
  return (pattern.exec(text) ?? [])[0]?.trim() ?? "failed";
}
