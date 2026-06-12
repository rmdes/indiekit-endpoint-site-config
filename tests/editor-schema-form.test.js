import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaToFields, parseConfigBody } from "../lib/editor/schema-form.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

const blockSchema = (id) => BUILTIN_BLOCKS.find((b) => b.id === id).schema;

// No builtin schema uses enum or x-advanced (verified by grep) — fixture
// schema exercising every control of the frozen subset.
const FIXTURE = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", title: "Title", maxLength: 50 },
    body: { type: "string", title: "Body", "x-control": "textarea", description: "Long text" },
    prose: { type: "string", "x-control": "markdown" },
    tint: { type: "string", title: "Tint", "x-control": "color" },
    style: { type: "string", title: "Style", enum: ["grid", "list"], default: "grid" },
    count: { type: "integer", title: "Count", minimum: 1, maximum: 50, default: 6 },
    ratio: { type: "number", title: "Ratio" },
    enabled: { type: "boolean", title: "Enabled", default: true },
    tags: { type: "array", title: "Tags", items: { type: "string" } },
    debugMode: { type: "boolean", title: "Debug mode", "x-advanced": true },
  },
};

// ---- schemaToFields ----

test("schemaToFields maps every frozen-subset type to its control", () => {
  const fields = schemaToFields(FIXTURE, { advanced: true });
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.title.type, "text");
  assert.equal(byName.body.type, "textarea");
  assert.equal(byName.prose.type, "markdown");
  assert.equal(byName.tint.type, "color");
  assert.equal(byName.style.type, "select");
  assert.deepEqual(byName.style.options, ["grid", "list"]);
  assert.equal(byName.count.type, "number");
  assert.equal(byName.ratio.type, "number");
  assert.equal(byName.enabled.type, "checkbox");
  assert.equal(byName.tags.type, "tags");
});

test("schemaToFields carries label/hint/bounds/default and preserves schema order", () => {
  const fields = schemaToFields(FIXTURE, { advanced: true });
  assert.deepEqual(fields.map((f) => f.name), Object.keys(FIXTURE.properties));
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.title.label, "Title");
  assert.equal(byName.prose.label, "prose"); // no title → name
  assert.equal(byName.body.hint, "Long text");
  assert.equal(byName.title.maxLength, 50);
  assert.equal(byName.count.minimum, 1);
  assert.equal(byName.count.maximum, 50);
  assert.equal(byName.count.default, 6);
  assert.equal(byName.enabled.default, true);
});

test("schemaToFields filters x-advanced fields out by default, includes + flags them when advanced", () => {
  const basic = schemaToFields(FIXTURE);
  assert.equal(basic.some((f) => f.name === "debugMode"), false);
  assert.ok(basic.every((f) => f.advanced === false));

  const advanced = schemaToFields(FIXTURE, { advanced: true });
  const debug = advanced.find((f) => f.name === "debugMode");
  assert.equal(debug.advanced, true);
  assert.equal(advanced.find((f) => f.name === "title").advanced, false);
});

test("schemaToFields works against the real hero builtin schema", () => {
  const fields = schemaToFields(blockSchema("hero"));
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.showSocial.type, "checkbox");
  assert.equal(byName.ctaText.type, "text");
  assert.equal(byName.ctaText.maxLength, 200);
});

// ---- parseConfigBody coercion ----

test("parseConfigBody: full round trip against the real recent-posts schema", () => {
  const result = parseConfigBody(
    { maxItems: "10", postTypes: "note, article", title: "" },
    blockSchema("recent-posts"),
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.config, { maxItems: 10, postTypes: ["note", "article"] });
});

test("parseConfigBody: number coercion, NaN → error", () => {
  const schema = blockSchema("recent-posts");
  assert.equal(parseConfigBody({ maxItems: "25" }, schema).config.maxItems, 25);
  const bad = parseConfigBody({ maxItems: "lots" }, schema);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /maxItems/.test(e)));
});

test("parseConfigBody: tags split on comma, trim, drop empties; array bodies accepted", () => {
  const schema = blockSchema("recent-posts");
  assert.deepEqual(
    parseConfigBody({ postTypes: " note ,, article , " }, schema).config.postTypes,
    ["note", "article"],
  );
  assert.deepEqual(
    parseConfigBody({ postTypes: ["note", " article ", ""] }, schema).config.postTypes,
    ["note", "article"],
  );
});

test("parseConfigBody: checkbox absent → explicit false for every declared boolean (hero showSocial)", () => {
  const result = parseConfigBody({ ctaText: "Hi" }, blockSchema("hero"));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.config.showSocial, false);
  assert.equal(result.config.showAvatar, false);
  assert.equal(result.config.showSocialLinks, false);
  assert.equal(result.config.ctaText, "Hi");
});

test("parseConfigBody: checkbox presence/'on'/'true' → true", () => {
  const schema = blockSchema("hero");
  for (const value of ["on", "true", true, ""]) {
    const result = parseConfigBody({ showSocial: value }, schema);
    assert.equal(result.config.showSocial, true, JSON.stringify(value));
  }
});

test("parseConfigBody: empty strings mean field omitted (non-boolean)", () => {
  const result = parseConfigBody({ ctaText: "", ctaUrl: "" }, blockSchema("hero"));
  assert.equal(result.ok, true);
  assert.equal("ctaText" in result.config, false);
  assert.equal("ctaUrl" in result.config, false);
});

test("parseConfigBody: unknown form fields are silently ignored (only schema names read)", () => {
  const result = parseConfigBody(
    { ctaText: "Go", csrfToken: "abc", _method: "POST" },
    blockSchema("hero"),
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal("csrfToken" in result.config, false);
  assert.equal("_method" in result.config, false);
});

test("parseConfigBody: schema validation verdict merged (bounds enforced after coercion)", () => {
  const result = parseConfigBody({ maxItems: "999" }, blockSchema("recent-posts"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /maximum/.test(e)));
});

test("parseConfigBody: enum select round-trip via fixture schema", () => {
  const good = parseConfigBody({ style: "list" }, FIXTURE);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.config.style, "list");
  const bad = parseConfigBody({ style: "mosaic" }, FIXTURE);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /style/.test(e)));
});

test("parseConfigBody: maxLength enforced via validation on pass-through text", () => {
  const result = parseConfigBody({ title: "x".repeat(51) }, FIXTURE);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /maxLength/.test(e)));
});

test("parseConfigBody: null/undefined body treated as empty (booleans still explicit)", () => {
  for (const body of [null, undefined, {}]) {
    const result = parseConfigBody(body, blockSchema("hero"));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.config, {
      showAvatar: false, showSocialLinks: false, showSocial: false,
    });
  }
});

test("parseConfigBody: coerced config carries NO materialized schema defaults (raw, gate-not-transformer)", () => {
  const result = parseConfigBody({}, blockSchema("recent-posts"));
  assert.equal(result.ok, true);
  // maxItems/postTypes declare defaults — the form layer must NOT bake them in.
  assert.deepEqual(result.config, {});
});
