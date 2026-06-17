import express from "express";
import { getHomepageConfig } from "../storage/get-homepage-config.js";
import { saveHomepageConfig } from "../storage/save-homepage-config.js";
import { writeHomepageJson } from "../render/write-homepage-json.js";
import { parseEntryArray, sanitizeEntries, cap } from "./homepage.js";

// 6.3-T7: the blog-tab "listing sidebar" half DISSOLVED into the listing
// surface — the `collection:default` composition, edited in Design → Listing
// and rendered by the theme. parseBlogBody now owns ONLY blogPostSidebar
// (6.4's post-template territory). The homepageConfig.blogListingSidebar field
// itself is preserved in storage (the v3→v4 migrator + one-time re-seed read
// it); the blog tab simply no longer edits or emits it.
export function parseBlogBody(body) {
  return {
    blogPostSidebar: cap(sanitizeEntries(parseEntryArray(body.blogPostSidebar))),
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
        // availableWidgets dropped with the listing picker (6.3-T7); only the
        // blog-post sidebar half remains in this tab.
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
