import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeCategoriesJson } from "../render/write-categories-json.js";
import { censusFromContentDir } from "../storage/category-census.js";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parse the Categories form body → { threshold, overrides }.
 * Per-category controls are 3-state selects (auto | on | off) for feed + listing;
 * "auto" means no override (fall back to the threshold). Pure + testable.
 * @param {object} body
 * @returns {{ threshold: number, overrides: object }}
 */
export function parseCategoriesBody(body) {
  let threshold = Number.parseInt(body?.threshold, 10);
  if (!Number.isInteger(threshold) || threshold < 1) threshold = 2;

  const overrides = {};
  const raw = body?.override && typeof body.override === "object" && !Array.isArray(body.override) ? body.override : {};
  for (const [slug, o] of Object.entries(raw)) {
    if (!SLUG_RE.test(slug) || !o || typeof o !== "object") continue;
    const entry = {};
    if (o.feed === "on") entry.feed = true;
    else if (o.feed === "off") entry.feed = false;
    if (o.listing === "on") entry.listing = true;
    else if (o.listing === "off") entry.listing = false;
    if (Object.keys(entry).length > 0) overrides[slug] = entry;
  }
  return { threshold, overrides };
}

/** Map a per-category override + count to the 3-state UI value for a surface. */
function surfaceState(override, surface) {
  if (override && override[surface] === true) return "on";
  if (override && override[surface] === false) return "off";
  return "auto";
}

export function categoriesRouter(Indiekit) {
  const router = express.Router();
  const contentDir = Indiekit.config?.application?.contentDir || "/app/data/content";

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      const cats = config.categories || {};
      const threshold = Number.isInteger(cats.threshold) && cats.threshold >= 1 ? cats.threshold : 2;
      const overrides = cats.overrides && typeof cats.overrides === "object" ? cats.overrides : {};

      const index = censusFromContentDir(contentDir);
      const rows = index.map((c) => {
        const ov = overrides[c.slug] || {};
        return {
          slug: c.slug,
          name: c.name,
          count: c.count,
          variants: c.variants,
          isMergeCandidate: c.variants.length > 1,
          feedState: surfaceState(ov, "feed"),
          listingState: surfaceState(ov, "listing"),
          // effective default if no override: meets threshold
          meetsThreshold: c.count >= threshold,
        };
      });

      res.render("site-config-categories", {
        config,
        activeTab: "categories",
        saved: req.query?.saved,
        categories: rows,
        threshold,
        total: rows.length,
        mergeCandidateCount: rows.filter((r) => r.isMergeCandidate).length,
        belowThresholdCount: rows.filter((r) => !r.meetsThreshold).length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { threshold, overrides } = parseCategoriesBody(req.body);
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, { categories: { threshold, overrides } }, userIdent);
      // categories.json is read by the theme's build-gating (lib/categories.mjs).
      try {
        await writeCategoriesJson(updated);
      } catch (error) {
        console.warn(`[site-config] categories.json write failed (saved to DB): ${error.message}`);
      }
      res.redirect("/site-config/categories?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
