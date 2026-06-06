import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";
import { isValidUrl } from "../validators/identity.js";

function safeString(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Coerce an HTML checkbox value to a boolean.
 * Unchecked checkboxes are absent from the body; checked ones send "on".
 * @param {*} raw - Raw body value
 * @returns {boolean}
 */
function checkbox(raw) {
  return raw === "on" || raw === "true" || raw === true || raw === "1";
}

/**
 * Accept an absolute URL or a root-relative path (e.g. "/ai", "/about/ai",
 * "https://example.com/ai-policy"). Falls back to the default when invalid.
 * @param {*} raw - Raw body value
 * @param {string} [fallback] - Default link
 * @returns {string}
 */
function safeLinkOrDefault(raw, fallback = "/ai") {
  const v = safeString(raw);
  if (!v) return fallback;
  if (v.startsWith("/")) return v; // root-relative path
  if (isValidUrl(v, { allowEmpty: false })) return v; // absolute URL
  return fallback;
}

export function parseGeneralBody(body) {
  return {
    aiTransparency: checkbox(body.aiTransparency),
    aiTransparencyUrl: safeLinkOrDefault(body.aiTransparencyUrl),
  };
}

export function generalRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-general", {
        config,
        activeTab: "general",
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const features = parseGeneralBody(req.body);
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, { features }, userIdent);
      await writeSiteJson(updated);
      res.redirect("/site-config/general?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
