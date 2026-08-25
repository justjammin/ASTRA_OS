#!/usr/bin/env node
// astra — the Astra OS harness CLI.
//
//   astra                                     install skills + plugin files, scan roles
//   astra start "<intent>" [--agent claude|pi]  open a run and its ledger
//   astra run [--gate <id>] [--all]            drive the current gate with the chosen agent CLI
//   astra gate <id>                            validate a gate from artifacts on disk
//   astra approve <id>                         human-only: clear a gate
//   astra advance | loop --to=<id> | complete   move the ledger
//   astra viz [--port 4319]                    serve the retro review console
//   astra roles scan|list|show <name>          role map (vendored + external roots)
//   astra doctor                               which agent CLIs are installed
import { cp, mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_IDS, detectAll, getAdapter } from "../lib/adapters.mjs";
import { GATES, GATE_IDS, checkGate, gateId, getGate } from "../lib/gates.mjs";
import {
  advance as advanceLedger,
  emptyLedger,
  loadLedger,
  loop as loopLedger,
  markCleared,
  markFailed,
  markRan,
  renderStatus,
  saveLedger,
} from "../lib/ledger.mjs";
import { REL, runRoot } from "../lib/paths.mjs";
import { runDesignGate, runExecution } from "../lib/pipeline.mjs";
import { MAP_DIR, loadMap, hydrate, scan } from "../lib/rolemap.mjs";
import { RUNTIME_IDS, getRuntime } from "../lib/runtime/index.mjs";
import { banner, ensureDir, slugify, style } from "../lib/util.mjs";
import { readInteraction, respondInteraction } from "../lib/policy.mjs";
import { initializeSession, loadSession, mutateSession, WORKER_MODELS } from "../lib/broker.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["astra", "grunt"];
const COMMAND_FILES = ["astra.md", "grunt.md"];
// Claude Code reads slash commands from ~/.claude/commands; Codex reads them from ~/.codex/prompts.
const HOSTS = [
  { id: "claude", skills: [".claude", "skills"], commands: [".claude", "commands"] },
  { id: "codex", skills: [".codex", "skills"], commands: [".codex", "prompts"] },
];

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function install() {
  for (const host of HOSTS) {
    const skillDir = join(homedir(), ...host.skills);
    const commandDir = join(homedir(), ...host.commands);
    await mkdir(skillDir, { recursive: true });
    await mkdir(commandDir, { recursive: true });
    for (const name of SKILLS) {
      await cp(join(PKG_ROOT, "skills", name), join(skillDir, name), { recursive: true, force: true });
    }
    for (const file of COMMAND_FILES) {
      await cp(join(PKG_ROOT, "commands", file), join(commandDir, file), { force: true });
    }
    console.log(`  installed  ${SKILLS.join(", ")}  →  ${skillDir}`);
    console.log(`             ${COMMAND_FILES.map((f) => `/${f.replace(".md", "")}`).join(", ")}  →  ${commandDir}`);
  }

  const result = await scan({});
  console.log(`  role map   ${result.count} roles across ${result.domains} domains  →  ${MAP_DIR}`);

  const detected = (await detectAll()).filter((d) => d.installed).map((d) => d.id);
  console.log(
    `  agent CLIs ${detected.length ? detected.join(", ") : style.amber("none found — install at least one of: " + ADAPTER_IDS.join(", "))}`,
  );
  console.log(`\n  Done. Restart your agent CLI, then run /astra, /grunt, or \`astra start "<intent>"\`.\n`);
}

