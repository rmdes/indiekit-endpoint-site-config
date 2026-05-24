/**
 * Default values for site configuration.
 * Single source of truth for the schema's defaults.
 * Frozen for immutability — never mutate this object directly.
 *
 * Schema v2 (theming v2 contract):
 *   - branding.surfacePreset / surfaceCustom / accentBase: Tier 1 inputs
 *   - branding.mode: light | dark | auto
 *   - branding.roles: per-role color override pairs ({ light, dark } or null)
 *   - branding.typography / logo / favicon: unchanged from v1
 *   - branding.history: FIFO ring of past snapshots (max 10)
 *
 * The flat brand-token block (colors.primary/link/focus/...) was removed
 * in v2 — those roles are now expressed via branding.roles overrides that
 * default to palette-derived values.
 *
 * @module storage/defaults
 */

import { CURATED_FONTS } from "../validators/font.js";

/**
 * The 10 Tier 2 role keys (semantic tokens). Each can be null (inherit
 * palette-derived default) or { light: hex, dark: hex } (user override).
 */
export const ROLE_KEYS = Object.freeze([
  "bg",
  "fg",
  "fgMuted",
  "heading",
  "link",
  "action",
  "actionFg",
  "surface",
  "border",
  "focus",
]);

/**
 * Build a fresh roles object with all keys set to null (inherit).
 * Use this to construct fresh override containers without sharing
 * references with DEFAULTS (which is frozen).
 *
 * @returns {Record<string, null>}
 */
export function emptyRoles() {
  return Object.fromEntries(ROLE_KEYS.map((k) => [k, null]));
}

export const DEFAULTS = Object.freeze({
  schemaVersion: 2,
  identity: Object.freeze({
    name: "My IndieWeb Site",
    description: "A site built with Indiekit",
    tagline: "",
    defaultAuthor: "",
    defaultOgImage: "",
    locale: "en",
    timezone: "UTC",
  }),
  branding: Object.freeze({
    // Tier 1 inputs
    surfacePreset: "warm-stone",
    surfaceCustom: null,
    accentBase: "#b45309",
    accentPreset: "amber",
    // Mode axis
    mode: "auto",
    // Tier 2 role overrides — null = inherit palette-derived default
    roles: Object.freeze({
      bg:       null,
      fg:       null,
      fgMuted:  null,
      heading:  null,
      link:     null,
      action:   null,
      actionFg: null,
      surface:  null,
      border:   null,
      focus:    null,
    }),
    // Typography (unchanged from v1)
    typography: Object.freeze({
      sans:    CURATED_FONTS.sans[0],
      serif:   CURATED_FONTS.serif[0],
      mono:    CURATED_FONTS.mono[0],
      hosting: "self",
    }),
    // Brand assets (unchanged from v1)
    logo:    "",
    favicon: "",
    // Undo history (FIFO ring of 10 — populated by the controller)
    history: Object.freeze([]),
  }),
  layout: Object.freeze({
    preset: "blog",
    sidebarEnabled: true,
    sidebarSide: "right",
    navItems: Object.freeze([
      Object.freeze({ label: "Home", url: "/", external: false }),
    ]),
    footerColumns: Object.freeze([]),
  }),
  features: Object.freeze({
    webmentions: true,
    syndication: true,
    activitypub: false,
    search: true,
    rss: true,
  }),
});
