import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTier2Defaults,
  applyOverrides,
} from "../lib/render/resolve-tier2.js";
import { SURFACE_PRESETS } from "../lib/render/surface-presets.js";
import { derivePaletteFromBase } from "../lib/render/derive-palette.js";
import { ROLE_KEYS, emptyRoles } from "../lib/storage/defaults-site.js";

const warmStone = SURFACE_PRESETS["warm-stone"];
const amber = derivePaletteFromBase("#b45309");

// ─── resolveTier2Defaults — light mode ──────────────────────────────────

test("resolveTier2Defaults(light) maps bg → surface-50", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.bg, warmStone[50]);
});

test("resolveTier2Defaults(light) maps fg → surface-700, fgMuted → surface-600", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.fg, warmStone[700]);
  assert.equal(r.fgMuted, warmStone[600]);
});

test("resolveTier2Defaults(light) maps heading → surface-900", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.heading, warmStone[900]);
});

test("resolveTier2Defaults(light) maps link/action → accent-600", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.link, amber[600]);
  assert.equal(r.action, amber[600]);
});

test("resolveTier2Defaults(light) maps surface (panel) → surface-100, border → surface-200", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.surface, warmStone[100]);
  assert.equal(r.border, warmStone[200]);
});

test("resolveTier2Defaults(light) maps focus → accent-500", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.focus, amber[500]);
});

test("resolveTier2Defaults(light) maps actionFg → surface-50 (light text on dark action)", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  assert.equal(r.actionFg, warmStone[50]);
});

// ─── resolveTier2Defaults — dark mode ───────────────────────────────────

test("resolveTier2Defaults(dark) maps bg → surface-950, heading → surface-100", () => {
  const r = resolveTier2Defaults(warmStone, amber, "dark");
  assert.equal(r.bg, warmStone[950]);
  assert.equal(r.heading, warmStone[100]);
});

test("resolveTier2Defaults(dark) maps link → accent-400, action → accent-500", () => {
  const r = resolveTier2Defaults(warmStone, amber, "dark");
  assert.equal(r.link, amber[400]);
  assert.equal(r.action, amber[500]);
});

test("resolveTier2Defaults(dark) maps surface → surface-800, border → surface-700", () => {
  const r = resolveTier2Defaults(warmStone, amber, "dark");
  assert.equal(r.surface, warmStone[800]);
  assert.equal(r.border, warmStone[700]);
});

test("resolveTier2Defaults(dark) maps focus → accent-400", () => {
  const r = resolveTier2Defaults(warmStone, amber, "dark");
  assert.equal(r.focus, amber[400]);
});

test("resolveTier2Defaults returns object with all 10 role keys", () => {
  const r = resolveTier2Defaults(warmStone, amber, "light");
  for (const role of ROLE_KEYS) {
    assert.ok(r[role], `Missing role "${role}" in resolved defaults`);
  }
});

test("resolveTier2Defaults throws on unknown modeKey", () => {
  assert.throws(
    () => resolveTier2Defaults(warmStone, amber, "twilight"),
    /unknown modeKey/,
  );
});

// ─── applyOverrides ─────────────────────────────────────────────────────

test("applyOverrides leaves defaults untouched when roles is empty", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "light");
  const result = applyOverrides(defaults, emptyRoles(), "light");
  for (const role of ROLE_KEYS) {
    assert.equal(result[role], defaults[role]);
  }
});

test("applyOverrides leaves defaults untouched when roles is null/undefined", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "light");
  assert.deepEqual(applyOverrides(defaults, null, "light"), defaults);
  assert.deepEqual(applyOverrides(defaults, undefined, "light"), defaults);
});

test("applyOverrides replaces a single role's value for the matching mode", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "light");
  const roles = { ...emptyRoles(), heading: { light: "#ff0000", dark: "#00ff00" } };
  const result = applyOverrides(defaults, roles, "light");
  assert.equal(result.heading, "#ff0000");
  // Other roles untouched
  assert.equal(result.bg, defaults.bg);
});

test("applyOverrides uses the dark half when modeKey=dark", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "dark");
  const roles = { ...emptyRoles(), heading: { light: "#ff0000", dark: "#00ff00" } };
  const result = applyOverrides(defaults, roles, "dark");
  assert.equal(result.heading, "#00ff00");
});

test("applyOverrides does not mutate the defaults input", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "light");
  const snapshot = { ...defaults };
  const roles = { ...emptyRoles(), heading: { light: "#ff0000", dark: "#00ff00" } };
  applyOverrides(defaults, roles, "light");
  assert.deepEqual(defaults, snapshot, "defaults should not be mutated");
});

test("applyOverrides silently ignores invalid override hex (keeps default)", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "light");
  const roles = { ...emptyRoles(), heading: { light: "not-hex", dark: "#00ff00" } };
  const result = applyOverrides(defaults, roles, "light");
  assert.equal(result.heading, defaults.heading);
});

test("applyOverrides handles null entries (inherits)", () => {
  const defaults = resolveTier2Defaults(warmStone, amber, "light");
  const roles = { ...emptyRoles(), heading: null };
  const result = applyOverrides(defaults, roles, "light");
  assert.equal(result.heading, defaults.heading);
});
