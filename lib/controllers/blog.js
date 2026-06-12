import express from "express";
import { getHomepageConfig } from "../storage/get-homepage-config.js";
import { saveHomepageConfig } from "../storage/save-homepage-config.js";
import { writeHomepageJson } from "../render/write-homepage-json.js";
import { parseEntryArray, sanitizeEntries, cap } from "./homepage.js";

export function parseBlogBody(body) {
  return {
    blogListingSidebar: cap(sanitizeEntries(parseEntryArray(body.blogListingSidebar))),
    blogPostSidebar:    cap(sanitizeEntries(parseEntryArray(body.blogPostSidebar))),
  };
}

export function blogRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const homepage = await getHomepageConfig(Indiekit);
      res.render("site-config-blog", {
        homepage,
        activeTab: "blog",
        // Flash flag: the admin Nunjucks env doesn't expose `request`, so
        // the redirect query param must be passed through as a local.
        saved: req.query?.saved,
        availableWidgets:         Indiekit.config?.application?.discoveredWidgets         || [],
        availableBlogPostWidgets: Indiekit.config?.application?.discoveredBlogPostWidgets || [],
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const patch = parseBlogBody(req.body);
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveHomepageConfig(Indiekit, patch, userIdent);
      await writeHomepageJson(updated);
      res.redirect("/site-config/blog?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
