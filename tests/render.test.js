import { test } from "node:test";
import assert from "node:assert/strict";
import { renderThemeCss } from "../lib/render/write-theme-css.js";
import { renderSiteJson } from "../lib/render/write-site-json.js";
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

test("renderThemeCss emits CSS generic keywords unquoted", () => {
  const config = mergeWithDefaults({
    branding: { typography: { mono: "ui-monospace", sans: "system-ui" } },
  });
  const css = renderThemeCss(config);
  assert.match(css, /--font-mono: {2}ui-monospace,/);
  assert.match(css, /--font-sans: {2}system-ui,/);
  assert.doesNotMatch(css, /--font-mono: {2}"ui-monospace"/);
  assert.doesNotMatch(css, /--font-sans: {2}"system-ui"/);
});

test("renderThemeCss emits named fonts quoted", () => {
  const config = mergeWithDefaults({
    branding: { typography: { sans: "Inter", serif: "Fraunces" } },
  });
  const css = renderThemeCss(config);
  assert.match(css, /--font-sans: {2}"Inter",/);
  assert.match(css, /--font-serif: "Fraunces",/);
});

test("renderThemeCss tolerates null/invalid brand colors via 0 0 0 fallback", () => {
  // Pass null through the merge so we exercise hexToRgbTriplet's fallback path
  // without mutating frozen DEFAULTS substructures.
  const config = mergeWithDefaults({ branding: { colors: { primary: null } } });
  const css = renderThemeCss(config);
  assert.match(css, /--c-primary: 0 0 0;/);
});

test("renderSiteJson emits the structure Eleventy templates expect", () => {
  const config = mergeWithDefaults({
    identity: { name: "rmendes.net", description: "Personal site" },
  });
  const json = JSON.parse(renderSiteJson(config));
  assert.equal(json.identity.name, "rmendes.net");
  assert.equal(json.branding.typography.sans, "Inter");
  assert.deepEqual(typeof json.layout, "object");
  assert.deepEqual(typeof json.features, "object");
});

test("renderSiteJson strips updatedBy but keeps updatedAt", () => {
  const config = mergeWithDefaults({ identity: { name: "test" } });
  // Simulate a saved config that has both updatedBy (PII) and updatedAt (safe timestamp)
  const configWithMeta = {
    ...config,
    updatedBy: "user@example.com",
    updatedAt: "2026-01-15T12:00:00.000Z",
  };
  const json = JSON.parse(renderSiteJson(configWithMeta));
  assert.equal(json.updatedBy, undefined, "updatedBy (PII) must be stripped");
  assert.equal(json.updatedAt, "2026-01-15T12:00:00.000Z", "updatedAt must be kept");
});
