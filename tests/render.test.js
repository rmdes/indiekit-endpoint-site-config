import { test } from "node:test";
import assert from "node:assert/strict";
import { renderThemeCss } from "../lib/render/write-theme-css.js";
import { renderSiteJson } from "../lib/render/write-site-json.js";
import { renderCriticalCss } from "../lib/render/write-critical-css.js";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";

// ─── theme.css generator (Tier 1) ───────────────────────────────────────

test("renderThemeCss includes all surface scale entries", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  for (const key of [50, 100, 500, 950]) {
    assert.match(css, new RegExp(`--c-surface-${key}:`));
  }
});

test("renderThemeCss includes all accent scale entries", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  for (const key of [50, 100, 500, 950]) {
    assert.match(css, new RegExp(`--c-accent-${key}:`));
  }
});

// ─── theme.css generator (Tier 2 — semantic roles) ──────────────────────

test("renderThemeCss emits all 10 Tier 2 semantic role variables", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  const tier2Vars = [
    "--c-bg",
    "--c-fg",
    "--c-fg-muted",
    "--c-heading",
    "--c-link",
    "--c-action",
    "--c-action-fg",
    "--c-surface:",
    "--c-border",
    "--c-focus",
  ];
  for (const v of tier2Vars) {
    assert.match(css, new RegExp(v.replace(/[-]/g, "[-]")));
  }
});

test("renderThemeCss Tier 2 defaults derive from palette (light mode = warm-stone defaults)", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const css = renderThemeCss(config);
  // bg (light) → surface-50 (warm-stone) = #faf8f5 = 250 248 245
  assert.match(css, /--c-bg:\s+250 248 245;/);
  // heading (light) → surface-900 = #1c1b19 = 28 27 25
  assert.match(css, /--c-heading:\s+28 27 25;/);
  // fg (light) → surface-700 = #3f3b35 = 63 59 53
  assert.match(css, /--c-fg:\s+63 59 53;/);
});

test("renderThemeCss role override (light) takes precedence over palette default", () => {
  const config = mergeWithDefaults({
    branding: {
      mode: "light",
      roles: { heading: { light: "#ff0000", dark: "#00ff00" } },
    },
  });
  const css = renderThemeCss(config);
  assert.match(css, /--c-heading:\s+255 0 0;/);
});

test("renderThemeCss role override (dark) takes precedence inside .dark block", () => {
  const config = mergeWithDefaults({
    branding: {
      mode: "auto",
      roles: { heading: { light: "#aaaaaa", dark: "#bbbbbb" } },
    },
  });
  const css = renderThemeCss(config);
  // The light value should be in :root (top), the dark in @media and .dark
  // 0xaa = 170, 0xbb = 187
  assert.match(css, /--c-heading:\s+170 170 170;/);
  assert.match(css, /--c-heading:\s+187 187 187;/);
});

// ─── theme.css generator (Tier 3 — fixed alerts) ────────────────────────

test("renderThemeCss emits Tier 3 alert tokens (success/warning/danger + -fg)", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  assert.match(css, /--c-success:\s+22 163 74;/);
  assert.match(css, /--c-warning:\s+202 138 4;/);
  assert.match(css, /--c-danger:\s+220 38 38;/);
  assert.match(css, /--c-success-fg:\s+255 255 255;/);
  assert.match(css, /--c-warning-fg:\s+28 25 23;/);
  assert.match(css, /--c-danger-fg:\s+255 255 255;/);
});

// ─── theme.css generator (mode handling) ────────────────────────────────

test("renderThemeCss mode=light emits only :root with no dark blocks", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const css = renderThemeCss(config);
  assert.match(css, /:root\s*\{/);
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /^\.dark\s*\{/m);
});

