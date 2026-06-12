import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSchemaDefinition,
  validateConfigAgainstSchema,
} from "../lib/validators/block-schema.js";

const GOOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxItems: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 10,
      title: "Max items",
    },
    title: { type: "string", maxLength: 200 },
    content: { type: "string", maxLength: 20000, "x-control": "textarea" },
    postTypes: { type: "array", items: { type: "string" } },
    listStyle: {
      type: "string",
      enum: ["grid", "list", "compact"],
      "x-advanced": true,
    },
    enabled: { type: "boolean", default: true },
  },
  required: ["maxItems"],
};

test("accepts a schema using the full frozen subset", () => {
  assert.deepEqual(validateSchemaDefinition(GOOD_SCHEMA), {
    ok: true,
    errors: [],
  });
});

test("rejects schemas missing additionalProperties: false", () => {
  const { additionalProperties, ...rest } = GOOD_SCHEMA;
  const result = validateSchemaDefinition(rest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /additionalProperties/);
});

test("rejects out-of-subset keywords and types", () => {
  for (const bad of [
    { ...GOOD_SCHEMA, patternProperties: {} },
    { ...GOOD_SCHEMA, properties: { x: { type: "object" } } },
    {
      ...GOOD_SCHEMA,
      properties: { x: { type: "array", items: { type: "number" } } },
    },
    { ...GOOD_SCHEMA, properties: { x: { type: "string", pattern: ".*" } } },
    {
      ...GOOD_SCHEMA,
      properties: { x: { type: "string", "x-control": "wysiwyg" } },
    },
    { ...GOOD_SCHEMA, required: ["nope"] },
    { ...GOOD_SCHEMA, properties: { x: { type: "integer", default: "ten" } } },
  ]) {
    assert.equal(validateSchemaDefinition(bad).ok, false);
  }
});

test("validates a config: applies defaults, checks bounds, rejects unknown keys", () => {
  const ok = validateConfigAgainstSchema({ maxItems: 5, title: "Hi" }, GOOD_SCHEMA);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.maxItems, 5);
  assert.equal(ok.value.enabled, true); // default applied

  assert.equal(validateConfigAgainstSchema({ maxItems: 99 }, GOOD_SCHEMA).ok, false);
  assert.equal(validateConfigAgainstSchema({ maxItems: "5" }, GOOD_SCHEMA).ok, false);
  assert.equal(validateConfigAgainstSchema({}, GOOD_SCHEMA).ok, false);
  assert.equal(
    validateConfigAgainstSchema({ maxItems: 5, bogus: 1 }, GOOD_SCHEMA).ok,
    false,
  );
  assert.equal(
    validateConfigAgainstSchema({ maxItems: 5, listStyle: "mosaic" }, GOOD_SCHEMA).ok,
    false,
  );
});

test("stripUnknown drops unknown keys with a warning instead of erroring (migrator mode)", () => {
  const result = validateConfigAgainstSchema(
    { maxItems: 5, legacyKey: "old" },
    GOOD_SCHEMA,
    { stripUnknown: true },
  );
  assert.equal(result.ok, true);
  assert.equal("legacyKey" in result.value, false);
  assert.equal(result.warnings.length, 1);
});

test("maxLength enforced; oversized string rejected", () => {
  const result = validateConfigAgainstSchema(
    { maxItems: 5, title: "x".repeat(201) },
    GOOD_SCHEMA,
  );
  assert.equal(result.ok, false);
});

// --- Additional edge-case coverage beyond the plan's minimum ---

test("rejects non-object schemas outright", () => {
  for (const bad of [null, undefined, "schema", 42, ["array"]]) {
    assert.equal(validateSchemaDefinition(bad).ok, false);
  }
});

test("rejects schemas with missing or non-object properties", () => {
  assert.equal(
    validateSchemaDefinition({ type: "object", additionalProperties: false }).ok,
    false,
  );
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: [],
    }).ok,
    false,
  );
});

test("rejects enum on arrays and empty/mismatched enums", () => {
  // enum values must match the declared type; arrays are never scalars
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "array", items: { type: "string" }, enum: [["a"]] },
      },
    }).ok,
    false,
  );
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string", enum: [] } },
    }).ok,
    false,
  );
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string", enum: ["a", 2] } },
    }).ok,
    false,
  );
});

test("rejects bounds on non-numeric types and maxLength on non-strings", () => {
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string", minimum: 1 } },
    }).ok,
    false,
  );
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "integer", maxLength: 5 } },
    }).ok,
    false,
  );
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string", maxLength: -1 } },
    }).ok,
    false,
  );
});

test("rejects items on non-array types and inexact array items", () => {
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string", items: { type: "string" } } },
    }).ok,
    false,
  );
  // array without items at all
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "array" } },
    }).ok,
    false,
  );
  // items with extra keywords beyond {type: "string"}
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "array", items: { type: "string", maxLength: 5 } },
      },
    }).ok,
    false,
  );
});

test("rejects non-boolean x-advanced and required that is not an array", () => {
  assert.equal(
    validateSchemaDefinition({
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string", "x-advanced": "yes" } },
    }).ok,
    false,
  );
  assert.equal(
    validateSchemaDefinition({ ...GOOD_SCHEMA, required: "maxItems" }).ok,
    false,
  );
});

test("number type accepts integers; integer type rejects floats in config", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ratio: { type: "number", minimum: 0, maximum: 1 },
      count: { type: "integer" },
    },
  };
  assert.deepEqual(validateSchemaDefinition(schema), { ok: true, errors: [] });

  const ok = validateConfigAgainstSchema({ ratio: 1, count: 3 }, schema);
  assert.equal(ok.ok, true);

  assert.equal(validateConfigAgainstSchema({ count: 3.5 }, schema).ok, false);
});

test("array config values must be arrays of strings", () => {
  const ok = validateConfigAgainstSchema(
    { maxItems: 5, postTypes: ["note", "article"] },
    GOOD_SCHEMA,
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.postTypes, ["note", "article"]);

  assert.equal(
    validateConfigAgainstSchema({ maxItems: 5, postTypes: ["note", 7] }, GOOD_SCHEMA).ok,
    false,
  );
  assert.equal(
    validateConfigAgainstSchema({ maxItems: 5, postTypes: "note" }, GOOD_SCHEMA).ok,
    false,
  );
});

test("non-object configs are treated as empty (required still enforced)", () => {
  for (const bad of [null, undefined, "config", 42, ["x"]]) {
    const result = validateConfigAgainstSchema(bad, GOOD_SCHEMA);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /required/);
  }
});

test("defaults never satisfy required — explicit value needed", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { maxItems: { type: "integer", default: 10 } },
    required: ["maxItems"],
  };
  const result = validateConfigAgainstSchema({}, schema);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /required/);
  // default is still applied to the (rejected) value for diagnostics
  assert.equal(result.value.maxItems, 10);
});

test("boolean false and empty string are valid config values (no falsy traps)", () => {
  const result = validateConfigAgainstSchema(
    { maxItems: 5, enabled: false, title: "" },
    GOOD_SCHEMA,
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.enabled, false);
  assert.equal(result.value.title, "");
});
