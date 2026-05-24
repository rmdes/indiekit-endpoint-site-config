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
 * Static layout-shell rules that are mode-agnostic. Mirrors css/critical.example.css
 * in the eleventy theme repo so first-paint after an admin save retains the same
 * layout-shell behavior (sticky header, mobile menu, fonts, sidebar grid, etc.).
 * Color rules are NOT here — those are emitted per-mode by the rule helpers below
 * so user-saved Tier 2 roles take effect.
 *
 * Keep this in sync with `css/critical.example.css` (the static fallback shipped
 * in the theme repo). Both files describe the same layout-shell surface.
 */
const LAYOUT_SHELL = `*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:"Inter",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.container{max-width:64rem;margin-left:auto;margin-right:auto;padding-left:1rem;padding-right:1rem}
.site-header{padding-top:1rem;padding-bottom:1rem;position:sticky;top:0;z-index:50}
.header-container{display:flex;align-items:center;justify-content:space-between}
.site-title{font-size:1.25rem;font-weight:700;text-decoration:none}
.header-actions{display:none}
@media(min-width:768px){.header-actions{display:flex;align-items:center;gap:1rem}}
.menu-toggle{display:block;padding:0.5rem;border-radius:0.5rem;background:none;border:none;cursor:pointer}
@media(min-width:768px){.menu-toggle{display:none}}
.hidden{display:none!important}
[x-cloak]{display:none!important}
.theme-toggle .sun-icon{display:none}
.theme-toggle .moon-icon{display:block}
.dark .theme-toggle .sun-icon{display:block}
.dark .theme-toggle .moon-icon{display:none}
main.container{padding-top:1.5rem;padding-bottom:1.5rem}
@media(min-width:768px){main.container{padding-top:2rem;padding-bottom:2rem}}
.layout-with-sidebar{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:1.5rem}
@media(min-width:768px){.layout-with-sidebar{gap:2rem}}
@media(min-width:1024px){.layout-with-sidebar{grid-template-columns:repeat(3,minmax(0,1fr))}}
.main-content{min-width:0;overflow-x:hidden}
@media(min-width:1024px){.main-content{grid-column:span 2/span 2}}
@media(min-width:1024px){.sidebar{min-height:600px}}
@font-face{font-family:'Inter';font-style:normal;font-display:optional;font-weight:400;src:url(/fonts/inter-latin-400-normal.woff2) format('woff2')}
@font-face{font-family:'Inter';font-style:normal;font-display:optional;font-weight:600;src:url(/fonts/inter-latin-600-normal.woff2) format('woff2')}
@font-face{font-family:'Inter';font-style:normal;font-display:optional;font-weight:700;src:url(/fonts/inter-latin-700-normal.woff2) format('woff2')}
h1,h2,h3,h4{margin:0;line-height:1.25}
.site-nav{display:flex;align-items:center;gap:1rem}
.site-nav>a,.site-nav .nav-dropdown-trigger{text-decoration:none;padding-top:0.5rem;padding-bottom:0.5rem}
img{max-width:100%;height:auto}
svg:not(:root):not([width]){width:1.25rem;height:1.25rem}
.skip-link{position:absolute;top:-100%;left:0;z-index:100;padding:0.5rem 1rem;font-weight:600;text-decoration:none}
.skip-link:focus{top:0;outline:none}
@media(prefers-reduced-motion:reduce){*{transition-duration:0.01ms!important;animation-duration:0.01ms!important}}`;

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
  // Nav text colors (menu toggle, site nav links). Mode-aware via fgMuted role
  // so they pick up user's saved muted text color, not hardcoded warm-stone.
  const navText = (sel, t) =>
    `${sel}.menu-toggle,${sel}.site-nav>a,${sel}.site-nav .nav-dropdown-trigger{color:${rgbLit(t.fgMuted)}}`;

  const emitSet = (sel, t) => [
    body(sel, t),
    header(sel, t),
    title(sel, t),
    link(sel, t),
    focus(sel, t),
    skipLink(sel, t),
    navText(sel, t),
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
    // OS dark preference — scoped to html:not(.light) so that when a user on
    // a dark-OS clicks the toggle to force light mode (JS adds .light to
    // <html>), these dark-mode rules stop applying. Without this scoping,
    // the user would see body text in light cream on a light background.
    "@media (prefers-color-scheme: dark){",
    emitSet("html:not(.light) ", dark)
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
