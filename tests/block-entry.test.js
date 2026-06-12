import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validBlockEntry, synthesizeLegacyEntry, convertMiniDsl,
  REGIONS, SURFACES, DATA_SOURCES, GENERIC_RENDERERS,
} from "../lib/discovery/block-entry.js";
import { validateSchemaDefinition } from "../lib/validators/block-schema.js";

const GOOD_BLOCK = {
  id: "github-repos",
  version: 1,
  label: "GitHub Projects",
  description: "Repos and commits",
  icon: "github",
  category: "social",
  placement: { regions: ["sidebar", "main"], surfaces: ["homepage", "collection"] },
  multiple: true,
  schema: { type: "object", additionalProperties: false, properties: {} },
  data: { source: "api" },
};

test("accepts a complete v2 block entry", () => {
  assert.equal(validBlockEntry(GOOD_BLOCK).ok, true);
});

test("rejects entries the legacy {id,label} check would have passed", () => {
  const r = validBlockEntry({ id: "x", label: "X" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /version/);
  assert.match(r.errors.join(" "), /schema/);
  assert.match(r.errors.join(" "), /regions/);
  assert.match(r.errors.join(" "), /data\.source/);
});

test("rejects bad ids, regions, sources, renderers", () => {
  for (const patch of [
    { id: "Bad_Id" },
    { id: "-leading" },
    { placement: { regions: [] } },
    { placement: { regions: ["nav"] } },
    { placement: { regions: ["main"], surfaces: ["everywhere"] } },
    { data: { source: "telepathy" } },
    { data: { source: "file" } },                       // file source requires data.file
    { version: 0 },                                     // declared entries start at 1
    { render: { renderer: "carousel" } },               // not one of the 10
    { schema: { type: "object", properties: {} } },     // fails meta-validation (no additionalProperties)
  ]) {
    assert.equal(validBlockEntry({ ...GOOD_BLOCK, ...patch }).ok, false, JSON.stringify(patch));
  }
});

test("aliases must be an array of kebab ids when present", () => {
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, aliases: ["old-name"] }).ok, true);
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, aliases: "old-name" }).ok, false);
});

test("convertMiniDsl maps every legacy field type", () => {
  const schema = convertMiniDsl({
    maxItems: { type: "number", label: "Max items", min: 1, max: 50 },
    title: { type: "text", label: "Title" },
    content: { type: "textarea", label: "Content" },
    enabled: { type: "boolean", label: "On" },
    postTypes: { type: "array", label: "Types" },
  });
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.maxItems, { type: "number", title: "Max items", minimum: 1, maximum: 50 });
  assert.deepEqual(schema.properties.title, { type: "string", title: "Title", maxLength: 200 });
  assert.deepEqual(schema.properties.content, { type: "string", title: "Content", maxLength: 20000, "x-control": "textarea" });
  assert.deepEqual(schema.properties.enabled, { type: "boolean", title: "On" });
  assert.deepEqual(schema.properties.postTypes, { type: "array", title: "Types", items: { type: "string" } });
});

test("synthesizeLegacyEntry derives placement from getter origin and is catalog-shaped", () => {
  const legacy = { id: "cv-experience", label: "Experience", description: "Work history",
    icon: "briefcase", defaultConfig: { maxItems: 5 },
    configSchema: { maxItems: { type: "number", label: "Max", min: 1, max: 20 } },
    sourcePlugin: "CV endpoint" };
  const entry = synthesizeLegacyEntry(legacy, "homepageSections");
  assert.equal(entry.version, 0);
  assert.equal(entry.legacy, true);
  assert.deepEqual(entry.placement.regions, ["main"]);
  assert.equal(entry.schema.additionalProperties, false);
  assert.deepEqual(entry.defaultConfig, { maxItems: 5 });
  const widget = synthesizeLegacyEntry(legacy, "homepageWidgets");
  assert.deepEqual(widget.placement.regions, ["sidebar"]);
  const blogWidget = synthesizeLegacyEntry(legacy, "blogPostWidgets");
  assert.deepEqual(blogWidget.placement.regions, ["sidebar"]);
  assert.deepEqual(blogWidget.placement.surfaces, ["postType"]);
});

// --- Additional coverage beyond the plan-mandated tests ---

test("rejects non-object entries outright", () => {
  for (const bad of [null, undefined, "github-repos", 42, ["x"]]) {
    const r = validBlockEntry(bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.errors.length > 0, true);
  }
});

test("accepted entries report zero errors; rejected entries name every failure", () => {
  const good = validBlockEntry(GOOD_BLOCK);
  assert.deepEqual(good.errors, []);
  // multiple defects → multiple distinct errors, not just the first
  const r = validBlockEntry({ ...GOOD_BLOCK, id: "Bad", version: 0, label: "" });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length >= 3, true, r.errors.join("; "));
});

test("collections source requires data.key; valid render.renderer accepted", () => {
  assert.equal(
    validBlockEntry({ ...GOOD_BLOCK, data: { source: "collections" } }).ok,
    false,
  );
  assert.equal(
    validBlockEntry({ ...GOOD_BLOCK, data: { source: "collections", key: "articles" } }).ok,
    true,
  );
  assert.equal(
    validBlockEntry({ ...GOOD_BLOCK, data: { source: "file", file: "github.json" } }).ok,
    true,
  );
  assert.equal(
    validBlockEntry({ ...GOOD_BLOCK, render: { renderer: "cards" } }).ok,
    true,
  );
});

