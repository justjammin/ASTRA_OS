import { createServer } from "node:http";
import { watch } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { GATES, GATE_IDS } from "../lib/gates.mjs";
import { REL } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const TEMPLATE_ROOT = join(HERE, "template");
const ASSET_ROOT = join(PROJECT_ROOT, "assets");

const ARTIFACT_PATHS = {
  uiLayout: REL.uiLayout,
  systemArchitecture: REL.systemArchitecture,
  callStackTypes: REL.callStackTypes,
  plan: REL.dag,
  execution: REL.execution,
  audit: REL.auditJson,
};

const DOC_PATHS = {
  product: REL.product,
  architecture: REL.architecture,
  programDesign: REL.programDesign,
  slices: REL.slices,
  plan: REL.plan,
  audit: REL.audit,
};

const STATIC_FILES = {
  "/": { path: join(TEMPLATE_ROOT, "index.html"), type: "text/html" },
  "/render.js": { path: join(TEMPLATE_ROOT, "render.js"), type: "text/javascript" },
  "/markdown.js": { path: join(TEMPLATE_ROOT, "markdown.js"), type: "text/javascript" },
  "/assets/astra-os.svg": { path: join(ASSET_ROOT, "astra-os.svg"), type: "image/svg+xml" },
  "/assets/astra-os-mark.svg": { path: join(ASSET_ROOT, "astra-os-mark.svg"), type: "image/svg+xml" },
};

const VALID_STATUSES = new Set(["pending", "ran", "cleared", "failed"]);
const VALID_VERDICTS = new Set(["approved", "changes-requested"]);
const VALID_SEVERITIES = new Set(["P0", "P1", "P2"]);
const MAX_BODY_BYTES = 1024 * 1024;

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function textResponse(res, status, body, type) {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function errorResponse(res, status, code, message) {
  jsonResponse(res, status, { ok: false, error: { code, message } });
}

async function readText(path) {
  return readFile(path, "utf8");
}

async function readJson(path) {
  try {
    return JSON.parse(await readText(path));
  } catch {
    return null;
  }
}

async function fileStat(root, relPath) {
  try {
    const info = await stat(join(root, relPath));
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function readArtifact(root, relPath) {
  const info = await fileStat(root, relPath);
  if (!info) return null;
  try {
    return JSON.parse(await readText(join(root, relPath)));
  } catch {
    return null;
  }
}

async function readDoc(root, relPath) {
  const info = await fileStat(root, relPath);
  if (!info) return null;
  try {
    const markdown = await readText(join(root, relPath));
    return { path: relPath, bytes: Buffer.byteLength(markdown), markdown };
  } catch {
    return null;
  }
}

async function collectMtimes(root, current = {}, prefix = "") {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return current;
  }

  await Promise.all(entries.map(async (entry) => {
    const relPath = prefix ? join(prefix, entry.name) : entry.name;
    const absolute = join(root, relPath);
    if (entry.isDirectory()) {
      await collectMtimes(root, current, relPath);
      return;
    }
    if (!entry.isFile()) return;
    try {
      current[relPath.split(sep).join("/")] = (await stat(absolute)).mtimeMs;
    } catch {
      // A file can disappear between readdir and stat.
    }
  }));
  return current;
}

/** Every Markdown file a run produced, not just the gate-named ones, newest gate first. */
async function collectMarkdown(root, prefix = "", found = []) {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectMarkdown(root, relPath, found);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const doc = await readDoc(root, relPath);
    if (doc) found.push(doc);
  }
  // Codepoint order, not locale order: it keeps 00-status.md and PLAN.md above the docs/ folder.
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const TAIL_LINES = 50;
const TAIL_BYTES = 256 * 1024;

/**
 * Rolling tail of the agent CLI transcripts. A headless CLI's stdout only lands in
 * .astra/<slug>/logs/, never in the operator's TUI, so the console surfaces the last
 * TAIL_LINES of whichever log is currently being written.
 */
async function readLogFeed(root) {
  const dir = join(root, "logs");
  let entries;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile());
  } catch {
    return null;
  }
  if (!entries.length) return null;

  const files = [];
  for (const entry of entries) {
    try {
      const info = await stat(join(dir, entry.name));
      files.push({ name: entry.name, mtimeMs: info.mtimeMs, bytes: info.size });
    } catch {
      // A log can rotate away between readdir and stat.
    }
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const active = files[0];

  let lines = [];
  try {
    const handle = await open(join(dir, active.name), "r");
    try {
      const start = Math.max(0, active.bytes - TAIL_BYTES);
      const length = active.bytes - start;
      const buffer = Buffer.alloc(length);
      if (length) await handle.read(buffer, 0, length, start);
      lines = buffer.toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift();
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines = lines.slice(-TAIL_LINES);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  return {
    path: `logs/${active.name}`,
    bytes: active.bytes,
    updatedAt: new Date(active.mtimeMs).toISOString(),
    truncated: active.bytes > TAIL_BYTES,
    lines,
    files: files.map((f) => ({ path: `logs/${f.name}`, bytes: f.bytes, updatedAt: new Date(f.mtimeMs).toISOString() })),
  };
}

export async function aggregateState(runRoot) {
  const root = resolve(runRoot);
  const ledger = await readArtifact(root, REL.ledger);
  const artifacts = {};
  for (const [key, relPath] of Object.entries(ARTIFACT_PATHS)) {
    artifacts[key] = await readArtifact(root, relPath);
  }

  const docs = {};
  for (const [key, relPath] of Object.entries(DOC_PATHS)) {
    docs[key] = await readDoc(root, relPath);
  }

  const gates = GATES.map((gate) => {
    const ledgerGate = ledger?.gates?.[gate.id];
    const status = VALID_STATUSES.has(ledgerGate?.status) ? ledgerGate.status : "pending";
    return { id: gate.id, n: gate.n, name: gate.name, status };
  });

  return {
    ok: true,
    runRoot: root,
    slug: typeof ledger?.meta?.slug === "string" ? ledger.meta.slug : basename(root),
    ledger,
    gates,
    artifacts,
    docs,
    markdown: await collectMarkdown(root),
    logFeed: await readLogFeed(root),
    mtimeMs: await collectMtimes(root),
  };
}

function decodedPath(reqUrl) {
  const rawPath = String(reqUrl ?? "").split("?", 1)[0];
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new Error("invalid URL encoding");
  }
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("invalid path");
  }
  return path;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateFeedback(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "body must be an object";
  }
  if (!GATE_IDS.includes(body.gate)) return `unknown gate "${String(body.gate)}"`;
  if (!VALID_VERDICTS.has(body.verdict)) return `verdict must be approved or changes-requested`;
  if (body.notes !== undefined && typeof body.notes !== "string") {
    return "notes must be a string";
  }
  if (body.findings !== undefined && !Array.isArray(body.findings)) {
    return "findings must be an array";
  }
  for (const finding of body.findings ?? []) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return "each finding must be an object";
    }
    if (!VALID_SEVERITIES.has(finding.severity)) return "finding severity must be P0, P1, or P2";
    if (typeof finding.claim !== "string") return "finding claim must be a string";
    if (typeof finding.fix !== "string") return "finding fix must be a string";
  }
  return null;
}

