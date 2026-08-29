import test from "node:test";
import assert from "node:assert/strict";
import { createCommandSandbox, SandboxUnavailableError } from "../lib/sandbox.mjs";

const TEST_CWD = process.cwd();

function managerStub({ wrapped = true, preflightExitCode = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async initialize(config) {
      calls.push(["initialize", config]);
    },
    isSupportedPlatform(platform) {
      calls.push(["isSupportedPlatform", platform]);
      return true;
    },
    checkDependencies() {
      calls.push(["checkDependencies"]);
      return true;
    },
    async waitForNetworkInitialization() {
      calls.push(["waitForNetworkInitialization"]);
      return true;
    },
    async wrapWithSandbox(command) {
      calls.push(["wrapWithSandbox", command]);
      if (!wrapped) return command;
      if (command.startsWith("touch ")) {
        return preflightExitCode === 0
          ? "sandbox-exec -p '(version 1) (deny file-write*)' /bin/sh -c 'false'"
          : "sandbox-exec -p '(version 1) (allow default)' /bin/sh -c 'true'";
      }
      return wrapped
        ? "sandbox-exec -p '(version 1) (allow default)' /bin/sh -c 'printf ASTRA_SANDBOX_WRAPPED'"
        : command;
    },
    async reset() {
      calls.push(["reset"]);
    },
  };
}

const fakeExecutor = async (command) => ({ exitCode: command.includes("'false'") ? 1 : 0 });

test("creates a backend with explicit filesystem grants and deny-all network", async () => {
  const manager = managerStub();
  const backend = await createCommandSandbox({
    cwd: TEST_CWD,
    allowRead: ["/workspace/src"],
    allowWrite: ["/workspace/out"],
    denyRead: ["/Users/secret"],
    denyWrite: ["/workspace/out/.env"],
    allowedDomains: ["api.example.test"],
    manager,
    platform: "darwin",
    commandExecutor: fakeExecutor,
  });

  const config = manager.calls.find(([name]) => name === "initialize")[1];
  assert.deepEqual(config.filesystem.allowRead, ["/workspace/src"]);
  assert.deepEqual(config.filesystem.allowWrite, ["/workspace/out"]);
  assert.deepEqual(config.filesystem.denyRead, ["~/.ssh", "~/.aws", "~/.gnupg", "/Users/secret"]);
  assert.deepEqual(config.filesystem.denyWrite.slice(0, -1), [".env", ".env.*", "*.pem", "*.key", "/workspace/out/.env"]);
  assert.match(config.filesystem.denyWrite.at(-1), /\.astra-sandbox-probe-/);
  assert.deepEqual(config.network, {
    allowedDomains: ["api.example.test"],
    deniedDomains: ["*"],
    strictAllowlist: true,
    allowLocalBinding: false,
    allowUnixSockets: [],
  });
  assert.ok(manager.calls.some(([name]) => name === "wrapWithSandbox"));
  await backend.close();
});

test("merges and deduplicates caller deny lists without dropping defaults", async () => {
  const manager = managerStub();
  const backend = await createCommandSandbox({
    cwd: TEST_CWD,
    denyRead: ["~/.ssh", "/tmp/private"],
    denyWrite: [".env", "/tmp/private"],
    manager,
    platform: "darwin",
    commandExecutor: fakeExecutor,
  });

  const config = manager.calls.find(([name]) => name === "initialize")[1];
  assert.deepEqual(config.filesystem.denyRead, ["~/.ssh", "~/.aws", "~/.gnupg", "/tmp/private"]);
  assert.deepEqual(config.filesystem.denyWrite.slice(0, -1), [".env", ".env.*", "*.pem", "*.key", "/tmp/private"]);
  assert.equal(new Set(config.filesystem.denyRead).size, config.filesystem.denyRead.length);
  assert.equal(new Set(config.filesystem.denyWrite).size, config.filesystem.denyWrite.length);
  await backend.close();
});

test("rejects an unavailable platform before initialization", async () => {
  const manager = managerStub();
  manager.isSupportedPlatform = () => false;

  await assert.rejects(
    () => createCommandSandbox({ cwd: TEST_CWD, manager, platform: "linux" }),
    (error) => error instanceof SandboxUnavailableError && /platform/i.test(error.message),
  );
  assert.equal(manager.calls.some(([name]) => name === "initialize"), false);
});

test("rejects missing runtime dependencies before any command can run", async () => {
  const manager = managerStub();
  manager.checkDependencies = () => false;

  await assert.rejects(
    () => createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin" }),
    (error) => error instanceof SandboxUnavailableError && /dependenc/i.test(error.message),
  );
  assert.equal(manager.calls.some(([name]) => name === "initialize"), false);
});

test("rejects dependency diagnostics returned as errors", async () => {
  const manager = managerStub();
  manager.checkDependencies = () => ({ errors: ["sandbox-exec"], warnings: [] });

  await assert.rejects(
    () => createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin" }),
    (error) => error instanceof SandboxUnavailableError && /dependenc/i.test(error.message),
  );
  assert.equal(manager.calls.some(([name]) => name === "initialize"), false);
});

test("rejects an ineffective wrapper instead of falling back", async () => {
  const manager = managerStub({ wrapped: false });

  await assert.rejects(
    () => createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin", commandExecutor: fakeExecutor }),
    (error) => error instanceof SandboxUnavailableError && /ineffective/i.test(error.message),
  );
  assert.equal(manager.calls.some(([name]) => name === "reset"), true);
});

test("rejects a runtime that reports isolation disabled", async () => {
  const manager = managerStub();
  manager.isSandboxingEnabled = () => false;

  await assert.rejects(
    () => createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin" }),
    (error) => error instanceof SandboxUnavailableError && /without enabling isolation/i.test(error.message),
  );
  assert.equal(manager.calls.some(([name]) => name === "reset"), true);
});

test("rejects a failed startup behavioral preflight", async () => {
  const manager = managerStub({ preflightExitCode: 1 });

  await assert.rejects(
    () => createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin", commandExecutor: fakeExecutor }),
    (error) => error instanceof SandboxUnavailableError && /preflight|forbidden write/i.test(error.message),
  );
  assert.equal(manager.calls.some(([name]) => name === "reset"), true);
});

test("does not permit a run after the backend is closed", async () => {
  const manager = managerStub();
  const backend = await createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin", commandExecutor: fakeExecutor });
  await backend.close();

  await assert.rejects(
    () => backend.run({ program: "printf", args: ["nope"] }),
    (error) => error instanceof SandboxUnavailableError && /closed/i.test(error.message),
  );
});

test("quotes structured argv before handing it to the runtime wrapper", async () => {
  const manager = managerStub();
  const backend = await createCommandSandbox({ cwd: TEST_CWD, manager, platform: "darwin", commandExecutor: fakeExecutor });
  await backend.run({ program: "printf", args: ["$(touch escaped)", "a b", "semi;colon"] });

  const wrappedCommand = manager.calls.filter(([name]) => name === "wrapWithSandbox").at(-1)[1];
  assert.match(wrappedCommand, /'\$\(touch escaped\)'/);
  assert.match(wrappedCommand, /'a b'/);
  assert.match(wrappedCommand, /'semi;colon'/);
  await backend.close();
});
