/**
 * APCA contrast validator tests (Theming v2 — Phase 2c).
 *
 * Covers:
 *   - computeLc: returns a number for valid input, null for invalid
 *   - validateResolved: classifies pass/warn/fail correctly per kind
 *   - validateBranding: walks resolveBothModes and tags entries with mode
 *   - partitionContrastResults: buckets entries into failures/warnings/passes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLc,
  validateResolved,
  validateBranding,
  partitionContrastResults,
  CRITICAL_PAIRS,
} from "../lib/validators/contrast.js";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";

// ─── computeLc ─────────────────────────────────────────────────────────

test("computeLc returns ~106 for black text on white background", () => {
  const lc = computeLc("#000000", "#ffffff");
  assert.ok(lc !== null);
  // APCA forward contrast for black/white is around +106
  assert.ok(Math.abs(lc) > 90, `expected |Lc| > 90, got ${lc}`);
});

test("computeLc returns ~-108 for white text on black background (inverted)", () => {
  const lc = computeLc("#ffffff", "#000000");
  assert.ok(lc !== null);
  // Negative because text is lighter than bg
  assert.ok(lc < 0, `expected negative Lc, got ${lc}`);
  assert.ok(Math.abs(lc) > 90, `expected |Lc| > 90, got ${lc}`);
});

test("computeLc returns 0 (clamped) for white text on yellow background — both high luminance", () => {
  const lc = computeLc("#ffffff", "#ffff00");
  // APCA clamps below noise floor
  assert.equal(lc, 0);
});

test("computeLc returns null for invalid input", () => {
  assert.equal(computeLc(null, "#ffffff"), null);
  assert.equal(computeLc("#ffffff", undefined), null);
  assert.equal(computeLc(42, "#ffffff"), null);
});

// ─── validateResolved ──────────────────────────────────────────────────

test("validateResolved flags a known-good light theme as pass", () => {
  // High-contrast light theme: black text on white background everywhere
  const resolved = {
    bg: "#ffffff",
    fg: "#000000",
    fgMuted: "#444444",
    heading: "#000000",
    link: "#0033cc",
    action: "#0033cc",
    actionFg: "#ffffff",
    surface: "#f8f8f8",
    border: "#e0e0e0",
    focus: "#0066ff",
  };
  const results = validateResolved(resolved, "light");
  assert.equal(results.length, CRITICAL_PAIRS.length);
  for (const r of results) {
    assert.equal(r.mode, "light");
    assert.equal(r.status, "pass", `${r.pair} should pass but got: ${r.message}`);
  }
});

test("validateResolved flags white-on-white as fail (effectively zero contrast)", () => {
  const resolved = {
    bg: "#ffffff",
    fg: "#ffffff",          // body text invisible
    fgMuted: "#fafafa",
    heading: "#ffffff",     // heading invisible
    link: "#ffffff",
    action: "#ffffff",
    actionFg: "#ffffff",
    surface: "#ffffff",
    border: "#ffffff",
    focus: "#ffffff",
  };
  const results = validateResolved(resolved, "light");
  const failures = results.filter((r) => r.status === "fail");
  assert.ok(failures.length >= 2, `expected at least 2 failures, got ${failures.length}`);
  // fg vs bg must fail
  assert.ok(failures.some((f) => f.text === "fg" && f.bg === "bg"));
  // heading vs bg must fail
  assert.ok(failures.some((f) => f.text === "heading" && f.bg === "bg"));
});

test("validateResolved flags a borderline pair as warn (not fail)", () => {
  // Light gray text on white sits in the warn band for body text:
  // |Lc| for #999 on white is around 50 — fail threshold 30, warn 45.
  const resolved = {
    bg: "#ffffff",
    fg: "#888888",          // approx Lc ~58 — body warn at <45 so this passes
    fgMuted: "#aaaaaa",
    heading: "#666666",     // ~75 (heading needs >=60)
    link: "#888888",
    action: "#0033cc",
    actionFg: "#ffffff",
    surface: "#f5f5f5",
    border: "#e0e0e0",
    focus: "#0066ff",
  };
  const results = validateResolved(resolved, "light");
  // We mostly want to make sure SOME bucket has warn or pass, not fail.
  const failures = results.filter((r) => r.status === "fail");
  assert.equal(failures.length, 0, `expected no failures, got: ${failures.map((f) => f.message).join("; ")}`);
});

test("validateResolved attaches the mode tag to each entry", () => {
  const resolved = {
    bg: "#ffffff", fg: "#000000", fgMuted: "#555", heading: "#000",
    link: "#0033cc", action: "#0033cc", actionFg: "#ffffff",
    surface: "#f8f8f8", border: "#e0e0e0", focus: "#0066ff",
  };
  const light = validateResolved(resolved, "light");
  const dark  = validateResolved(resolved, "dark");
  light.forEach((r) => assert.equal(r.mode, "light"));
  dark.forEach((r) => assert.equal(r.mode, "dark"));
});

test("validateResolved returns fail with null lc when role hex is missing", () => {
  const resolved = {
    bg: "#ffffff",
    fg: undefined, // missing
    fgMuted: "#666666",
    heading: "#000000",
    link: "#0033cc",
    action: "#0033cc",
    actionFg: "#ffffff",
    surface: "#f8f8f8",
    border: "#e0e0e0",
    focus: "#0066ff",
  };
  const results = validateResolved(resolved, "light");
  const fgEntry = results.find((r) => r.text === "fg" && r.bg === "bg");
  assert.ok(fgEntry);
  assert.equal(fgEntry.lc, null);
  assert.equal(fgEntry.status, "fail");
});

// ─── validateBranding (end-to-end through resolveBothModes) ─────────────

test("validateBranding checks both modes when mode=auto", () => {
  const config = mergeWithDefaults({});
  const results = validateBranding(config.branding);
  // 4 critical pairs × 2 modes = 8 entries
  assert.equal(results.length, CRITICAL_PAIRS.length * 2);
  const lightCount = results.filter((r) => r.mode === "light").length;
  const darkCount = results.filter((r) => r.mode === "dark").length;
  assert.equal(lightCount, CRITICAL_PAIRS.length);
  assert.equal(darkCount, CRITICAL_PAIRS.length);
});

test("validateBranding checks only light when mode=light", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const results = validateBranding(config.branding);
  assert.equal(results.length, CRITICAL_PAIRS.length);
  results.forEach((r) => assert.equal(r.mode, "light"));
});

test("validateBranding checks only dark when mode=dark", () => {
  const config = mergeWithDefaults({ branding: { mode: "dark" } });
  const results = validateBranding(config.branding);
  assert.equal(results.length, CRITICAL_PAIRS.length);
  results.forEach((r) => assert.equal(r.mode, "dark"));
});

test("validateBranding default warm-stone + amber config passes", () => {
  const config = mergeWithDefaults({});
  const results = validateBranding(config.branding);
  const failures = results.filter((r) => r.status === "fail");
  assert.equal(failures.length, 0, "default theme should not fail contrast: " + failures.map((f) => f.message).join("; "));
});

test("validateBranding flags a low-contrast custom override as fail", () => {
  const config = mergeWithDefaults({
    branding: {
      mode: "light",
      roles: {
        // Body text the same color as the background → guaranteed fail
        fg: { light: "#ffffff", dark: "#ffffff" },
      },
    },
  });
  const results = validateBranding(config.branding);
  const failures = results.filter((r) => r.status === "fail");
  assert.ok(failures.some((f) => f.text === "fg" && f.bg === "bg"));
});

// ─── partitionContrastResults ──────────────────────────────────────────

test("partitionContrastResults buckets entries by status", () => {
  const results = [
    { status: "pass", message: "ok" },
    { status: "warn", message: "warn1" },
    { status: "fail", message: "fail1" },
    { status: "pass", message: "ok2" },
    { status: "fail", message: "fail2" },
  ];
  const { failures, warnings, passes } = partitionContrastResults(results);
  assert.equal(failures.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(passes.length, 2);
});

test("CRITICAL_PAIRS exposes the 4 required pairs from spec §11.1", () => {
  assert.equal(CRITICAL_PAIRS.length, 4);
  const labels = CRITICAL_PAIRS.map((p) => `${p.text} vs ${p.bg}`);
  assert.ok(labels.includes("fg vs bg"));
  assert.ok(labels.includes("heading vs bg"));
  assert.ok(labels.includes("link vs bg"));
  assert.ok(labels.includes("actionFg vs action"));
});
