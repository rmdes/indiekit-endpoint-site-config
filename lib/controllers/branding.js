import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";
import { writeThemeCss } from "../render/write-theme-css.js";
import { writeCriticalCss } from "../render/write-critical-css.js";
import {
  isValidHexColor,
  normalizeHex,
  isValidMode,
  isValidColorOverride,
} from "../validators/color.js";
import { isValidFont, CURATED_FONTS } from "../validators/font.js";
import { SURFACE_PRESETS } from "../render/surface-presets.js";
import { ROLE_KEYS } from "../storage/defaults.js";

const VALID_PRESETS = new Set([...Object.keys(SURFACE_PRESETS), "custom"]);

/**
 * Branding controller (Theming v2 — Phase 2a foundation).
 *
 * NOTE: the admin form view is still the v1 view in Phase 2a. This controller
 * is updated to:
 *   - Read the new v2 schema (surfacePreset/accentBase/mode/roles/typography).
 *   - Accept any v2 fields the form posts (mode, role overrides) — silently
 *     defaulting if absent so the v1 form keeps working until Phase 2b
 *     rewrites the view.
 *   - Always re-emit theme.css AND critical.css on save.
 *
 * The full 12-control admin form arrives in Phase 2b.
 */
export function brandingRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-branding", {
        config,
        activeTab: "branding",
        curatedFonts: CURATED_FONTS,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = req.body || {};

      // ── Tier 1 inputs ───────────────────────────────────────────────
      const surfacePreset = VALID_PRESETS.has(body.surfacePreset)
        ? body.surfacePreset
        : "warm-stone";

      const surfaceCustom =
        surfacePreset === "custom"
          ? Object.fromEntries(
              [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
                .map((k) => [k, normalizeHex(body[`surfaceCustom_${k}`])])
                .filter(([, v]) => v != null),
            )
          : null;

      if (surfacePreset === "custom") {
        const missing = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
          .filter((k) => !surfaceCustom[k]);
        if (missing.length > 0) {
          return res
            .status(400)
            .send(`Custom palette is missing tones: ${missing.join(", ")}`);
        }
      }

      const accentBase = normalizeHex(body.accentBase);
      if (!accentBase) return res.status(400).send("Invalid accentBase");

      const accentPreset =
        typeof body.accentPreset === "string" && body.accentPreset.length > 0
          ? body.accentPreset
          : null;

      // ── Mode ────────────────────────────────────────────────────────
      const mode = isValidMode(body.mode) ? body.mode : "auto";

      // ── Tier 2 role overrides ───────────────────────────────────────
      // Each role accepts either:
      //   roles_<name>_inherit = "1"            → null (inherit)
      //   roles_<name>_light + roles_<name>_dark → { light, dark }
      // If neither is provided, the role is preserved from current config.
      const existing = await getSiteConfig(Indiekit);
      const currentRoles = existing.branding?.roles || {};
      const roles = {};
      for (const role of ROLE_KEYS) {
        const inherit = body[`roles_${role}_inherit`] === "1";
        const lightRaw = body[`roles_${role}_light`];
        const darkRaw = body[`roles_${role}_dark`];
        const hasOverride =
          lightRaw !== undefined && darkRaw !== undefined;

        if (inherit) {
          roles[role] = null;
        } else if (hasOverride) {
          const light = normalizeHex(lightRaw);
          const dark = normalizeHex(darkRaw);
          if (!light || !dark) {
            return res.status(400).send(`Invalid override for role "${role}"`);
          }
          const override = { light, dark };
          if (!isValidColorOverride(override)) {
            return res.status(400).send(`Invalid override for role "${role}"`);
          }
          roles[role] = override;
        } else {
          // Field not present in body — keep existing value.
          roles[role] = currentRoles[role] ?? null;
        }
      }

      // ── Typography (unchanged from v1) ──────────────────────────────
      const typography = {
        hosting: ["self", "bunny"].includes(body.typography_hosting)
          ? body.typography_hosting
          : "self",
      };
      for (const cat of ["sans", "serif", "mono"]) {
        const name = body[`typography_${cat}`];
        if (!isValidFont(name, cat)) {
          return res.status(400).send(`Invalid font for ${cat}: ${name}`);
        }
        typography[cat] = name;
      }

      // ── Persist ─────────────────────────────────────────────────────
      const patch = {
        branding: {
          surfacePreset,
          surfaceCustom,
          accentBase,
          accentPreset,
          mode,
          roles,
          typography,
        },
      };

      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, patch, userIdent);
      await writeSiteJson(updated);
      await writeThemeCss(updated);
      await writeCriticalCss(updated);
      res.redirect("/site-config/branding?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// Re-exported for tests / future controllers
export { isValidHexColor };
