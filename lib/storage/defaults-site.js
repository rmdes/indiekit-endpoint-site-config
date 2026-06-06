/**
 * Default values for siteConfig collection (identity, branding, navigation).
 * Singleton _id: "primary".
 *
 * Schema v3 (unification):
 *   - identity expanded to rich h-card shape (was 7 flat fields in v2; now 16 scalar + categories[] + social[])
 *   - layout subtree removed entirely (replaced by homepageConfig + navigation)
 *   - navigation.items[] added (was siteConfig.layout.navItems[])
 *   - branding subtree unchanged from v2 (Path D)
 *   - features subtree DROPPED in v3.x (was unused; per-plugin config lives in
 *     each plugin's own admin UI, plugin loadout lives in plugins.yaml).
 *
 * Frozen for immutability — never mutate this object directly.
 * @module storage/defaults-site
 */

import { CURATED_FONTS } from "../validators/font.js";

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

export function emptyRoles() {
  return Object.fromEntries(ROLE_KEYS.map((k) => [k, null]));
}

export const DEFAULTS_SITE = Object.freeze({
  schemaVersion: 3,
  identity: Object.freeze({
    name: "",
    // Site title / brand — drives the header, <title>, og:site_name and
    // schema.org publisher. Distinct from `name` (the person, used by the
    // h-card / hero). Empty falls back to `name` in the theme so single-author
    // sites where the brand IS the person keep working with one field.
    siteName: "",
    avatar: "",
    title: "",
    pronoun: "",
    bio: "",
    description: "",
    locality: "",
    country: "",
    org: "",
    url: "",
    email: "",
    keyUrl: "",
    categories: Object.freeze([]),
    social: Object.freeze([]),
    locale: "en",
    timezone: "UTC",
    defaultOgImage: "",
    tagline: "",
  }),
  branding: Object.freeze({
    surfacePreset: "warm-stone",
    surfaceCustom: null,
    accentBase: "#b45309",
    accentPreset: "amber",
    mode: "auto",
    roles: Object.freeze({
      bg: null, fg: null, fgMuted: null, heading: null, link: null,
      action: null, actionFg: null, surface: null, border: null, focus: null,
    }),
    typography: Object.freeze({
      sans:    CURATED_FONTS.sans[0],
      serif:   CURATED_FONTS.serif[0],
      mono:    CURATED_FONTS.mono[0],
      hosting: "self",
    }),
    logo: "",
    favicon: "",
    history: Object.freeze([]),
  }),
  navigation: Object.freeze({
    items: Object.freeze([]),
  }),
  // Site-wide feature toggles. `aiTransparency` gates the theme's per-post AI
  // usage disclosure (off by default — not every site uses AI); when on, the
  // disclosure renders on every post/page. `aiTransparencyUrl` is the
  // customizable "learn more" link target (defaults to the /ai page).
  features: Object.freeze({
    aiTransparency: false,
    aiTransparencyUrl: "/ai",
  }),
});

// Legacy export name for any code path that hasn't been updated yet.
// Remove after Phase J cleanup.
export const DEFAULTS = DEFAULTS_SITE;
