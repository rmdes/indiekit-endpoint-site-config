import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";
import { writeThemeCss } from "../render/write-theme-css.js";
import { isValidHexColor, normalizeHex } from "../validators/color.js";
import { isValidFont, CURATED_FONTS } from "../validators/font.js";

export function brandingRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-branding", {
        config,
        activeTab: "branding",
        curatedFonts: CURATED_FONTS,
        success: req.query.success,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = req.body;

      // Collect custom surface if preset === custom
      const surfaceCustom = body.surfacePreset === "custom"
        ? Object.fromEntries(
            [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
              .map((k) => [k, normalizeHex(body[`surfaceCustom_${k}`])])
              .filter(([, v]) => v != null),
          )
        : null;

      // Validate and collect brand tokens
      const colors = {};
      for (const token of ["primary", "link", "focus", "success", "warning", "danger"]) {
        const raw = body[`colors_${token}`];
        if (!isValidHexColor(raw)) {
          return res.status(400).send(`Invalid color for ${token}: ${raw}`);
        }
        colors[token] = normalizeHex(raw);
      }

      // Validate typography
      const typography = {
        hosting: ["self", "bunny"].includes(body.typography_hosting) ? body.typography_hosting : "self",
      };
      for (const cat of ["sans", "serif", "mono"]) {
        const name = body[`typography_${cat}`];
        if (!isValidFont(name, cat)) {
          return res.status(400).send(`Invalid font for ${cat}: ${name}`);
        }
        typography[cat] = name;
      }

      const accentBase = normalizeHex(body.accentBase);
      if (!accentBase) return res.status(400).send("Invalid accentBase");

      const patch = {
        branding: {
          surfacePreset: body.surfacePreset || "warm-stone",
          surfaceCustom,
          accentBase,
          colors,
          typography,
        },
      };

      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, patch, userIdent);
      await writeSiteJson(updated);
      await writeThemeCss(updated);
      const message = encodeURIComponent(res.locals.__("siteConfig.common.saved"));
      res.redirect(`/site-config/branding?success=${message}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
