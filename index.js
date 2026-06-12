import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { identityRouter   } from "./lib/controllers/identity.js";
import { brandingRouter   } from "./lib/controllers/branding.js";
import { homepageRouter   } from "./lib/controllers/homepage.js";
import { blogRouter       } from "./lib/controllers/blog.js";
import { navigationRouter } from "./lib/controllers/navigation.js";
import { generalRouter    } from "./lib/controllers/general.js";
import { publicApiRouter, adminApiRouter } from "./lib/controllers/api.js";

import { getSiteConfig     } from "./lib/storage/get-site-config.js";
import { getHomepageConfig } from "./lib/storage/get-homepage-config.js";
import { maybeSeedFromEnv  } from "./lib/storage/seed-from-env.js";
import { maybeBackfillIdentity } from "./lib/storage/backfill-identity.js";
import { migrateV3toV4 } from "./lib/storage/migrate-v3-to-v4.js";

import { writeThemeCss    } from "./lib/render/write-theme-css.js";
import { writeCriticalCss } from "./lib/render/write-critical-css.js";
import { writeSiteJson    } from "./lib/render/write-site-json.js";
import { writeHomepageJson } from "./lib/render/write-homepage-json.js";
import { writeBlockCatalogJson } from "./lib/render/write-block-catalog-json.js";
import { writeCompositionJson } from "./lib/render/write-composition-json.js";

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
    Indiekit.addCollection("compositions");

    Indiekit.config.application.contentDir = this.options.contentDir;

    this._publicApiRouter = publicApiRouter(Indiekit);

    const protectedRouter = express.Router();
    protectedRouter.get("/", (req, res) => res.redirect(`${this.mountPath}/identity`));
    protectedRouter.use("/identity",   identityRouter(Indiekit));
    protectedRouter.use("/branding",   brandingRouter(Indiekit));
    protectedRouter.use("/homepage",   homepageRouter(Indiekit));
    protectedRouter.use("/blog",       blogRouter(Indiekit));
    protectedRouter.use("/navigation", navigationRouter(Indiekit));
    protectedRouter.use("/general",    generalRouter(Indiekit));
    protectedRouter.use("/api",        adminApiRouter(Indiekit));

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

    // Plugin discovery — defer until all plugins' init() has returned.
    // The try/catch is load-bearing (spec §3.1): an async callback without it
    // would turn any scan/write failure into an unhandled rejection. On dev
    // machines where /app/data is not writable, the catalog write fails and
    // we only warn — same posture as the initial render above.
    const self = this;
    process.nextTick(async () => {
      let catalog;
      try {
        ({ catalog } = scanPlugins(Indiekit, self));
        await writeBlockCatalogJson(catalog);
      } catch (error) {
        console.warn("[site-config] plugin discovery/catalog write failed:", error?.message ?? String(error));
      }

      // Dual-running v3 → v4 migration (spec §7). SAFE BY CONSTRUCTION on
      // every boot: seed-if-absent never touches the v3 doc and never
      // overwrites existing compositions. This is the migrator's single
      // sanctioned non-dry caller (see the TOCTOU precondition there).
      //
      // Separate try/catch — deliberately granular so a migration failure
      // logs distinctly from a discovery failure (and, like discovery,
      // never crashes boot). `catalog` survives a failed artifact write
      // above (it is destructured before writeBlockCatalogJson), so an
      // unwritable /app/data doesn't block the DB seed; only a failed SCAN
      // leaves it undefined, in which case there is nothing to validate
      // against and the migration is skipped (the artifact write below does
      // not need the catalog, so it still runs).
      if (catalog) {
        try {
          const db = Indiekit.database;
          if (db) {
            const { report } = await migrateV3toV4(db, catalog, { dryRun: false });
            if (report.skipped) {
              console.log("[site-config] v4 migration: no v3 source, skipped");
            } else {
              // skippedExisting vs seeded is the single most important
              // diagnostic distinction — log the ids, not just counts.
              const summary =
                `[site-config] v4 migration: seeded=[${report.seeded}] ` +
                `existing=[${report.skippedExisting}] valid=${report.valid}` +
                (report.errors.length ? " errors=" + report.errors.join(" | ") : "") +
                (report.warnings.length ? " warnings=" + report.warnings.join(" | ") : "");
              if (report.valid) {
                console.log(summary);
              } else {
                // One invalid legacy config blocks seeding of EVERY surface on
                // every boot — the one failure operators must notice before
                // Phase 3. warn-level so it stands apart from success lines.
                console.warn(summary);
              }
            }
          }
        } catch (error) {
          console.warn("[site-config] v4 migration failed:", error?.message ?? String(error));
        }
      }

      // Phase 3 cutover: (re)write the composition artifact — THE theme
      // activation switch (Tier-0 renders the homepage from the v4 path when
      // compositions/homepage.json exists). Boot self-heals the artifact on
      // every start; /app/data persists across restarts but we write anyway.
      // Separate try/catch — an artifact failure logs distinctly from a
      // migration failure and never crashes boot.
      try {
        const db = Indiekit.database;
        const doc = db
          ? await db.collection("compositions").findOne({ _id: "homepage" })
          : null;
        if (doc) {
          await writeCompositionJson(doc);
          console.log("[site-config] composition artifact written: homepage");
        } else {
          console.log("[site-config] composition artifact skipped: no homepage composition");
        }
      } catch (error) {
        console.warn("[site-config] composition artifact write failed:", error?.message ?? String(error));
      }
    });
  }

  get routesPublic() {
    const router = express.Router();
    if (this._publicApiRouter) {
      router.use("/api", this._publicApiRouter);
    }
    return router;
  }
}
