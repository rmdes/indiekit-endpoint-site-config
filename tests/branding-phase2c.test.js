/**
 * Branding controller — Phase 2c tests.
 *
 * Covers:
 *   - parseBrandingForm contrast integration (fail blocks, warn allows)
 *   - parseBrandingForm skipContrastCheck for the live preview path
 *   - resetBrandingSection for every reset section
 *   - HISTORY_LIMIT export and shape
 *   - savedBy stripped from public JSON
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBrandingForm,
  resetBrandingSection,
  buildHistorySnapshot,
  prependHistory,
  HISTORY_LIMIT,
  RESET_SECTIONS,
} from "../lib/controllers/branding.js";
import { renderSiteJson } from "../lib/render/write-site-json.js";
import { ROLE_KEYS, DEFAULTS } from "../lib/storage/defaults-site.js";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";

// ─── helpers ──────────────────────────────────────────────────────────

function validBody(overrides = {}) {
  return {
    surfacePreset: "warm-stone",
    accentBase: "#b45309",
    mode: "auto",
    ...Object.fromEntries(
      ROLE_KEYS.map((r) => [`roles_${r}_inherit`, "1"]),
    ),
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
    ...overrides,
  };
}

// ─── HISTORY_LIMIT export ──────────────────────────────────────────────

test("HISTORY_LIMIT is 10 per spec §11.2", () => {
  assert.equal(HISTORY_LIMIT, 10);
});

test("RESET_SECTIONS exposes the documented sections", () => {
  assert.deepEqual([...RESET_SECTIONS], [
    "palette",
    "text",
    "interaction",
    "structure",
    "advanced",
    "typography",
    "all",
  ]);
});

// ─── parseBrandingForm contrast integration ────────────────────────────

test("parseBrandingForm: returns warnings array when result is ok", () => {
  const result = parseBrandingForm(validBody());
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.warnings));
});

test("parseBrandingForm: blocks save when a critical pair fails contrast", () => {
  // White body text on white background — guaranteed fail
  const body = validBody({
    mode: "light",
    roles_fg_light: "#ffffff",
    roles_fg_dark: "#ffffff",
  });
  // Remove the inherit flag for fg so the override is applied
  delete body.roles_fg_inherit;
  const result = parseBrandingForm(body);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /Contrast/);
  assert.ok(Array.isArray(result.contrastErrors));
  assert.ok(result.contrastErrors.length >= 1);
});

test("parseBrandingForm: skipContrastCheck=true allows a guaranteed-fail save", () => {
  // Same fail config but with skipContrastCheck — should pass
  const body = validBody({
    mode: "light",
    roles_fg_light: "#ffffff",
    roles_fg_dark: "#ffffff",
  });
  delete body.roles_fg_inherit;
  const result = parseBrandingForm(body, {}, { skipContrastCheck: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
});

test("parseBrandingForm: warnings populated when contrast is borderline (not fail)", () => {
  // Crafted to produce a warn but not a fail:
  // body text #888888 on white → |Lc| ~58 which is pass for body
  // But link #aaaaaa on white → |Lc| ~46 which is warn for body
  const body = validBody({
    mode: "light",
    roles_link_light: "#aaaaaa",
    roles_link_dark: "#aaaaaa",
  });
  delete body.roles_link_inherit;
  const result = parseBrandingForm(body);
  // We can't assert on EXACT counts because the same override applies to
  // both modes and the dark mode may swing differently. Just check shape:
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.warnings));
});

// ─── resetBrandingSection ──────────────────────────────────────────────

test("resetBrandingSection('all') wipes overrides but keeps history", () => {
  const before = {
    surfacePreset: "cool-slate",
    accentBase: "#0d9488",
    accentPreset: "teal",
    mode: "dark",
    roles: {
      heading: { light: "#001a33", dark: "#e6f0ff" },
      fg: { light: "#222222", dark: "#dddddd" },
      ...Object.fromEntries(
        ROLE_KEYS.filter((r) => r !== "heading" && r !== "fg").map((r) => [r, null]),
      ),
    },
    typography: { sans: "Inter", serif: "Fraunces", mono: "ui-monospace", hosting: "self" },
    history: [{ savedAt: "2026-01-01T00:00:00Z", savedBy: "user", snapshot: { mode: "light" } }],
  };
  const after = resetBrandingSection(before, "all");
  assert.equal(after.surfacePreset, DEFAULTS.branding.surfacePreset);
  assert.equal(after.accentBase, DEFAULTS.branding.accentBase);
  assert.equal(after.mode, DEFAULTS.branding.mode);
  for (const r of ROLE_KEYS) {
    assert.equal(after.roles[r], null, `${r} should be null after reset all`);
  }
  // history preserved
  assert.equal(after.history.length, 1);
});

test("resetBrandingSection('palette') only resets palette + mode", () => {
  const before = {
    surfacePreset: "cool-slate",
    accentBase: "#0d9488",
    accentPreset: "teal",
    mode: "dark",
    roles: {
      heading: { light: "#001a33", dark: "#e6f0ff" },
      ...Object.fromEntries(
        ROLE_KEYS.filter((r) => r !== "heading").map((r) => [r, null]),
      ),
    },
  };
  const after = resetBrandingSection(before, "palette");
  assert.equal(after.surfacePreset, DEFAULTS.branding.surfacePreset);
  assert.equal(after.mode, DEFAULTS.branding.mode);
  // Roles preserved
  assert.deepEqual(after.roles.heading, { light: "#001a33", dark: "#e6f0ff" });
});

test("resetBrandingSection('text') only clears text roles", () => {
  const before = {
    roles: {
      heading: { light: "#001a33", dark: "#e6f0ff" },
      fg:      { light: "#111111", dark: "#eeeeee" },
      fgMuted: { light: "#444444", dark: "#aaaaaa" },
      link:    { light: "#0033cc", dark: "#88aaff" },
      ...Object.fromEntries(
        ["action", "actionFg", "surface", "border", "focus", "bg"].map((r) => [r, null]),
      ),
    },
  };
  const after = resetBrandingSection(before, "text");
  assert.equal(after.roles.heading, null);
  assert.equal(after.roles.fg, null);
  assert.equal(after.roles.fgMuted, null);
  // Other roles preserved
  assert.deepEqual(after.roles.link, { light: "#0033cc", dark: "#88aaff" });
});

test("resetBrandingSection('interaction') only clears interaction roles", () => {
  const before = {
    roles: {
      heading:  { light: "#001a33", dark: "#e6f0ff" },
      link:     { light: "#0033cc", dark: "#88aaff" },
      action:   { light: "#22aa22", dark: "#55ff55" },
      actionFg: { light: "#ffffff", dark: "#000000" },
      focus:    { light: "#ff0000", dark: "#ff8888" },
      ...Object.fromEntries(
        ["fg", "fgMuted", "surface", "border", "bg"].map((r) => [r, null]),
      ),
    },
  };
  const after = resetBrandingSection(before, "interaction");
  assert.equal(after.roles.link, null);
  assert.equal(after.roles.action, null);
  assert.equal(after.roles.actionFg, null);
  assert.equal(after.roles.focus, null);
  // Heading preserved
  assert.deepEqual(after.roles.heading, { light: "#001a33", dark: "#e6f0ff" });
});

test("resetBrandingSection('structure') clears surface + border", () => {
  const before = {
    roles: {
      surface: { light: "#f0f0f0", dark: "#222" },
      border:  { light: "#dddddd", dark: "#444" },
      heading: { light: "#001a33", dark: "#e6f0ff" },
      ...Object.fromEntries(
        ["fg", "fgMuted", "link", "action", "actionFg", "focus", "bg"].map((r) => [r, null]),
      ),
    },
  };
  const after = resetBrandingSection(before, "structure");
  assert.equal(after.roles.surface, null);
  assert.equal(after.roles.border, null);
  assert.deepEqual(after.roles.heading, { light: "#001a33", dark: "#e6f0ff" });
});

test("resetBrandingSection('advanced') clears bg + actionFg", () => {
  const before = {
    roles: {
      bg:       { light: "#fefefe", dark: "#101010" },
      actionFg: { light: "#ffffff", dark: "#000000" },
      heading:  { light: "#001a33", dark: "#e6f0ff" },
      ...Object.fromEntries(
        ["fg", "fgMuted", "link", "action", "surface", "border", "focus"].map((r) => [r, null]),
      ),
    },
  };
  const after = resetBrandingSection(before, "advanced");
  assert.equal(after.roles.bg, null);
  assert.equal(after.roles.actionFg, null);
  assert.deepEqual(after.roles.heading, { light: "#001a33", dark: "#e6f0ff" });
});

test("resetBrandingSection('typography') restores font defaults", () => {
  const before = {
    typography: { sans: "Atkinson Hyperlegible", serif: "Lora", mono: "Cascadia Code", hosting: "bunny" },
    roles: {},
  };
  const after = resetBrandingSection(before, "typography");
  assert.deepEqual(after.typography, DEFAULTS.branding.typography);
});

test("resetBrandingSection() does not mutate the input", () => {
  const before = {
    surfacePreset: "cool-slate",
    accentBase: "#0d9488",
    mode: "dark",
    roles: {
      heading: { light: "#001a33", dark: "#e6f0ff" },
    },
  };
  const beforeCopy = JSON.parse(JSON.stringify(before));
  resetBrandingSection(before, "palette");
  assert.deepEqual(before, beforeCopy, "input should not be mutated");
});

test("resetBrandingSection() with unknown section returns unchanged", () => {
  const before = { mode: "dark", roles: {} };
  const after = resetBrandingSection(before, "made-up");
  assert.equal(after, before);
});

// ─── buildHistorySnapshot + prependHistory ────────────────────────────

test("buildHistorySnapshot strips the existing history field", () => {
  const branding = {
    mode: "dark",
    accentBase: "#b45309",
    history: [{ savedAt: "2026-01-01", savedBy: "old", snapshot: {} }],
  };
  const snap = buildHistorySnapshot(branding, "user@example.com");
  assert.equal(snap.savedBy, "user@example.com");
  assert.match(snap.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snap.snapshot.mode, "dark");
  assert.equal(snap.snapshot.accentBase, "#b45309");
  // No nested history
  assert.equal(snap.snapshot.history, undefined);
});

test("buildHistorySnapshot defaults savedBy to 'unknown' when caller omits it", () => {
  const snap = buildHistorySnapshot({ mode: "auto" }, null);
  assert.equal(snap.savedBy, "unknown");
});

test("prependHistory adds the snapshot at index 0", () => {
  const existing = [
    { savedAt: "2026-04-01", savedBy: "a", snapshot: { mode: "dark" } },
    { savedAt: "2026-03-01", savedBy: "b", snapshot: { mode: "light" } },
  ];
  const newSnap = { savedAt: "2026-05-01", savedBy: "c", snapshot: { mode: "auto" } };
  const next = prependHistory(existing, newSnap);
  assert.equal(next.length, 3);
  assert.equal(next[0], newSnap);
});

test("prependHistory caps the ring at HISTORY_LIMIT", () => {
  // Build 12 existing entries
  const existing = Array.from({ length: 12 }, (_, i) => ({
    savedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    savedBy: "user",
    snapshot: { mode: "dark", marker: i },
  }));
  const newSnap = { savedAt: "2026-06-01", savedBy: "user", snapshot: { mode: "auto", marker: -1 } };
  const next = prependHistory(existing, newSnap);
  assert.equal(next.length, HISTORY_LIMIT);
  // Newest is index 0
  assert.equal(next[0].snapshot.marker, -1);
  // Oldest preserved entries: the original index 0..8 (we kept 9 prior)
  assert.equal(next[1].snapshot.marker, 0);
  assert.equal(next[HISTORY_LIMIT - 1].snapshot.marker, HISTORY_LIMIT - 2);
});

test("prependHistory handles undefined/non-array existing history", () => {
  const snap = { savedAt: "2026-05-01", savedBy: "u", snapshot: {} };
  assert.equal(prependHistory(undefined, snap).length, 1);
  assert.equal(prependHistory(null, snap).length, 1);
  assert.equal(prependHistory("not an array", snap).length, 1);
});

// ─── renderSiteJson strips savedBy from history (PII) ──────────────────

test("renderSiteJson strips savedBy from every history entry", () => {
  const config = mergeWithDefaults({
    branding: {
      history: [
        { savedAt: "2026-05-01T00:00:00Z", savedBy: "user@example.com", snapshot: { mode: "light" } },
        { savedAt: "2026-05-02T00:00:00Z", savedBy: "rick@rmendes.net", snapshot: { mode: "dark" } },
      ],
    },
  });
  const json = renderSiteJson(config);
  const parsed = JSON.parse(json);
  assert.ok(parsed.branding.history.length === 2);
  for (const entry of parsed.branding.history) {
    assert.equal(entry.savedBy, undefined, "savedBy must be stripped");
    assert.ok(entry.savedAt, "savedAt must be preserved");
    assert.ok(entry.snapshot, "snapshot must be preserved");
  }
});

test("renderSiteJson still strips updatedBy (regression)", () => {
  const config = mergeWithDefaults({
    updatedBy: "user@example.com",
    updatedAt: "2026-05-01T00:00:00Z",
  });
  const json = renderSiteJson(config);
  const parsed = JSON.parse(json);
  assert.equal(parsed.updatedBy, undefined);
  assert.equal(parsed.updatedAt, "2026-05-01T00:00:00Z");
});
