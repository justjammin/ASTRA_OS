import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readJson, writeJson } from "./util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(here, "..");
export const VENDORED_DIR = join(PKG_ROOT, "agents");
export const MAP_DIR = join(homedir(), ".astra", "map");

// Astra ships its own pipeline roles so a run never depends on an external marketplace.
// External roots only add domain depth on top of these.
export const GATE_ROLE = {
  product: "astra-product-architect",
  architecture: "astra-system-designer",
  design: "astra-program-designer",
  plan: "astra-graph-engineer",
};

export const NODE_ROLE = {
  implement: "astra-slice-implementer",
  static: "astra-static-verifier",
  unit: "astra-unit-verifier",
  integration: "astra-integration-verifier",
  e2e: "astra-e2e-tracer",
};

export const PERSONA_ROLE = {
  Grunt: "astra-grunt-skeptic",
  Melchior: "astra-magi-melchior",
  Balthasar: "astra-magi-balthasar",
  Casper: "astra-magi-casper",
};

export const DEFAULT_ROOTS = [
  join(homedir(), ".claude", "agents"),
  join(homedir(), ".claude", "plugins", "marketplaces"),
  join(homedir(), ".factory", "droids"),
];

const DOMAIN_KEYWORDS = {
  "astra-pipeline": ["astra", "gate", "tribunal", "slice", "trophy"],
  backend: ["backend", "api", "endpoint", "service", "microservice", "grpc", "graphql", "rest"],
  frontend: ["frontend", "react", "vue", "svelte", "css", "ui", "component", "browser"],
  data: ["database", "sql", "postgres", "migration", "schema", "query", "index", "warehouse"],
  infra: ["infrastructure", "kubernetes", "terraform", "docker", "deploy", "ci", "pipeline", "cloud"],
  security: ["security", "auth", "vulnerability", "threat", "crypto", "compliance", "audit"],
  testing: ["test", "qa", "coverage", "tdd", "playwright", "pytest", "assertion"],
  docs: ["document", "readme", "tutorial", "changelog", "reference", "wiki"],
  languages: ["typescript", "javascript", "python", "golang", "rust", "java", "php", "ruby"],
  ml: ["machine learning", "llm", "embedding", "rag", "model", "prompt", "vector"],
  review: ["review", "refactor", "debug", "performance", "lint", "architect"],
};

export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  for (const line of head.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    data[key] = raw.replace(/^["']|["']$/g, "").trim();
  }
  return { data, body };
}

export function classify(text) {
  const haystack = String(text).toLowerCase();
  let best = { domain: "general", score: 0 };
  for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = words.reduce((sum, word) => (haystack.includes(word) ? sum + 1 : sum), 0);
    if (score > best.score) best = { domain, score };
  }
  return best.domain;
}

export async function loadRole(name) {
  const path = join(VENDORED_DIR, `${name}.md`);
  if (!(await exists(path))) return null;
  const text = await readFile(path, "utf8");
  const { data, body } = parseFrontmatter(text);
  return { name: data.name ?? name, description: data.description ?? "", frontmatter: data, body: body.trim(), path };
}

export async function roleForGate(gateId) {
  const name = GATE_ROLE[gateId];
  return name ? loadRole(name) : null;
}

export async function roleForNode(kind) {
  const name = NODE_ROLE[kind];
  return name ? loadRole(name) : null;
}

export async function roleForPersona(persona) {
  const name = PERSONA_ROLE[persona];
  return name ? loadRole(name) : null;
}

/** Persona text prepended to a task prompt. Missing role file degrades to no persona, not a crash. */
export function personaBlock(role, extra) {
  if (!role) return extra ?? "";
  const block = [`[ROLE — ${role.name}]`, role.body];
  if (extra) block.push("", `[SPECIALIST OVERLAY]`, extra);
  return block.join("\n");
}

