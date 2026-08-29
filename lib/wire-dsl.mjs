const STRUCTURAL = new Set(["project", "style", "screen", "layout", "component", "cell"]);

export class WireDslError extends Error {
  constructor(message, token = null) {
    super(token ? `${message} at ${token.line}:${token.column}` : message);
    this.name = "WireDslError";
  }
}

function tokenize(source) {
  const input = String(source ?? "");
  const tokens = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const advance = (value) => {
    for (const char of value) {
      if (char === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    offset += value.length;
  };

  while (offset < input.length) {
    const rest = input.slice(offset);
    const whitespace = /^[\s]+/.exec(rest)?.[0];
    if (whitespace) {
      advance(whitespace);
      continue;
    }
    const comment = /^\/\/[^\n]*/.exec(rest)?.[0];
    if (comment) {
      advance(comment);
      continue;
    }

    const start = { line, column };
    if (rest[0] === '"') {
      let raw = '"';
      let escaped = false;
      let closed = false;
      for (let index = 1; index < rest.length; index += 1) {
        const char = rest[index];
        raw += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new WireDslError("unterminated string", start);
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new WireDslError("invalid quoted string", start);
      }
      tokens.push({ type: "string", value, ...start });
      advance(raw);
      continue;
    }

    const number = /^-?\d+(?:\.\d+)?/.exec(rest)?.[0];
    if (number) {
      tokens.push({ type: "number", value: Number(number), ...start });
      advance(number);
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest)?.[0];
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier, ...start });
      advance(identifier);
      continue;
    }
    if ("{}():,[]".includes(rest[0])) {
      tokens.push({ type: rest[0], value: rest[0], ...start });
      advance(rest[0]);
      continue;
    }
    throw new WireDslError(`unsupported character ${JSON.stringify(rest[0])}`, start);
  }
  tokens.push({ type: "eof", value: "", line, column });
  return tokens;
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.index = 0;
  }

  current() { return this.tokens[this.index]; }
  peek(distance = 1) { return this.tokens[this.index + distance] ?? this.tokens.at(-1); }
  take() { return this.tokens[this.index++]; }

  expect(value) {
    const token = this.current();
    if (token.value !== value && token.type !== value) {
      throw new WireDslError(`expected ${JSON.stringify(value)}, found ${JSON.stringify(token.value)}`, token);
    }
    return this.take();
  }

  identifier(label) {
    const token = this.current();
    if (token.type !== "identifier") throw new WireDslError(`expected ${label}`, token);
    this.take();
    return token.value;
  }

  value() {
    const token = this.current();
    if (["string", "number", "identifier"].includes(token.type)) {
      this.take();
      return token.value;
    }
    if (token.type === "[") {
      this.take();
      const values = [];
      while (this.current().type !== "]") {
        values.push(this.value());
        if (this.current().type === ",") this.take();
        else if (this.current().type !== "]") throw new WireDslError("expected comma or closing bracket", this.current());
      }
      this.take();
      return values;
    }
    throw new WireDslError("expected property value", token);
  }

  properties({ untilBrace = false } = {}) {
    const properties = {};
    while (this.current().type !== "eof") {
      const token = this.current();
      if (untilBrace && token.type === "{") break;
      if (!untilBrace && (token.type === "}" || STRUCTURAL.has(token.value))) break;
      const key = this.identifier("property name");
      this.expect(":");
      properties[key] = this.value();
      if (this.current().type === ",") this.take();
    }
    return properties;
  }

  parameters() {
    if (this.current().type !== "(") return {};
    this.take();
    const properties = {};
    while (this.current().type !== ")") {
      const key = this.identifier("parameter name");
      this.expect(":");
      properties[key] = this.value();
      if (this.current().type === ",") this.take();
      else if (this.current().type !== ")") throw new WireDslError("expected comma or closing parenthesis", this.current());
    }
    this.take();
    return properties;
  }

  skipObject() {
    this.expect("{");
    let depth = 1;
    while (depth > 0) {
      const token = this.take();
      if (token.type === "eof") throw new WireDslError("unterminated block", token);
      if (token.type === "{") depth += 1;
      if (token.type === "}") depth -= 1;
    }
  }

  component() {
    this.expect("component");
    const componentType = this.identifier("component type");
    return { type: "component", componentType, props: this.properties() };
  }

  cell() {
    this.expect("cell");
    const props = this.properties({ untilBrace: true });
    this.expect("{");
    const children = this.children();
    this.expect("}");
    return { type: "cell", props, children };
  }

  layout() {
    this.expect("layout");
    const layoutType = this.identifier("layout type");
    const params = this.parameters();
    this.expect("{");
    const children = this.children();
    this.expect("}");
    return { type: "layout", layoutType, params, children };
  }

  children() {
    const children = [];
    while (this.current().type !== "}" && this.current().type !== "eof") {
      if (this.current().value === "layout") children.push(this.layout());
      else if (this.current().value === "component") children.push(this.component());
      else if (this.current().value === "cell") children.push(this.cell());
      else throw new WireDslError("expected layout, cell, or component", this.current());
    }
    return children;
  }

  screen() {
    this.expect("screen");
    const name = this.identifier("screen identifier");
    const params = this.parameters();
    this.expect("{");
    const children = this.children();
    this.expect("}");
    if (!children.length) throw new WireDslError(`screen ${name} has no layout`, this.current());
    return { name, params, children };
  }

  parse() {
    this.expect("project");
    const name = this.current().type === "string" ? this.take().value : this.identifier("project name");
    this.expect("{");
    const screens = [];
    while (this.current().type !== "}") {
      if (this.current().value === "style") {
        this.take();
        this.skipObject();
      } else if (this.current().value === "screen") {
        screens.push(this.screen());
      } else {
        throw new WireDslError("only style and screen blocks are supported", this.current());
      }
    }
    this.expect("}");
    this.expect("eof");
    if (!screens.length) throw new WireDslError("project must declare at least one screen");
    return { name, screens };
  }
}

export function parseWireDsl(source) {
  return new Parser(source).parse();
}

export function inspectWireDsl(source) {
  try {
    const project = parseWireDsl(source);
    return { ok: true, project };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), project: null };
  }
}

export function validateUiWireDsl(layout) {
  const inspected = inspectWireDsl(layout?.wireDsl);
  if (!inspected.ok) return { ok: false, detail: `Wire DSL: ${inspected.error}` };
  const declared = new Set((layout.screens ?? []).map((screen) => screen.id));
  const rendered = new Set(inspected.project.screens.map((screen) => screen.name));
  const missing = [...declared].filter((id) => !rendered.has(id));
  const extra = [...rendered].filter((id) => !declared.has(id));
  if (missing.length || extra.length) {
    return {
      ok: false,
      detail: `Wire DSL screen ids differ from screens[]${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; extra ${extra.join(", ")}` : ""}`,
    };
  }
  return { ok: true, detail: `${rendered.size} Wire DSL screen(s), syntax valid` };
}
