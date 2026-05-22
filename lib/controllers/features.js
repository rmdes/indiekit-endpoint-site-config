import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";

/**
 * Discover feature flags from loaded plugins by reading `plugin.featureFlag`.
 * Plugins without the capability are skipped.
 */
export function discoverFlags(Indiekit) {
  const plugins = Indiekit.config?.plugins || [];
  return plugins
    .map((p) => p.featureFlag)
    .filter(Boolean)
    .sort((a, b) => (a.category || "").localeCompare(b.category || ""));
}

export function featuresRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      const flags = discoverFlags(Indiekit);
      res.render("site-config-features", {
        config,
        activeTab: "features",
        flags,
        success: req.query.success,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const flags = discoverFlags(Indiekit);
      const features = {};
      for (const flag of flags) {
        features[flag.key] = req.body[`feature_${flag.key}`] === "on";
      }
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, { features }, userIdent);
      await writeSiteJson(updated);
      const message = encodeURIComponent(
        res.locals.__("siteConfig.common.saved"),
      );
      res.redirect(`/site-config/features?success=${message}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
