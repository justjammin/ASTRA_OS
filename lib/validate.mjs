// Zero-dependency validator for the JSON Schema subset the Astra artifact schemas use:
// type, required, properties, additionalProperties:false, items, enum, pattern,
// minItems, minLength, and uniqueItems. Anything richer belongs in a gate prompt, not a schema.
export function validate(schema, value, path = "$") {
  const errors = [];
  check(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function check(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const matches = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!matches) {
      errors.push(`${path}: expected ${types.join("|")}, got ${actual}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in [${schema.enum.join(", ")}]`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${truncate(value)}" does not match /${schema.pattern}/`);
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} item(s), has ${value.length}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push(`${path}: items must be unique`);
    }
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) check(props[key], child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
}

function truncate(text) {
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}
