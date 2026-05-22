/**
 * Theme CSS writer.
 * Renders a `:root {}` block of CSS custom properties from a site config,
 * and optionally writes it atomically to disk.
 *
 * CSS variables use space-separated RGB triplets (no commas) so that
 * Tailwind's alpha-value pattern works: `rgb(var(--c-primary) / <alpha-value>)`.
 *
 * @module render/write-theme-css
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { getSurfacePalette, derivePaletteFromBase } from "./derive-palette.js";
import { normalizeHex } from "../validators/color.js";

/**
 * Convert a hex color string to a space-separated RGB triplet.
 * Returns "0 0 0" for invalid or null input (safe fallback).
 *
 * @param {string|null} hex - Hex color string (e.g. "#ff0000")
 * @returns {string} Space-separated triplet (e.g. "255 0 0")
 */
function hexToRgbTriplet(hex) {
  const v = normalizeHex(hex);
  if (!v) return "0 0 0";
  const r = parseInt(v.slice(1, 3), 16);
  const g = parseInt(v.slice(3, 5), 16);
  const b = parseInt(v.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

/**
 * Render the theme CSS string from a site config.
 * Pure function — no I/O side effects.
 *
 * @param {object} config - Full site config (from mergeWithDefaults)
 * @returns {string} CSS `:root {}` block
 */
export function renderThemeCss(config) {
  const surface = getSurfacePalette(
    config.branding.surfacePreset,
    config.branding.surfaceCustom,
  );
  const accent = derivePaletteFromBase(config.branding.accentBase);
  const { primary, link, focus, success, warning, danger } = config.branding.colors;
  const { sans, serif, mono } = config.branding.typography;

  const surfaceVars = Object.entries(surface)
    .map(([k, v]) => `  --c-surface-${k}: ${hexToRgbTriplet(v)};`)
    .join("\n");
  const accentVars = Object.entries(accent)
    .map(([k, v]) => `  --c-accent-${k}: ${hexToRgbTriplet(v)};`)
    .join("\n");

  return `:root {
${surfaceVars}
${accentVars}
  --c-primary: ${hexToRgbTriplet(primary)};
  --c-link:    ${hexToRgbTriplet(link)};
  --c-focus:   ${hexToRgbTriplet(focus)};
  --c-success: ${hexToRgbTriplet(success)};
  --c-warning: ${hexToRgbTriplet(warning)};
  --c-danger:  ${hexToRgbTriplet(danger)};
  --font-sans:  ${JSON.stringify(sans)}, system-ui, sans-serif;
  --font-serif: ${JSON.stringify(serif)}, Georgia, serif;
  --font-mono:  ${JSON.stringify(mono)}, ui-monospace, monospace;
}
`;
}

/**
 * Write theme CSS to disk atomically (tmp file → rename).
 * Creates the output directory if it does not exist.
 * The rename is atomic on POSIX — Eleventy's file watcher will not
 * observe a partial write.
 *
 * @param {object} config - Full site config (from mergeWithDefaults)
 * @param {string} [outputPath="/app/data/content/_data/theme.css"] - Destination path
 * @returns {Promise<void>}
 */
export async function writeThemeCss(config, outputPath = "/app/data/content/_data/theme.css") {
  const css = renderThemeCss(config);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp`;
  await writeFile(tmp, css, "utf8");
  await rename(tmp, outputPath);  // atomic swap
}
