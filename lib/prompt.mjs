import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const LIB_ROOT = here;

export async function loadPrompt(name) {
  return readFile(join(here, "prompts", name), "utf8");
}

export async function loadSchema(name) {
  return JSON.parse(await readFile(join(here, "schemas", `${name}.schema.json`), "utf8"));
}

export async function schemaText(name) {
  return JSON.stringify(await loadSchema(name), null, 2);
}

/** Replace every {{TOKEN}} with vars[TOKEN]; an unknown token is a bug, not a blank. */
export function render(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt template references unknown var {{${key}}}`);
    const value = vars[key];
    return Array.isArray(value) ? value.join("\n") : String(value ?? "");
  });
}

export async function renderPrompt(name, vars) {
  return render(await loadPrompt(name), vars);
}

export { join as joinPath };
