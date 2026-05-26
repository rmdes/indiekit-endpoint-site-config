import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHomepageBody, parseEntryArray, detectActivePreset } from "../lib/controllers/homepage.js";

test("parseEntryArray handles JSON string from hidden input", () => {
  const json = JSON.stringify([{ type: "hero", config: {} }]);
  const result = parseEntryArray(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "hero");
});

test("parseEntryArray returns input array unchanged when already array", () => {
  const input = [{ type: "recent-posts", config: { maxItems: 10 } }];
  const result = parseEntryArray(input);
  assert.deepEqual(result, input);
});

test("parseEntryArray handles indexed object form", () => {
  const input = {
    "0": { type: "hero", config: {} },
    "1": { type: "recent-posts", config: {} },
  };
  const result = parseEntryArray(input);
  assert.equal(result.length, 2);
});

test("parseEntryArray returns empty array for missing/invalid", () => {
  assert.deepEqual(parseEntryArray(null), []);
  assert.deepEqual(parseEntryArray(undefined), []);
  assert.deepEqual(parseEntryArray("not json"), []);
});

test("parseHomepageBody extracts layout, hero, sections, sidebar, footer", () => {
  const body = {
    layout: "two-column",
    heroEnabled: "on",
    heroShowSocial: "on",
    sections: JSON.stringify([{ type: "hero", config: {} }]),
    sidebar: JSON.stringify([{ type: "search", config: {} }]),
    footer: JSON.stringify([]),
  };
  const result = parseHomepageBody(body);
  assert.equal(result.layout, "two-column");
  assert.equal(result.hero.enabled, true);
  assert.equal(result.hero.showSocial, true);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sidebar.length, 1);
  assert.deepEqual(result.footer, []);
});

test("parseHomepageBody hero unchecked checkbox = false", () => {
  const body = {
    layout: "single-column",
    sections: "[]", sidebar: "[]", footer: "[]",
  };
  const result = parseHomepageBody(body);
  assert.equal(result.hero.enabled, false);
  assert.equal(result.hero.showSocial, false);
});

test("parseHomepageBody coerces invalid layout to default", () => {
  const body = {
    layout: "spaceship",
    sections: "[]", sidebar: "[]", footer: "[]",
  };
  const result = parseHomepageBody(body);
  assert.equal(result.layout, "two-column");
});

test("detectActivePreset matches a config to a preset by layout+sections+sidebar", () => {
  const presets = [
    {
      id: "blog",
      layout: "two-column",
      sections: [{ type: "hero" }, { type: "recent-posts" }],
      sidebar: [{ type: "search" }, { type: "author-card" }],
    },
    {
      id: "cv",
      layout: "full-width-hero",
      sections: [{ type: "hero" }, { type: "cv-experience" }],
      sidebar: [{ type: "author-card" }],
    },
  ];
  const matching = {
    layout: "two-column",
    sections: [{ type: "hero" }, { type: "recent-posts" }],
    sidebar:  [{ type: "search" }, { type: "author-card" }],
  };
  assert.equal(detectActivePreset(matching, presets), "blog");
});

test("detectActivePreset returns null when no preset matches", () => {
  const presets = [{ id: "blog", layout: "two-column", sections: [{ type: "hero" }], sidebar: [] }];
  const custom = { layout: "single-column", sections: [{ type: "custom-html" }], sidebar: [] };
  assert.equal(detectActivePreset(custom, presets), null);
});
