/**
 * Gate 1's user-story contract.
 *
 * JSON shape is checked by the shared schema validator. The checks here cover the small amount
 * of semantic policy that JSON Schema cannot express in the dependency-free validator: Mermaid's
 * diagram kind, safe source text, and the UI/non-UI surface split.
 */

const FLOWCHART_HEADER = /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/i;
// Gate 1 diagrams are data, not an HTML/URL rendering surface. Reject every HTML tag/comment,
// protocol URL (including non-http schemes), protocol-relative URL, and common bare-host form.
const UNSAFE_SOURCE = /<!--[\s\S]*?-->|<![a-z]|<\s*\/?\s*[a-z][^>]*>|(?:[a-z][a-z0-9+.-]{1,31}:|\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i;

export function inspectMermaid(source) {
  if (typeof source !== "string" || !source.trim()) {
    return { ok: false, error: "Mermaid source is required" };
  }

  const value = source.trim();
  if (!FLOWCHART_HEADER.test(value)) {
    return { ok: false, error: "Mermaid source must begin with flowchart or graph and a direction" };
  }
  if (UNSAFE_SOURCE.test(value)) {
    return { ok: false, error: "Mermaid source contains HTML, script, URL, or javascript content" };
  }

  const balance = balancedMermaidDelimiters(value);
  if (!balance.ok) return balance;

  // A header alone is not a useful interaction flow. Mermaid permits comments and declarations,
  // so count a node or edge after stripping comments before accepting the source.
  const body = value
    .split(/\r?\n/)
    .filter((line) => !/^\s*%%/.test(line))
    .slice(1)
    .join("\n")
    .trim();
  if (!body || !/[A-Za-z_][A-Za-z0-9_-]*(?:\s*[-=:.|]+>|\s*\[[^\]]+\]|\s*\([^)]*\)|\s*\{[^}]+\})/.test(body)) {
    return { ok: false, error: "Mermaid flowchart must contain at least one labeled node or edge" };
  }

  return { ok: true, source: value };
}

function balancedMermaidDelimiters(source) {
  const pairs = new Map([["[", "]"], ["(", ")"], ["{", "}"]]);
  const closing = new Set([...pairs.values()]);
  const stack = [];
  let quoted = false;
  let escaped = false;

  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (pairs.has(char)) stack.push(char);
    else if (closing.has(char)) {
      const open = stack.pop();
      if (!open || pairs.get(open) !== char) {
        return { ok: false, error: `Mermaid delimiter ${char} is out of order` };
      }
    }
  }

  if (quoted) return { ok: false, error: "Mermaid source contains an unterminated quoted label" };
  if (stack.length) return { ok: false, error: `Mermaid delimiter ${stack.at(-1)} is not closed` };
  return { ok: true };
}

export function validateUserStory(story, { slug } = {}) {
  const mermaid = inspectMermaid(story?.mermaid);
  if (!mermaid.ok) return { ok: false, detail: `Mermaid: ${mermaid.error}` };

  if (slug !== undefined && story?.meta?.slug !== slug) {
    return { ok: false, detail: `user-story meta.slug must match active run slug "${slug}"` };
  }

  const surface = story?.meta?.surface;
  if (surface === "ui") {
    if (!Array.isArray(story.screens) || story.screens.length === 0) {
      return { ok: false, detail: "UI user stories require at least one screen" };
    }
    const ids = story.screens.map((screen) => screen?.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      return { ok: false, detail: "UI user story screen ids must be unique" };
    }
  } else if (surface === "non-ui") {
    if (story && Object.prototype.hasOwnProperty.call(story, "screens")) {
      return { ok: false, detail: "non-UI user stories must omit screens" };
    }
  } else {
    return { ok: false, detail: 'meta.surface must be "ui" or "non-ui"' };
  }

  return {
    ok: true,
    detail: `${surface} user story; Mermaid flowchart valid${surface === "ui" ? `; ${story.screens.length} screen(s)` : ""}`,
  };
}

export function isUiUserStory(story) {
  return story?.meta?.surface === "ui";
}