async function handleFeedback(req, res, runRoot) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    errorResponse(res, error.statusCode ?? 400, "invalid_json", error.statusCode ? error.message : "request body must be valid JSON");
    return;
  }

  const validationError = validateFeedback(body);
  if (validationError) {
    errorResponse(res, 400, "invalid_feedback", validationError);
    return;
  }

  const relativePath = `json/feedback-${body.gate}.json`;
  const target = resolve(runRoot, relativePath);
  const targetRelative = relative(resolve(runRoot), target);
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`)) {
    errorResponse(res, 400, "invalid_path", "feedback path is outside run root");
    return;
  }

  const feedback = {
    gate: body.gate,
    verdict: body.verdict,
    notes: body.notes ?? "",
    findings: body.findings ?? [],
    receivedAt: new Date().toISOString(),
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(feedback, null, 2)}\n`, "utf8");
  jsonResponse(res, 200, { ok: true, path: target });
}

function staticFile(pathname) {
  return STATIC_FILES[pathname] ?? null;
}

async function handleRequest(req, res, runRoot, streamClients) {
  let pathname;
  try {
    pathname = decodedPath(req.url);
  } catch (error) {
    errorResponse(res, 400, "invalid_path", error.message);
    return;
  }

  if (pathname === "/api/state") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "method_not_allowed", "GET required");
      return;
    }
    jsonResponse(res, 200, await aggregateState(runRoot));
    return;
  }

  if (pathname === "/api/stream") {
    if (req.method !== "GET") {
      errorResponse(res, 405, "method_not_allowed", "GET required");
      return;
    }
    await streamState(req, res, runRoot, streamClients);
    return;
  }

  if (pathname === "/api/feedback") {
    if (req.method !== "POST") {
      errorResponse(res, 405, "method_not_allowed", "POST required");
      return;
    }
    await handleFeedback(req, res, runRoot);
    return;
  }

  if (req.method === "GET") {
    const file = staticFile(pathname);
    if (file) {
      try {
        const body = await readFile(file.path);
        res.writeHead(200, {
          "content-type": `${file.type}; charset=utf-8`,
          "cache-control": "no-store",
          "content-length": body.byteLength,
        });
        res.end(body);
      } catch {
        errorResponse(res, 404, "not_found", "static file not found");
      }
      return;
    }
  }

  if (staticFile(pathname)) {
    errorResponse(res, 405, "method_not_allowed", "GET required");
    return;
  }

  errorResponse(res, 404, "not_found", "route not found");
}