async function walk(dir, depth = 0, out = []) {
  if (depth > 5) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", "cache"].includes(entry.name)) continue;
      await walk(path, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Build the lean routing map. Vendored Astra roles are always present; each external root
 * contributes any Markdown file carrying `name` + `description` frontmatter. Output is sorted so
 * repeat scans are byte-identical.
 */
export async function scan({ roots = DEFAULT_ROOTS, mapDir = MAP_DIR, includeVendored = true } = {}) {
  const found = new Map();
  const scanned = [];

  const ingest = async (path, root) => {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return;
    }
    const { data } = parseFrontmatter(text);
    if (!data.name || !data.description) return;
    if (found.has(data.name)) return;
    found.set(data.name, {
      name: data.name,
      description: data.description,
      file: relative(root, path),
      root,
      domain: data.gate ? "astra-pipeline" : classify(`${data.name} ${data.description}`),
      ...(data.model ? { model: data.model } : {}),
      ...(data.gate ? { gate: data.gate, kind: data.kind ?? "gate" } : {}),
    });
  };

  if (includeVendored) {
    for (const path of await walk(VENDORED_DIR)) await ingest(path, VENDORED_DIR);
    scanned.push(VENDORED_DIR);
  }

  for (const root of roots) {
    if (!(await exists(root))) continue;
    const info = await stat(root);
    if (!info.isDirectory()) continue;
    for (const path of await walk(root)) await ingest(path, root);
    scanned.push(root);
  }

  const domains = {};
  for (const entry of [...found.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    (domains[entry.domain] ??= []).push(entry.name);
  }

  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    roots: scanned,
    domains: Object.fromEntries(Object.keys(domains).sort().map((d) => [d, domains[d]])),
  };

  await writeJson(join(mapDir, "index.json"), index);
  for (const domain of Object.keys(domains)) {
    const entries = [...found.values()]
      .filter((e) => e.domain === domain)
      .sort((a, b) => a.name.localeCompare(b.name));
    await writeJson(join(mapDir, `${domain}.json`), entries);
  }

  return { index, count: found.size, domains: Object.keys(domains).length };
}

export async function loadMap(mapDir = MAP_DIR) {
  const indexPath = join(mapDir, "index.json");
  if (!(await exists(indexPath))) return null;
  const index = await readJson(indexPath);
  return { index, mapDir };
}

/** Resolve one agent by name from the map and return its persona text. */
export async function hydrate(name, { mapDir = MAP_DIR } = {}) {
  const vendored = await loadRole(name);
  if (vendored) return vendored;

  const map = await loadMap(mapDir);
  if (!map) return null;
  for (const domain of Object.keys(map.index.domains)) {
    if (!map.index.domains[domain].includes(name)) continue;
    const entries = await readJson(join(mapDir, `${domain}.json`));
    const entry = entries.find((e) => e.name === name);
    if (!entry) continue;
    const path = join(entry.root, entry.file);
    if (!(await exists(path))) continue;
    const { data, body } = parseFrontmatter(await readFile(path, "utf8"));
    return { name: entry.name, description: data.description ?? entry.description, frontmatter: data, body: body.trim(), path };
  }
  return null;
}

/**
 * Pick an external specialist whose description matches this node, to overlay on the vendored
 * worker role. Returns null when no map exists or nothing scores above the vendored role.
 */
export async function suggestSpecialist(text, { mapDir = MAP_DIR } = {}) {
  const map = await loadMap(mapDir);
  if (!map) return null;
  const domain = classify(text);
  const names = map.index.domains[domain];
  if (!names?.length) return null;

  const entries = await readJson(join(mapDir, `${domain}.json`));
  const external = entries.filter((e) => !e.name.startsWith("astra-"));
  if (!external.length) return null;

  const words = new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const scored = external
    .map((entry) => {
      const haystack = `${entry.name} ${entry.description}`.toLowerCase();
      const score = [...words].reduce((sum, word) => (haystack.includes(word) ? sum + 1 : sum), 0);
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!scored[0] || scored[0].score === 0) return null;
  return hydrate(scored[0].entry.name, { mapDir });
}
