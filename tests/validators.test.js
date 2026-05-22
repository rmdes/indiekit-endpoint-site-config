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
