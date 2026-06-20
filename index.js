import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { identityRouter   } from "./lib/controllers/identity.js";
import { brandingRouter   } from "./lib/controllers/branding.js";
import { homepageRouter   } from "./lib/controllers/homepage.js";
import { designRouter     } from "./lib/controllers/design.js";
import { navigationRouter } from "./lib/controllers/navigation.js";
import { generalRouter    } from "./lib/controllers/general.js";
import { categoriesRouter } from "./lib/controllers/categories.js";
import { publicApiRouter, adminApiRouter } from "./lib/controllers/api.js";

import { getSiteConfig     } from "./lib/storage/get-site-config.js";
import { getHomepageConfig } from "./lib/storage/get-homepage-config.js";
import { maybeSeedFromEnv  } from "./lib/storage/seed-from-env.js";
import { maybeBackfillIdentity } from "./lib/storage/backfill-identity.js";
import { migrateV3toV4 } from "./lib/storage/migrate-v3-to-v4.js";
import { reseedListingComposition, reseedSidebarSurface } from "./lib/storage/reseed-sidebar-surface.js";

import { writeThemeCss    } from "./lib/render/write-theme-css.js";
import { writeCriticalCss } from "./lib/render/write-critical-css.js";
import { writeSiteJson    } from "./lib/render/write-site-json.js";
import { writeHomepageJson } from "./lib/render/write-homepage-json.js";
import { writeBlockCatalogJson } from "./lib/render/write-block-catalog-json.js";
import { writeCompositionArtifacts, writePagesJson } from "./lib/render/write-composition-json.js";

import { scanPlugins } from "./lib/discovery/scan-plugins.js";
import { refreshPublicationCategories } from "./lib/storage/publication-categories.js";

import { waitForReady } from "@rmdes/indiekit-startup-gate";

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
    protectedRouter.use("/homepage",   homepageRouter()); // legacy URL → design editor redirect
    protectedRouter.use("/design",     designRouter(Indiekit));
    protectedRouter.use("/navigation", navigationRouter(Indiekit));
    protectedRouter.use("/general",    generalRouter(Indiekit));
    protectedRouter.use("/categories", categoriesRouter(Indiekit));
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

      // 6.3-T7 one-time forced re-seed (design D7 option a): carry the
      // operator's CURRENT blog-tab blogListingSidebar into collection:default
      // ONCE at the 6.3 cutover (the migrator is skip-if-exists, so a
      // post-migration blog-tab edit would otherwise be stranded). Gated on
      // siteConfig.migrations.listingReseed so it runs exactly once and never
      // clobbers a later listing-editor edit. MUST run BEFORE the artifact
      // write below so the re-seeded tree is flushed to collection-default.json.
      // Separate try/catch — never crashes boot.
      try {
        const db = Indiekit.database;
        if (db) {
          const { ran, reseeded } = await reseedListingComposition(db);
          if (ran) {
            console.log(
              `[site-config] listing re-seed: ran=true reseeded=${reseeded}`,
            );
          }
        }
      } catch (error) {
        console.warn("[site-config] listing re-seed failed:", error?.message ?? String(error));
      }

      // 6.4-T3 one-time forced re-seed (design D6): the EXACT same mechanism as
      // the listing re-seed above, for the postType surface — carry the
      // operator's CURRENT blog-tab blogPostSidebar into posttype:default ONCE
      // at the 6.4 cutover. Gated on siteConfig.migrations.posttypeReseed, an
      // INDEPENDENT gate from listingReseed (re-seeding one surface never
      // sets/consumes the other's gate). MUST run BEFORE the artifact write
      // below so the re-seeded posttype:default tree is flushed to
      // posttype-default.json on the cutover boot. Separate try/catch — never
      // crashes boot.
      try {
        const db = Indiekit.database;
        if (db) {
          const { ran, reseeded } = await reseedSidebarSurface(db, {
            surfaceId: "posttype:default", kind: "postType",
            target: { postType: "default" }, sourceField: "blogPostSidebar",
            gateField: "posttypeReseed",
          });
          if (ran) {
            console.log(
              `[site-config] posttype re-seed: ran=true reseeded=${reseeded}`,
            );
          }
        }
      } catch (error) {
        console.warn("[site-config] posttype re-seed failed:", error?.message ?? String(error));
      }

      // Phase 3 cutover: (re)write the composition artifact — THE theme
      // activation switch (Tier-0 renders the homepage from the v4 path when
      // compositions/homepage.json exists). Boot self-heals the artifact on
      // every start; /app/data persists across restarts but we write anyway.
      // Separate try/catch — an artifact failure logs distinctly from a
      // migration failure and never crashes boot.
      try {
        const db = Indiekit.database;
        // Write ONE artifact per LIVE surface (6.4: homepage + collection:default
        // + posttype:default; the id list is derived from the surface registry
        // inside the helper, so 6.5 surfaces auto-extend). The per-doc `doc?.tree`
        // guard inside the helper still skips draft-only docs (apply-recipe on a
        // fresh install can insert a draft-only doc with no published tree —
        // writing that would activate the theme's v4 path with an empty artifact).
        // posttype:default IS now a live surface (registered in T2, re-seeded just
        // above) and is written here to posttype-default.json.
        const written = db ? await writeCompositionArtifacts(db) : [];
        for (const surfaceId of written) {
          console.log(`[site-config] composition artifact written: ${surfaceId}`);
        }
        if (written.length === 0) {
          console.log("[site-config] composition artifact skipped: no published compositions");
        }

        // Standalone pages (6.5) render from a SINGLE pages.json ARRAY artifact
        // — separate write path from the singleton per-surface loop above
        // (writeCompositionArtifacts cannot enumerate N page:<slug> docs). Boot
        // self-heals the array on every start; an empty published set writes [].
        if (db) {
          const pagesPath = await writePagesJson(db);
          console.log(`[site-config] pages artifact written: ${pagesPath}`);
        }
      } catch (error) {
        console.warn("[site-config] composition artifact write failed:", error?.message ?? String(error));
      }
    });

    // Category Governance L1 wiring: publish the canonical category list to
    // Indiekit.publication.categories so normalise-on-write (jf2.js) and the
    // ?q=category typeahead fold authored categories to existing casing. The
    // census parses ~2,600 .md files, so defer it behind the startup gate
    // (after the first Eleventy build) to stay clear of the build memory peak.
    // Pre-gate writes still get trim/drop-empty/dedupe; only cross-post folding
    // waits for the list. Hot restarts fire immediately (gate file present).
    this._stopCategoriesGate = waitForReady(
      () => refreshPublicationCategories(Indiekit),
      { label: "site-config:categories" },
    );
  }

  /** Cancel the category gate poll if the host tears the plugin down pre-build. */
  destroy() {
    this._stopCategoriesGate?.();
  }

  get routesPublic() {
    const router = express.Router();
    if (this._publicApiRouter) {
      router.use("/api", this._publicApiRouter);
    }
    return router;
  }
}
