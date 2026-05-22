import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { identityRouter } from "./lib/controllers/identity.js";
import { brandingRouter } from "./lib/controllers/branding.js";
import { layoutRouter } from "./lib/controllers/layout.js";
import { featuresRouter } from "./lib/controllers/features.js";
import { apiRouter } from "./lib/controllers/api.js";
import { getSiteConfig } from "./lib/storage/get-site-config.js";
import { maybeSeedFromEnv } from "./lib/storage/seed-from-env.js";
import { writeThemeCss } from "./lib/render/write-theme-css.js";
import { writeSiteJson } from "./lib/render/write-site-json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaults = {
  mountPath: "/site-config",
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
    this._apiRouter = apiRouter(Indiekit);

    const protectedRouter = express.Router();
    protectedRouter.get("/", (req, res) => res.redirect(`${this.mountPath}/identity`));
    protectedRouter.use("/identity", identityRouter(Indiekit));
    protectedRouter.use("/branding", brandingRouter(Indiekit));
    protectedRouter.use("/layout",   layoutRouter(Indiekit));
    protectedRouter.use("/features", featuresRouter(Indiekit));

    this.routes = protectedRouter;

    // Ensure files exist on first boot — synchronously regenerate.
    try {
      await maybeSeedFromEnv(Indiekit);
      const config = await getSiteConfig(Indiekit);
      await writeThemeCss(config);
      await writeSiteJson(config);
    } catch (error) {
      console.warn("[site-config] initial render skipped:", error.message);
    }
  }

  get routesPublic() {
    const router = express.Router();
    if (this._apiRouter) {
      router.use("/api", this._apiRouter);
    }
    return router;
  }
}
