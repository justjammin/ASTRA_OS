#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const openPencilEntry = resolve(here, "../node_modules/@open-pencil/cli/bin/openpencil.js");

// @open-pencil/cli 0.14.0's published CLI is Node-launchable, but its bundled DOM/CSS path uses
// the two Bun file APIs below. Keep this narrow shim local to the child process; Astra itself never
// mutates the host's globals and never depends on an ambient Bun or globally installed CLI.
if (!globalThis.Bun) {
  globalThis.Bun = {
    argv: process.argv,
    file(path) {
      return {
        text: () => readFile(path, "utf8"),
        arrayBuffer: async () => {
          const bytes = await readFile(path);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        json: async () => JSON.parse(await readFile(path, "utf8")),
      };
    },
    async write(path, data) {
      const value = data && typeof data.arrayBuffer === "function"
        ? Buffer.from(await data.arrayBuffer())
        : data;
      await writeFile(path, value);
      return typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength ?? 0;
    },
  };
}

await import(pathToFileURL(openPencilEntry).href);
