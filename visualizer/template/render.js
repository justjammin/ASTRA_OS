import { markdownToHtml } from "./markdown.js";

const consoleRoot = document.getElementById("console");
const reviewFooter = document.getElementById("review-footer");
const runSlug = document.getElementById("run-slug");
const runIntent = document.getElementById("run-intent");
const liveDot = document.getElementById("live-dot");
const liveLabel = document.getElementById("live-label");
const themeToggle = document.getElementById("theme-toggle");
const docModal = document.getElementById("doc-modal");
const docModalTitle = document.getElementById("doc-modal-title");
const docModalMeta = document.getElementById("doc-modal-meta");
const docModalBody = document.getElementById("doc-modal-body");
const docModalClose = document.getElementById("doc-modal-close");
const themeRoot = document.documentElement;
const themeMeta = document.querySelector('meta[name="theme-color"]');
const themeMedia = globalThis.matchMedia?.("(prefers-color-scheme: light)");
const SVG_NS = "http://www.w3.org/2000/svg";

const GATES = [
  { id: "product", n: 1, name: "Product Intent & User Story", artifactKeys: ["userStory"], docKey: "product" },
  { id: "architecture", n: 2, name: "Architecture & Adversarial Audit", artifactKeys: ["systemArchitecture", "audit"], docKey: "architecture" },
  { id: "design", n: 3, name: "Program Design & Contract Hardening", artifactKeys: ["callStackTypes"], docKey: "programDesign" },
  { id: "plan", n: 4, name: "Graph Engineering & Agent Role Allocation", artifactKeys: ["plan"], docKey: "slices" },
  { id: "execute", n: 5, name: "Testing Trophy Execution", artifactKeys: ["execution"], docKey: null },
];

const ARTIFACT_LABELS = {
  userStory: "USER STORY",
  uiLayout: "UI LAYOUT",
  systemArchitecture: "ARCH",
  audit: "AUDIT",
  callStackTypes: "CONTRACTS",
  plan: "DAG",
  execution: "LIVE EXEC",
};

const KIND_COLORS = {
  implement: "var(--vermilion)",
  static: "var(--voting-blue)",
  unit: "var(--lime)",
  integration: "var(--amber)",
  e2e: "var(--vermilion)",
};

const app = {
  state: null,
  localDrop: false,
  sequenceId: 0,
  disclosures: new Map(),
  modalReturnFocus: null,
  modalReturnFocusKey: null,
};
const THEME_MODES = ["auto", "dark", "light"];
let themeMode = THEME_MODES.includes(themeRoot.dataset.theme) ? themeRoot.dataset.theme : "auto";

function updateThemeMeta() {
  if (!themeMeta) return;
  const charred = getComputedStyle(themeRoot).getPropertyValue("--charred").trim();
  if (charred) themeMeta.content = charred;
}

function updateThemeControl() {
  if (!themeToggle) return;
  const nextMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  themeToggle.textContent = themeMode.toUpperCase();
  themeToggle.setAttribute("aria-pressed", String(themeMode !== "auto"));
  themeToggle.setAttribute("aria-label", `Theme mode: ${themeMode}. Activate to switch to ${nextMode} mode.`);
}

function setTheme(mode, persist = true) {
  themeMode = THEME_MODES.includes(mode) ? mode : "auto";
  themeRoot.dataset.theme = themeMode;
  if (persist) {
    try {
      localStorage.setItem("astra-theme", themeMode);
    } catch {}
  }
  updateThemeMeta();
  updateThemeControl();
}

themeToggle?.addEventListener("click", () => {
  const nextMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  setTheme(nextMode);
});
themeMedia?.addEventListener("change", () => {
  if (themeMode === "auto") updateThemeMeta();
  updateThemeControl();
});
updateThemeMeta();
updateThemeControl();

function text(value) {
  return value == null ? "" : String(value);
}

function node(tag, className = "", attributes = {}, children = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (key === "text") element.textContent = text(value);
    else if (key === "checked" || key === "disabled" || key === "selected") element[key] = Boolean(value);
    else element.setAttribute(key, text(value));
  }
  const items = Array.isArray(children) ? children : [children];
  for (const child of items) {
    if (child instanceof Node) element.append(child);
    else if (child !== undefined && child !== null) element.append(document.createTextNode(text(child)));
  }
  return element;
}

function svgNode(tag, attributes = {}, children = []) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) element.setAttribute(key, text(value));
  }
  for (const child of (Array.isArray(children) ? children : [children])) {
    if (child instanceof Node) element.append(child);
    else if (child !== undefined && child !== null) element.append(document.createTextNode(text(child)));
  }
  return element;
}

function chip(value, extraClass = "") {
  const safeClass = /^[A-Za-z0-9_-]+$/.test(text(value)) ? text(value) : "";
  return node("span", `chip ${safeClass} ${extraClass}`.trim(), { text: value });
}

function section(id, eyebrow, title, content, { open = true } = {}) {
  const panel = node("details", "panel", { id });
  panel.open = app.disclosures.has(id) ? app.disclosures.get(id) : open;
  const heading = node("summary", "panel-heading", {}, [
    node("h2", "", { text: title }),
    node("span", "eyebrow", { text: eyebrow }),
  ]);
  panel.addEventListener("toggle", () => app.disclosures.set(id, panel.open));
  panel.append(heading, node("div", "panel-content", {}, [content]));
  return panel;
}

consoleRoot?.addEventListener("click", (event) => {
  const link = event.target.closest?.('a[href^="#artifact-"]');
  if (!link) return;
  const target = document.querySelector(link.getAttribute("href"));
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
    app.disclosures.set(target.id, true);
  }
});

function empty(message) {
  return node("div", "empty", { text: message });
}

function list(items, className = "") {
  const element = node("ul", className);
  for (const item of items ?? []) element.append(node("li", "", { text: item }));
  return element;
}

