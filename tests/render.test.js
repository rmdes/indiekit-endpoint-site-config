import { test } from "node:test";
import assert from "node:assert/strict";
import { renderThemeCss } from "../lib/render/write-theme-css.js";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";

test("renderThemeCss includes all surface scale entries", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  for (const key of [50, 100, 500, 950]) {
    assert.match(css, new RegExp(`--c-surface-${key}:`));
  }
});

test("renderThemeCss includes all brand tokens", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  for (const token of ["primary", "link", "focus", "success", "warning", "danger"]) {
    assert.match(css, new RegExp(`--c-${token}:`));
  }
});

test("renderThemeCss includes typography vars", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  assert.match(css, /--font-sans:/);
  assert.match(css, /--font-serif:/);
  assert.match(css, /--font-mono:/);
});

test("renderThemeCss writes rgb triplets without commas (Tailwind alpha-value pattern)", () => {
  const config = mergeWithDefaults({ branding: { colors: { primary: "#ff0000" } } });
  const css = renderThemeCss(config);
  assert.match(css, /--c-primary: 255 0 0;/);
});
