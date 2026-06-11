/**
 * Theme CSS writer (Theming v2).
 *
 * Renders the v2 3-tier semantic-token contract as a CSS file:
 *
 *   Tier 1 — Palette scales (--c-surface-{50..950}, --c-accent-{50..950})
 *   Tier 2 — Semantic roles (--c-bg, --c-fg, --c-fg-muted, --c-heading,
 *            --c-link, --c-action, --c-action-fg, --c-surface, --c-border,
 *            --c-focus). Defaults derived from Tier 1; user overrides win.
 *   Tier 3 — Fixed alert tokens (--c-success, --c-warning, --c-danger)
 *            plus matching -fg pairs. NOT user-configurable in v2.
 *
 * Mode axis (light / dark / auto):
 *   - light: serve only light Tier 2 values in :root
 *   - dark:  serve only dark Tier 2 values in :root
 *   - auto:  light Tier 2 in :root; dark values in BOTH
 *            @media (prefers-color-scheme: dark) AND .dark
 *            (so OS preference and the user-toggle JS class both apply)
 *
 * CSS variables use space-separated RGB triplets (no commas) so Tailwind's
 * alpha-value pattern works: `rgb(var(--c-bg) / <alpha-value>)`.
 *
 * Baseline admin-theme isolation (spec §11.5):
 *   The variables emitted here (--c-bg, --c-fg, etc.) are read ONLY by
 *   the public Eleventy theme's base.njk → /css/theme.css. The admin views
 *   shipped by this plugin use @indiekit/frontend's CSS custom properties
 *   (--color-surface, --color-on-surface, --color-primary, etc.) which are
 *   defined by the indiekit admin layout, NOT by this writer. A bad save
 *   here cannot therefore lock an operator out of /site-config — the admin
 *   UI keeps its baseline styling and remains usable to recover from any
 *   contrast disaster on the public side.
 *
 * @module render/write-theme-css
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { getSurfacePalette, derivePaletteFromBase } from "./derive-palette.js";
import { resolveTier2Defaults, applyOverrides } from "./resolve-tier2.js";
import { normalizeHex } from "../validators/color.js";

/**
 * Tier 3 alert tokens — fixed in v2. RGB-triplet form, ready to inline.
 * Values come from the v2 spec §3.3 (a11y-validated against light & dark
 * surface backgrounds).
 */