function dataTable(headers, rows, className = "") {
  const wrapper = node("div", "table-wrap");
  const table = node("table", `data-table ${className}`.trim());
  const head = node("thead");
  const headRow = node("tr");
  for (const header of headers) headRow.append(node("th", "", { scope: "col", text: header }));
  head.append(headRow);
  const body = node("tbody");
  for (const row of rows ?? []) {
    const tableRow = node("tr");
    for (const value of row) {
      const cell = node("td");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = text(value);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function updateHeader(data) {
  const ledger = data?.ledger ?? {};
  const meta = ledger.meta ?? {};
  const execution = data?.artifacts?.execution;
  runSlug.textContent = text(data?.slug || meta.slug || "UNNAMED RUN").toUpperCase();
  runIntent.textContent = text(meta.intent || execution?.meta?.intent || "No intent recorded");
  const phase = text(ledger.phase || "unknown").toUpperCase();
  const agent = text(meta.agent || execution?.meta?.agent || "unknown").toUpperCase();
  liveLabel.textContent = app.localDrop ? "LOCAL DROP" : `${phase} // ${agent}`;
}

function renderGateRail(data) {
  const rail = node("div", "gate-rail");
  for (const gate of GATES) {
    const stateGate = (data?.gates ?? []).find((entry) => entry.id === gate.id) ?? {};
    const card = node("article", `gate-card ${data?.ledger?.phase === gate.id ? "current" : ""}`.trim());
    card.append(
      node("div", "gate-number", { text: `GATE ${String(gate.n).padStart(2, "0")}` }),
      node("div", "gate-title gate-name", { text: gate.name }),
      chip(stateGate.status || "pending"),
    );
    const artifacts = node("div", "gate-artifacts");
    const artifactKeys = gate.id === "product" && !data?.artifacts?.userStory && data?.artifacts?.uiLayout
      ? ["uiLayout"]
      : gate.artifactKeys;
    for (const key of artifactKeys) {
      const present = data?.artifacts?.[key] !== null && data?.artifacts?.[key] !== undefined;
      const label = node("span", "artifact-link", { text: `${present ? "●" : "○"} ${ARTIFACT_LABELS[key]}` });
      if (present) {
        const link = node("a", "artifact-link", { href: `#artifact-${key}` });
        link.append(label);
        artifacts.append(link);
      } else {
        artifacts.append(label);
      }
    }
    if (gate.docKey && data?.docs?.[gate.docKey]) {
      const docLink = node("a", "artifact-link", { href: `#doc-${gate.docKey}`, text: "↳ DOC VIEWER" });
      artifacts.append(docLink);
    }
    card.append(artifacts);
    rail.append(card);
  }
  return section("gate-rail", "FIVE FRONT-LOADED GATES", "Run rail", rail);
}

let controlId = 0;

function mockLabel(labelText, control) {
  const id = `mock-control-${controlId++}`;
  control.id = id;
  control.setAttribute("aria-label", text(labelText));
  const label = node("label", "", { for: id, text: labelText });
  return node("div", "mock-control", {}, [label, control]);
}

function mockChildren(item) {
  const children = Array.isArray(item?.children) ? item.children : [];
  return children.filter((child) => child && typeof child === "object").map((child) => renderMockElement(child));
}

function renderMockElement(item = {}) {
  const type = text(item.type || "text");
  const label = text(item.label || type);
  let result;
  switch (type) {
    case "heading":
      result = node("h3", "mock-heading", { text: label });
      break;
    case "text":
      result = node("p", "mock-text", { text: label });
      break;
    case "button":
      result = node("button", "mock-button", { type: "button", text: label });
      break;
    case "input":
      result = mockLabel(label, node("input", "", { type: "text", placeholder: text(item.notes || label) }));
      break;
    case "select": {
      const select = node("select");
      const children = Array.isArray(item.children) && item.children.length ? item.children : [{ label }];
      for (const optionData of children) {
        const option = node("option", "", { text: optionData?.label || optionData?.value || "Option" });
        if (optionData?.value !== undefined) option.value = text(optionData.value);
        select.append(option);
      }
      result = mockLabel(label, select);
      break;
    }
    case "checkbox": {
      const checkbox = node("input", "", { type: "checkbox" });
      checkbox.checked = false;
      result = mockLabel(label, checkbox);
      break;
    }
    case "table": {
      const table = node("table");
      table.append(node("caption", "", { text: label }));
      const headRow = node("tr");
      for (const heading of ["FIELD", "VALUE"]) headRow.append(node("th", "", { text: heading }));
      table.append(node("thead", "", {}, [headRow]));
      const rows = Array.isArray(item.children) && item.children.length ? item.children : [{ label: "status", notes: "ready" }, { label: "owner", notes: "operator" }];
      const body = node("tbody");
      for (const row of rows) {
        body.append(node("tr", "", {}, [
          node("td", "", { text: row?.label || "field" }),
          node("td", "", { text: row?.notes || "—" }),
        ]));
      }
      table.append(body);
      result = node("div", "mock-table", {}, [table]);
      break;
    }
    case "list": {
      const items = Array.isArray(item.children) && item.children.length ? item.children : [{ label: label }, { label: "Awaiting input" }, { label: "Ready" }];
      result = node("div", "mock-list", {}, [
        node("strong", "", { text: label }),
        node("ul", "", {}, items.map((entry) => node("li", "", { text: entry?.label || entry?.value || "item" }))),
      ]);
      break;
    }
    case "card":
      result = node("article", "mock-card", {}, [
        node("strong", "", { text: label }),
        node("p", "", { text: item.notes || "Card content" }),
        ...mockChildren(item),
      ]);
      break;
    case "image": {
      const image = node("img", "", {
        alt: label,
        loading: "lazy",
        src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3C/svg%3E",
      });
      image.style.width = "100%";
      image.style.minHeight = "78px";
      image.style.objectFit = "cover";
      result = node("figure", "mock-image", {}, [image, node("figcaption", "", { text: label })]);
      break;
    }
    case "nav": {
      const links = Array.isArray(item.children) && item.children.length ? item.children : [{ label: "Overview" }, { label: "Activity" }, { label: "Settings" }];
      result = node("nav", "mock-nav", { "aria-label": label }, links.map((entry) => node("a", "", { href: "#", text: entry?.label || "Link" })));
      break;
    }
    case "form":
      result = node("form", "mock-form", {}, [
        node("strong", "", { text: label }),
        ...mockChildren(item),
        node("button", "", { type: "button", text: "SUBMIT" }),
      ]);
      result.addEventListener("submit", (event) => event.preventDefault());
      break;
    case "chart": {
      const chart = svgNode("svg", { viewBox: "0 0 260 100", role: "img", "aria-label": label });
      chart.append(svgNode("title", {}, label));
      chart.append(svgNode("path", { d: "M12 82H250M12 12V82", stroke: "var(--line-strong)", "stroke-width": "2", fill: "none" }));
      [35, 55, 30, 72, 62, 88].forEach((height, index) => {
        chart.append(svgNode("rect", { x: 24 + index * 36, y: 82 - height * .7, width: 20, height: height * .7, fill: index % 2 ? "var(--vermilion)" : "var(--voting-blue)" }));
      });
      result = node("div", "mock-chart", {}, [node("strong", "", { text: label }), chart]);
      break;
    }
    case "badge":
      result = node("span", "mock-badge", { text: label });
      break;
    case "modal":
      result = node("div", "mock-modal", { role: "dialog", "aria-label": label }, [
        node("strong", "", { text: label }),
        node("p", "", { text: item.notes || "Modal content" }),
        ...mockChildren(item),
        node("button", "", { type: "button", text: "CLOSE" }),
      ]);
      break;
    case "terminal":
      result = node("pre", "mock-terminal", { text: item.notes ? `${label}\n\n${item.notes}` : `${label}\n\n$ astra status\n> awaiting signal` });
      break;
    default:
      result = node("p", "mock-text", { text: label });
      break;
  }
  if (item.notes && !["input", "terminal", "card", "modal"].includes(type)) {
    result.append(node("small", "muted", { text: item.notes }));
  }
  return node("div", `mock-element mock-${type}`, {}, [result]);
}

const WIRE_COMPONENT_TYPES = {
  heading: "heading",
  text: "text",
  label: "text",
  paragraph: "text",
  button: "button",
  iconbutton: "button",
  input: "input",
  textarea: "input",
  select: "select",
  checkbox: "checkbox",
  radio: "checkbox",
  toggle: "checkbox",
  table: "table",
  list: "list",
  card: "card",
  image: "image",
  topbar: "nav",
  sidebar: "nav",
  sidebarmenu: "nav",
  breadcrumbs: "nav",
  tabs: "nav",
  chart: "chart",
  stat: "card",
  code: "terminal",
  badge: "badge",
  link: "button",
  alert: "card",
  modal: "modal",
};

function wireItems(value) {
  if (Array.isArray(value)) return value.map((entry) => ({ label: text(entry) }));
  return text(value).split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => ({ label: entry }));
}

function wireComponent(component) {
  const props = component?.props ?? {};
  const componentName = text(component?.componentType || "Text");
  const type = WIRE_COMPONENT_TYPES[componentName.toLowerCase()] ?? "text";
  const label = props.text ?? props.label ?? props.title ?? props.value ?? componentName;
  const item = {
    type,
    label: text(label),
    notes: text(props.placeholder ?? props.subtitle ?? props.description ?? ""),
  };
  if (props.items !== undefined) item.children = wireItems(props.items);
  if (componentName.toLowerCase() === "table") {
    item.children = wireItems(props.columns ?? props.items ?? "Column 1,Column 2");
  }
  return renderMockElement(item);
}

function renderWireNode(item) {
  if (item?.type === "component") return wireComponent(item);
  const kind = item?.type === "cell" ? "cell" : text(item?.layoutType || "stack").toLowerCase();
  const attributes = { "data-wire-layout": kind };
  if (item?.params?.direction) attributes["data-direction"] = text(item.params.direction).toLowerCase();
  const container = node("div", `wire-layout wire-${kind}`, attributes);
  if (kind === "grid") {
    const columns = Number(item?.params?.columns);
    if (Number.isInteger(columns) && columns > 0 && columns <= 12) {
      container.style.setProperty("--wire-columns", String(columns));
    }
  }
  for (const child of item?.children ?? []) container.append(renderWireNode(child));
  return container;
}

function userStoryFlow(story) {
  return typeof story?.mermaid === "string" ? story.mermaid.trim() : "";
}

function userStorySurface(story) {
  return story?.meta?.surface === "ui" ? "ui" : "non-ui";
}

function userStorySummary(story) {
  return text(story?.meta?.intent).trim();
}

let mermaidModulePromise;
let mermaidInstance;

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("/vendor/mermaid/mermaid.esm.min.mjs").then((module) => {
      const candidate = module?.default ?? module?.mermaid ?? module;
      mermaidInstance = candidate?.default ?? candidate;
      if (!mermaidInstance || typeof mermaidInstance.render !== "function") {
        throw new Error("Mermaid module did not expose render()");
      }
      mermaidInstance.initialize?.({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
      });
      return mermaidInstance;
    });
  }
  return mermaidModulePromise;
}

