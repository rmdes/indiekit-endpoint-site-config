import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";

const PRESETS = ["blog", "portfolio", "business", "landing"];

export function layoutRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-layout", {
        config,
        activeTab: "layout",
        presets: PRESETS,
        success: req.query.success,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const navItems = [];
      const labels = [].concat(req.body.navLabel || []);
      const urls = [].concat(req.body.navUrl || []);
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] && urls[i]) {
          navItems.push({
            label: labels[i].trim(),
            url: urls[i].trim(),
            external: urls[i].startsWith("http"),
          });
        }
      }

      const patch = {
        layout: {
          preset: PRESETS.includes(req.body.preset) ? req.body.preset : "blog",
          sidebarEnabled: req.body.sidebarEnabled === "on",
          sidebarSide: ["left", "right"].includes(req.body.sidebarSide)
            ? req.body.sidebarSide
            : "right",
          navItems,
          footerColumns: [],
        },
      };

      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, patch, userIdent);
      await writeSiteJson(updated);
      const message = encodeURIComponent(
        res.locals.__("siteConfig.common.saved"),
      );
      res.redirect(`/site-config/layout?success=${message}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
