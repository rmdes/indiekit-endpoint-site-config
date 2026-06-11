import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { getHomepageConfig } from "../storage/get-homepage-config.js";
import { saveHomepageConfig } from "../storage/save-homepage-config.js";
import { writeHomepageJson } from "../render/write-homepage-json.js";
import { LAYOUT_PRESETS } from "../presets/layout-presets.js";
import { sanitizeCustomHtml } from "../sanitize/custom-html.js";

const VALID_LAYOUTS = new Set(["single-column", "two-column", "full-width-hero"]);

// Hero "read more" CTA: accept a root-relative path or absolute URL, else fall
// back to /about. Text is free-form (localizable per site), defaulting to "Read more".
function safeHeroLink(raw, fallback = "/about/") {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return fallback;
  if (v.startsWith("/")) return v;
  try { new URL(v); return v; } catch { return fallback; }
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

// Sanitize every custom-html entry's content in place (sections/sidebar/footer).
function sanitizeEntries(entries) {
  for (const entry of entries) {
    if (entry && entry.type === "custom-html" && entry.config && typeof entry.config.content === "string") {
      entry.config.content = sanitizeCustomHtml(entry.config.content);
    }
  }
  return entries;
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
    sections: sanitizeEntries(parseEntryArray(body.sections)),
    sidebar:  sanitizeEntries(parseEntryArray(body.sidebar)),
    footer:   sanitizeEntries(parseEntryArray(body.footer)),
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
      res.redirect("/site-config/homepage?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
