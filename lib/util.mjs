import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "run";
}

export function nowIso() {
  return new Date().toISOString();
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isNonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export function fail(message, code = 1) {
  const err = new Error(message);
  err.exitCode = code;
  return err;
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));

export const style = {
  lime: wrap("38;5;154"),
  magenta: wrap("38;5;213"),
  cyan: wrap("38;5;51"),
  amber: wrap("38;5;214"),
  red: wrap("38;5;203"),
  dim: wrap("2"),
  bold: wrap("1"),
};

export function banner(title, lines = []) {
  const width = Math.max(title.length + 4, ...lines.map((l) => l.length + 4), 46);
  const bar = "\u2500".repeat(width - 2);
  const out = [
    style.magenta(`\u250c${bar}\u2510`),
    style.magenta("\u2502 ") + style.bold(style.lime(title.padEnd(width - 4))) + style.magenta(" \u2502"),
  ];
  if (lines.length) out.push(style.magenta(`\u251c${bar}\u2524`));
  for (const line of lines) {
    out.push(style.magenta("\u2502 ") + line.padEnd(width - 4) + style.magenta(" \u2502"));
  }
  out.push(style.magenta(`\u2514${bar}\u2518`));
  return out.join("\n");
}
