import { parse, formatHex, oklch, clampChroma } from "culori";
import { SURFACE_PRESETS } from "./surface-presets.js";

const SCALE_STEPS = [
  { key: 50,  l: 0.97 }, { key: 100, l: 0.94 }, { key: 200, l: 0.86 },
  { key: 300, l: 0.78 }, { key: 400, l: 0.65 }, { key: 500, l: 0.55 },
  { key: 600, l: 0.45 }, { key: 700, l: 0.36 }, { key: 800, l: 0.27 },
  { key: 900, l: 0.20 }, { key: 950, l: 0.13 },
];

const REQUIRED_SCALE_KEYS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export function derivePaletteFromBase(baseHex) {
  const base = oklch(parse(baseHex));
  if (!base) throw new Error(`Invalid color: ${baseHex}`);
  const palette = {};
  for (const step of SCALE_STEPS) {
    const color = {
      mode: "oklch",
      l: step.l,
      c: base.c * (step.l < 0.5 ? step.l * 1.8 : (1 - step.l) * 1.8),
      h: base.h ?? 0, // hue unused when base.c === 0; fallback prevents NaN in OKLCH ops
    };
    palette[step.key] = formatHex(clampChroma(color, "oklch", "rgb"));
  }
  return palette;
}

export function getSurfacePalette(preset, custom = null) {
  if (preset === "custom") {
    if (!custom) throw new Error("Custom preset selected but no custom palette provided");
    const missing = REQUIRED_SCALE_KEYS.filter((k) => !custom[k]);
    if (missing.length > 0) {
      throw new Error(`Custom palette is missing required scale keys: ${missing.join(", ")}`);
    }
    return custom;
  }
  const p = SURFACE_PRESETS[preset];
  if (!p) throw new Error(`Unknown surface preset: ${preset}`);
  return p;
}
