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
import { randomBytes } from "node:crypto";
import path from "node:path";
import { getSurfacePalette, derivePaletteFromBase } from "./derive-palette.js";
import { normalizeHex } from "../validators/color.js";

/**
 * Convert a hex color string to a space-separated RGB triplet.
 * Returns "0 0 0" for invalid or null input (safe fallback).
 *
 * 8-digit (alpha) hex inputs have their alpha channel dropped; a warning is
 * logged because the RGB triplet output format cannot represent alpha.
 * (Tailwind applies alpha at the use site via the <alpha-value> pattern.)
 *
 * @param {string|null} hex - Hex color string (e.g. "#ff0000")
 * @returns {string} Space-separated triplet (e.g. "255 0 0")
 */
function hexToRgbTriplet(hex) {
  const v = normalizeHex(hex);
  if (!v) return "0 0 0";
  if (v.length === 9) {
    // 8-digit hex includes alpha; alpha is not representable in our CSS var format.
    // (Tailwind applies alpha at use site via the <alpha-value> pattern.)
    console.warn(`[site-config] alpha channel in '${hex}' is not supported in CSS custom properties and will be ignored`);
  }
  const r = parseInt(v.slice(1, 3), 16);
  const g = parseInt(v.slice(3, 5), 16);
  const b = parseInt(v.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

/**
 * CSS generic font keywords (and ui-* generics) per CSS Fonts spec.
 * These MUST be emitted unquoted; quoting them turns them into a search for a
 * custom font-family named "ui-monospace" rather than the CSS generic keyword.
 */
const CSS_GENERIC_FONT_KEYWORDS = new Set([
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
]);

/**
 * Format a font-family name for a CSS declaration. Generic keywords are
 * emitted unquoted; named families are wrapped in quotes via JSON.stringify
 * (which also escapes any special characters safely).
 *
 * @param {string} name - Font family name
 * @returns {string} CSS-ready font family token
 */
function formatFontFamily(name) {
  return CSS_GENERIC_FONT_KEYWORDS.has(name) ? name : JSON.stringify(name);
}

/**
 * Render the site's theme as a CSS string with custom properties.
 *
 * Note: only light-mode (:root) variables are emitted. Dark-mode overrides
 * are out of scope for this module; the theme uses Tailwind's class-based
 * dark mode (darkMode: "class") via existing styling, not via separate
 * CSS variable overrides.
 *
 * @param {object} config - Merged site config object (output of mergeWithDefaults)
 * @returns {string} CSS source ready to be written or served
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
  --font-sans:  ${formatFontFamily(sans)}, system-ui, sans-serif;
  --font-serif: ${formatFontFamily(serif)}, Georgia, serif;
  --font-mono:  ${formatFontFamily(mono)}, ui-monospace, monospace;
}
`;
}

/**
 * Write theme CSS to disk atomically (tmp file → rename).
 * Creates the output directory if it does not exist.
 *
 * The tmp file uses a random suffix so concurrent callers don't collide on a
 * shared tmp name (two simultaneous writes both renaming the same file would
 * cause one to fail with ENOENT). The rename itself is atomic on POSIX —
 * Eleventy's file watcher will not observe a partial write.
 *
 * @param {object} config - Full site config (from mergeWithDefaults)
 * @param {string} [outputPath="/app/data/content/_data/theme.css"] - Destination path
 * @returns {Promise<void>}
 */
export async function writeThemeCss(config, outputPath = "/app/data/content/_data/theme.css") {
  const css = renderThemeCss(config);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, css, "utf8");
  await rename(tmp, outputPath);
}