function safeMermaidSvg(svg) {
  const template = document.createElement("template");
  template.innerHTML = text(svg);
  template.content.querySelectorAll("script, foreignObject, a").forEach((element) => element.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || /^(?:href|xlink:href)$/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  });
  return template.content;
}

// Dropped state is untrusted browser input. Mermaid directives, click handlers, and links are
// outside the User Story display contract, even when Mermaid's strict mode is unavailable.
function safeMermaidSource(source) {
  const value = text(source).trim();
  if (!value) return "";
  if (/(?:%%\{|\}%%|\bclick\b|\blinkStyle\b)/i.test(value)) return null;
  if (/(?:[a-z][a-z0-9+.-]{1,31}:|\/\/|www\.)[^\s<>"']+/i.test(value)) return null;
  return value;
}

async function renderMermaidFlow(container, source) {
  const safeSource = safeMermaidSource(source);
  if (safeSource === null) {
    container.replaceChildren(
      node("p", "story-error", { role: "alert", text: "MERMAID FLOW CONTAINS UNSUPPORTED DIRECTIVES OR LINKS" }),
      node("pre", "mermaid-source", { tabIndex: "0", "aria-label": "Mermaid flow source", text: source }),
    );
    return;
  }
  if (!safeSource) {
    container.replaceChildren(empty("NO MERMAID FLOW PROVIDED"));
    return;
  }
  container.replaceChildren(node("p", "story-loading", { role: "status", text: "RENDERING INTERACTION FLOW…" }));
  try {
    const mermaid = await loadMermaid();
    const renderId = `user-story-flow-${++app.sequenceId}`;
    const result = await mermaid.render(renderId, safeSource);
    const svg = node("div", "mermaid-svg", { role: "img", "aria-label": "User interaction flow diagram" });
    svg.append(safeMermaidSvg(result?.svg));
    container.replaceChildren(svg);
  } catch (error) {
    container.replaceChildren(
      node("p", "story-error", { role: "alert", text: `MERMAID RENDER ERROR // ${error?.message || "unknown error"}` }),
      node("pre", "mermaid-source", { tabIndex: "0", "aria-label": "Mermaid flow source", text: safeSource }),
    );
  }
}

const USER_STORY_ROUTES = Object.freeze({
  preview: "/api/artifacts/user-story/preview",
  previewDownload: "/api/artifacts/user-story/preview?download=1",
  design: "/api/artifacts/user-story/design",
});

function artifactUrl(kind) {
  return USER_STORY_ROUTES[kind];
}

function artifactDownload(label, href, filename, disabled = false) {
  if (disabled || !href) return node("span", "artifact-download unavailable", { text: `${label} UNAVAILABLE` });
  return node("a", "artifact-download", { href, download: filename, text: label });
}

function openUserStoryModal(story, preview, design, trigger) {
  rememberModalFocus(trigger);
  const title = text(story?.meta?.title || story?.title || "USER STORY // UI DEMONSTRATION");
  docModalTitle.textContent = title;
  docModalMeta.textContent = [
    preview?.path ? `${preview.path} // ${preview.bytes ?? "?"} BYTES` : "PREVIEW UNAVAILABLE",
    design?.path ? `${design.path} // EDITABLE DESIGN` : "EDITABLE DESIGN UNAVAILABLE",
  ].join(" · ");
  const body = node("div", "story-modal");
  if (preview) {
    const image = node("img", "story-modal-image", {
      src: artifactUrl("preview"),
      alt: `${title} OpenPencil UI demonstration`,
    });
    image.addEventListener("error", () => {
      image.replaceWith(node("p", "story-error", { role: "alert", text: "UI PREVIEW COULD NOT BE LOADED" }));
    }, { once: true });
    body.append(node("figure", "story-modal-figure", {}, [image, node("figcaption", "muted", { text: "READ-ONLY OPENPENCIL PREVIEW" })]));
  } else {
    body.append(empty("UI PREVIEW UNAVAILABLE"));
  }
  body.append(node("div", "artifact-actions", {}, [
    artifactDownload("DOWNLOAD PNG", artifactUrl("previewDownload"), "user-story.png", !preview),
    artifactDownload("DOWNLOAD .FIG", artifactUrl("design"), "user-story.fig", !design),
  ]));
  docModalBody.replaceChildren(body);
  docModalBody.scrollTop = 0;
  if (typeof docModal.showModal === "function" && !docModal.open) docModal.showModal();
  docModalClose.focus();
}

function renderUserStory(data) {
  const story = data?.artifacts?.userStory;
  if (!story) return null;
  const surface = userStorySurface(story);
  const flow = userStoryFlow(story);
  const content = node("div", "user-story-content");
  const summary = userStorySummary(story);
  if (summary) content.append(node("p", "user-story-summary", { text: summary }));

  const flowContainer = node("div", "mermaid-flow", {
    role: "region",
    "aria-label": "User interaction flow",
    "aria-live": "polite",
  });
  content.append(node("div", "story-block", {}, [
    node("h3", "subheading", { text: "INTERACTION FLOW // MERMAID" }),
    flowContainer,
  ]));
  void renderMermaidFlow(flowContainer, flow);

  const sourceDisclosure = node("details", "story-source");
  sourceDisclosure.append(
    node("summary", "story-source-heading", { text: "MERMAID SOURCE" }),
    node("pre", "mermaid-source", { tabIndex: "0", "aria-label": "Mermaid flow source", text: flow || "(missing)" }),
  );
  content.append(sourceDisclosure);

  if (surface === "ui") {
    const preview = data?.artifacts?.userStoryPreview;
    const design = data?.artifacts?.userStoryDesign;
    const previewBlock = node("div", "story-block");
    previewBlock.append(node("h3", "subheading", { text: "UI DEMONSTRATION // OPENPENCIL" }));
    if (preview) {
      const trigger = node("button", "story-preview-trigger", {
        type: "button",
        "aria-label": "Open the User Story UI demonstration in a larger viewer",
        "data-modal-trigger": "user-story-preview",
      });
      const image = node("img", "story-preview-image", {
        src: artifactUrl("preview"),
        alt: `${text(story?.meta?.title || story?.title || "User Story")} UI demonstration thumbnail`,
        loading: "lazy",
      });
      image.addEventListener("error", () => {
        trigger.replaceChildren(node("span", "story-error", { role: "alert", text: "UI PREVIEW UNAVAILABLE" }));
        trigger.disabled = true;
      }, { once: true });
      trigger.append(image, node("span", "story-preview-caption", { text: "POP OUT" }));
      trigger.addEventListener("click", () => openUserStoryModal(story, preview, design, trigger));
      previewBlock.append(trigger);
    } else {
      previewBlock.append(empty("UI PREVIEW UNAVAILABLE // OPENPENCIL ARTIFACT NOT FOUND"));
    }
    previewBlock.append(node("div", "artifact-actions", {}, [
      artifactDownload("DOWNLOAD PNG", artifactUrl("previewDownload"), "user-story.png", !preview),
      artifactDownload("DOWNLOAD .FIG", artifactUrl("design"), "user-story.fig", !design),
    ]));
    content.append(previewBlock);
  }

  return section("artifact-userStory", "GATE 01 // USER STORY", "User Story", content, { open: true });
}

function wireScreen(layout, id) {
  return layout?.wireframes?.project?.screens?.find((screen) => screen.name === id) ?? null;
}

function renderUiLayout(data) {
  // New runs use the User Story renderer; keep this path for pre-User-Story runs.
  if (data?.artifacts?.userStory) return null;
  const layout = data?.artifacts?.uiLayout;
  if (!layout) return null;
  const content = node("div");
  const screens = layout.screens ?? [];
  if (screens.length === 0) {
    content.append(empty(layout.meta?.headless ? "HEADLESS PRODUCT // NO SCREENS DECLARED" : "NO SCREENS DECLARED"));
  }
  const grid = node("div", "screen-grid");
  for (const screen of screens) {
    const card = node("article", "screen-card", { id: `screen-${text(screen.id)}` });
    const parsedScreen = wireScreen(data, screen.id);
    const title = node("div", "screen-title", {}, [
      node("h3", "", { text: `${text(screen.id)} // ${text(screen.name)}` }),
      chip(parsedScreen ? "WIRE DSL" : "LEGACY HTML"),
    ]);
    const frame = node("div", "screen-frame", { role: "region", "aria-label": `${text(screen.name)} mockup` });
    if (parsedScreen) {
      for (const element of parsedScreen.children ?? []) frame.append(renderWireNode(element));
    } else {
      for (const element of screen.elements ?? []) frame.append(renderMockElement(element));
    }
    const aside = node("aside", "screen-aside");
    aside.append(
      node("div", "aside-block", {}, [
        node("span", "aside-label", { text: "PURPOSE" }),
        node("p", "", { text: screen.purpose }),
      ]),
      node("div", "aside-block", {}, [
        node("span", "aside-label", { text: "ACCEPTANCE" }),
        node("ul", "acceptance", {}, (screen.acceptance ?? []).map((item) => node("li", "", { text: item }))),
      ]),
    );
    card.append(title, node("div", "screen-layout", {}, [frame, aside]));
    grid.append(card);
  }
  content.append(grid);
  if (!data?.wireframes?.ok && !data?.wireframes?.legacy) {
    content.append(node("p", "wire-warning", { text: `WIRE DSL FALLBACK // ${data.wireframes.error}` }));
  }
  const flows = layout.flows ?? [];
  if (flows.length) {
    const flowList = node("div", "flows");
    flowList.append(node("h3", "subheading", { text: "USER FLOWS" }));
    for (const flow of flows) {
      flowList.append(node("div", "flow-row", {}, [
        node("span", "flow-node", { text: flow.from }),
        node("span", "flow-arrow", { "aria-hidden": "true", text: "→" }),
        node("span", "flow-node", { text: flow.to }),
        node("span", "flow-trigger", { text: flow.trigger }),
      ]));
    }
    content.append(flowList);
  }
  return section("artifact-uiLayout", "GATE 01 // OPTIONAL VISUAL INTENT", "UI mockups", content, { open: false });
}

function serviceGroups(architecture) {
  const groups = new Map();
  for (const service of architecture.services ?? []) {
    if (!groups.has(service.kind)) groups.set(service.kind, []);
    groups.get(service.kind).push(service);
  }
  const grid = node("div", "service-groups");
  for (const [kind, services] of groups) {
    const listElement = node("ul", "service-list");
    for (const service of services) {
      listElement.append(node("li", "", {}, [
        node("span", "service-name", { text: `${text(service.id)} // ${text(service.name)}` }),
        node("span", "service-kind", { text: service.existing ? `${kind} // EXISTING` : kind }),
        node("span", "service-responsibility", { text: service.responsibility }),
      ]));
    }
    grid.append(node("article", "service-group", {}, [
      node("h3", "", { text: kind }),
      listElement,
    ]));
  }
  return grid;
}

function riskFlags(flags, target = "") {
  const filtered = (flags ?? []).filter((flag) => !target || !flag.target || text(flag.target).toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(text(flag.target).toLowerCase()));
  if (!filtered.length) return null;
  const listElement = node("div", "risk-list");
  for (const flag of filtered) {
    listElement.append(node("div", "risk-flag", {}, [
      chip(flag.severity, text(flag.severity)),
      node("p", "", {}, [
        node("strong", "", { text: flag.claim }),
        flag.target ? node("span", "fix", { text: `TARGET // ${flag.target}` }) : null,
        flag.fix ? node("span", "fix", { text: `FIX // ${flag.fix}` }) : null,
      ]),
    ]));
  }
  return listElement;
}

function sequenceDiagram(sequence) {
  const participants = [];
  for (const step of sequence.steps ?? []) {
    if (!participants.includes(step.from)) participants.push(step.from);
    if (!participants.includes(step.to)) participants.push(step.to);
  }
  const laneWidth = 150;
  const width = Math.max(440, participants.length * laneWidth + 30);
  const rowHeight = 48;
  const height = Math.max(130, 76 + (sequence.steps?.length ?? 0) * rowHeight);
  const markerId = `arrow-${app.sequenceId++}`;
  const svg = svgNode("svg", { class: "sequence-svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": sequence.name });
  const defs = svgNode("defs");
  defs.append(svgNode("marker", { id: markerId, markerWidth: "8", markerHeight: "8", refX: "7", refY: "4", orient: "auto", markerUnits: "strokeWidth" }, [
    svgNode("path", { d: "M0 0 8 4 0 8Z", fill: "var(--vermilion)" }),
  ]));
  svg.append(defs, svgNode("title", {}, sequence.name));
  const lane = new Map(participants.map((participant, index) => [participant, 15 + index * laneWidth + laneWidth / 2]));
  participants.forEach((participant, index) => {
    const x = lane.get(participant);
    svg.append(
      svgNode("rect", { x: x - 54, y: 12, width: "108", height: "25", fill: "var(--surface-emphasis)", stroke: "var(--line-strong)" }),
      svgNode("text", { x, y: "29", fill: "var(--cyan-soft)", "font-size": "10", "font-family": "ui-monospace, monospace", "text-anchor": "middle" }, participant),
      svgNode("line", { x1: x, y1: "40", x2: x, y2: height - 12, stroke: index % 2 ? "var(--line)" : "var(--line-strong)", "stroke-dasharray": "3 5" }),
    );
  });
  for (const [index, step] of (sequence.steps ?? []).entries()) {
    const y = 65 + index * rowHeight;
    const x1 = lane.get(step.from) ?? 30;
    const x2 = lane.get(step.to) ?? width - 30;
    const sameLane = x1 === x2;
    const line = sameLane
      ? svgNode("path", { d: `M${x1} ${y - 8} C${x1 + 55} ${y - 8},${x1 + 55} ${y + 18},${x1} ${y + 18}`, fill: "none", stroke: "var(--vermilion)", "stroke-width": "2", "marker-end": `url(#${markerId})` })
      : svgNode("line", { x1, y1: y, x2, y2: y, stroke: "var(--vermilion)", "stroke-width": "2", "marker-end": `url(#${markerId})`, ...(step.async ? { "stroke-dasharray": "7 5" } : {}) });
    svg.append(line, svgNode("text", { x: (x1 + x2) / 2, y: y - 7, fill: "var(--ink)", "font-size": "10", "font-family": "ui-monospace, monospace", "text-anchor": "middle" }, step.message));
  }
  return svg;
}

function renderArchitecture(data) {
  const architecture = data?.artifacts?.systemArchitecture;
  if (!architecture) return null;
  const content = node("div");
  content.append(node("h3", "subheading", { text: "SERVICES // GROUPED BY KIND" }), serviceGroups(architecture));

  if (architecture.endpoints?.length) {
    content.append(node("div", "data-block", {}, [
      node("h3", "subheading", { text: "ENDPOINTS" }),
      dataTable(["ID", "SERVICE", "SIGNATURE", "PURPOSE", "REQ → RES"], architecture.endpoints.map((endpoint) => [
        endpoint.id,
        endpoint.service,
        node("span", "mono", { text: endpoint.signature }),
        endpoint.purpose,
        `${text(endpoint.request || "—")} → ${text(endpoint.response || "—")}`,
      ])),
    ]));
  }

  if (architecture.dataModels?.length) {
    const models = node("div", "data-block");
    models.append(node("h3", "subheading", { text: "DATA MODELS" }));
    for (const model of architecture.dataModels) {
      models.append(node("article", "service-group", {}, [
        node("h3", "", { text: `${text(model.name)}${model.store ? ` // ${text(model.store)}` : ""}` }),
        dataTable(["FIELD", "TYPE", "NOTES"], (model.fields ?? []).map((field) => [field.name, field.type, field.notes || "—"])),
      ]));
    }
    content.append(models);
  }

  if (architecture.sequences?.length) {
    const sequenceList = node("div", "data-block");
    sequenceList.append(node("h3", "subheading", { text: "SEQUENCES // SOLID = SYNC · DASH = ASYNC" }));
    const sequenceCards = node("div", "sequence-list");
    for (const sequence of architecture.sequences) {
      const card = node("article", "sequence-card", {}, [
        node("h3", "", { text: `${text(sequence.id)} // ${text(sequence.name)}` }),
        node("div", "sequence-scroll", {}, sequenceDiagram(sequence)),
      ]);
      const flags = riskFlags(architecture.riskFlags, sequence.id) || riskFlags(architecture.riskFlags, sequence.name);
      if (flags) card.append(flags);
      sequenceCards.append(card);
    }
    sequenceList.append(sequenceCards);
    content.append(sequenceList);
  }

  if (architecture.patterns?.length) {
    const patterns = node("div", "data-block");
    patterns.append(node("h3", "subheading", { text: "PATTERNS // SELECTED VS REJECTED" }));
    const grid = node("div", "pattern-grid");
    for (const pattern of architecture.patterns) {
      grid.append(node("article", `pattern ${pattern.status || ""}`.trim(), {}, [
        node("span", "pattern-name", { text: `${pattern.status === "selected" ? "✓" : "×"} ${pattern.name}` }),
        node("p", "", { text: pattern.rationale }),
        pattern.appliesTo?.length ? node("p", "mono", { text: `APPLIES // ${pattern.appliesTo.join(", ")}` }) : null,
      ]));
    }
    patterns.append(grid);
    content.append(patterns);
  }

  if (architecture.riskFlags?.length) {
    content.append(node("div", "data-block", {}, [
      node("h3", "subheading", { text: "RISK FLAGS // JUDGE OUTPUT" }),
      riskFlags(architecture.riskFlags),
    ]));
  }
  return section("artifact-systemArchitecture", "GATE 02 // SYSTEM SHAPE", "Architecture", content, { open: data?.ledger?.phase === "architecture" });
}

/** The solo judge was renamed to Grunt; runs recorded before the rename still say Sideeye. */
function personaLabel(name) {
  return /^sideeye$/i.test(String(name ?? "").trim()) ? "Grunt" : name;
}

function renderAudit(data) {
  const audit = data?.artifacts?.audit;
  if (!audit) return null;
  const verdict = text(audit.verdict || "unknown");
  const content = node("div");
  const banner = node("div", `audit-banner ${verdict}`.trim(), {}, [
    node("strong", "", { text: `OVERALL // ${verdict}` }),
    audit.confidence ? chip(`CONFIDENCE // ${audit.confidence}`) : null,
    audit.summary ? node("p", "audit-dissent", { text: audit.summary }) : null,
  ]);
  content.append(banner);
  const personas = node("div", "persona-grid");
  for (const persona of audit.personas ?? []) {
    const personaCard = node("article", "persona-card", {}, [
      node("div", "persona-head", {}, [
        node("span", "persona-name", { text: personaLabel(persona.name) }),
        chip(persona.verdict || "unknown", persona.verdict || ""),
      ]),
      persona.lens ? node("p", "persona-lens", { text: persona.lens }) : null,
      persona.confidence ? chip(`CONF // ${persona.confidence}`) : null,
    ]);
    const findings = node("ul", "finding-list");
    for (const finding of persona.findings ?? []) {
      findings.append(node("li", "finding", {}, [
        chip(finding.severity, finding.severity),
        node("p", "", { text: finding.claim }),
        finding.target ? node("p", "mono", { text: `TARGET // ${finding.target}` }) : null,
        finding.evidence ? node("p", "", { text: `EVIDENCE // ${finding.evidence}` }) : null,
        finding.fix ? node("p", "fix", { text: `FIX // ${finding.fix}` }) : null,
      ]));
    }
    if ((persona.findings ?? []).length) personaCard.append(findings);
    else personaCard.append(empty("NO FINDINGS"));
    personas.append(personaCard);
  }
  if (audit.personas?.length) content.append(personas);
  if (audit.dissent) content.append(node("p", "audit-dissent", { text: `DISSENT // ${audit.dissent}` }));
  return section("artifact-audit", "GATE 02 // ADVERSARIAL JUDGE", "Audit tribunal", content, { open: data?.ledger?.phase === "architecture" });
}

function renderContracts(data) {
  const contracts = data?.artifacts?.callStackTypes;
  if (!contracts) return null;
  const content = node("div");
  const files = node("div", "contract-files");
  for (const file of contracts.files ?? []) {
    const exportsList = node("div", "export-list");
    for (const exported of file.exports ?? []) {
      exportsList.append(node("div", "export-row", {}, [
        chip(exported.kind, `kind-${exported.kind}`),
        node("div", "signature", {}, [
          node("span", "", { text: `${text(exported.name)}${exported.extends ? ` extends ${text(exported.extends)}` : ""}` }),
          node("span", "signature-description", { text: exported.signature }),
          exported.description ? node("span", "signature-description", { text: exported.description }) : null,
        ]),
      ]));
    }
    files.append(node("article", "file-card", {}, [
      node("div", "file-header", {}, [
        node("span", "file-path", { text: file.path }),
        file.status ? chip(file.status) : null,
      ]),
      node("p", "file-purpose", { text: file.purpose }),
      exportsList,
    ]));
  }
  if (files.childElementCount) content.append(node("h3", "subheading", { text: "FILE → EXPORT TREE" }), files);

  if (contracts.callStacks?.length) {
    const chains = node("div", "data-block");
    chains.append(node("h3", "subheading", { text: "CALL STACKS // ORDERED CHAINS" }));
    const listElement = node("div", "chain-list");
    for (const stack of contracts.callStacks) {
      const chain = node("div", "chain");
      for (const [index, step] of (stack.steps ?? []).entries()) {
        if (index) chain.append(node("span", "chain-arrow", { "aria-hidden": "true", text: "→" }));
        chain.append(node("span", "chain-step", { text: step }));
      }
      listElement.append(node("article", "chain-card", {}, [
        node("h3", "", { text: `${text(stack.id)} // ${text(stack.entry)}` }),
        chain,
        stack.notes ? node("p", "muted", { text: stack.notes }) : null,
      ]));
    }
    chains.append(listElement);
    content.append(chains);
  }

  if (contracts.tests?.length) {
    const tests = node("div", "data-block");
    tests.append(node("h3", "subheading", { text: "TESTING TROPHY // ASSERTION PLAN" }));
    const grouped = new Map();
    for (const test of contracts.tests) {
      if (!grouped.has(test.layer)) grouped.set(test.layer, []);
      grouped.get(test.layer).push(test);
    }
    const groups = node("div", "node-groups");
    for (const [layer, entries] of grouped) {
      groups.append(node("div", "node-group", {}, [
        node("h3", "", { text: layer }),
        dataTable(["PATH", "TARGET", "ASSERTIONS"], entries.map((test) => [
          test.path,
          test.target,
          (test.assertions ?? []).join(" · "),
        ])),
      ]));
    }
    tests.append(groups);
    content.append(tests);
  }

  if (contracts.typeBoundaries?.length) {
    content.append(node("div", "data-block type-boundary", {}, [
      node("h3", "subheading", { text: "TYPE BOUNDARIES // VALIDATE HERE" }),
      dataTable(["BOUNDARY", "SHAPE", "VALIDATOR"], contracts.typeBoundaries.map((boundary) => [boundary.boundary, boundary.shape, boundary.validator || "—"])),
    ]));
  }
  return section("artifact-callStackTypes", "GATE 03 // CONTRACTS", "Program design", content, { open: data?.ledger?.phase === "design" });
}

function topologicalWaves(nodes) {
  const remaining = [...(nodes ?? [])];
  const done = new Set();
  const waves = [];
  while (remaining.length) {
    const ready = remaining.filter((entry) => (entry.deps ?? []).every((dep) => done.has(dep) || !nodes.some((candidate) => candidate.id === dep)));
    if (!ready.length) return [{ cycle: true, nodes: remaining }];
    waves.push(ready);
    for (const entry of ready) done.add(entry.id);
    const readyIds = new Set(ready.map((entry) => entry.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (readyIds.has(remaining[index].id)) remaining.splice(index, 1);
    }
  }
  return waves;
}

function dagGraph(plan) {
  const waves = topologicalWaves(plan.nodes ?? []);
  const waveWidth = 210;
  const nodeHeight = 58;
  const maxWaveSize = Math.max(1, ...waves.map((wave) => wave.nodes?.length ?? wave.length));
  const width = Math.max(680, waves.length * waveWidth + 20);
  const height = Math.max(180, maxWaveSize * 78 + 70);
  const svg = svgNode("svg", { class: "dag-svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Topological DAG waves" });
  svg.append(svgNode("title", {}, "Executable DAG arranged in topological waves"));
  const positions = new Map();
  for (const [waveIndex, waveValue] of waves.entries()) {
    const wave = waveValue.nodes ?? waveValue;
    svg.append(svgNode("text", { x: 18 + waveIndex * waveWidth, y: 22, fill: "var(--lime)", "font-size": "11", "font-family": "ui-monospace, monospace", "letter-spacing": "1.5" }, `WAVE ${waveIndex + 1}`));
    wave.forEach((entry, nodeIndex) => {
      positions.set(entry.id, { x: 18 + waveIndex * waveWidth, y: 38 + nodeIndex * 78 });
    });
  }
  for (const entry of plan.nodes ?? []) {
    const target = positions.get(entry.id);
    if (!target) continue;
    for (const dependency of entry.deps ?? []) {
      const source = positions.get(dependency);
      if (!source) continue;
      svg.append(svgNode("line", {
        x1: source.x + 176,
        y1: source.y + nodeHeight / 2,
        x2: target.x,
        y2: target.y + nodeHeight / 2,
        stroke: "var(--line-strong)",
        "stroke-width": "2",
        "marker-end": "url(#dag-arrow)",
      }));
    }
  }
  const defs = svgNode("defs");
  defs.append(svgNode("marker", { id: "dag-arrow", markerWidth: "8", markerHeight: "8", refX: "7", refY: "4", orient: "auto" }, [
    svgNode("path", { d: "M0 0 8 4 0 8Z", fill: "var(--line-strong)" }),
  ]));
  svg.prepend(defs);
  for (const entry of plan.nodes ?? []) {
    const position = positions.get(entry.id);
    if (!position) continue;
    const color = KIND_COLORS[entry.kind] || "var(--muted)";
    const group = svgNode("g");
    const title = `${text(entry.id)} // ${text(entry.title)} | role: ${text(entry.role?.name)} | write-boundary paths: ${(entry.role?.writeBoundary ?? []).length}`;
    group.append(
      svgNode("title", {}, title),
      svgNode("rect", { x: position.x, y: position.y, width: "176", height: nodeHeight, fill: "var(--surface)", stroke: color, "stroke-width": "2" }),
      svgNode("text", { x: position.x + 9, y: position.y + 19, fill: color, "font-size": "11", "font-family": "ui-monospace, monospace" }, entry.id),
      svgNode("text", { x: position.x + 9, y: position.y + 37, fill: "var(--ink)", "font-size": "10", "font-family": "Chakra Petch, ui-monospace, monospace" }, text(entry.title).slice(0, 25)),
      svgNode("text", { x: position.x + 9, y: position.y + 51, fill: "var(--muted)", "font-size": "9", "font-family": "ui-monospace, monospace" }, `${text(entry.role?.name).slice(0, 18)} // WB ${(entry.role?.writeBoundary ?? []).length}`),
    );
    svg.append(group);
  }
  return svg;
}

function renderPlan(data) {
  const plan = data?.artifacts?.plan;
  if (!plan) return null;
  const content = node("div");
  const slices = node("div", "slice-list");
  for (const slice of plan.slices ?? []) {
    slices.append(node("article", "slice-row", {}, [
      node("span", "slice-id", { text: slice.id }),
      node("div", "", {}, [
        node("div", "slice-title", { text: slice.title }),
        node("p", "slice-demo", { text: slice.demo }),
        node("ul", "criteria", {}, (slice.criteria ?? []).map((criterion) => node("li", "", { text: criterion }))),
      ]),
      slice.tracer ? chip("TRACER", "cleared") : chip("SLICE"),
    ]));
  }
  if (slices.childElementCount) content.append(slices);
  content.append(node("h3", "subheading", { text: "DAG // TOPOLOGICAL WAVES" }), node("div", "dag-scroll", {}, dagGraph(plan)));
  const legend = node("div", "kind-legend");
  for (const kind of Object.keys(KIND_COLORS)) legend.append(node("span", `chip kind-${kind}`, {}, kind));
  content.append(legend);
  return section("artifact-plan", "GATE 04 // GRAPH ENGINEERING", "Executable DAG", content, { open: data?.ledger?.phase === "plan" });
}

function duration(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function executionSliceProgress(execution, sliceId) {
  const nodes = (execution.nodes ?? []).filter((entry) => entry.slice === sliceId);
  const passed = nodes.filter((entry) => ["passed", "skipped"].includes(entry.status)).length;
  return { passed, total: nodes.length };
}

function renderExecution(data) {
  const execution = data?.artifacts?.execution;
  if (!execution) return null;
  const content = node("div");
  const head = node("div", "execution-head", {}, [
    node("strong", "execution-status", { text: execution.status }),
    execution.meta?.updatedAt ? node("span", "muted mono", { text: `UPDATED // ${execution.meta.updatedAt}` }) : null,
    execution.meta?.concurrency ? chip(`CONCURRENCY // ${execution.meta.concurrency}`) : null,
  ]);
  content.append(head);

  const sliceEntries = execution.slices?.length
    ? execution.slices
    : [...new Set((execution.nodes ?? []).map((entry) => entry.slice))].filter(Boolean).map((id) => ({ id, title: id }));
  const progressList = node("div", "progress-list");
  for (const slice of sliceEntries) {
    const progress = executionSliceProgress(execution, slice.id);
    const ratio = progress.total ? progress.passed / progress.total : (slice.status === "passed" ? 1 : 0);
    progressList.append(node("div", "progress-row", {}, [
      node("span", "progress-label", { text: `${text(slice.id)} // ${text(slice.title)}` }),
      node("progress", "", { max: "1", value: ratio, "aria-label": `${text(slice.id)} progress` }),
      node("span", "progress-count", { text: `${progress.passed}/${progress.total || "?"} // ${slice.status || "pending"}` }),
    ]));
  }
  if (progressList.childElementCount) content.append(node("h3", "subheading", { text: "SLICE PROGRESS" }), progressList);

  if (execution.nodes?.length) {
    content.append(node("h3", "subheading", { text: "NODE TELEMETRY" }), dataTable(
      ["ID", "TITLE", "SLICE", "STATUS", "ATTEMPTS", "DURATION", "EXIT"],
      execution.nodes.map((entry) => [
        entry.id,
        entry.title,
        entry.slice,
        chip(entry.status, entry.status),
        entry.attempts ?? "—",
        duration(entry.durationMs),
        entry.exitCode ?? "—",
      ]),
      "nodes-table",
    ));
  }

  if (execution.events?.length) {
    const eventList = node("ul", "event-list");
    for (const event of execution.events.slice(-40)) {
      eventList.append(node("li", "event-row", {}, [
        node("time", "event-ts", { dateTime: event.ts, text: event.ts }),
        node("span", `level-${event.level}`, { text: text(event.level).toUpperCase() }),
        node("span", "event-message", { text: `${event.node ? `${event.node} // ` : ""}${event.message}` }),
      ]));
    }
    content.append(node("h3", "subheading", { text: "EVENT LOG // NEWEST LAST" }), eventList);
  }
  return section("artifact-execution", "GATE 05 // LIVE TELEMETRY", "Execution", content, {
    open: data?.ledger?.phase === "execute" || execution.status === "running",
  });
}

/** The headless agent CLI writes to disk, not to the operator's TUI, so tail its transcript here. */
function renderLogFeed(data) {
  const feed = data?.logFeed;
  if (!feed) return null;
  const content = node("div", "log-feed");
  content.append(node("div", "log-head", {}, [
    node("strong", "mono", { text: feed.path }),
    node("span", "muted mono", { text: `${feed.bytes} BYTES // UPDATED ${feed.updatedAt}` }),
    feed.truncated ? chip("TRUNCATED") : null,
  ]));

  const pane = node("pre", "log-pane", { tabIndex: "0", "aria-label": `tail of ${feed.path}` });
  pane.textContent = feed.lines.length ? feed.lines.join("\n") : "(empty)";
  content.append(pane);

  if (feed.files?.length > 1) {
    content.append(node("h3", "subheading", { text: "TRANSCRIPTS" }), dataTable(
      ["PATH", "BYTES", "UPDATED"],
      feed.files.map((file) => [file.path, file.bytes, file.updatedAt]),
      "log-table",
    ));
  }
  return section("artifact-logs", "AGENT CLI // ROLLING TAIL", "Transcript", content, { open: false });
}

// markdownToHtml escapes every text run and restricts link targets, so innerHTML is safe here.
function renderMarkdown(markdown) {
  const wrapper = node("div", "markdown");
  wrapper.innerHTML = markdownToHtml(markdown);
  return wrapper;
}

function rememberModalFocus(trigger) {
  app.modalReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  app.modalReturnFocusKey = app.modalReturnFocus?.dataset.modalTrigger || null;
}

function findModalReturnFocus() {
  if (app.modalReturnFocus && document.contains(app.modalReturnFocus)) return app.modalReturnFocus;
  if (!app.modalReturnFocusKey) return null;
  for (const element of document.querySelectorAll("[data-modal-trigger]")) {
    if (element.dataset.modalTrigger === app.modalReturnFocusKey) return element;
  }
  return null;
}

function restoreModalFocus() {
  const returnFocus = findModalReturnFocus();
  app.modalReturnFocus = null;
  app.modalReturnFocusKey = null;
  if (returnFocus) returnFocus.focus();
}

const DOC_LABELS = {
  "docs/01-product.md": "01 // PRODUCT",
  "docs/02-architecture.md": "02 // ARCHITECTURE",
  "docs/03-program-design.md": "03 // PROGRAM DESIGN",
  "docs/04-slices.md": "04 // SLICES",
  "docs/audit.md": "AUDIT",
  "PLAN.md": "PLAN",
  "00-status.md": "STATUS LEDGER",
};

function docId(path) {
  return `doc-${path.replace(/[^\w-]+/g, "-")}`;
}

function openDocModal(doc, label, trigger) {
  rememberModalFocus(trigger || document.activeElement);
  docModalTitle.textContent = label;
  docModalMeta.textContent = `${doc.path} // ${doc.bytes} BYTES`;
  docModalBody.replaceChildren(renderMarkdown(doc.markdown));
  docModalBody.scrollTop = 0;
  if (typeof docModal.showModal === "function" && !docModal.open) docModal.showModal();
  docModalClose.focus();
}

function closeDocModal() {
  if (docModal.open) docModal.close();
  docModalBody.replaceChildren();
}

/** Every Markdown file the run produced, rendered as HTML rather than raw lines. */
function renderDocs(data) {
  const files = data?.markdown?.length
    ? data.markdown
    : Object.values(data?.docs ?? {}).filter(Boolean);
  if (!files.length) return null;

  const content = node("div", "doc-grid");
  for (const doc of files) {
    const label = DOC_LABELS[doc.path] ?? doc.path;
    const expand = node("button", "doc-expand", {
      type: "button",
      text: "POP OUT",
      "aria-label": `Open ${label} in a larger viewer`,
      "data-modal-trigger": `doc:${doc.path}`,
    });
    expand.addEventListener("click", () => openDocModal(doc, label, expand));
    content.append(node("article", "doc-card", { id: docId(doc.path) }, [
      node("div", "doc-card-head", {}, [node("h3", "", { text: label }), expand]),
      node("p", "doc-meta", { text: `${doc.path} // ${doc.bytes} BYTES` }),
      renderMarkdown(doc.markdown),
    ]));
  }
  return section("docs", "ARTIFACT DOCUMENTS", "Document viewers", content, { open: false });
}

function collectOpenQuestions(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectOpenQuestions(entry, output, seen);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(open[-_ ]?questions?|questions?)$/i.test(key) && Array.isArray(child)) {
      for (const question of child) {
        const valueText = typeof question === "string" ? question : question?.q || question?.question || question?.text;
        if (valueText) output.push(text(valueText));
      }
    } else {
      collectOpenQuestions(child, output, seen);
    }
  }
  return output;
}

async function submitFeedback(gate, verdict, textarea, feedbackState, buttons) {
  buttons.forEach((button) => { button.disabled = true; });
  feedbackState.textContent = "TRANSMITTING…";
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate, verdict, notes: textarea.value }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || `server returned ${response.status}`);
    feedbackState.textContent = `SAVED // ${payload.path}`;
  } catch (error) {
    feedbackState.textContent = `ERROR // ${error.message}`;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function submitInteraction(interaction, action, value, state) {
  state.textContent = "TRANSMITTING…";
  try {
    const response = await fetch("/api/interaction/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: interaction.requestId, resumeToken: interaction.resumeToken, action, ...(value ? { value } : {}) }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || `server returned ${response.status}`);
    state.textContent = "RESPONSE SAVED";
  } catch (error) {
    state.textContent = `ERROR // ${error.message}`;
  }
}

function renderInteraction(data) {
  const interaction = data?.interaction;
  if (!interaction || interaction.status !== "waiting") return null;
  const responseState = node("div", "feedback-state", { "aria-live": "polite" });
  const controls = [];
  if (interaction.kind === "command-approval") {
    controls.push(node("button", "review-button approve", { type: "button", text: "ALLOW ONCE" }));
    controls.push(node("button", "review-button changes", { type: "button", text: "DENY" }));
    controls[0].addEventListener("click", () => submitInteraction(interaction, "approve", "", responseState));
    controls[1].addEventListener("click", () => submitInteraction(interaction, "deny", "", responseState));
  } else {
    const answer = node("input", "interaction-answer", { type: "text", placeholder: "TYPE RESPONSE" });
    const send = node("button", "review-button approve", { type: "button", text: "ANSWER" });
    send.addEventListener("click", () => submitInteraction(interaction, "answer", answer.value, responseState));
    controls.push(answer, send);
  }
  return section("interaction", "LIVE CONTROL", "Pending agent interaction", node("div", "interaction-card", {}, [
    node("div", "eyebrow", { text: `${interaction.kind} // ${interaction.agent} // ${interaction.risk}` }),
    node("h3", "", { text: interaction.summary }),
    interaction.command ? node("pre", "mock-terminal", { text: `${interaction.cwd || ""}\n$ ${interaction.command}` }) : null,
    interaction.question ? node("p", "session-note", { text: interaction.question }) : null,
    node("div", "button-row", {}, controls),
    responseState,
  ]));
}

function formatTokens(value) {
  return Number(value ?? 0).toLocaleString();
}

function renderSession(data) {
  const session = data?.session;
  if (!session) return null;
  const budget = session.budget ?? {};
  const limit = budget.budgetTokens ? formatTokens(budget.budgetTokens) : "UNBOUNDED";
  const percent = budget.percent == null ? "—" : `${Number(budget.percent).toFixed(1)}%`;
  const workers = session.workers ?? [];
  const cards = node("div", "session-grid", {}, [
    node("article", "session-stat", {}, [node("span", "eyebrow", { text: "SESSION PATH" }), node("strong", "", { text: `SESSION → ${String(session.harness).toUpperCase()} → ${String(session.interface).toUpperCase()}` })]),
    node("article", "session-stat", {}, [node("span", "eyebrow", { text: "TOKEN BUDGET" }), node("strong", "", { text: `${formatTokens(budget.usedTokens)} / ${limit}` }), node("small", "", { text: `${percent} used · compact at 50%` })]),
    node("article", "session-stat", {}, [node("span", "eyebrow", { text: "SUBAGENTS" }), node("strong", "", { text: `${workers.filter((worker) => worker.status === "running").length} ACTIVE / ${workers.length} TOTAL` })]),
  ]);
  if (budget.percent != null) {
    const meter = node("progress", "session-budget", { max: "100", value: Math.min(100, Number(budget.percent)), "aria-label": "Token budget used" });
    cards.children[1].append(meter);
  }
  if (workers.length) {
    cards.append(dataTable(["WORKER", "HARNESS", "MODEL", "STATUS"], workers.map((worker) => [
      worker.kind ?? worker.id,
      worker.harness ?? session.harness,
      worker.model ?? "inherited",
      chip(worker.status ?? "pending"),
    ]), "worker-table"));
  }
  for (const warning of session.warnings ?? []) cards.append(node("p", "session-note", { text: `WARNING // ${warning}` }));
  return section("session", "DURABLE BROKER", "Session, harness & budget", cards, { open: false });
}

function renderReviewFooter(data) {
  const content = node("div", "panel");
  content.append(node("div", "panel-heading", {}, [
    node("h2", "", { text: "Human review" }),
    node("span", "eyebrow", { text: "FEEDBACK // READ-ONLY QUESTIONS" }),
  ]));
  const questions = collectOpenQuestions(data?.artifacts);
  if (questions.length) {
    content.append(node("p", "session-note", { text: "Questions are read-only. Answer them in your agent session." }));
  }
  const grid = node("div", "review-grid");
  const currentGate = GATES.find((gate) => gate.id === data?.ledger?.phase);
  const reviewGates = currentGate && !data?.ledger?.complete ? [currentGate] : [];
  for (const gate of reviewGates) {
    const textarea = node("textarea", "", { "aria-label": `${gate.name} review notes`, placeholder: "NOTES // required changes, evidence, decision context" });
    const approve = node("button", "review-button approve", { type: "button", text: "APPROVE" });
    const changes = node("button", "review-button changes", { type: "button", text: "REQUEST CHANGES" });
    const state = node("div", "feedback-state", { "aria-live": "polite" });
    const buttons = [approve, changes];
    approve.addEventListener("click", () => submitFeedback(gate.id, "approved", textarea, state, buttons));
    changes.addEventListener("click", () => submitFeedback(gate.id, "changes-requested", textarea, state, buttons));
    grid.append(node("article", "review-card", {}, [
      node("h3", "", { text: `GATE ${String(gate.n).padStart(2, "0")} // ${gate.id}` }),
      textarea,
      node("div", "button-row", {}, buttons),
      state,
    ]));
  }
  if (!reviewGates.length) grid.append(empty("NO OPEN GATE REQUIRES REVIEW"));
  content.append(grid);
  return content;
}

function renderState(data) {
  app.state = data;
  updateHeader(data);
  // SSE replaces the trigger subtree while an open dialog remains mounted.
  if (docModal.open && app.modalReturnFocus && !document.contains(app.modalReturnFocus)) app.modalReturnFocus = null;
  consoleRoot.replaceChildren();
  const session = renderSession(data);
  if (session) consoleRoot.append(session);
  consoleRoot.append(renderGateRail(data));
  const renderers = [renderUserStory, renderUiLayout, renderArchitecture, renderAudit, renderContracts, renderPlan, renderExecution, renderLogFeed];
  const interaction = renderInteraction(data);
  if (interaction) consoleRoot.append(interaction);
  for (const renderer of renderers) {
    const rendered = renderer(data);
    if (rendered) consoleRoot.append(rendered);
  }
  const docs = renderDocs(data);
  if (docs) consoleRoot.append(docs);
  reviewFooter.replaceChildren(renderReviewFooter(data));
}

function classifyDrop(data) {
  if (data?.meta?.surface && data?.mermaid) return "userStory";
  if (data?.screens && data?.meta?.intent) return "uiLayout";
  if (data?.services && data?.sequences) return "systemArchitecture";
  if (data?.personas && data?.verdict) return "audit";
  if (data?.files && data?.callStacks) return "callStackTypes";
  if (data?.status && data?.nodes) return "execution";
  if (data?.slices && data?.nodes) return "plan";
  if (data?.gates && data?.phase) return "ledger";
  return null;
}

function handleDrop(data) {
  const key = classifyDrop(data);
  if (!key) {
    liveLabel.textContent = "DROP UNKNOWN";
    return;
  }
  const next = JSON.parse(JSON.stringify(app.state ?? { ok: true, artifacts: {}, docs: {}, gates: [] }));
  if (key === "ledger") next.ledger = data;
  else next.artifacts[key] = data;
  app.localDrop = true;
  renderState(next);
  liveDot.className = "live-dot connected";
  liveLabel.textContent = `LOCAL // ${ARTIFACT_LABELS[key] || "LEDGER"}`;
}

async function loadState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`state request returned ${response.status}`);
    renderState(await response.json());
    liveDot.className = "live-dot connected";
  } catch (error) {
    liveDot.className = "live-dot offline";
    liveLabel.textContent = "STATE ERROR";
    consoleRoot.replaceChildren(section("load-error", "SYSTEM", "Visualizer fault", empty(error.message)));
    reviewFooter.replaceChildren();
  }
}

function connectStream() {
  if (!("EventSource" in globalThis)) return;
  const stream = new EventSource("/api/stream");
  stream.addEventListener("state", (event) => {
    try {
      app.localDrop = false;
      renderState(JSON.parse(event.data));
      liveDot.className = "live-dot connected";
    } catch {
      liveDot.className = "live-dot offline";
      liveLabel.textContent = "STREAM DATA ERROR";
    }
  });
  stream.addEventListener("error", () => {
    liveDot.className = "live-dot offline";
    liveLabel.textContent = "RECONNECTING";
  });
}

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.dataset.drop = "true";
});

window.addEventListener("dragleave", () => {
  delete document.body.dataset.drop;
});

window.addEventListener("drop", async (event) => {
  event.preventDefault();
  delete document.body.dataset.drop;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    handleDrop(JSON.parse(await file.text()));
  } catch {
    liveLabel.textContent = "DROP INVALID JSON";
  }
});

docModalClose.addEventListener("click", closeDocModal);
docModal.addEventListener("close", () => {
  docModalBody.replaceChildren();
  restoreModalFocus();
});
// Clicking the backdrop lands on the dialog itself, never on its children.
docModal.addEventListener("click", (event) => {
  if (event.target === docModal) closeDocModal();
});

loadState();
connectStream();
