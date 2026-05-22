import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePaletteFromBase, getSurfacePalette } from "../lib/render/derive-palette.js";

test("derivePaletteFromBase produces 11 entries 50-950", () => {
  const scale = derivePaletteFromBase("#f59e0b");
  const keys = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  for (const k of keys) {
    assert.ok(scale[k], `missing scale[${k}]`);
    assert.match(scale[k], /^#[0-9a-f]{6}$/);
  }
});

test("derivePaletteFromBase: lower numbers are lighter than higher", () => {
  const scale = derivePaletteFromBase("#1f3a8a");
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
  };
  assert.ok(luminance(scale[100]) > luminance(scale[500]));
  assert.ok(luminance(scale[500]) > luminance(scale[900]));
});

test("getSurfacePalette returns preset", () => {
  const stone = getSurfacePalette("warm-stone");
  assert.equal(stone[500], "#7a746a");
  const slate = getSurfacePalette("cool-slate");
  assert.notEqual(slate[500], stone[500]);
});

test("getSurfacePalette returns custom override when preset === 'custom'", () => {
  const custom = { 50: "#ffffff", 500: "#888888", 950: "#000000" };
  const palette = getSurfacePalette("custom", custom);
  assert.equal(palette[500], "#888888");
});
