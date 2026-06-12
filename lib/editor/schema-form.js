/**
 * Schema ⇄ form bridge for the Phase 4 block config editor. Two directions:
 *
 * - `schemaToFields` turns a frozen-subset block schema
 *   (validators/block-schema.js) into ordered form-field descriptors the
 *   config-form template renders.
 * - `parseConfigBody` coerces a form-encoded POST body (everything is a
 *   string) back into a typed config, then delegates the verdict to
 *   `validateConfigAgainstSchema` (STRICT mode — no stripUnknown).
 *
 * Only schema-declared names are ever read from the body, so unknown form
 * fields (csrf tokens, _method, hostile extras) are silently ignored at the
 * form layer and can never reach the validator as "unknown config key"
 * errors. The returned config is the RAW coerced input — schema defaults are
 * NOT materialized (gate-not-transformer, the module-wide convention).
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/schema-form
 */
import { validateConfigAgainstSchema } from "../validators/block-schema.js";

const X_CONTROL_TYPES = Object.freeze({
  textarea: "textarea",
  markdown: "markdown",
  color: "color",
});

/**
 * Map a property definition to its form control type.
 * @param {object} def Frozen-subset property definition
 * @returns {string}
 */
function controlType(def) {
  if (Array.isArray(def.enum)) return "select"; // enum wins for any base type
  if (def.type === "boolean") return "checkbox";
  if (def.type === "integer" || def.type === "number") return "number";
  if (def.type === "array") return "tags";
  return X_CONTROL_TYPES[def["x-control"]] ?? "text";
}

/**
 * Turn a block config schema into ordered form-field descriptors.
 *
 * @param {object} schema Schema previously accepted by validateSchemaDefinition
 * @param {object} [options]
 * @param {boolean} [options.advanced] Include `x-advanced` fields (they are
 *   FILTERED OUT entirely when false)
 * @returns {object[]} `[{ name, type, label, hint?, minimum?, maximum?,
 *   maxLength?, options?, default?, advanced }]` in schema property order
 */
export function schemaToFields(schema, options = {}) {
  const { advanced = false } = options;
  const fields = [];
  for (const [name, def] of Object.entries(schema?.properties ?? {})) {
    const isAdvanced = def["x-advanced"] === true;
    if (isAdvanced && !advanced) continue;
    const field = {
      name,
      type: controlType(def),
      label: def.title || name,
      advanced: isAdvanced,
    };
    if (def.description !== undefined) field.hint = def.description;
    if (def.minimum !== undefined) field.minimum = def.minimum;
    if (def.maximum !== undefined) field.maximum = def.maximum;
    if (def.maxLength !== undefined) field.maxLength = def.maxLength;
    if (Array.isArray(def.enum)) field.options = [...def.enum];
    if (def.default !== undefined) field.default = def.default;
    fields.push(field);
  }
  return fields;
}

/**
 * Coerce one raw form value per its declared type. Returns `undefined` to
 * mean "field omitted" and `{ error }` for un-coercible input.
 * @param {unknown} raw Form value (string, or array for multi-value inputs)
 * @param {object} def Property definition
 * @param {string} name Property name (error messages)
 * @returns {{ value?: unknown, error?: string } | undefined}
 */
function coerce(raw, def, name) {
  if (raw === undefined || raw === "") return undefined; // empty string = omitted
  if (def.type === "integer" || def.type === "number") {
    const value = Number(raw);
    if (Number.isNaN(value)) return { error: `"${name}" must be a number` };
    return { value };
  }
  if (def.type === "array") {
    const parts = Array.isArray(raw) ? raw : String(raw).split(",");
    return { value: parts.map((part) => String(part).trim()).filter(Boolean) };
  }
  return { value: raw }; // select/text pass through (schema bounds via validation)
}

/**
 * Parse a form-encoded body into a typed config: coercion first, then strict
 * schema validation; both error sets merged.
 *
 * Checkbox semantics: HTML checkboxes don't submit when unchecked, so every
 * schema-declared boolean gets an EXPLICIT true/false — presence ("on",
 * "true", true, or a bare value) → true, ABSENT → false. (An explicit
 * "false"/false value — the hidden-input fallback pattern — also reads as
 * false; the contract doesn't reserve it for anything else.)
 *
 * @param {unknown} body Form-encoded request body (untrusted)
 * @param {object} schema Schema previously accepted by validateSchemaDefinition
 * @returns {{ ok: boolean, config: object, errors: string[] }} `config` is
 *   the raw coerced input (no defaults materialized) — callers MUST check
 *   `ok` before persisting it
 */
export function parseConfigBody(body, schema) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const errors = [];
  const config = {};

  for (const [name, def] of Object.entries(schema?.properties ?? {})) {
    // Own-property lookup only — never read inherited Object.prototype
    // members for hostile names like "toString".
    const present = Object.hasOwn(source, name);
    const raw = present ? source[name] : undefined;

    if (def.type === "boolean") {
      config[name] = present && raw !== "false" && raw !== false;
      continue;
    }
    const coerced = coerce(raw, def, name);
    if (coerced === undefined) continue; // omitted
    if (coerced.error) {
      errors.push(coerced.error);
      continue;
    }
    config[name] = coerced.value;
  }

  // STRICT validation (no stripUnknown): config only ever contains
  // schema-declared names, so "unknown key" errors are impossible here.
  const result = validateConfigAgainstSchema(config, schema);
  errors.push(...result.errors);
  return { ok: errors.length === 0, config, errors };
}
