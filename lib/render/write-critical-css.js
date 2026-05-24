/**
 * Critical CSS writer (Theming v2).
 *
 * Emits the minimum-viable CSS needed for first-paint with the user's actual
 * brand colors baked in. Inlined into `<head>` by the Eleventy theme via
 * `inlineFile`. Because this is inlined BEFORE theme.css loads, it cannot
 * reference `var(--c-bg)` etc — those would resolve to `initial`. Instead,
 * we resolve Tier 2 hex values at generation time and emit literal `rgb(...)`
 * values for the small subset of rules that matter for first paint.
 *
 * Strategy is Option B from the v2 spec §10.1: per-site critical CSS, no
 * brand flicker on first load.
 *
 * @module render/write-critical-css
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { resolveBothModes } from "./write-theme-css.js";
import { normalizeHex } from "../validators/color.js";

/**
 * Convert a hex to a `rgb(r, g, b)` literal — used inline in critical CSS
 * declarations (NOT the space-separated Tailwind triplet format).
 *
 * @param {string} hex
 * @returns {string}
 */
function rgbLit(hex) {
  const v = normalizeHex(hex) || "#000000";
  const r = parseInt(v.slice(1, 3), 16);
  const g = parseInt(v.slice(3, 5), 16);
  const b = parseInt(v.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Static layout-shell rules that are mode-agnostic. Kept here so the
 * generator emits a single, self-contained critical.css.
 */
const LAYOUT_SHELL = `*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--font-sans, "Inter", system-ui, sans-serif);line-height:1.5}
.container{max-width:64rem;margin-left:auto;margin-right:auto;padding-left:1rem;padding-right:1rem}
.skip-link{position:absolute;top:-40px;left:0;padding:8px 16px;text-decoration:none;border-radius:0 0 4px 0;transition:top 0.2s ease}
.skip-link:focus{top:0}
@media (prefers-reduced-motion: reduce){
  *{transition-duration:0.01ms!important;animation-duration:0.01ms!important;scroll-behavior:auto!important}
}`;

/**
 * Render the critical CSS string for first-paint.
 *
 * Mode handling mirrors the theme.css generator:
 *   - light: only light-mode rules in :root selectors
 *   - dark:  only dark-mode rules (the page IS always dark)
 *   - auto:  light defaults + @media (prefers-color-scheme: dark) + .dark
 *
 * @param {object} config - Full site config
 * @returns {string} CSS source
 */
export function renderCriticalCss(config) {
  const branding = config.branding;
  const { light, dark } = resolveBothModes(branding);
  const mode = branding.mode || "auto";

  // Each rule helper takes a selector prefix so the same logic can emit
  // either bare (`body { ... }`) or class-scoped (`.dark body { ... }`) rules.
  const body = (sel, t) => `${sel}body{background-color:${rgbLit(t.bg)};color:${rgbLit(t.fg)}}`;
  const header = (sel, t) => `${sel}.site-header{background-color:${rgbLit(t.bg)};border-bottom:1px solid ${rgbLit(t.border)}}`;
  const title = (sel, t) => `${sel}.site-title{color:${rgbLit(t.heading)}}`;
  const link = (sel, t) => `${sel}a{color:${rgbLit(t.link)}}`;
  const focus = (sel, t) =>
    `${sel}a:focus-visible,${sel}button:focus-visible,${sel}[type="button"]:focus-visible{outline:2px solid ${rgbLit(t.focus)};outline-offset:2px}`;
  const skipLink = (sel, t) => `${sel}.skip-link{background:${rgbLit(t.action)};color:${rgbLit(t.actionFg)}}`;

  const emitSet = (sel, t) => [
    body(sel, t),
    header(sel, t),
    title(sel, t),
    link(sel, t),
    focus(sel, t),
    skipLink(sel, t),
  ].join("\n");

  if (mode === "light") {
    return [LAYOUT_SHELL, emitSet("", light), ""].join("\n");
  }

  if (mode === "dark") {
    return [LAYOUT_SHELL, emitSet("", dark), ""].join("\n");
  }

  // mode === "auto"
  return [
    LAYOUT_SHELL,
    // Light defaults in :root selectors (bare)
    emitSet("", light),
    // OS dark preference
    "@media (prefers-color-scheme: dark){",
    emitSet("", dark)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "}",
    // Class-based override (theme toggle button writes .dark on <html>)
    emitSet(".dark ", dark),
    "",
  ].join("\n");
}

/**
 * Write critical CSS to disk atomically (tmp file → rename).
 *
 * @param {object} config - Full site config (from mergeWithDefaults)
 * @param {string} [outputPath="/app/data/content/_data/critical.css"]
 * @returns {Promise<void>}
 */
export async function writeCriticalCss(
  config,
  outputPath = "/app/data/content/_data/critical.css",
) {
  const css = renderCriticalCss(config);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, css, "utf8");
  await rename(tmp, outputPath);
}