async function mtimeFingerprint(root) {
  const mtimes = await collectMtimes(root);
  return JSON.stringify(Object.entries(mtimes).sort(([left], [right]) => left.localeCompare(right)));
}

async function streamState(req, res, runRoot, streamClients) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const client = { res, watcher: null, pollTimer: null, keepalive: null, debounce: null, closed: false };
  streamClients.add(client);

  const sendState = async () => {
    if (client.closed || res.writableEnded) return;
    const payload = await aggregateState(runRoot);
    res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const trigger = () => {
    if (client.closed || client.debounce) return;
    client.debounce = setTimeout(async () => {
      client.debounce = null;
      try {
        await sendState();
      } catch {
        // A transient file race should not kill an SSE connection.
      }
    }, 150);
  };

  const startPoll = async () => {
    if (client.pollTimer || client.closed) return;
    let previous = await mtimeFingerprint(runRoot);
    client.pollTimer = setInterval(async () => {
      if (client.closed) return;
      const next = await mtimeFingerprint(runRoot);
      if (next !== previous) {
        previous = next;
        trigger();
      }
    }, 1000);
  };

  const stopWatcher = () => {
    if (client.watcher) {
      client.watcher.close();
      client.watcher = null;
    }
    if (client.pollTimer) {
      clearInterval(client.pollTimer);
      client.pollTimer = null;
    }
  };

  const cleanup = () => {
    if (client.closed) return;
    client.closed = true;
    clearTimeout(client.debounce);
    clearInterval(client.keepalive);
    stopWatcher();
    streamClients.delete(client);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  client.keepalive = setInterval(() => {
    if (!client.closed && !res.writableEnded) res.write(": keepalive\n\n");
  }, 20_000);

  try {
    await sendState();
  } catch {
    cleanup();
    if (!res.writableEnded) res.end();
    return;
  }

  try {
    client.watcher = watch(runRoot, { recursive: true }, trigger);
    client.watcher.on("error", () => {
      if (!client.pollTimer) {
        stopWatcher();
        startPoll().catch(() => {});
      }
    });
  } catch {
    await startPoll();
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function startVisualizer({
  runRoot,
  port = 4319,
  host = "127.0.0.1",
  open = false,
} = {}) {
  if (!runRoot) throw new Error("runRoot is required");
  const root = resolve(runRoot);
  const streamClients = new Set();
  const server = createServer((req, res) => {
    handleRequest(req, res, root, streamClients).catch((error) => {
      if (!res.headersSent) errorResponse(res, 500, "server_error", error.message);
      else if (!res.writableEnded) res.end();
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${urlHost}:${actualPort}`;

  if (open) openBrowser(url);

  let closed = false;
  const close = () => new Promise((resolveClose) => {
    if (closed) {
      resolveClose();
      return;
    }
    closed = true;
    for (const client of streamClients) {
      client.res.end();
    }
    server.close(() => resolveClose());
  });

  return { url, close };
}

async function runStandalone() {
  const args = process.argv.slice(2);
  const runRoot = args.find((arg) => !arg.startsWith("--"));
  if (!runRoot) {
    throw new Error("usage: node visualizer/server.mjs <runRoot> [--port=4319]");
  }
  const portArg = args.find((arg) => arg.startsWith("--port="));
  const port = Number(portArg?.slice("--port=".length) ?? 4319);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  const visualizer = await startVisualizer({ runRoot, port });
  console.log(`astra: visualizer at ${visualizer.url}`);
  const shutdown = async () => {
    await visualizer.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStandalone().catch((error) => {
    console.error(`astra: ${error.message}`);
    process.exitCode = 1;
  });
}
