import { test } from "node:test";
import assert from "node:assert/strict";

import { inspectWireDsl, parseWireDsl, validateUiWireDsl } from "../lib/wire-dsl.mjs";

const SOURCE = `
project "Account" {
  style { device: "desktop" density: "comfortable" }
  screen u1 {
    layout split(gap: lg) {
      layout panel(padding: md) {
        component Sidebar items: "Overview,Settings"
      }
      layout stack(direction: vertical, gap: md) {
        component Heading text: "Account settings"
        component Input label: "Display name" placeholder: "Ada"
        component Button text: "Save" variant: primary
      }
    }
  }
}`;

test("Wire DSL parser preserves screens, layouts, and safe component properties", () => {
  const project = parseWireDsl(SOURCE);
  assert.equal(project.name, "Account");
  assert.equal(project.screens[0].name, "u1");
  assert.equal(project.screens[0].children[0].layoutType, "split");
  const stack = project.screens[0].children[0].children[1];
  assert.equal(stack.children[1].componentType, "Input");
  assert.equal(stack.children[1].props.placeholder, "Ada");
});

test("Wire DSL parser rejects executable and unsupported syntax", () => {
  const script = inspectWireDsl('project "X" { screen u1 { layout stack { component Text text: "ok" <script> } } }');
  assert.equal(script.ok, false);
  assert.match(script.error, /unsupported character/);

  const custom = inspectWireDsl('project "X" { import "remote" }');
  assert.equal(custom.ok, false);
  assert.match(custom.error, /only style and screen blocks/);
});

test("UI contract requires Wire DSL screen ids to match structured screens", () => {
  assert.deepEqual(validateUiWireDsl({ wireDsl: SOURCE, screens: [{ id: "u1" }] }).ok, true);
  const mismatch = validateUiWireDsl({ wireDsl: SOURCE, screens: [{ id: "u2" }] });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /missing u2.*extra u1/);
});
