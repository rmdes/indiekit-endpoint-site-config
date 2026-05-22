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
          const url = urls[i].trim();
          navItems.push({
            label: labels[i].trim(),
            url,
            external: url.startsWith("http"),
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
          // footerColumns intentionally omitted — managed by a future tab; deepMerge would replace, not preserve
        },
      };

      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, patch, userIdent);
      await writeSiteJson(updated);
      res.redirect("/site-config/layout?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
