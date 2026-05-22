import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const TIMEZONE_RE = /^[A-Za-z]+\/[A-Za-z_\/]+$/;

function validLocale(raw) {
  const v = raw?.trim() || "en";
  return LOCALE_RE.test(v) ? v : "en";
}

function validTimezone(raw) {
  const v = raw?.trim() || "UTC";
  // "UTC" is a special-case valid timezone that doesn't match the region/city pattern
  if (v === "UTC") return v;
  return TIMEZONE_RE.test(v) ? v : "UTC";
}

export function identityRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-identity", {
        config,
        activeTab: "identity",
        success: req.query.success,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const patch = {
        identity: {
          name: req.body.name?.trim() || "",
          description: req.body.description?.trim() || "",
          tagline: req.body.tagline?.trim() || "",
          defaultAuthor: req.body.defaultAuthor?.trim() || "",
          defaultOgImage: req.body.defaultOgImage?.trim() || "",
          locale: validLocale(req.body.locale),
          timezone: validTimezone(req.body.timezone),
        },
      };
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, patch, userIdent);
      await writeSiteJson(updated);
      const message = encodeURIComponent(res.locals.__("siteConfig.common.saved"));
      res.redirect(`/site-config/identity?success=${message}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
