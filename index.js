import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { identityRouter   } from "./lib/controllers/identity.js";
import { brandingRouter   } from "./lib/controllers/branding.js";
import { homepageRouter   } from "./lib/controllers/homepage.js";
import { blogRouter       } from "./lib/controllers/blog.js";
import { navigationRouter } from "./lib/controllers/navigation.js";
import { generalRouter    } from "./lib/controllers/general.js";
import { apiRouter        } from "./lib/controllers/api.js";

import { getSiteConfig     } from "./lib/storage/get-site-config.js";
import { getHomepageConfig } from "./lib/storage/get-homepage-config.js";
import { maybeSeedFromEnv  } from "./lib/storage/seed-from-env.js";
import { maybeBackfillIdentity } from "./lib/storage/backfill-identity.js";

import { writeThemeCss    } from "./lib/render/write-theme-css.js";
import { writeCriticalCss } from "./lib/render/write-critical-css.js";
import { writeSiteJson    } from "./lib/render/write-site-json.js";
import { writeHomepageJson } from "./lib/render/write-homepage-json.js";

import { scanPlugins } from "./lib/discovery/scan-plugins.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaults = {
  mountPath: "/site-config",
  contentDir: "/app/data/content",
};

export default class SiteConfigEndpoint {
  name = "Site Config endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  get localesDirectory() {
    return path.join(__dirname, "locales");
  }

  get viewsDirectory() {
    return path.join(__dirname, "views");
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "siteConfig.title",
      requiresDatabase: true,
    };
  }

  get shortcutItems() {
    return {
      url: this.options.mountPath,
      name: "siteConfig.title",
      iconName: "settings",
      requiresDatabase: true,
    };
  }

  async init(Indiekit) {
    Indiekit.addEndpoint(this);
    Indiekit.addCollection("siteConfig");
    Indiekit.addCollection("homepageConfig");

    Indiekit.config.application.contentDir = this.options.contentDir;

    this._apiRouter = apiRouter(Indiekit);

    const protectedRouter = express.Router();
    protectedRouter.get("/", (req, res) => res.redirect(`${this.mountPath}/identity`));
    protectedRouter.use("/identity",   identityRouter(Indiekit));
    protectedRouter.use("/branding",   brandingRouter(Indiekit));
    protectedRouter.use("/homepage",   homepageRouter(Indiekit));
    protectedRouter.use("/blog",       blogRouter(Indiekit));
    protectedRouter.use("/navigation", navigationRouter(Indiekit));
    protectedRouter.use("/general",    generalRouter(Indiekit));

    this.routes = protectedRouter;

    // First-boot seed + initial file write
    try {
      await maybeSeedFromEnv(Indiekit);
      await maybeBackfillIdentity(Indiekit);
      const config   = await getSiteConfig(Indiekit);
      const homepage = await getHomepageConfig(Indiekit);
      await writeThemeCss(config);
      await writeCriticalCss(config);
      await writeSiteJson(config);
      await writeHomepageJson(homepage);
    } catch (error) {
      console.warn("[site-config] initial render skipped:", error.message);
    }

    // Plugin discovery — defer until all plugins' init() has returned
    const self = this;
    process.nextTick(() => {
      try {
        scanPlugins(Indiekit, self);
      } catch (error) {
        console.warn("[site-config] plugin discovery failed:", error.message);
      }
    });
  }

  get routesPublic() {
    const router = express.Router();
    if (this._apiRouter) {
      router.use("/api", this._apiRouter);
    }
    return router;
  }
}
