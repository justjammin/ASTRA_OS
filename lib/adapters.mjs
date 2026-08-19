import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeText, nowIso } from "./util.mjs";

// One adapter drives an entire Astra run. A gate never switches CLIs: the agent that wrote the
// product intent is the agent that writes the code, so its reasoning context stays coherent.
export const ADAPTERS = {
  claude: {
    id: "claude",
    bin: "claude",
    label: "Claude Code",
    notes: "Strongest at long-horizon reasoning gates (architecture, contract design).",
    build: ({ prompt, role }) => ({
      argv: ["-p", role ? `${role}\n\n---\n\n${prompt}` : prompt, "--dangerously-skip-permissions"],
    }),
  },
  droid: {
    id: "droid",
    bin: "droid",
    label: "Factory Droid",
    notes: "High-speed vertical-slice generation; autonomous edit loop.",
    build: ({ prompt, role }) => ({
      argv: ["exec", "--auto", "high", role ? `${role}\n\n---\n\n${prompt}` : prompt],
    }),
  },
  opencode: {
    id: "opencode",
    bin: "opencode",
    label: "OpenCode",
    notes: "Pragmatic audits and script generation; quiet headless output.",
    build: ({ prompt, role }) => ({
      argv: ["run", "--quiet", role ? `${role}\n\n---\n\n${prompt}` : prompt],
    }),
  },
  hermes: {
    id: "hermes",
    bin: "hermes",
    label: "Hermes",
    notes: "Native system-prompt slot; suits red-team adversarial passes.",
    build: ({ prompt, role }) => ({
      argv: ["chat", ...(role ? ["--system", role] : []), "--message", prompt],
    }),
  },
  codex: {
    id: "codex",
    bin: "codex",
    label: "OpenAI Codex",
    notes: "Fast static verification and focused unit-test generation.",
    needsPromptFile: true,
    build: ({ prompt, role, promptFile }) => ({
      argv: ["exec", "--file", promptFile],
      files: [{ path: promptFile, content: role ? `${role}\n\n---\n\n${prompt}` : prompt }],
    }),
  },
};

export const ADAPTER_IDS = Object.keys(ADAPTERS);

export function getAdapter(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`unknown agent "${id}" — choose one of: ${ADAPTER_IDS.join(", ")}`);
  }
  return adapter;
}

export function detect(id) {
  const adapter = getAdapter(id);
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", [adapter.bin], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    probe.stdout.on("data", (chunk) => (out += chunk));
    probe.on("error", () => resolve({ id, installed: false, path: null }));
    probe.on("close", (code) =>
      resolve({ id, installed: code === 0 && out.trim().length > 0, path: out.trim().split("\n")[0] || null }),
    );
  });
}

export async function detectAll() {
  return Promise.all(ADAPTER_IDS.map((id) => detect(id)));
}

/**
 * Run one headless turn of the selected agent CLI.
 * Resolves with { ok, code, stdout, stderr, durationMs, argv } and never throws on non-zero exit.
 */
export async function invoke(adapterId, { prompt, role, cwd, logFile, timeoutMs = 30 * 60 * 1000, dryRun = false, workDir }) {
  const adapter = getAdapter(adapterId);
  const promptFile = adapter.needsPromptFile ? join(workDir ?? cwd, `.astra-prompt-${Date.now()}.txt`) : undefined;
  const spec = adapter.build({ prompt, role, promptFile });

  for (const file of spec.files ?? []) {
    await writeText(file.path, file.content);
  }

  if (dryRun) {
    return { ok: true, code: 0, stdout: "", stderr: "", durationMs: 0, argv: [adapter.bin, ...spec.argv], dryRun: true };
  }

  if (logFile) await ensureDir(join(logFile, ".."));
  const log = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
  log?.write(`\n=== ${nowIso()} ${adapter.bin} ${spec.argv.map(redact).join(" ")}\n`);

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(adapter.bin, spec.argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      log?.write(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log?.end();
      resolve({
        ok: false,
        code: 127,
        stdout,
        stderr: `${stderr}${err.message}`,
        durationMs: Date.now() - started,
        argv: [adapter.bin, ...spec.argv],
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log?.end();
      resolve({
        ok: code === 0 && !timedOut,
        code: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\ntimed out after ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - started,
        argv: [adapter.bin, ...spec.argv],
      });
    });
  });
}

function redact(arg) {
  return arg.length > 120 ? `${arg.slice(0, 117)}...` : arg;
}
