import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";
import { validBlockEntry } from "../lib/discovery/block-entry.js";
import { BUILTIN_SECTIONS } from "../lib/presets/builtin-sections.js";
import { BUILTIN_WIDGETS } from "../lib/presets/builtin-widgets.js";
import { BUILTIN_BLOG_POST_WIDGETS } from "../lib/presets/builtin-blog-post-widgets.js";

test("every built-in block entry passes the strict validBlockEntry gate", () => {
  for (const entry of BUILTIN_BLOCKS) {
    const result = validBlockEntry(entry);
    assert.equal(result.ok, true, `${entry.id}: ${result.errors.join("; ")}`);
  }
});

test("catalog ids exactly cover the legacy built-in ids (drift guard, both directions)", () => {
  const legacyIds = new Set(
    [...BUILTIN_SECTIONS, ...BUILTIN_WIDGETS, ...BUILTIN_BLOG_POST_WIDGETS].map(
      (e) => e.id,
    ),
  );
  const catalogIds = new Set(BUILTIN_BLOCKS.map((e) => e.id));
  assert.deepEqual(
    [...catalogIds].sort(),
    [...legacyIds].sort(),
    "builtin-blocks.js must mirror the legacy built-ins 1:1 — if a legacy built-in was added/removed, update the catalog (and vice versa)",
  );
  assert.equal(
    BUILTIN_BLOCKS.length,
    catalogIds.size,
    "duplicate id inside BUILTIN_BLOCKS",
  );
});

test("merged dual-origin entries carry both regions", () => {
  const recentPosts = BUILTIN_BLOCKS.find((e) => e.id === "recent-posts");
  assert.deepEqual([...recentPosts.placement.regions].sort(), ["main", "sidebar"]);
});

test("every legacy configSchema field survives into the catalog schema (no dropped fields)", () => {
  // Union field names per id across all three legacy arrays — this handles
  // the four dual-origin merges (recent-posts, custom-html, ai-usage,
  // recent-comments) automatically.
  const legacyFields = new Map();
  for (const entry of [
    ...BUILTIN_SECTIONS,
    ...BUILTIN_WIDGETS,
    ...BUILTIN_BLOG_POST_WIDGETS,
  ]) {
    const fields = legacyFields.get(entry.id) ?? new Set();
    for (const name of Object.keys(entry.configSchema ?? {})) fields.add(name);
    legacyFields.set(entry.id, fields);
  }
  for (const [id, fields] of legacyFields) {
    const catalogEntry = BUILTIN_BLOCKS.find((e) => e.id === id);
    assert.ok(catalogEntry, `no catalog entry for legacy id "${id}"`);
    for (const field of fields) {
      assert.ok(
        Object.hasOwn(catalogEntry.schema.properties, field),
        `${id}: legacy configSchema field "${field}" dropped from catalog schema`,
      );
    }
  }
});

test("no schema uses required (legacy configs may omit anything; migration must not fail)", () => {
  for (const entry of BUILTIN_BLOCKS) {
    assert.ok(
      !("required" in entry.schema),
      `${entry.id}: schema must not use required`,
    );
    // Belt-and-braces: even if required is ever introduced, it must never
    // be combined with a default on the same property.
    for (const name of entry.schema.required ?? []) {
      assert.ok(
        !("default" in (entry.schema.properties[name] ?? {})),
        `${entry.id}: "${name}" combines required with default`,
      );
    }
  }
});

test("recent-posts maxItems default is the main/section variant value, within encoded bounds", () => {
  const recentPosts = BUILTIN_BLOCKS.find((e) => e.id === "recent-posts");
  const def = recentPosts.schema.properties.maxItems;
  assert.equal(def.type, "integer");
  assert.equal(def.default, 10, "section variant default (10) wins over widget (5)");
  assert.equal(def.minimum, 1);
  assert.equal(def.maximum, 50, "global maxItems cap is encoded in the schema");
  assert.ok(def.default >= def.minimum && def.default <= def.maximum);
});

test("table conformance spot checks", () => {
  const byId = new Map(BUILTIN_BLOCKS.map((e) => [e.id, e]));

  const hero = byId.get("hero");
  assert.equal(hero.multiple, false);
  assert.deepEqual([...hero.placement.regions], ["hero"]);
  assert.deepEqual([...hero.placement.surfaces].sort(), ["homepage", "standalone"]);
  assert.equal(hero.data.source, "config");
  assert.ok(!("render" in hero), "hero is bespoke — render must be omitted");

  const subscribe = byId.get("subscribe");
  assert.deepEqual([...subscribe.placement.regions], ["sidebar", "footer"]);
  assert.deepEqual([...subscribe.placement.surfaces].sort(), ["homepage", "postType"]);
  assert.equal(subscribe.multiple, false);

  const featuredPosts = byId.get("featured-posts");
  assert.deepEqual(featuredPosts.data, { source: "collections", key: "featuredPosts" });
  assert.equal(featuredPosts.render.renderer, "feed");

  const categories = byId.get("categories");
  assert.deepEqual(categories.data, { source: "collections", key: "categories" });
  assert.equal(categories.render.renderer, "tag-cloud");

  const postingActivity = byId.get("posting-activity");
  assert.deepEqual(postingActivity.data, { source: "collections", key: "posts" });
  assert.ok(!("render" in postingActivity), "posting-activity is bespoke");

  const customHtml = byId.get("custom-html");
  assert.equal(customHtml.render.renderer, "prose");
  assert.equal(customHtml.schema.properties.content["x-control"], "markdown");
  assert.equal(customHtml.schema.properties.content.maxLength, 20_000);

  const socialActivity = byId.get("social-activity");
  assert.deepEqual(socialActivity.data, { source: "api" });
});

test("catalog invariants: version 1, deep-frozen, multiple declared on every entry", () => {
  assert.ok(Object.isFrozen(BUILTIN_BLOCKS), "BUILTIN_BLOCKS array must be frozen");
  for (const entry of BUILTIN_BLOCKS) {
    assert.equal(entry.version, 1, `${entry.id}: version must be 1`);
    assert.equal(typeof entry.multiple, "boolean", `${entry.id}: multiple missing`);
    assert.ok(Object.isFrozen(entry), `${entry.id}: entry must be frozen`);
    assert.ok(Object.isFrozen(entry.schema), `${entry.id}: schema must be frozen`);
    assert.ok(
      Object.isFrozen(entry.schema.properties),
      `${entry.id}: schema.properties must be frozen`,
    );
    assert.ok(Object.isFrozen(entry.placement), `${entry.id}: placement must be frozen`);
    assert.ok(Object.isFrozen(entry.data), `${entry.id}: data must be frozen`);
  }
});
