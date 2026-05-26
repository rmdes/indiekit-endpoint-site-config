import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS_HOMEPAGE } from "../lib/storage/defaults-homepage.js";

test("DEFAULTS_HOMEPAGE has top-level keys", () => {
  for (const k of ["layout", "hero", "sections", "sidebar",
                   "blogListingSidebar", "blogPostSidebar", "footer"]) {
    assert.ok(k in DEFAULTS_HOMEPAGE, `missing key: ${k}`);
  }
});

test("DEFAULTS_HOMEPAGE.layout is 'two-column'", () => {
  assert.equal(DEFAULTS_HOMEPAGE.layout, "two-column");
});

test("DEFAULTS_HOMEPAGE.hero defaults to enabled with social", () => {
  assert.equal(DEFAULTS_HOMEPAGE.hero.enabled, true);
  assert.equal(DEFAULTS_HOMEPAGE.hero.showSocial, true);
});

test("DEFAULTS_HOMEPAGE.sections seeds a single recent-posts section", () => {
  assert.equal(DEFAULTS_HOMEPAGE.sections.length, 1);
  assert.equal(DEFAULTS_HOMEPAGE.sections[0].type, "recent-posts");
});

test("DEFAULTS_HOMEPAGE.sidebar seeds three widgets", () => {
  assert.equal(DEFAULTS_HOMEPAGE.sidebar.length, 3);
  assert.deepEqual(
    DEFAULTS_HOMEPAGE.sidebar.map((w) => w.type),
    ["author-card", "recent-posts", "categories"]
  );
});

test("DEFAULTS_HOMEPAGE.blogListingSidebar and .blogPostSidebar are empty arrays", () => {
  assert.deepEqual(DEFAULTS_HOMEPAGE.blogListingSidebar, []);
  assert.deepEqual(DEFAULTS_HOMEPAGE.blogPostSidebar, []);
});
