import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";

export function identityRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const config = await getSiteConfig(Indiekit);
    res.render("site-config-identity", { config, activeTab: "identity" });
  });

  router.post("/", async (req, res) => {
    const patch = {
      identity: {
        name: req.body.name?.trim() || "",
        description: req.body.description?.trim() || "",
        tagline: req.body.tagline?.trim() || "",
        defaultAuthor: req.body.defaultAuthor?.trim() || "",
        defaultOgImage: req.body.defaultOgImage?.trim() || "",
        locale: req.body.locale?.trim() || "en",
        timezone: req.body.timezone?.trim() || "UTC",
      },
    };
    const userIdent = req.session?.user?.profile?.url || "unknown";
    const updated = await saveSiteConfig(Indiekit, patch, userIdent);
    await writeSiteJson(updated);
    req.flash?.("success", "siteConfig.common.saved");
    res.redirect("/site-config/identity");
  });

  return router;
}
