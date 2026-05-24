/**
 * Tier 2 semantic-token resolution.
 *
 * Given Tier 1 palettes (surface + accent) and a mode key, this module
 * returns the 10 Tier 2 role hex values. User-supplied role overrides
 * take precedence over palette-derived defaults.
 *
 * The resolved object uses hex strings (lowercase #rrggbb). Conversion to
 * the CSS-variable RGB-triplet format happens in write-theme-css.js.
 *
 * @module render/resolve-tier2
 */

import { normalizeHex } from "../validators/color.js";
import { ROLE_KEYS } from "../storage/defaults.js";

/**
 * Default Tier 2 → Tier 1 mapping per the v2 spec, §6.2.
 *
 * Each entry is [paletteName, scaleKey]. Both modes are encoded so callers
 * pass `mode` and get a fully-resolved Tier 2 hex map.
 */
const TIER2_DEFAULTS = Object.freeze({
  light: Object.freeze({
    bg:       ["surface", 50],
    fg:       ["surface", 700],
    fgMuted:  ["surface", 600],
    heading:  ["surface", 900],
    link:     ["accent",  600],
    action:   ["accent",  600],
    actionFg: ["surface", 50],
    surface:  ["surface", 100],   // panel role; the CSS var is --c-surface
    border:   ["surface", 200],
    focus:    ["accent",  500],
  }),
  dark: Object.freeze({
    bg:       ["surface", 950],
    fg:       ["surface", 300],
    fgMuted:  ["surface", 400],
    heading:  ["surface", 100],
    link:     ["accent",  400],
    action:   ["accent",  500],
    actionFg: ["surface", 50],
    surface:  ["surface", 800],
    border:   ["surface", 700],
    focus:    ["accent",  400],
  }),
});

/**
 * Resolve Tier 2 defaults for a given mode by reading from the Tier 1 palettes.
 * The returned object is a fresh, mutable hex map keyed by role name.
 *
 * @param {Record<string|number, string>} surface - Surface palette (50..950 → hex)
 * @param {Record<string|number, string>} accent  - Accent palette  (50..950 → hex)
 * @param {"light" | "dark"} modeKey
 * @returns {Record<string, string>} { bg, fg, fgMuted, heading, link, action, actionFg, surface, border, focus } → hex
 */
export function resolveTier2Defaults(surface, accent, modeKey) {
  const palettes = { surface, accent };
  const mapping = TIER2_DEFAULTS[modeKey];
  if (!mapping) {
    throw new Error(`resolveTier2Defaults: unknown modeKey "${modeKey}" (expected "light" or "dark")`);
  }
  const out = {};
  for (const role of ROLE_KEYS) {
    const [paletteName, scaleKey] = mapping[role];
    const palette = palettes[paletteName];
    const hex = palette[scaleKey];
    if (!hex) {
      throw new Error(`resolveTier2Defaults: palette "${paletteName}" missing scale ${scaleKey}`);
    }
    out[role] = hex;
  }
  return out;
}

/**
 * Apply role overrides on top of a resolved defaults map. Each override is
 * `{ light: hex, dark: hex }` or null. Only the mode-matching half of the
 * override is consumed here.
 *
 * Invalid overrides are silently ignored (the default is kept). The validator
 * layer should have rejected these earlier; this is a defensive fallback.
 *
 * @param {Record<string, string>} defaults - From resolveTier2Defaults
 * @param {Record<string, { light: string, dark: string } | null>} roles
 * @param {"light" | "dark"} modeKey
 * @returns {Record<string, string>} Fresh object — does not mutate `defaults`
 */
export function applyOverrides(defaults, roles, modeKey) {
  const out = { ...defaults };
  if (!roles) return out;
  for (const role of ROLE_KEYS) {
    const override = roles[role];
    if (!override) continue;
    const hex = normalizeHex(override[modeKey]);
    if (hex) out[role] = hex;
  }
  return out;
}
