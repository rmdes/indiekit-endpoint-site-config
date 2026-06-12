import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { getHomepageConfig } from "../storage/get-homepage-config.js";
import { saveHomepageConfig } from "../storage/save-homepage-config.js";
import { writeHomepageJson } from "../render/write-homepage-json.js";
import { refreshHomepageComposition } from "../storage/refresh-homepage-composition.js";
import { LAYOUT_PRESETS } from "../presets/layout-presets.js";
import { sanitizeCustomHtml } from "../sanitize/custom-html.js";
import { safeConfigUrl } from "../validators/config-url.js";

const VALID_LAYOUTS = new Set(["single-column", "two-column", "full-width-hero"]);

// Phase 0 cheap guards: cap entries per zone and bound string field lengths.
// Full catalog/schema validation is deferred to a later phase.
const MAX_ENTRIES_PER_ZONE = 24;
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 20000;

function coerceString(v, max) {
  if (v === undefined || v === null) return v;
  return String(v).slice(0, max);
}

// Hero "read more" CTA: route through safeConfigUrl (accepts root-relative paths
// and http/https absolute URLs, rejects javascript:/data:/private SSRF targets),
// falling back to /about. Text is free-form (localizable per site).
function safeHeroLink(raw, fallback = "/about/") {
  return safeConfigUrl(raw) || fallback;
}

function safeHeroText(raw, fallback = "Read more") {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v || fallback;
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

// Coerce known string fields to bounded strings and sanitize custom-html content
// in place (homepage zones + blog sidebars). title is coerced for every entry; custom-html
// content is length-bounded before sanitizing.
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

function validLayout(raw) {
  return VALID_LAYOUTS.has(raw) ? raw : "two-column";
}

export function parseHomepageBody(body) {
  return {
    layout: validLayout(body.layout),
    hero: {
      enabled:    body.heroEnabled    === "on" || body.heroEnabled    === true,
      showSocial: body.heroShowSocial === "on" || body.heroShowSocial === true,
      ctaText:    safeHeroText(body.heroCtaText),
      ctaUrl:     safeHeroLink(body.heroCtaUrl),
    },
    sections: cap(sanitizeEntries(parseEntryArray(body.sections))),
    sidebar:  cap(sanitizeEntries(parseEntryArray(body.sidebar))),
    footer:   cap(sanitizeEntries(parseEntryArray(body.footer))),
  };
}

export function detectActivePreset(homepage, presets) {
  for (const preset of presets) {
    if (homepage.layout !== preset.layout) continue;
    const configTypes = (homepage.sections || []).map((s) => s.type).join(",");
    const presetTypes = preset.sections.map((s) => s.type).join(",");
    if (configTypes !== presetTypes) continue;
    const configWidgets = (homepage.sidebar || []).map((w) => w.type).join(",");
    const presetWidgets = preset.sidebar.map((w) => w.type).join(",");
    if (configWidgets !== presetWidgets) continue;
    return preset.id;
  }
  return null;
}

// Phase 3 bridge: propagate every v3 homepage save to the v4 composition doc
// + artifact (the theme activation switch). A refresh failure must NOT fail
// the v3 save — separate try/catch, warn only. **Phase 4 MUST remove this
// hook** when the composition editor becomes the source of truth, else v3
// saves clobber editor work (see storage/refresh-homepage-composition.js).
async function refreshV4Composition(Indiekit) {
  try {
    const db = Indiekit.database;
    if (!db) return;
    const catalog = Indiekit.config?.application?.blockCatalog || [];
    const report = await refreshHomepageComposition(db, catalog);
    if (!report.ok) {
      console.warn(`[site-config] v4 refresh failed: ${report.errors.join(" | ")}`);
    }
  } catch (error) {
    console.warn(`[site-config] v4 refresh failed: ${error?.message ?? String(error)}`);
  }
}

export function homepageRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      const homepage = await getHomepageConfig(Indiekit);
      const activePresetId = detectActivePreset(homepage, LAYOUT_PRESETS);
      res.render("site-config-homepage", {
        config,
        homepage,
        activeTab: "homepage",
        layouts: [
          { id: "single-column",   label: "Single Column" },
          { id: "two-column",      label: "Two Column with Sidebar" },
          { id: "full-width-hero", label: "Full-width Hero + Grid" },
        ],
        layoutPresets: LAYOUT_PRESETS,
        availableSections: Indiekit.config?.application?.discoveredSections || [],
        availableWidgets:  Indiekit.config?.application?.discoveredWidgets  || [],
        activePresetId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const patch = parseHomepageBody(req.body);
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveHomepageConfig(Indiekit, patch, userIdent);
      await writeHomepageJson(updated);
      await refreshV4Composition(Indiekit);
      res.redirect("/site-config/homepage?saved=1");
    } catch (error) {
      next(error);
    }
  });

  router.post("/apply-preset", async (req, res, next) => {
    try {
      const presetId = req.body.presetId;
      const preset = LAYOUT_PRESETS.find((p) => p.id === presetId);
      if (!preset) {
        res.status(400).redirect("/site-config/homepage?error=preset");
        return;
      }
      const patch = {
        layout:   preset.layout,
        hero:     preset.hero,
        sections: preset.sections,
        sidebar:  preset.sidebar,
        footer:   preset.footer,
      };
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveHomepageConfig(Indiekit, patch, userIdent);
      await writeHomepageJson(updated);
      await refreshV4Composition(Indiekit);
      res.redirect("/site-config/homepage?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