const TIER3_ALERTS = Object.freeze({
  light: Object.freeze({
    success:    "22 163 74",
    successFg:  "255 255 255",
    warning:    "202 138 4",
    warningFg:  "28 25 23",
    danger:     "220 38 38",
    dangerFg:   "255 255 255",
  }),
  dark: Object.freeze({
    success:    "34 197 94",
    successFg:  "255 255 255",
    warning:    "250 204 21",
    warningFg:  "28 25 23",
    danger:     "248 113 113",
    dangerFg:   "255 255 255",
  }),
});

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
    console.warn(`[site-config] alpha channel in '${hex}' is not supported in CSS custom properties and will be ignored`);
  }
  const r = parseInt(v.slice(1, 3), 16);
  const g = parseInt(v.slice(3, 5), 16);
  const b = parseInt(v.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

/**
 * CSS generic font keywords (and ui-* generics) per the CSS Fonts spec.
 * These MUST be emitted unquoted; quoting them turns them into a search for
 * a custom family named "ui-monospace" rather than the CSS generic keyword.
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
 * @param {string} name
 * @returns {string}
 */
function formatFontFamily(name) {
  return CSS_GENERIC_FONT_KEYWORDS.has(name) ? name : JSON.stringify(name);
}

/**
 * Build a Tier 1 palette block for a single palette family
 * (surface or accent), as CSS declarations.
 *
 * @param {string} prefix - "surface" or "accent"
 * @param {Record<string|number, string>} palette
 * @returns {string} CSS declaration block (no enclosing selector/braces)
 */
function paletteBlock(prefix, palette) {
  return Object.entries(palette)
    .map(([k, v]) => `  --c-${prefix}-${k}: ${hexToRgbTriplet(v)};`)
    .join("\n");
}

/**
 * Build the Tier 3 alert block for a given mode.
 *
 * @param {"light" | "dark"} modeKey
 * @returns {string} CSS declaration block
 */
function tier3Block(modeKey) {
  const a = TIER3_ALERTS[modeKey];
  return [
    `  --c-success:    ${a.success};`,
    `  --c-success-fg: ${a.successFg};`,
    `  --c-warning:    ${a.warning};`,
    `  --c-warning-fg: ${a.warningFg};`,
    `  --c-danger:     ${a.danger};`,
    `  --c-danger-fg:  ${a.dangerFg};`,
  ].join("\n");
}

/**
 * Build the typography block (always shared across modes).
 *
 * @param {{ sans: string, serif: string, mono: string }} typography
 * @returns {string} CSS declaration block
 */
function typographyBlock(typography) {
  const { sans, serif, mono } = typography;
  return [
    `  --font-sans:  ${formatFontFamily(sans)}, system-ui, sans-serif;`,
    `  --font-serif: ${formatFontFamily(serif)}, Georgia, serif;`,
    `  --font-mono:  ${formatFontFamily(mono)}, ui-monospace, monospace;`,
  ].join("\n");
}

/**
 * Build a Tier 2 semantic-role block from a resolved hex map.
 *
 * @param {Record<string, string>} resolved - Output of applyOverrides()
 * @returns {string} CSS declaration block
 */
function tier2Block(resolved) {
  return [
    `  --c-bg:        ${hexToRgbTriplet(resolved.bg)};`,
    `  --c-fg:        ${hexToRgbTriplet(resolved.fg)};`,
    `  --c-fg-muted:  ${hexToRgbTriplet(resolved.fgMuted)};`,
    `  --c-heading:   ${hexToRgbTriplet(resolved.heading)};`,
    `  --c-link:      ${hexToRgbTriplet(resolved.link)};`,
    `  --c-action:    ${hexToRgbTriplet(resolved.action)};`,
    `  --c-action-fg: ${hexToRgbTriplet(resolved.actionFg)};`,
    `  --c-surface:   ${hexToRgbTriplet(resolved.surface)};`,
    `  --c-border:    ${hexToRgbTriplet(resolved.border)};`,
    `  --c-focus:     ${hexToRgbTriplet(resolved.focus)};`,
  ].join("\n");
}

/**
 * Resolve both light and dark Tier 2 hex maps from a branding subtree.
 * Exported for reuse by the critical-CSS writer.
 *
 * @param {object} branding - The site config's branding subtree
 * @returns {{ light: Record<string,string>, dark: Record<string,string> }}
 */
export function resolveBothModes(branding) {
  const surface = getSurfacePalette(branding.surfacePreset, branding.surfaceCustom);
  const accent = derivePaletteFromBase(branding.accentBase);
  const roles = branding.roles || {};
  return {
    light: applyOverrides(resolveTier2Defaults(surface, accent, "light"), roles, "light"),
    dark:  applyOverrides(resolveTier2Defaults(surface, accent, "dark"),  roles, "dark"),
    surface,
    accent,
  };
}

/**
 * Render the site's theme as a CSS string with the full Tier 1 + Tier 2 +
 * Tier 3 contract. Mode handling follows the v2 spec §6.1.
 *
 * @param {object} config - Merged site config object (output of mergeWithDefaults)
 * @param {object} [options]
 * @param {boolean} [options.preview=false] - Preview mode. The live-preview
 *   iframe is a design tool: its Light/Dark toggle must ALWAYS work regardless
 *   of the saved `mode`. So in preview mode we emit BOTH a light and a dark
 *   set, scoped to explicit `.light` / `.dark` classes (driven by the toolbar
 *   toggle), with `:root` defaulting to light. No `prefers-color-scheme` media
 *   query is used — the operator's explicit toggle choice should win over the
 *   host OS preference while inspecting a design. The production path (no
 *   options) is unchanged and still honors `mode` per spec §6.1.
 * @returns {string} CSS source ready to be written or served
 */
export function renderThemeCss(config, options = {}) {
  const branding = config.branding;
  const { light, dark, surface, accent } = resolveBothModes(branding);
  const mode = branding.mode || "auto";

  const shared = [
    "  /* Tier 1 — surface palette */",
    paletteBlock("surface", surface),
    "  /* Tier 1 — accent palette */",
    paletteBlock("accent", accent),
    "  /* Typography */",
    typographyBlock(branding.typography),
  ].join("\n");

  // Preview mode: emit both light and dark as explicit, class-scoped blocks so
  // the iframe's Light/Dark toggle is always functional and OS-independent.
  if (options.preview === true) {
    return [
      ":root {",
      shared,
      "  /* Tier 3 — alerts (light) */",
      tier3Block("light"),
      "  /* Tier 2 — semantic roles (light) */",
      tier2Block(light),
      "}",
      "",
      // Explicit light class so the toggle can force light over any default.
      ".light {",
      "  /* Tier 3 — alerts (light) */",
      tier3Block("light"),
      "  /* Tier 2 — semantic roles (light) */",
      tier2Block(light),
      "}",
      "",
      ".dark {",
      "  /* Tier 3 — alerts (dark) */",
      tier3Block("dark"),
      "  /* Tier 2 — semantic roles (dark) */",
      tier2Block(dark),
      "}",
      "",
    ].join("\n");
  }

  // Tier 3 alerts vary by mode (different RGB values for light vs dark).
  // For "light" / "dark" modes we emit only the matching set in :root.
  // For "auto" we put light alerts in :root and dark alerts in both
  // @media (prefers-color-scheme: dark) and .dark.
  if (mode === "light") {
    return [
      ":root {",
      shared,
      "  /* Tier 3 — alerts (light) */",
      tier3Block("light"),
      "  /* Tier 2 — semantic roles (light) */",
      tier2Block(light),
      "}",
      "",
      // Explicit dark override so the header's Light/Dark toggle (which adds
      // .dark to <html>) actually works even when the default mode is light.
      ".dark {",
      "  /* Tier 3 — alerts (dark) — explicit toggle override */",
      tier3Block("dark"),
      "  /* Tier 2 — semantic roles (dark) */",
      tier2Block(dark),
      "}",
      "",
    ].join("\n");
  }

  if (mode === "dark") {
    return [
      ":root {",
      shared,
      "  /* Tier 3 — alerts (dark) */",
      tier3Block("dark"),
      "  /* Tier 2 — semantic roles (dark) */",
      tier2Block(dark),
      "}",
      "",
      // Explicit light override so the header's Light/Dark toggle (which adds
      // .light to <html>) actually works even when the default mode is dark.
      ".light {",
      "  /* Tier 3 — alerts (light) — explicit toggle override */",
      tier3Block("light"),
      "  /* Tier 2 — semantic roles (light) */",
      tier2Block(light),
      "}",
      "",
    ].join("\n");
  }

  // mode === "auto" (default)
  return [
    ":root {",
    shared,
    "  /* Tier 3 — alerts (light) */",
    tier3Block("light"),
    "  /* Tier 2 — semantic roles (light) */",
    tier2Block(light),
    "}",
    "",
    // OS prefers dark — apply dark values UNLESS user has explicitly chosen
    // light mode via the toggle button (which adds .light to <html>).
    // Without :not(.light), a user on a dark-OS who toggles the site to light
    // would still see dark-mode CSS vars applied via this @media rule,
    // resulting in light text on light background.
    "@media (prefers-color-scheme: dark) {",
    "  :root:not(.light) {",
    "    /* Tier 3 — alerts (dark) */",
    tier3Block("dark").replace(/^ {2}/gm, "    "),
    "    /* Tier 2 — semantic roles (dark) */",
    tier2Block(dark).replace(/^ {2}/gm, "    "),
    "  }",
    "}",
    "",
    // Explicit class-based dark override (JS toggle button). Beats both
    // :root and the @media rule above via specificity.
    ".dark {",
    "  /* Tier 3 — alerts (dark) */",
    tier3Block("dark"),
    "  /* Tier 2 — semantic roles (dark) */",
    tier2Block(dark),
    "}",
    "",
  ].join("\n");
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
 * @param {string} [outputPath="/app/data/content/_data/theme.css"]
 * @returns {Promise<void>}
 */
export async function writeThemeCss(config, outputPath = "/app/data/content/_data/theme.css") {
  const css = renderThemeCss(config);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, css, "utf8");
  await rename(tmp, outputPath);
}
