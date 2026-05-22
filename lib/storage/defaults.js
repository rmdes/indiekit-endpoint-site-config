/**
 * Default values for site configuration.
 * Single source of truth for the schema's defaults.
 * Frozen for immutability — never mutate this object directly.
 * @module storage/defaults
 */

import { CURATED_FONTS } from "../validators/font.js";

export const DEFAULTS = Object.freeze({
  schemaVersion: 1,
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
    surfacePreset: "warm-stone",
    surfaceCustom: null,
    accentBase: "#f59e0b",
    colors: Object.freeze({
      primary: "#1f3a8a",
      link: "#3b82f6",
      focus: "#fbbf24",
      success: "#16a34a",
      warning: "#eab308",
      danger: "#dc2626",
    }),
    typography: Object.freeze({
      sans:  CURATED_FONTS.sans[0],
      serif: CURATED_FONTS.serif[0],
      mono:  CURATED_FONTS.mono[0],
      hosting: "self",
    }),
    logo: "",
    favicon: "",
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
