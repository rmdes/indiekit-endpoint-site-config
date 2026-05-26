import { test } from "node:test";
import assert from "node:assert/strict";
import { getHomepageConfig, mergeWithHomepageDefaults } from "../lib/storage/get-homepage-config.js";
import { saveHomepageConfig } from "../lib/storage/save-homepage-config.js";

// In-memory MongoDB stub
function makeIndiekitStub(initialDoc = null) {
  let doc = initialDoc;
  return {
    database: {
      collection() {
        return {
          async findOne() { return doc; },
          async replaceOne(_filter, newDoc) { doc = newDoc; return { acknowledged: true }; },
        };
      },
    },
  };
}

test("mergeWithHomepageDefaults overlays input on defaults", () => {
  const merged = mergeWithHomepageDefaults({ layout: "single-column" });
  assert.equal(merged.layout, "single-column");
  assert.equal(merged.hero.enabled, true); // from defaults
});

test("getHomepageConfig returns defaults when no DB", async () => {
  const config = await getHomepageConfig({ database: null });
  assert.equal(config.layout, "two-column");
});

test("getHomepageConfig returns defaults when document missing", async () => {
  const Indiekit = makeIndiekitStub(null);
  const config = await getHomepageConfig(Indiekit);
  assert.equal(config.layout, "two-column");
});

test("getHomepageConfig merges existing document with defaults", async () => {
  const Indiekit = makeIndiekitStub({
    _id: "homepage",
    layout: "full-width-hero",
    sections: [{ type: "hero", config: {} }],
  });
  const config = await getHomepageConfig(Indiekit);
  assert.equal(config.layout, "full-width-hero");
  assert.equal(config.sections.length, 1);
  assert.equal(config.hero.enabled, true); // still from defaults
});

test("saveHomepageConfig records updatedAt and persists patch", async () => {
  const Indiekit = makeIndiekitStub(null);
  const result = await saveHomepageConfig(Indiekit, { layout: "single-column" }, "test-user");
  assert.equal(result.layout, "single-column");
  assert.ok(result.updatedAt);
  assert.equal(result.updatedBy, "test-user");
});

test("saveHomepageConfig throws when no DB", async () => {
  await assert.rejects(
    () => saveHomepageConfig({ database: null }, {}, "u"),
    /Database not configured/
  );
});
