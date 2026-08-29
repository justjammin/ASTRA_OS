import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandSandbox } from "../lib/sandbox.mjs";

const enabled = process.platform === "darwin" && process.env.ASTRA_SANDBOX_INTEGRATION === "1";

test("sandbox blocks forbidden writes, symlink escapes, secret reads, and network by default", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-sandbox-test-"));
  const work = join(root, "work");
  const outside = join(root, "outside");
  const secret = join(outside, "secret.txt");
  await mkdir(work);
  await mkdir(outside);
  await writeFile(secret, "ASTRA_SECRET_SHOULD_NOT_LEAK\n");
  await symlink(outside, join(work, "escape"));

  const sandbox = await createCommandSandbox({
    cwd: work,
    allowRead: [work],
    allowWrite: [work],
    denyRead: [secret],
    allowedDomains: [],
  });
  try {
    const forbiddenWrite = await sandbox.run({ program: "sh", args: ["-c", `touch ${join(outside, "write.txt")}`] });
    assert.notEqual(forbiddenWrite.exitCode, 0);

    const symlinkEscape = await sandbox.run({ program: "sh", args: ["-c", `touch ${join(work, "escape", "created.txt")}`] });
    assert.notEqual(symlinkEscape.exitCode, 0);

    const secretRead = await sandbox.run({ program: "cat", args: [secret] });
    assert.notEqual(secretRead.exitCode, 0);
    assert.doesNotMatch(secretRead.stdout, /ASTRA_SECRET_SHOULD_NOT_LEAK/);

    const networkProbe = await sandbox.run({ program: "curl", args: ["-fsS", "--max-time", "2", "https://example.com"] });
    assert.notEqual(networkProbe.exitCode, 0);
  } finally {
    await sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});