test("renderThemeCss mode=dark emits dark values in :root, no @media/.dark", () => {
  const config = mergeWithDefaults({ branding: { mode: "dark" } });
  const css = renderThemeCss(config);
  assert.match(css, /:root\s*\{/);
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)/);
  // bg (dark) → surface-950 = #0f0e0d = 15 14 13
  assert.match(css, /--c-bg:\s+15 14 13;/);
});

test("renderThemeCss mode=auto emits both @media and .dark blocks", () => {
  const config = mergeWithDefaults({ branding: { mode: "auto" } });
  const css = renderThemeCss(config);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{/);
  assert.match(css, /\.dark\s*\{/);
});

test("renderThemeCss default mode is auto (DEFAULTS.branding.mode)", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /\.dark\s*\{/);
});

// ─── theme.css generator (typography + formatting) ──────────────────────

test("renderThemeCss includes typography vars", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  assert.match(css, /--font-sans:/);
  assert.match(css, /--font-serif:/);
  assert.match(css, /--font-mono:/);
});

test("renderThemeCss writes rgb triplets without commas (Tailwind alpha-value pattern)", () => {
  const config = mergeWithDefaults({
    branding: {
      mode: "light",
      roles: { heading: { light: "#ff0000", dark: "#ff0000" } },
    },
  });
  const css = renderThemeCss(config);
  assert.match(css, /--c-heading:\s+255 0 0;/);
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

// ─── critical.css generator ─────────────────────────────────────────────

test("renderCriticalCss emits the layout shell", () => {
  const config = mergeWithDefaults({});
  const css = renderCriticalCss(config);
  assert.match(css, /\.container\s*\{/);
  assert.match(css, /\.skip-link/);
  assert.match(css, /prefers-reduced-motion/);
});

test("renderCriticalCss inlines body background/color from palette (mode=light)", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const css = renderCriticalCss(config);
  // warm-stone surface-50 (light bg) = #faf8f5 = rgb(250, 248, 245)
  assert.match(css, /body\{background-color:rgb\(250, 248, 245\)/);
});

test("renderCriticalCss mode=auto emits both @media and .dark blocks", () => {
  const config = mergeWithDefaults({ branding: { mode: "auto" } });
  const css = renderCriticalCss(config);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{/);
  assert.match(css, /\.dark body\{/);
});

test("renderCriticalCss honors role overrides", () => {
  const config = mergeWithDefaults({
    branding: {
      mode: "light",
      roles: { bg: { light: "#112233", dark: "#445566" } },
    },
  });
  const css = renderCriticalCss(config);
  // 0x11=17, 0x22=34, 0x33=51
  assert.match(css, /body\{background-color:rgb\(17, 34, 51\)/);
});

// ─── site-config.json writer ────────────────────────────────────────────

test("renderSiteJson emits the structure Eleventy templates expect", () => {
  const config = mergeWithDefaults({
    identity: { name: "rmendes.net", description: "Personal site" },
  });
  const json = JSON.parse(renderSiteJson(config));
  assert.equal(json.identity.name, "rmendes.net");
  assert.equal(json.branding.typography.sans, "Inter");
  assert.ok(json.navigation !== null && typeof json.navigation === "object");
  assert.ok(Array.isArray(json.navigation.items));
  assert.ok(json.features !== null && typeof json.features === "object");
});

test("renderSiteJson strips updatedBy but keeps updatedAt", () => {
  const config = mergeWithDefaults({ identity: { name: "test" } });
  const configWithMeta = {
    ...config,
    updatedBy: "user@example.com",
    updatedAt: "2026-01-15T12:00:00.000Z",
  };
  const json = JSON.parse(renderSiteJson(configWithMeta));
  assert.equal(json.updatedBy, undefined);
  assert.equal(json.updatedAt, "2026-01-15T12:00:00.000Z");
});

test("renderSiteJson preserves schemaVersion 3 in v3 schema", () => {
  const config = mergeWithDefaults({});
  const json = JSON.parse(renderSiteJson(config));
  assert.equal(json.schemaVersion, 3);
});
