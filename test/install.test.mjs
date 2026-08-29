import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function runInstall(home, path, log = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "bin/astra.mjs"), "install", "--postinstall"], {
      cwd: root,
      env: { ...process.env, HOME: home, PATH: path, ASTRA_INSTALL_LOG: log },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("install skips missing hosts and does not create legacy host directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "astra-install-"));
  const emptyPath = await mkdtemp(join(tmpdir(), "astra-path-"));
  try {
    const result = await runInstall(home, emptyPath);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skipped claude/);
    assert.match(result.stdout, /skipped codex/);
    assert.match(result.stdout, /skipped droid/);
    await assert.rejects(readFile(join(home, ".claude", "skills", "stella")));
    await assert.rejects(readFile(join(home, ".codex", "skills", "astra")));
    await assert.rejects(readFile(join(home, ".factory", "skills", "astra")));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(emptyPath, { recursive: true, force: true });
  }
});

test("ships Mermaid and OpenPencil skills in every host plugin mirror", async () => {
  const roots = [".claude-plugin/skills", ".codex-plugin/skills", ".factory-plugin/skills", ".codex/skills"];
  for (const skill of ["mermaid", "open-pencil"]) {
    const source = await readFile(join(root, "skills", skill, "SKILL.md"), "utf8");
    assert.match(source, new RegExp(`name: ${skill}`));
    for (const base of roots) {
      assert.equal(await readFile(join(root, base, skill, "SKILL.md"), "utf8"), source, `${base}/${skill} mirror drifted`);
    }
  }
});

test("install copies Stella, merges Factory MCP, and is idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "astra-install-positive-"));
  const bin = await mkdtemp(join(tmpdir(), "astra-install-bin-"));
  const log = await mkdtemp(join(tmpdir(), "astra-install-log-"));
  const legacy = `---
name: astra-mcp
description: Use the Astra MCP tools for durable five-gate software-factory runs, human approval, and resumable interaction waits.
---

# Astra through MCP

Use one run per project and keep all transitions in the shared \`.astra/\` ledger.

1. \`astra_start\` creates a run from a concrete intent.
2. \`astra_status\` reports the current gate, validation, and pending interaction.
3. \`astra_run\` drives the current gate; use \`dryRun: true\` to preview.
4. Present artifacts and validation to the user; \`astra_approve\` requires \`human: true\`.
5. \`astra_respond\` needs the exact \`requestId\` and \`resumeToken\` for command/input waits.
6. \`astra_session\` lists/resumes sessions; \`astra_complete\` closes one on explicit request.

Never write protocol diagnostics to stdout. The bundled stdio bridge redirects runtime logs to stderr.

`;
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$ASTRA_INSTALL_LOG/$(basename "$0").log"
exit 0
`;
  try {
    for (const name of ["claude", "codex", "droid"]) {
      const file = join(bin, name);
      await writeFile(file, script, { mode: 0o755 });
      await chmod(file, 0o755);
      await mkdir(join(home, name === "claude" ? ".claude" : name === "codex" ? ".codex" : ".factory", "skills", "astra"), { recursive: true });
      await writeFile(join(home, name === "claude" ? ".claude" : name === "codex" ? ".codex" : ".factory", "skills", "astra", "SKILL.md"), legacy);
    }
    await mkdir(join(home, ".factory"), { recursive: true });
    await writeFile(join(home, ".factory", "mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "keep" } } }));

    const envPath = `${bin}:/usr/bin:/bin`;
    const first = await runInstall(home, envPath, log);
    assert.equal(first.code, 0, first.stderr);
    for (const [host, base] of [["claude", ".claude"], ["codex", ".codex"], ["droid", ".factory"]]) {
      for (const skill of ["stella", "grunt", "mermaid", "open-pencil"]) {
        assert.ok(await readFile(join(home, base, "skills", skill, "SKILL.md")), `${host} missing ${skill}`);
      }
      await assert.rejects(readFile(join(home, base, "skills", "astra", "SKILL.md")));
      assert.ok(await readFile(join(home, base, host === "codex" ? "prompts" : "commands", "astra.md")));
    }
    const factory = JSON.parse(await readFile(join(home, ".factory", "mcp.json"), "utf8"));
    assert.equal(factory.mcpServers.keep.command, "keep");
    assert.deepEqual(factory.mcpServers.astra, { type: "stdio", command: process.execPath, args: [join(root, "lib", "mcp-server.mjs")] });

    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { astra: factory.mcpServers.astra } }));
    await writeFile(join(home, ".codex", "config.toml"), `[mcp_servers.astra]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, "lib", "mcp-server.mjs"))}]\n`);
    const second = await runInstall(home, envPath, log);
    assert.equal(second.code, 0, second.stderr);
    for (const name of ["claude", "codex", "droid"]) {
      const calls = await readFile(join(log, `${name}.log`), "utf8").then((value) => value.split("\n").filter(Boolean)).catch(() => []);
      const registrations = calls.filter((line) => /(^|\s)mcp (add|add-json)(\s|$)/.test(line));
      assert.equal(registrations.length, name === "droid" ? 0 : 1, `${name} MCP registration count mismatch`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    await rm(log, { recursive: true, force: true });
  }
});
