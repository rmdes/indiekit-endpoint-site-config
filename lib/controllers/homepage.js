/**
 * Phase 4: the v3 homepage builder tab is RETIRED — the composition editor
 * under /site-config/design is the homepage source of truth. This module
 * keeps exactly two things:
 *
 * - a legacy-URL redirect (old bookmarks/links to /site-config/homepage land
 *   on the design editor's homepage surface)
 * - the shared zone-entry parsing/sanitizing helpers (`parseEntryArray`,
 *   `sanitizeEntries`, `cap`) consumed by controllers/blog.js — the blog
 *   sidebars still edit the v3 homepageConfig doc until their own Phase 6
 *   composition surfaces take over.
 *
 * Deleted here (Phase 4 mandate): the v3 GET render + POST save +
 * POST /apply-preset handlers, their orphaned parsers (parseHomepageBody,
 * detectActivePreset, hero helpers), and the refreshV4Composition hook —
 * storage/refresh-homepage-composition.js's own docblock required its
 * removal at this exact point, else v3 saves clobber editor work.
 */
import express from "express";
import { sanitizeCustomHtml } from "../sanitize/custom-html.js";

// Phase 0 cheap guards (still guarding the blog sidebars via blog.js):
// cap entries per zone and bound string field lengths.
const MAX_ENTRIES_PER_ZONE = 24;
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 20000;

function coerceString(v, max) {
  if (v === undefined || v === null) return v;
  return String(v).slice(0, max);
}

export function parseEntryArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (value && typeof value === "object") {
    return Object.values(value);
  }
  return [];
}

// Coerce known string fields to bounded strings and sanitize custom-html
// content in place (blog sidebar zones). title is coerced for every entry;
// custom-html content is length-bounded before sanitizing.
export function sanitizeEntries(entries) {
  for (const entry of entries) {
    if (!entry || !entry.config) continue;
    if (typeof entry.config.title !== "undefined") {
      entry.config.title = coerceString(entry.config.title, MAX_TITLE_LEN);
    }
    if (entry.type === "custom-html" && typeof entry.config.content !== "undefined") {
      entry.config.content = sanitizeCustomHtml(coerceString(entry.config.content, MAX_CONTENT_LEN));
    }
  }
  return entries;
}

// Cap a zone's entry count (Phase 0 cheap guard against unbounded compositions).
export function cap(entries) {
  return entries.slice(0, MAX_ENTRIES_PER_ZONE);
}

export function homepageRouter() {
  const router = express.Router();

  // Legacy tab URL → the Phase 4 design editor. 303 (See Other): the old
  // POST endpoints are gone, and a 303 guarantees the follow-up is a GET.
  router.get("/", (request, response) => {
    response.redirect(303, "/site-config/design/homepage");
  });

  return router;
}