test("multiple must be boolean when present; empty aliases array allowed", () => {
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, multiple: "yes" }).ok, false);
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, aliases: [] }).ok, true);
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, aliases: ["Bad_Alias"] }).ok, false);
});

test("exported vocabulary sets are populated", () => {
  assert.equal(REGIONS.has("main"), true);
  assert.equal(SURFACES.has("postType"), true);
  assert.equal(DATA_SOURCES.has("config"), true);
  assert.equal(GENERIC_RENDERERS.size, 10);
});

test("convertMiniDsl skips reserved property names with a warning", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  // JSON.parse creates "__proto__" as an OWN key (unlike object literals)
  const malicious = JSON.parse(
    '{"__proto__": {"type": "text", "label": "evil"}, "constructor": {"type": "text"}, "safe": {"type": "text", "label": "Safe"}}',
  );
  const schema = convertMiniDsl(malicious);
  assert.equal(Object.hasOwn(schema.properties, "__proto__"), false);
  assert.equal(Object.hasOwn(schema.properties, "constructor"), false);
  assert.equal(Object.hasOwn(schema.properties, "safe"), true);
  // no prototype pollution leaked into plain objects
  assert.equal({}.type, undefined);
  assert.equal(warn.mock.callCount() >= 2, true);
  // result still passes the strict walker
  assert.equal(validateSchemaDefinition(schema).ok, true);
});

test("convertMiniDsl tolerates null/non-object configSchema and skips junk fields", () => {
  for (const bad of [null, undefined, "nope", 42, ["x"]]) {
    const schema = convertMiniDsl(bad);
    assert.deepEqual(schema, { type: "object", additionalProperties: false, properties: {} });
  }
  const schema = convertMiniDsl({ junk: null, alsoJunk: "string", ok: { type: "boolean" } });
  assert.deepEqual(Object.keys(schema.properties), ["ok"]);
});

test("convertMiniDsl output always passes validateSchemaDefinition", () => {
  const schema = convertMiniDsl({
    n: { type: "number", min: 0, max: 10 },
    t: { type: "text", label: "T" },
    ta: { type: "textarea" },
    b: { type: "boolean" },
    a: { type: "array" },
    weird: { type: "select" }, // unrecognized degrades to bounded string
  });
  const result = validateSchemaDefinition(schema);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(schema.properties.weird, { type: "string", maxLength: 200 });
});

test("synthesizeLegacyEntry returns fresh placement objects per call", () => {
  const legacy = { id: "cv-skills", label: "Skills", sourcePlugin: "CV endpoint" };
  const a = synthesizeLegacyEntry(legacy, "homepageSections");
  const b = synthesizeLegacyEntry(legacy, "homepageSections");
  assert.notEqual(a.placement, b.placement);
  assert.notEqual(a.placement.regions, b.placement.regions);
  a.placement.regions.push("sidebar");
  a.placement.surfaces.push("standalone");
  assert.deepEqual(b.placement.regions, ["main"]);
  assert.deepEqual(b.placement.surfaces, ["homepage"]);
});

test("renderer error message enumerates the allowed renderers", () => {
  const r = validBlockEntry({ ...GOOD_BLOCK, render: { renderer: "carousel" } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), new RegExp([...GENERIC_RENDERERS].join("\\|")));
});

test("convertMiniDsl drops non-finite min/max so output stays walker-valid", () => {
  const schema = convertMiniDsl({
    n: { type: "number", min: NaN },
    m: { type: "number", min: -Infinity, max: Infinity },
  });
  assert.deepEqual(schema.properties.n, { type: "number" });
  assert.deepEqual(schema.properties.m, { type: "number" });
  const result = validateSchemaDefinition(schema);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("synthesizeLegacyEntry clones defaultConfig — no reference sharing or bleed", () => {
  const input = { maxItems: 5, tags: ["a", "b"] };
  const legacy = { id: "cv-skills", label: "Skills", defaultConfig: input };
  const entry = synthesizeLegacyEntry(legacy, "homepageSections");
  assert.notEqual(entry.defaultConfig, input);
  assert.notEqual(entry.defaultConfig.tags, input.tags);
  assert.deepEqual(entry.defaultConfig, input);
  entry.defaultConfig.maxItems = 99;
  entry.defaultConfig.tags.push("c");
  assert.equal(input.maxItems, 5);
  assert.deepEqual(input.tags, ["a", "b"]);
  // unclonable defaultConfig degrades to {} instead of throwing
  const weird = synthesizeLegacyEntry(
    { id: "x-y", label: "X", defaultConfig: { fn: () => {} } },
    "homepageSections",
  );
  assert.deepEqual(weird.defaultConfig, {});
});

test("synthesizeLegacyEntry falls back to default placement for unknown origins", () => {
  const entry = synthesizeLegacyEntry({ id: "x-y", label: "X" }, "somethingElse");
  assert.deepEqual(entry.placement, { regions: ["main"], surfaces: ["homepage"] });
});

test("synthesizeLegacyEntry defaults optional fields and keeps catalog shape", () => {
  const entry = synthesizeLegacyEntry({ id: "bare-block", label: "Bare" }, "homepageWidgets");
  assert.equal(entry.description, "");
  assert.equal(entry.icon, "");
  assert.equal(entry.category, "plugin");
  assert.equal(entry.multiple, true);
  assert.deepEqual(entry.defaultConfig, {});
  assert.deepEqual(entry.data, { source: "config" });
  assert.equal(entry.sourcePlugin, undefined);
  assert.equal(validateSchemaDefinition(entry.schema).ok, true);
});
