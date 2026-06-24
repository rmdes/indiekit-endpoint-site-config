import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validBlockEntry,
  REGIONS, SURFACES, DATA_SOURCES, GENERIC_RENDERERS,
} from "../lib/discovery/block-entry.js";

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

test("defaultConfig must validate against the entry's own schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      maxItems: { type: "integer", title: "Max items", minimum: 1, maximum: 50 },
    },
  };
  // Valid defaultConfig passes
  assert.equal(
    validBlockEntry({ ...GOOD_BLOCK, schema, defaultConfig: { maxItems: 5 } }).ok,
    true,
  );
  // Absent defaultConfig is fine (builtins omit it)
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, schema }).ok, true);
  // Unknown key, type mismatch, constraint violation, non-object — all rejected
  for (const defaultConfig of [
    { unknown: 1 },        // unknown config key
    { maxItems: "five" },  // type mismatch
    { maxItems: 999 },     // violates maximum
    "evil",                // non-object (validateConfigAgainstSchema leniency bypass)
    ["evil"],              // array
    null,                  // null
  ]) {
    const r = validBlockEntry({ ...GOOD_BLOCK, schema, defaultConfig });
    assert.equal(r.ok, false, JSON.stringify(defaultConfig));
    assert.match(r.errors.join(" "), /defaultConfig does not validate against schema/);
  }
});

test("aliases must be an array of kebab ids when present", () => {
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, aliases: ["old-name"] }).ok, true);
  assert.equal(validBlockEntry({ ...GOOD_BLOCK, aliases: "old-name" }).ok, false);
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

test("renderer error message enumerates the allowed renderers", () => {
  const r = validBlockEntry({ ...GOOD_BLOCK, render: { renderer: "carousel" } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), new RegExp([...GENERIC_RENDERERS].join("\\|")));
});

