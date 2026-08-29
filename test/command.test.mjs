import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../lib/pipeline.mjs";

test("command nodes execute an exact argv vector without a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-command-"));
  const file = join(root, "node.log");
  const result = await runCommand(
    {
      program: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a; echo injected", "$(echo substituted)"],
    },
    root,
    file,
    false,
    {
      sandbox: {
        run: async ({ program, args }) => {
          const { execFile } = await import("node:child_process");
          return new Promise((resolve) => {
            execFile(program, args, { cwd: root }, (error, stdout, stderr) => resolve({
              exitCode: error?.code ?? 0,
              stdout,
              stderr,
            }));
          });
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["a; echo injected", "$(echo substituted)"]);
});

test("legacy string commands fail closed with a Gate 4 regeneration message", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-command-"));
  const result = await runCommand("echo should-not-run", root, join(root, "node.log"));

  assert.equal(result.code, 125);
  assert.equal(result.blocked, true);
  assert.match(result.stderr, /legacy string command rejected/);
  assert.match(result.stderr, /regenerate Gate 4/);
});
