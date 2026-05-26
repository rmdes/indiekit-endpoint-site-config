import express from "express";
import { getHomepageConfig } from "../storage/get-homepage-config.js";
import { saveHomepageConfig } from "../storage/save-homepage-config.js";
import { writeHomepageJson } from "../render/write-homepage-json.js";
import { parseEntryArray } from "./homepage.js";

export function parseBlogBody(body) {
  return {
    blogListingSidebar: parseEntryArray(body.blogListingSidebar),
    blogPostSidebar:    parseEntryArray(body.blogPostSidebar),
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
