import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function isExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseNavigationBody(body) {
  const labels = toArray(body.navLabel).map((s) => (s || "").trim());
  const urls   = toArray(body.navUrl).map((s) => (s || "").trim());
  const max = Math.max(labels.length, urls.length);
  const items = [];
  for (let i = 0; i < max; i++) {
    const label = labels[i] || "";
    const url   = urls[i]   || "";
    if (label === "" && url === "") continue;
    items.push({ label, url, external: isExternal(url) });
  }
  return { items };
}

export function navigationRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-navigation", {
        config,
        activeTab: "navigation",
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const navigation = parseNavigationBody(req.body);
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, { navigation }, userIdent);
      await writeSiteJson(updated);
      res.redirect("/site-config/navigation?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
