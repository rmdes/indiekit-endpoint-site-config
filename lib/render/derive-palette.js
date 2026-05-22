import { parse, formatHex, oklch } from "culori";
import { SURFACE_PRESETS } from "./surface-presets.js";

const SCALE_STEPS = [
  { key: 50,  l: 0.97 }, { key: 100, l: 0.94 }, { key: 200, l: 0.86 },
  { key: 300, l: 0.78 }, { key: 400, l: 0.65 }, { key: 500, l: 0.55 },
  { key: 600, l: 0.45 }, { key: 700, l: 0.36 }, { key: 800, l: 0.27 },
  { key: 900, l: 0.20 }, { key: 950, l: 0.13 },
];

export function derivePaletteFromBase(baseHex) {
  const base = oklch(parse(baseHex));
  if (!base) throw new Error(`Invalid color: ${baseHex}`);
  const palette = {};
  for (const step of SCALE_STEPS) {
    palette[step.key] = formatHex({
      mode: "oklch",
      l: step.l,
      c: base.c * (step.l < 0.5 ? step.l * 1.8 : (1 - step.l) * 1.8),
      h: base.h ?? 0,
    });
  }
  return palette;
}

export function getSurfacePalette(preset, custom = null) {
  if (preset === "custom") {
    if (!custom) throw new Error("Custom preset selected but no custom palette provided");
    return custom;
  }
  const p = SURFACE_PRESETS[preset];
  if (!p) throw new Error(`Unknown surface preset: ${preset}`);
  return p;
}
