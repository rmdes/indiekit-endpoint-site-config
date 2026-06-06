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
  // Unweighted channel sum is sufficient here: OKLCH lightness is monotonic
  // enough that channel sum tracks it for the purposes of this assertion.
  const channelSum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
  };
  assert.ok(channelSum(scale[100]) > channelSum(scale[500]));
  assert.ok(channelSum(scale[500]) > channelSum(scale[900]));
});

test("getSurfacePalette returns preset", () => {
  const stone = getSurfacePalette("warm-stone");
  assert.equal(stone[500], "#7a746a");
  const slate = getSurfacePalette("cool-slate");
  assert.notEqual(slate[500], stone[500]);
});

test("getSurfacePalette exposes the clay and stone presets", () => {
  // clay = terracotta/rose-tinted warm, distinct from the other neutrals.
  const clay = getSurfacePalette("clay");
  assert.match(clay[500], /^#[0-9a-f]{6}$/);
  assert.equal(clay[50], "#faf4f1");
  assert.equal(clay[950], "#1a0f0b");

  // stone = Tailwind "neutral" — pure gray
  const stone = getSurfacePalette("stone");
  assert.equal(stone[50], "#fafafa");
  assert.equal(stone[950], "#0a0a0a");

  // All five presets distinct at mid-tone
  const presets = ["warm-stone", "clay", "stone", "cool-slate", "sage"];
  const mid500s = presets.map((p) => getSurfacePalette(p)[500]);
  assert.equal(new Set(mid500s).size, presets.length, "mid-tones should all differ");
});

test("getSurfacePalette returns custom override when preset === 'custom'", () => {
  const custom = {
    50: "#ffffff", 100: "#eeeeee", 200: "#dddddd", 300: "#cccccc",
    400: "#aaaaaa", 500: "#888888", 600: "#666666", 700: "#444444",
    800: "#222222", 900: "#111111", 950: "#000000",
  };
  const palette = getSurfacePalette("custom", custom);
  assert.equal(palette[500], "#888888");
});

test("derivePaletteFromBase throws on invalid hex input", () => {
  assert.throws(
    () => derivePaletteFromBase("not-a-color"),
    /Invalid color: not-a-color/,
  );
});

test("getSurfacePalette throws on unknown preset name", () => {
  assert.throws(
    () => getSurfacePalette("magenta-thunder"),
    /Unknown surface preset: magenta-thunder/,
  );
});

test("getSurfacePalette throws when custom preset is null", () => {
  assert.throws(
    () => getSurfacePalette("custom", null),
    /Custom preset selected but no custom palette provided/,
  );
});

test("getSurfacePalette throws when custom palette is missing required keys", () => {
  assert.throws(
    () => getSurfacePalette("custom", { 500: "#888888" }),
    /Custom palette is missing required scale keys/,
  );
});

test("derivePaletteFromBase produces neutral gray scale for achromatic input", () => {
  // Grayscale input: chroma=0 means hue is unused; all steps should have equal R,G,B
  const scale = derivePaletteFromBase("#888888");
  for (const key of [50, 500, 950]) {
    const v = scale[key];
    const r = parseInt(v.slice(1, 3), 16);
    const g = parseInt(v.slice(3, 5), 16);
    const b = parseInt(v.slice(5, 7), 16);
    // Allow ±2 for OKLCH→sRGB rounding noise
    assert.ok(Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2,
      `Expected gray at step ${key}, got R=${r} G=${g} B=${b} (${v})`);
  }
});

test("clampChroma keeps amber hue stable across all 11 steps", () => {
  // Regression test for the hue-drift bug that channel-clamping caused.
  // For a saturated amber base, after the clampChroma fix every step should
  // still be in the warm-orange-amber visual range (red component largest,
  // then green, then blue smallest).
  const scale = derivePaletteFromBase("#f59e0b");
  for (const key of [200, 400, 500, 700, 900]) {
    const v = scale[key];
    const r = parseInt(v.slice(1, 3), 16);
    const g = parseInt(v.slice(3, 5), 16);
    const b = parseInt(v.slice(5, 7), 16);
    assert.ok(r >= g && g >= b,
      `Step ${key} (${v}) should have R>=G>=B for warm amber, got R=${r} G=${g} B=${b}`);
  }
});
