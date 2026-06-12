/**
 * Frozen JSON Schema 2020-12 SUBSET walker (spec §3.1) for block config
 * schemas. Hand-rolled by design — the subset is small enough that a
 * dependency (ajv) would cost more than it saves, and the freeze is the
 * point: schemas using anything outside the subset are REJECTED at
 * registration, so every consumer (admin forms, save validation, migrator)
 * can rely on the exact same tiny semantics.
 * @module validators/block-schema
 */

const PROPERTY_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "array",
]);
const PROPERTY_KEYWORDS = new Set([
  "type",
  "enum",
  "default",
  "minimum",
  "maximum",
  "maxLength",
  "title",
  "description",
  "items",
  "x-control",
  "x-advanced",
]);
const TOP_LEVEL_KEYWORDS = new Set([
  "type",
  "additionalProperties",
  "properties",
  "required",
]);
const X_CONTROLS = new Set([
  "textarea",
  "markdown",
  "color",
  "post-type-picker",
]);
// Property names that collide with Object.prototype plumbing. A schema
// property literally named "__proto__" (reachable via JSON.parse) would hit
// the inherited setter when the defaults loop assigns value["__proto__"],
// silently losing the default or reassigning the prototype.
const RESERVED_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeOfValue(value) {
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/**
 * @param {unknown} value
 * @param {string} type Frozen-subset type name
 * @returns {boolean}
 */
function valueMatchesType(value, type) {
  const actual = typeOfValue(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "array") {
    return actual === "array" && value.every((v) => typeof v === "string");
  }
  return actual === type;
}

/**
 * Check a (type-correct) value against a property definition's enum, bounds,
 * and maxLength constraints. Shared between config validation and the
 * meta-validation of `default` values, so a schema can never declare a
 * default that its own constraints would reject on round-trip.
 * @param {string} label Error-message prefix (e.g. `"maxItems"`)
 * @param {unknown} value
 * @param {object} def Property definition
 * @returns {string | null} Error message, or null when the value passes
 */
function constraintError(label, value, def) {
  if ("enum" in def && Array.isArray(def.enum) && !def.enum.includes(value)) {
    return `${label} must be one of ${def.enum.join(", ")}`;
  }
  if (typeof value === "number") {
    if ("minimum" in def && value < def.minimum) {
      return `${label} below minimum ${def.minimum}`;
    }
    if ("maximum" in def && value > def.maximum) {
      return `${label} above maximum ${def.maximum}`;
    }
  }
  if (typeof value === "string" && "maxLength" in def && value.length > def.maxLength) {
    return `${label} exceeds maxLength ${def.maxLength}`;
  }
  return null;
}

/**
 * Meta-validate a block config schema against the frozen subset.
 * @param {unknown} schema
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSchemaDefinition(schema) {
  const errors = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: false, errors: ["schema must be an object"] };
  }
  for (const key of Object.keys(schema)) {
    if (!TOP_LEVEL_KEYWORDS.has(key)) {
      errors.push(`unknown top-level keyword "${key}"`);
    }
  }
  if (schema.type !== "object") errors.push(`top-level type must be "object"`);
  if (schema.additionalProperties !== false) {
    errors.push("additionalProperties: false is mandatory");
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    errors.push("properties object is required");
    return { ok: errors.length === 0, errors };
  }
  for (const [name, def] of Object.entries(properties)) {
    if (RESERVED_PROPERTY_NAMES.has(name)) {
      errors.push(`property name "${name}" is reserved`);
      continue;
    }
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      errors.push(`property "${name}" must be an object`);
      continue;
    }
    for (const key of Object.keys(def)) {
      if (!PROPERTY_KEYWORDS.has(key)) {
        errors.push(`property "${name}": unknown keyword "${key}"`);
      }
    }
    if (!PROPERTY_TYPES.has(def.type)) {
      errors.push(
        `property "${name}": type must be one of ${[...PROPERTY_TYPES].join("|")}`,
      );
      continue;
    }
    if (def.type === "array") {
      if (
        !def.items ||
        typeof def.items !== "object" ||
        Array.isArray(def.items) ||
        def.items.type !== "string" ||
        Object.keys(def.items).length !== 1
      ) {
        errors.push(
          `property "${name}": arrays must declare items: {type: "string"} exactly`,
        );
      }
    } else if ("items" in def) {
      errors.push(`property "${name}": items only allowed on arrays`);
    }
    if ("enum" in def) {
      if (
        !Array.isArray(def.enum) ||
        def.enum.length === 0 ||
        def.type === "array" ||
        !def.enum.every((v) => valueMatchesType(v, def.type))
      ) {
        errors.push(
          `property "${name}": enum must be a non-empty array of ${def.type} values`,
        );
      }
    }
    if ("default" in def) {
      if (!valueMatchesType(def.default, def.type)) {
        errors.push(`property "${name}": default does not match type ${def.type}`);
      } else {
        // A default must satisfy the property's own constraints, otherwise
        // validateConfigAgainstSchema({}, schema) emits a value the schema
        // itself rejects when round-tripped.
        const constraint = constraintError(
          `property "${name}": default`,
          def.default,
          def,
        );
        if (constraint) errors.push(constraint);
      }
    }
    for (const bound of ["minimum", "maximum"]) {
      if (bound in def) {
        if (!Number.isFinite(def[bound])) {
          errors.push(`property "${name}": ${bound} must be a finite number`);
        }
        if (def.type !== "integer" && def.type !== "number") {
          errors.push(`property "${name}": ${bound} only allowed on numeric types`);
        }
      }
    }
    if ("maxLength" in def) {
      if (!Number.isInteger(def.maxLength) || def.maxLength < 0) {
        errors.push(`property "${name}": maxLength must be a non-negative integer`);
      }
      if (def.type !== "string") {
        errors.push(`property "${name}": maxLength only allowed on strings`);
      }
    }
    if ("x-control" in def && !X_CONTROLS.has(def["x-control"])) {
      errors.push(`property "${name}": unknown x-control "${def["x-control"]}"`);
    }
    if ("x-advanced" in def && typeof def["x-advanced"] !== "boolean") {
      errors.push(`property "${name}": x-advanced must be boolean`);
    }
  }
  if ("required" in schema) {
    if (
      !Array.isArray(schema.required) ||
      !schema.required.every(
        (n) => typeof n === "string" && Object.hasOwn(properties, n),
      )
    ) {
      errors.push("required must be an array of declared property names");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a config object against an (already meta-valid) schema.
 * No type coercion — form-layer coercion is the Phase 4 editor's job.
 * @param {unknown} config
 * @param {object} schema Schema previously accepted by validateSchemaDefinition
 * @param {{ stripUnknown?: boolean }} [options] stripUnknown drops unknown
 *   keys with a warning instead of erroring (migrator mode for legacy configs)
 * @returns {{ ok: boolean, errors: string[], warnings: string[], value: object }}
 *   `value` is populated (with defaults applied) even when `ok: false` —
 *   callers MUST check `ok` before persisting `value`.
 */
export function validateConfigAgainstSchema(config, schema, options = {}) {
  const { stripUnknown = false } = options;
  const errors = [];
  const warnings = [];
  const isPlainObject =
    config !== null && typeof config === "object" && !Array.isArray(config);
  if (config != null && !isPlainObject) {
    warnings.push("config is not an object; treated as empty");
  }
  const source = isPlainObject ? config : {};
  const properties = schema?.properties || {};
  const value = {};

  for (const [key, raw] of Object.entries(source)) {
    // Own-property lookup only — a bare properties[key] would resolve
    // inherited Object.prototype members for config keys like "toString"
    // or "constructor" (reachable via JSON.parse of legacy data).
    const def = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!def) {
      if (stripUnknown) warnings.push(`dropped unknown config key "${key}"`);
      else errors.push(`unknown config key "${key}"`);
      continue;
    }
    if (!valueMatchesType(raw, def.type)) {
      errors.push(`"${key}" must be ${def.type}`);
      continue;
    }
    // No separate float-vs-integer check needed: typeOfValue() classifies
    // 3.5 as "number", so valueMatchesType already rejected it for "integer".
    const constraint = constraintError(`"${key}"`, raw, def);
    if (constraint) {
      errors.push(constraint);
      continue;
    }
    value[key] = raw;
  }
  // Required means EXPLICITLY provided — defaults never satisfy required.
  // (The plan's own contract: validateConfigAgainstSchema({}, schema) fails
  // for a required property even when that property declares a default.)
  for (const name of schema?.required || []) {
    if (!Object.hasOwn(source, name)) errors.push(`missing required "${name}"`);
  }
  for (const [name, def] of Object.entries(properties)) {
    if (!Object.hasOwn(value, name) && "default" in def) value[name] = def.default;
  }
  return { ok: errors.length === 0, errors, warnings, value };
}
