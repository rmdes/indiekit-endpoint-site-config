/**
 * Branding controller tests (Theming v2 — Phase 2b).
 *
 * Focuses on the pure form parser `parseBrandingForm` plus the per-role
 * default computation. The HTTP layer is a thin wrapper around these — its
 * integration with MongoDB and the filesystem writers is exercised by the
 * existing render + storage tests (and the Cloudron smoke deploy).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBrandingForm,
  computeRoleDefaults,
  ACCENT_SUGGESTIONS,
  SURFACE_PRESET_OPTIONS,
} from "../lib/controllers/branding.js";
import { ROLE_KEYS } from "../lib/storage/defaults.js";

// ─── Form parsing — happy paths ────────────────────────────────────────

test("parseBrandingForm accepts a minimal valid body and emits a v2 patch", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    // All roles inherit
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    // Typography (controller requires curated values)
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.equal(result.patch.branding.surfacePreset, "warm-stone");
  assert.equal(result.patch.branding.accentBase, "#b45309");
  assert.equal(result.patch.branding.mode, "auto");
  for (const role of ROLE_KEYS) {
    assert.equal(result.patch.branding.roles[role], null, `role ${role} should be null (inherit)`);
  }
});

test("parseBrandingForm captures a Tier 2 role override and normalizes hex", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    // Heading is overridden (mixed case + 3-digit hex should normalize)
    roles_heading_light: "#001A33",
    roles_heading_dark: "#FFF",
    // Other roles inherit
    ...Object.fromEntries(
      ROLE_KEYS.filter((r) => r !== "heading").map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch.branding.roles.heading, {
    light: "#001a33",
    dark: "#ffffff",
  });
  assert.equal(result.patch.branding.roles.fg, null);
});

test("parseBrandingForm forward-compat: missing role fields preserve existing override", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
    // No role fields at all
  };
  const currentRoles = {
    heading: { light: "#001a33", dark: "#e6f0ff" },
    fg: null,
  };
  const result = parseBrandingForm(body, currentRoles);
  assert.equal(result.ok, true);
  // Existing heading override preserved
  assert.deepEqual(result.patch.branding.roles.heading, {
    light: "#001a33",
    dark: "#e6f0ff",
  });
  // fg stays null
  assert.equal(result.patch.branding.roles.fg, null);
  // A role missing from currentRoles defaults to null
  assert.equal(result.patch.branding.roles.link, null);
});

test("parseBrandingForm: inherit=1 wins over any submitted light/dark", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    // Heading has BOTH inherit AND override fields (mirrors what the
    // real form does — the override inputs stay in the DOM with values
    // even when the inherit checkbox is checked).
    roles_heading_inherit: "1",
    roles_heading_light: "#ff0000",
    roles_heading_dark: "#00ff00",
    ...Object.fromEntries(
      ROLE_KEYS.filter((r) => r !== "heading").map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.equal(result.patch.branding.roles.heading, null);
});

test("parseBrandingForm: mode falls back to 'auto' for invalid input", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "neon-disco",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.equal(result.patch.branding.mode, "auto");
});

test("parseBrandingForm: each valid mode is preserved", () => {
  for (const mode of ["light", "dark", "auto"]) {
    const body = {
      surfacePreset: "warm-stone",
      accentBase: "#b45309",
      mode,
      ...Object.fromEntries(
        ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
      ),
      typography_sans: "Inter",
      typography_serif: "Fraunces",
      typography_mono: "ui-monospace",
      typography_hosting: "self",
    };
    const result = parseBrandingForm(body);
    assert.equal(result.ok, true, `mode=${mode} should parse`);
    assert.equal(result.patch.branding.mode, mode);
  }
});

test("parseBrandingForm: accentPreset metadata captured when present", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#0d9488",
    accentPreset: "teal",
    mode: "auto",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.equal(result.patch.branding.accentPreset, "teal");
});

test("parseBrandingForm: empty accentPreset becomes null", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    accentPreset: "",
    mode: "auto",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.equal(result.patch.branding.accentPreset, null);
});

// ─── Form parsing — error paths ────────────────────────────────────────

test("parseBrandingForm rejects an invalid accent hex", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "not-a-color",
    mode: "auto",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /accentBase/i);
});

test("parseBrandingForm rejects an invalid role override hex", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    roles_link_light: "#abc",
    roles_link_dark: "ZZZZZZ",
    ...Object.fromEntries(
      ROLE_KEYS.filter((r) => r !== "link").map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /link/);
});

test("parseBrandingForm rejects a partial role override (only light, no dark)", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    roles_focus_light: "#aabbcc",
    // dark deliberately missing
    ...Object.fromEntries(
      ROLE_KEYS.filter((r) => r !== "focus").map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /focus/);
});

test("parseBrandingForm rejects custom surface preset with missing tones", () => {
  const body = {
    surfacePreset: "custom",
    accentBase: "#b45309",
    mode: "auto",
    // Only a few tones provided — missing the rest
    surfaceCustom_50: "#ffffff",
    surfaceCustom_950: "#000000",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /Custom palette/i);
});

test("parseBrandingForm rejects an invalid font choice", () => {
  const body = {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Comic Sans MS",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /font/i);
});

test("parseBrandingForm falls back to warm-stone for unknown surface preset", () => {
  const body = {
    surfacePreset: "made-up-preset",
    accentBase: "#b45309",
    mode: "auto",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  };
  const result = parseBrandingForm(body);
  assert.equal(result.ok, true);
  assert.equal(result.patch.branding.surfacePreset, "warm-stone");
});

// ─── computeRoleDefaults ───────────────────────────────────────────────

test("computeRoleDefaults returns light + dark hex per role for default palette", () => {
  const defaults = computeRoleDefaults("warm-stone", null, "#b45309");
  for (const role of ROLE_KEYS) {
    assert.ok(defaults[role], `${role} should have defaults`);
    assert.match(defaults[role].light, /^#[0-9a-f]{6}$/i, `${role}.light should be a hex`);
    assert.match(defaults[role].dark,  /^#[0-9a-f]{6}$/i, `${role}.dark should be a hex`);
  }
  // Heading light defaults to surface-900 (warm-stone) = #1c1b19
  assert.equal(defaults.heading.light, "#1c1b19");
  // bg light defaults to surface-50 = #faf8f5
  assert.equal(defaults.bg.light, "#faf8f5");
});

test("computeRoleDefaults differs between palettes", () => {
  const warmStone = computeRoleDefaults("warm-stone", null, "#b45309");
  const coolSlate = computeRoleDefaults("cool-slate", null, "#b45309");
  // bg light differs (warm-stone #faf8f5 vs cool-slate #f8fafc)
  assert.notEqual(warmStone.bg.light, coolSlate.bg.light);
});

// ─── Suggestion / preset exports ───────────────────────────────────────

test("ACCENT_SUGGESTIONS exposes 8 entries with valid hex values", () => {
  assert.equal(ACCENT_SUGGESTIONS.length, 8);
  for (const s of ACCENT_SUGGESTIONS) {
    assert.match(s.hex, /^#[0-9a-f]{6}$/i, `${s.slug} hex should be valid`);
    assert.ok(s.label && s.slug);
  }
});

test("SURFACE_PRESET_OPTIONS exposes the 5 v2 Phase 2c presets", () => {
  const slugs = SURFACE_PRESET_OPTIONS.map((p) => p.slug);
  assert.deepEqual(slugs, [
    "warm-stone",
    "warm-gray",
    "stone",
    "cool-slate",
    "neutral-zinc",
  ]);
});