async function listRuns(cwd) {
  const base = join(cwd, ".astra");
  let slugs;
  try {
    slugs = (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  const runs = [];
  for (const slug of slugs) {
    const root = join(base, slug);
    const ledger = await loadLedger(root);
    if (ledger) runs.push({ cwd, root, ledger });
  }
  return runs;
}

async function resolveRun(flags) {
  const cwd = process.cwd();
  if (flags.out) {
    const root = resolve(cwd, flags.out);
    const ledger = await loadLedger(root);
    if (!ledger) throw exit(`no run at ${root} — start one with \`astra start "<intent>"\``, 3);
    return { cwd, root, ledger };
  }

  const runs = await listRuns(cwd);
  if (!runs) throw exit('no run in this repository — start one with `astra start "<intent>"`', 3);
  const active = runs.filter((r) => !r.ledger.complete);
  if (flags.slug) {
    const match = runs.find((r) => r.ledger.meta.slug === flags.slug);
    if (!match) throw exit(`no run with slug "${flags.slug}"`, 3);
    return match;
  }
  if (!active.length) throw exit('no active run — start one with `astra start "<intent>"`', 3);
  if (active.length > 1) {
    throw exit(`${active.length} active runs — pass --slug <${active.map((r) => r.ledger.meta.slug).join("|")}>`, 3);
  }
  return active[0];
}

function contextFor({ cwd, root, ledger }, flags) {
  return {
    cwd,
    root,
    slug: ledger.meta.slug,
    intent: ledger.meta.intent,
    agent: flags.agent ?? ledger.meta.agent,
    judge: flags.judge ?? ledger.meta.judge,
    runtime: flags.runtime ?? ledger.meta.runtime ?? "local",
    concurrency: Number(flags.concurrency ?? 2),
    slice: typeof flags.slice === "string" ? flags.slice : null,
    maxAttempts: Number(flags["max-attempts"] ?? 2),
    dryRun: Boolean(flags["dry-run"]),
    specialists: flags.specialists === "false" ? false : true,
    timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
    budgetTokens: flags["budget-tokens"] ?? ledger.meta.budgetTokens ?? null,
    workerModel: WORKER_MODELS[flags.agent ?? ledger.meta.agent] ?? { model: null, effort: null },
  };
}

function exit(message, code = 1) {
  const err = new Error(message);
  err.exitCode = code;
  return err;
}

async function cmdStart(positional, flags) {
  const intent = positional.join(" ").trim();
  if (!intent) throw exit('astra start "<intent>" — intent is required', 1);

  const agent = flags.agent ?? "claude";
  getAdapter(agent);
  const judge = flags.judge ?? "solo";
  if (!["solo", "magi"].includes(judge)) throw exit(`--judge must be solo or magi, got "${judge}"`, 1);
  const runtime = flags.runtime ?? "local";
  if (!RUNTIME_IDS.includes(runtime)) throw exit(`--runtime must be one of: ${RUNTIME_IDS.join(", ")}`, 1);
  if (flags["budget-tokens"] !== undefined) {
    const budget = Number(flags["budget-tokens"]);
    if (!Number.isSafeInteger(budget) || budget <= 0) throw exit("--budget-tokens must be a positive integer", 1);
  }

  const cwd = process.cwd();
  const slug = flags.slug ? slugify(flags.slug) : slugify(intent);
  const root = runRoot(cwd, slug, flags.out);

  // One active run per repository: parallel runs would race the same source tree at Gate 5.
  const active = (await listRuns(cwd))?.find((r) => !r.ledger.complete);
  if (active) {
    throw exit(
      `a run for "${active.ledger.meta.slug}" is already active (phase ${active.ledger.phase}) — ` +
        "finish it with `astra complete` or abandon it before starting another",
      3,
    );
  }

  await ensureDir(root);
  const ledger = emptyLedger({ slug, intent, agent, judge, runRoot: root, cwd });
  ledger.meta.runtime = runtime;
  ledger.meta.budgetTokens = flags["budget-tokens"] ? Number(flags["budget-tokens"]) : null;
  await saveLedger(root, ledger);

  const gui = flags.gui || (!flags["no-gui"] && process.stdout.isTTY);
  await initializeSession(root, {
    slug,
    harness: agent,
    budgetTokens: ledger.meta.budgetTokens,
    interfaceMode: gui ? "gui" : "tui",
  });

  const detection = (await detectAll()).find((d) => d.id === agent);
  console.log(
    banner("ASTRA READY", [
      `intent    ${intent.slice(0, 60)}`,
      `slug      ${slug}`,
      `agent     ${agent}${detection?.installed ? "" : "  (NOT ON PATH)"}`,
      `judge     ${judge}`,
      `runtime   ${runtime}`,
      `session   ${agent} → ${gui ? "GUI" : "TUI"}`,
      `budget    ${ledger.meta.budgetTokens ? `${ledger.meta.budgetTokens.toLocaleString()} tokens` : "display only (unbounded)"}`,
      `artifacts ${root}`,
      `phase     1/5 ${GATES[0].name}`,
    ]),
  );
  if (gui) {
    launchVisualizer(root, Number(flags.port ?? 4319));
    console.log(`\n  console launching in background; next: ${style.lime("astra run")}\n`);
  } else {
    console.log(`\n  next: ${style.lime("astra run")}  ·  GUI: ${style.lime("astra viz")}\n`);
  }
}

function launchVisualizer(root, port) {
  const child = spawn(process.execPath, [join(PKG_ROOT, "visualizer", "server.mjs"), root, `--port=${port}`, "--open"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function cmdRun(positional, flags) {
  const run = await resolveRun(flags);
  const ctx = contextFor(run, flags);
  await mutateSession(run.root, (session) => {
    session.status = "running";
    session.coordinator.status = "running";
  });
  const all = Boolean(flags.all);
  const target = flags.gate ?? positional[0] ?? run.ledger.phase;

  if (!GATE_IDS.includes(target)) throw exit(`unknown gate "${target}" — one of: ${GATE_IDS.join(", ")}`, 1);
  if (target !== run.ledger.phase) {
    throw exit(`ledger is at "${run.ledger.phase}", not "${target}" — use \`astra advance\` or \`astra loop --to=${target}\``, 3);
  }

  let ledger = run.ledger;
  for (;;) {
    const gate = getGate(ledger.phase);

    if (ctx.dryRun) {
      const preview = gate.execute ? await runExecution(ctx) : await runDesignGate(ctx, gate.id);
      console.log(`  ${style.dim("dry run —")} would invoke: ${(preview.argv ?? [ctx.agent]).slice(0, 2).join(" ")} …`);
      return;
    }

    const result = gate.execute
      ? await runExecutionGate(ctx, gate)
      : await runDesignGate(ctx, gate.id);

    ledger = result.ok ? markRan(ledger, gate.id, result.detail) : markFailed(ledger, gate.id, result.detail);
    await saveLedger(ctx.root, ledger);
    await printGate(ctx.root, gate.id);

    if (!result.ok) throw exit(`gate ${gate.n} (${gate.id}) did not produce valid artifacts`, 1);
    if (!all) {
      console.log(`\n  human review, then: ${style.lime(`astra approve ${gate.id}`)} && ${style.lime("astra advance")}\n`);
      return;
    }
    ledger = markCleared(ledger, gate.id, "astra run --all");
    if (gate.id === GATE_IDS.at(-1)) {
      ledger.complete = true;
      await saveLedger(ctx.root, ledger);
      console.log(`\n  ${style.lime("run complete")}\n`);
      return;
    }
    ledger = advanceLedger(ledger);
    await saveLedger(ctx.root, ledger);
  }
}

async function runExecutionGate(ctx, gate) {
  const dagCheck = await checkGate(ctx.root, "plan");
  if (!dagCheck.ok) throw exit(`gate 4 artifacts are invalid — cannot execute: ${dagCheck.checks.filter((c) => !c.ok).map((c) => c.path).join(", ")}`, 1);
  const { status } = await runExecution(ctx);
  const verdict = await checkGate(ctx.root, gate.id);
  return { ok: status === "passed" && verdict.ok, detail: `execution ${status}` };
}

async function printGate(root, gateId) {
  const { gate, ok, checks } = await checkGate(root, gateId);
  const lines = checks.map((c) => `${c.ok ? style.lime("✓") : style.red("✗")} ${c.path.padEnd(30)} ${style.dim(c.detail)}`);
  console.log(
    `\n${banner(`GATE ${gate.n} — ${gate.name.toUpperCase()}`, [`status  ${ok ? "artifacts valid" : "artifacts INVALID"}`])}`,
  );
  for (const line of lines) console.log(`  ${line}`);
  return ok;
}

async function cmdGate(positional, flags) {
  const run = await resolveRun(flags);
  const gateId = positional[0] ? toGateId(positional[0]) : run.ledger.phase;
  const ok = await printGate(run.root, gateId);
  if (!ok) throw exit(`gate "${gateId}" is not satisfied`, 1);
  const state = run.ledger.gates[gateId];
  if (state.status === "pending") {
    run.ledger = markRan(run.ledger, gateId, "validated from disk");
    await saveLedger(run.root, run.ledger);
  }
  console.log(`\n  ${style.dim("human approval:")} ${style.lime(`astra approve ${gateId}`)}\n`);
}

async function cmdApprove(positional, flags) {
  const run = await resolveRun(flags);
  const gateId = positional[0] ? toGateId(positional[0]) : run.ledger.phase;
  const human = flags["i-am-human"] || process.env.ASTRA_HUMAN === "1" || process.stdin.isTTY;
  if (!human) {
    throw exit(
      `clearing a gate is the human's decision — surface this command instead of running it:\n    astra approve ${gateId}`,
      4,
    );
  }
  const { ok } = await checkGate(run.root, gateId);
  if (!ok) throw exit(`gate "${gateId}" artifacts are invalid — nothing to approve`, 1);

  run.ledger = markCleared(run.ledger, gateId, "human");
  await saveLedger(run.root, run.ledger);
  console.log(`  ${style.lime("cleared")} ${gateId}\n  next: ${style.lime("astra advance")}`);
}

async function cmdAdvance(_positional, flags) {
  const run = await resolveRun(flags);
  const ledger = advanceLedger(run.ledger);
  await saveLedger(run.root, ledger);
  if (ledger.complete) {
    console.log(`  ${style.lime("run complete")} — artifacts at ${run.root}`);
    return;
  }
  const gate = getGate(ledger.phase);
  console.log(`  phase ${gate.n}/5 ${style.bold(gate.name)}\n  next: ${style.lime("astra run")}`);
}

async function cmdLoop(_positional, flags) {
  const run = await resolveRun(flags);
  if (!flags.to) throw exit("astra loop --to=<gate> --reason=\"<one line>\"", 1);
  if (!flags.reason) throw exit("--reason is required: name what the loop must fix", 1);
  const target = toGateId(flags.to);
  const ledger = loopLedger(run.ledger, target, String(flags.reason));
  await saveLedger(run.root, ledger);
  console.log(`  looped to ${target} — ${flags.reason}\n  next: ${style.lime("astra run")}`);
}

/** Accept a gate number or id from the command line; the ledger only ever stores ids. */
function toGateId(value) {
  try {
    return gateId(String(value));
  } catch (err) {
    throw exit(err.message, 1);
  }
}

async function cmdComplete(_positional, flags) {
  const run = await resolveRun(flags);
  run.ledger.complete = true;
  await saveLedger(run.root, run.ledger);
  await mutateSession(run.root, (session) => {
    session.status = "complete";
    session.coordinator.status = "complete";
  });
  console.log(`  run "${run.ledger.meta.slug}" closed.`);
}

async function cmdStatus(_positional, flags) {
  const run = await resolveRun(flags);
  if (flags.json) {
    console.log(JSON.stringify(run.ledger, null, 2));
    return;
  }
  console.log(renderStatus(run.ledger));
  const session = await loadSession(run.root);
  if (session) printSession(session);
}

async function cmdSession(_positional, flags) {
  const run = await resolveRun(flags);
  const session = await loadSession(run.root);
  if (!session) throw exit("run has no broker session", 3);
  if (flags.json) console.log(JSON.stringify(session, null, 2));
  else printSession(session);
}

function printSession(session) {
  const budget = session.budget ?? {};
  const used = Number(budget.usedTokens ?? 0).toLocaleString();
  const limit = budget.budgetTokens ? Number(budget.budgetTokens).toLocaleString() : "unbounded";
  const percent = budget.percent == null ? "—" : `${budget.percent.toFixed(1)}%`;
  console.log(`\n${banner("ASTRA SESSION", [
    `id       ${session.id}`,
    `path     session → ${session.harness} → ${String(session.interface).toUpperCase()}`,
    `budget   ${used} / ${limit} tokens (${percent})`,
    `workers  ${(session.workers ?? []).length}`,
  ])}`);
  for (const warning of session.warnings ?? []) console.log(`  ${style.amber("!")} ${warning}`);
}

async function cmdRespond(positional, flags) {
  const requestId = positional[0];
  if (!requestId) throw exit('astra respond <request-id> --approve|--deny|--answer="…"', 1);
  const run = await resolveRun(flags);
  const action = flags.approve ? "approve" : flags.deny ? "deny" : flags.answer !== undefined ? "answer" : null;
  if (!action) throw exit('choose exactly one of --approve, --deny, or --answer="…"', 1);
  const current = await readInteraction(run.root);
  if (!current || current.requestId !== requestId) throw exit(`no pending interaction "${requestId}"`, 1);
  const result = await respondInteraction(run.root, {
    requestId,
    resumeToken: flags.token ?? current.resumeToken,
    action,
    ...(action === "answer" ? { value: String(flags.answer) } : {}),
  });
  if (!result.ok) throw exit(result.errors.join("; "), 1);
  console.log(`  ${style.lime("interaction resolved")} ${requestId} — ${result.data.status}`);
}

async function cmdViz(_positional, flags) {
  const run = await resolveRun(flags);
  const { startVisualizer } = await import("../visualizer/server.mjs");
  const { url } = await startVisualizer({
    runRoot: run.root,
    port: Number(flags.port ?? 4319),
    open: flags.open !== "false" && !flags["no-open"],
  });
  console.log(banner("ASTRA VISUALIZER", [`run   ${run.ledger.meta.slug}`, `url   ${url}`, "stop  ctrl-c"]));
}

async function cmdRoles(positional, flags) {
  const sub = positional[0] ?? "list";
  if (sub === "scan") {
    const roots = flags.dir ? [resolve(process.cwd(), String(flags.dir))] : undefined;
    const result = await scan({ roots, mapDir: flags.map ? String(flags.map) : MAP_DIR });
    console.log(`  ${result.count} roles across ${result.domains} domains → ${flags.map ?? MAP_DIR}`);
    for (const [domain, names] of Object.entries(result.index.domains)) {
      console.log(`  ${style.cyan(domain.padEnd(22))} ${names.length}`);
    }
    return;
  }
  if (sub === "show") {
    const name = positional[1];
    if (!name) throw exit("astra roles show <name>", 1);
    const role = await hydrate(name);
    if (!role) throw exit(`role "${name}" not found — run \`astra roles scan\``, 1);
    console.log(`# ${role.name}\n\n${role.description}\n\n${role.body}`);
    return;
  }

  const map = await loadMap();
  if (!map) throw exit("no role map — run `astra roles scan`", 1);
  for (const [domain, names] of Object.entries(map.index.domains)) {
    console.log(`${style.cyan(domain)}`);
    for (const name of names) console.log(`  ${name}`);
  }
}

async function cmdDoctor() {
  const detected = await detectAll();
  console.log(banner("ASTRA DOCTOR"));
  for (const d of detected) {
    const adapter = getAdapter(d.id);
    console.log(
      `  ${d.installed ? style.lime("✓") : style.dim("·")} ${d.id.padEnd(9)} ${d.installed ? d.path : style.dim("not on PATH")}`,
    );
    console.log(`    ${style.dim(adapter.notes)}`);
  }
  const map = await loadMap();
  console.log(`\n  role map  ${map ? `${Object.keys(map.index.domains).length} domains at ${MAP_DIR}` : style.amber("missing — run `astra roles scan`")}`);
  console.log("  runtimes");
  for (const id of RUNTIME_IDS) {
    const ready = await runtimeReady(id);
    console.log(
      `  ${ready.ok ? style.lime("✓") : style.dim("·")} ${id.padEnd(9)} ${getRuntime(id).label}${ready.ok ? "" : style.dim(` — ${ready.hint}`)}`,
    );
  }
}

async function cmdMcp() {
  const { serveStdio } = await import("../lib/mcp-server.mjs");
  await serveStdio();
}

async function runtimeReady(id) {
  if (id !== "langgraph") return { ok: true };
  try {
    await import("@langchain/langgraph");
    return { ok: true };
  } catch {
    return { ok: false, hint: "npm install @langchain/langgraph" };
  }
}

function usage() {
  console.log(
    [
      "astra — Astra OS harness",
      "",
      "  astra                                install skills, plugin files, and the role map",
      '  astra start "<intent>"               open a run   [--agent claude|droid|opencode|hermes|codex|pi]',
      "                                                    [--judge solo|magi] [--runtime local|langgraph] [--budget-tokens N]",
      "                                                    [--gui|--no-gui] [--out <dir>]",
      "  astra run [--all] [--dry-run]        drive the current gate with the run's agent CLI",
      "                                       gate 5 only: [--slice tracer|<id>] [--concurrency N] [--timeout <sec>]",
      "  astra gate [<gate>]                  validate a gate from artifacts on disk",
      "  astra approve <gate>                 human-only: clear a gate",
      "  astra advance                        move to the next gate",
      '  astra loop --to=<gate> --reason="…"  go back a gate (budget 2 each)',
      "  astra status [--json]                ledger",
      "  astra session [--json]               harness, workers, and token budget",
      "  astra respond <request-id>            resolve a pending command/input wait",
      "  astra viz [--port 4319]              retro review console",
      "  astra roles scan|list|show <name>    role map",
      "  astra doctor                         installed agent CLIs and runtimes",
      "  astra mcp                            MCP stdio server for host harnesses",
      "  astra complete                       close the run",
      "",
      `  gates: ${GATES.map((g) => `${g.n}:${g.id}`).join("  ")}`,
      `  agents: ${ADAPTER_IDS.join(", ")}`,
      "",
      `  artifacts land in ${REL.status.replace("00-status.md", "")}.astra/<slug>/`,
    ].join("\n"),
  );
}

const COMMANDS = {
  start: cmdStart,
  run: cmdRun,
  gate: cmdGate,
  approve: cmdApprove,
  advance: cmdAdvance,
  loop: cmdLoop,
  status: cmdStatus,
  session: cmdSession,
  respond: cmdRespond,
  viz: cmdViz,
  roles: cmdRoles,
  doctor: cmdDoctor,
  mcp: cmdMcp,
  complete: cmdComplete,
  install,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) return install();
  if (["-h", "--help", "help"].includes(command)) return usage();

  const handler = COMMANDS[command];
  if (!handler) {
    usage();
    throw exit(`unknown command "${command}"`, 1);
  }
  const { flags, positional } = parseArgs(rest);
  await handler(positional, flags);
}

main().catch((err) => {
  console.error(`\n  ${style.red("astra:")} ${err.message}\n`);
  process.exit(err.exitCode ?? 1);
});
