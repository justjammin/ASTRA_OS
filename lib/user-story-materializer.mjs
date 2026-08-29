import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { artifact } from "./paths.mjs";
import { ensureDir, isNonEmptyFile } from "./util.mjs";
import { isUiUserStory } from "./user-story.mjs";

export const OPEN_PENCIL_CLI_WRAPPER = fileURLToPath(new URL("./open-pencil-cli.mjs", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIG_LOCAL_FILE = 0x04034b50;
const FIG_CENTRAL_FILE = 0x02014b50;
const FIG_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export class UserStoryMaterializationError extends Error {
  constructor(message, { phase = "materialization", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UserStoryMaterializationError";
    this.code = "USER_STORY_MATERIALIZATION_FAILED";
    this.phase = phase;
  }
}

/**
 * Convert a UI user story into the two host-owned review artifacts. The agent never receives this
 * function or its write paths: the pipeline invokes it only after the story has passed validation.
 */
export async function materializeUserStory(root, story, options = {}) {
  const figPath = artifact(root, "userStoryFig");
  const previewPath = artifact(root, "userStoryPreview");

  if (!isUiUserStory(story)) {
    await removeOutputs(figPath, previewPath);
    return { ok: true, surface: "non-ui", outputs: [] };
  }

  const execFile = options.execFile ?? nodeExecFile;
  const cli = options.cli ?? process.execPath;
  const cliPrefix = options.cli ? (options.cliArgs ?? []) : [OPEN_PENCIL_CLI_WRAPPER];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const tempDir = await mkdtemp(join(tmpdir(), "astra-user-story-"));
  const htmlPath = join(tempDir, "user-story.html");
  const cssPath = join(tempDir, "user-story.css");

  await ensureDir(dirname(figPath));
  await ensureDir(dirname(previewPath));
  await removeOutputs(figPath, previewPath);

  try {
    await writeFile(htmlPath, renderUserStoryHtml(story), "utf8");
    await writeFile(cssPath, renderUserStoryCss(), "utf8");
    await runOpenPencil(execFile, cli, [...cliPrefix, "import", htmlPath,
      "--format",
      "fig",
      "--output",
      figPath,
      "--css",
      cssPath,
      "--page-name",
      "User Story",
    ], { cwd: root, timeoutMs, phase: "HTML import" });
    if (!(await isNonEmptyFile(figPath))) {
      throw new UserStoryMaterializationError("OpenPencil HTML import produced an empty .fig file", { phase: "HTML import" });
    }
    await assertFig(figPath);

    await runOpenPencil(execFile, cli, [...cliPrefix, "export",
      figPath,
      "--format",
      "png",
      "--output",
      previewPath,
      "--scale",
      "1",
    ], { cwd: root, timeoutMs, phase: "PNG export" });
    await assertPng(previewPath);
    return {
      ok: true,
      surface: "ui",
      outputs: [figPath, previewPath],
    };
  } catch (error) {
    await removeOutputs(figPath, previewPath);
    if (error instanceof UserStoryMaterializationError) throw error;
    throw new UserStoryMaterializationError(error instanceof Error ? error.message : String(error), {
      phase: "materialization",
      cause: error,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function removeOutputs(figPath, previewPath) {
  await Promise.all([
    rm(figPath, { force: true }),
    rm(previewPath, { force: true }),
  ]);
}

function runOpenPencil(execFile, cli, args, { cwd, timeoutMs, phase }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout = "", stderr = "") => {
      if (settled) return;
      settled = true;
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = String(stderr || stdout || error.message || error).trim();
      reject(new UserStoryMaterializationError(`OpenPencil ${phase} failed${detail ? `: ${detail}` : ""}`, {
        phase,
        cause: error,
      }));
    };

    try {
      // Keep this an argv-only call. User-authored labels are written to the temporary HTML file,
      // never interpolated into the executable or its arguments.
      execFile(cli, args, {
        cwd,
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      }, finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function assertPng(path) {
  if (!(await isNonEmptyFile(path))) {
    throw new UserStoryMaterializationError("OpenPencil PNG export produced an empty preview", { phase: "PNG export" });
  }
  const bytes = await readFile(path);
  if (!isPng(bytes)) {
    throw new UserStoryMaterializationError("OpenPencil PNG export did not produce a valid PNG", { phase: "PNG export" });
  }
}

/** Disk-only check used by Gate 1 approval paths after materialization has run. */
export async function checkMaterializedUserStory(root, story) {
  if (!isUiUserStory(story)) return { ok: true, surface: "non-ui", outputs: [] };
  const figPath = artifact(root, "userStoryFig");
  const previewPath = artifact(root, "userStoryPreview");
  const fig = await isNonEmptyFile(figPath) && isFigZip(await readFile(figPath));
  const png = await isNonEmptyFile(previewPath) && isPng(await readFile(previewPath));
  const failures = [];
  if (!fig) failures.push("designs/user-story.fig is missing, empty, or not a valid ZIP container");
  if (!png) failures.push("assets/user-story.png is missing, empty, or not a structurally valid PNG");
  return {
    ok: failures.length === 0,
    surface: "ui",
    outputs: [figPath, previewPath],
    detail: failures.length ? failures.join("; ") : "OpenPencil .fig and PNG artifacts valid",
  };
}

/** Validate enough PNG structure to reject a signature-only or truncated fake preview. */
export function isPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length + 12 || !PNG_SIGNATURE.equals(bytes.subarray(0, PNG_SIGNATURE.length))) return false;
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end + 4 > bytes.length) return false;
    const type = bytes.subarray(typeOffset, dataOffset).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const crc = bytes.readUInt32BE(end);
    if (pngCrc32(Buffer.concat([Buffer.from(type, "ascii"), bytes.subarray(dataOffset, end)])) !== crc) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || bytes.readUInt32BE(dataOffset) === 0 || bytes.readUInt32BE(dataOffset + 4) === 0) return false;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || !sawHeader || !sawData) return false;
      sawEnd = true;
      offset = end + 4;
      break;
    }
    offset = end + 4;
  }
  return sawEnd && offset === bytes.length;
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** .fig files are ZIP containers; reject arbitrary non-empty files before approval. */
export async function assertFig(path) {
  const bytes = await readFile(path);
  if (!isFigZip(bytes)) {
    throw new UserStoryMaterializationError("OpenPencil HTML import did not produce a valid .fig ZIP container", { phase: "HTML import" });
  }
}

export function isFigZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) return false;
  const minOffset = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (bytes.readUInt32LE(offset) === FIG_END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return false;
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > eocd || eocd + 22 > bytes.length) return false;
  if (entries === 0) return centralSize === 0;
  if (centralSize < 46 || bytes.readUInt32LE(centralOffset) !== FIG_CENTRAL_FILE) return false;
  // A central directory entry must point at a local file header within the archive.
  const localOffset = bytes.readUInt32LE(centralOffset + 42);
  return localOffset + 4 <= centralOffset && bytes.readUInt32LE(localOffset) === FIG_LOCAL_FILE;
}

export function renderUserStoryHtml(story) {
  const title = escapeHtml(story?.meta?.intent || "Astra User Story");
  const screens = Array.isArray(story?.screens) ? story.screens : [];
  const body = screens.map(renderScreen).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Fixed host-owned styling passed to OpenPencil's HTML/CSS importer, never story-authored CSS. */
export function renderUserStoryCss() {
  return `:root { font-family: system-ui, sans-serif; color: #172033; background: #f4f6fb; }
body { margin: 0; padding: 32px; }
main { box-sizing: border-box; width: 960px; margin: 0 auto 32px; padding: 32px; background: #fff; border: 1px solid #d9dfeb; border-radius: 16px; }
h1, h2, p { margin: 0 0 16px; }
.story-element { margin: 12px 0; }
button { padding: 8px 16px; }
input, select { display: block; min-width: 280px; padding: 8px; }
small { display: block; color: #56627a; }
`;
}

function renderScreen(screen) {
  const id = escapeHtml(screen.id);
  const name = escapeHtml(screen.name);
  const purpose = escapeHtml(screen.purpose);
  const elements = (screen.elements ?? []).map(renderElement).join("\n");
  return `<main data-screen-id="${id}">
  <h1>${name}</h1>
  <p>${purpose}</p>
  ${elements}
</main>`;
}

function renderElement(element) {
  const type = String(element?.type ?? "text");
  const label = escapeHtml(element?.label ?? "");
  const notes = element?.notes ? `<small>${escapeHtml(element.notes)}</small>` : "";
  const className = `story-element story-${escapeHtml(type)}`;

  switch (type) {
    case "heading": return `<h2 class="${className}">${label}</h2>`;
    case "button": return `<button class="${className}" type="button">${label}</button>${notes}`;
    case "input": return `<label class="${className}">${label}<input aria-label="${label}"></label>${notes}`;
    case "select": return `<label class="${className}">${label}<select aria-label="${label}"><option>${label}</option></select></label>${notes}`;
    case "checkbox": return `<label class="${className}"><input type="checkbox"> ${label}</label>${notes}`;
    case "image": return `<figure class="${className}" role="img" aria-label="${label}"><figcaption>${label}</figcaption></figure>${notes}`;
    case "terminal": return `<pre class="${className}">${label}</pre>${notes}`;
    case "list": return `<ul class="${className}"><li>${label}</li></ul>${notes}`;
    case "table": return `<table class="${className}"><caption>${label}</caption><tbody><tr><td>${label}</td></tr></tbody></table>${notes}`;
    case "card": return `<article class="${className}"><h3>${label}</h3>${notes}</article>`;
    case "nav": return `<nav class="${className}" aria-label="${label}">${label}</nav>${notes}`;
    case "form": return `<form class="${className}"><fieldset><legend>${label}</legend>${notes}</fieldset></form>`;
    case "chart": return `<figure class="${className}"><figcaption>${label}</figcaption><div role="img" aria-label="${label}">Chart</div>${notes}</figure>`;
    case "badge": return `<span class="${className}">${label}</span>${notes}`;
    case "modal": return `<section class="${className}" role="dialog" aria-label="${label}"><h2>${label}</h2>${notes}</section>`;
    case "text":
    default: return `<p class="${className}">${label}</p>${notes}`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
