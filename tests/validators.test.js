import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidHexColor, normalizeHex } from "../lib/validators/color.js";
import { isValidFont, CURATED_FONTS } from "../lib/validators/font.js";

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

test("isValidFont accepts curated entries", () => {
  assert.ok(isValidFont("Inter"));
  assert.ok(isValidFont("Fraunces"));
  assert.equal(isValidFont("Comic Sans"), false);
});

test("CURATED_FONTS has three categories with entries", () => {
  assert.ok(Array.isArray(CURATED_FONTS.sans)  && CURATED_FONTS.sans.length > 0);
  assert.ok(Array.isArray(CURATED_FONTS.serif) && CURATED_FONTS.serif.length > 0);
  assert.ok(Array.isArray(CURATED_FONTS.mono)  && CURATED_FONTS.mono.length > 0);
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
  // Empty string is now correctly treated as "category provided but unknown",
  // not as "no category". This catches the bug where a missing form field
  // would bypass category checking.
  assert.equal(isValidFont("Inter", ""), false);
});

test("isValidFont rejects non-string input", () => {
  assert.equal(isValidFont(null), false);
  assert.equal(isValidFont(undefined), false);
  assert.equal(isValidFont(123), false);
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
