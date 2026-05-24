import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidHexColor,
  normalizeHex,
  isValidMode,
  isValidColorOverride,
  isValidPaletteScale,
} from "../lib/validators/color.js";
import { isValidFont, CURATED_FONTS } from "../lib/validators/font.js";

// ─── Hex color ──────────────────────────────────────────────────────────

test("isValidHexColor accepts 3, 6, 8 digit hex", () => {
  assert.ok(isValidHexColor("#abc"));
  assert.ok(isValidHexColor("#aabbcc"));
  assert.ok(isValidHexColor("#aabbcc80"));
});

test("isValidHexColor rejects malformed", () => {
  assert.equal(isValidHexColor("abc"), false);
  assert.equal(isValidHexColor("#xyz"), false);
  assert.equal(isValidHexColor("#1234"), false);
});

test("normalizeHex expands 3-digit", () => {
  assert.equal(normalizeHex("#abc"), "#aabbcc");
  assert.equal(normalizeHex("#aabbcc"), "#aabbcc");
});

test("normalizeHex on invalid input returns null", () => {
  assert.equal(normalizeHex("not-hex"), null);
  assert.equal(normalizeHex(""), null);
  assert.equal(normalizeHex("#xyz"), null);
});

test("normalizeHex on 8-digit alpha hex lowercases but does not expand", () => {
  assert.equal(normalizeHex("#aabbcc80"), "#aabbcc80");
  assert.equal(normalizeHex("#AABBCC80"), "#aabbcc80");
});

// ─── Mode ───────────────────────────────────────────────────────────────

test("isValidMode accepts light, dark, auto", () => {
  assert.ok(isValidMode("light"));
  assert.ok(isValidMode("dark"));
  assert.ok(isValidMode("auto"));
});

test("isValidMode rejects unknown modes and non-strings", () => {
  assert.equal(isValidMode("twilight"), false);
  assert.equal(isValidMode(""), false);
  assert.equal(isValidMode(null), false);
  assert.equal(isValidMode(undefined), false);
  assert.equal(isValidMode(42), false);
});

// ─── Color override ─────────────────────────────────────────────────────

test("isValidColorOverride accepts null (inherit)", () => {
  assert.ok(isValidColorOverride(null));
});

test("isValidColorOverride accepts { light, dark } with valid hex", () => {
  assert.ok(isValidColorOverride({ light: "#ffffff", dark: "#000000" }));
  assert.ok(isValidColorOverride({ light: "#fff", dark: "#000" }));
});

test("isValidColorOverride rejects missing or invalid hex", () => {
  assert.equal(isValidColorOverride({ light: "#fff" }), false);
  assert.equal(isValidColorOverride({ light: "not-hex", dark: "#000" }), false);
  assert.equal(isValidColorOverride({}), false);
  assert.equal(isValidColorOverride(undefined), false);
  assert.equal(isValidColorOverride("not-object"), false);
});

// ─── Palette scale ──────────────────────────────────────────────────────

test("isValidPaletteScale accepts a full 11-key hex scale", () => {
  const scale = {
    50: "#ffffff", 100: "#eeeeee", 200: "#dddddd", 300: "#cccccc",
    400: "#bbbbbb", 500: "#aaaaaa", 600: "#999999", 700: "#888888",
    800: "#666666", 900: "#444444", 950: "#222222",
  };
  assert.ok(isValidPaletteScale(scale));
});

test("isValidPaletteScale rejects missing keys", () => {
  const incomplete = {
    50: "#fff", 100: "#eee", 500: "#888", 950: "#000",
  };
  assert.equal(isValidPaletteScale(incomplete), false);
});

test("isValidPaletteScale rejects invalid hex in any slot", () => {
  const scale = {
    50: "#ffffff", 100: "#eeeeee", 200: "not-hex", 300: "#cccccc",
    400: "#bbbbbb", 500: "#aaaaaa", 600: "#999999", 700: "#888888",
    800: "#666666", 900: "#444444", 950: "#222222",
  };
  assert.equal(isValidPaletteScale(scale), false);
});

test("isValidPaletteScale rejects non-object input", () => {
  assert.equal(isValidPaletteScale(null), false);
  assert.equal(isValidPaletteScale(undefined), false);
  assert.equal(isValidPaletteScale("string"), false);
  assert.equal(isValidPaletteScale(42), false);
});

// ─── Font ───────────────────────────────────────────────────────────────

test("isValidFont accepts curated entries", () => {
  assert.ok(isValidFont("Inter"));
  assert.ok(isValidFont("Fraunces"));
  assert.equal(isValidFont("Comic Sans"), false);
});

test("CURATED_FONTS has three categories with entries", () => {
  assert.ok(Array.isArray(CURATED_FONTS.sans) && CURATED_FONTS.sans.length > 0);
  assert.ok(Array.isArray(CURATED_FONTS.serif) && CURATED_FONTS.serif.length > 0);
  assert.ok(Array.isArray(CURATED_FONTS.mono) && CURATED_FONTS.mono.length > 0);
});

test("isValidFont with category restricts to that category", () => {
  assert.ok(isValidFont("Inter", "sans"));
  assert.equal(isValidFont("Inter", "serif"), false);
  assert.equal(isValidFont("Fraunces", "sans"), false);
});

test("isValidFont with invalid category returns false", () => {
  assert.equal(isValidFont("Inter", "not-a-category"), false);
});

test("isValidFont with empty string category returns false (regression: was true)", () => {
  assert.equal(isValidFont("Inter", ""), false);
});

test("isValidFont rejects non-string input", () => {
  assert.equal(isValidFont(null), false);
  assert.equal(isValidFont(undefined), false);
  assert.equal(isValidFont(123), false);
});
