import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { saveSiteConfig } from "../storage/save-site-config.js";
import { writeSiteJson } from "../render/write-site-json.js";
import {
  isValidUrl, isValidEmail, isValidLocale,
  normalizeCategoriesInput,
} from "../validators/identity.js";
import { sanitizeSocialList } from "../validators/social.js";

const TIMEZONE_RE = /^[A-Za-z]+\/[A-Za-z_\/]+$/;

function validLocale(raw) {
  const v = (raw || "").trim();
  return isValidLocale(v) ? v : "en";
}

function validTimezone(raw) {
  const v = (raw || "").trim();
  if (v === "UTC") return v;
  return TIMEZONE_RE.test(v) ? v : "UTC";
}

function safeString(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function safeUrlOrEmpty(raw) {
  const v = safeString(raw);
  return isValidUrl(v, { allowEmpty: true }) ? v : "";
}

function safeEmailOrEmpty(raw) {
  const v = safeString(raw);
  return isValidEmail(v, { allowEmpty: true }) ? v : "";
}

function parseSocialFromBody(body) {
  if (!body.social) return [];
  const raw = Array.isArray(body.social) ? body.social : Object.values(body.social);
  return sanitizeSocialList(raw);
}

export function parseIdentityBody(body) {
  return {
    name:           safeString(body.name),
    avatar:         safeUrlOrEmpty(body.avatar),
    title:          safeString(body.title),
    pronoun:        safeString(body.pronoun),
    bio:            safeString(body.bio),
    description:    safeString(body.description),
    locality:       safeString(body.locality),
    country:        safeString(body.country),
    org:            safeString(body.org),
    url:            safeUrlOrEmpty(body.url),
    email:          safeEmailOrEmpty(body.email),
    keyUrl:         safeUrlOrEmpty(body.keyUrl),
    categories:     normalizeCategoriesInput(body.categories),
    social:         parseSocialFromBody(body),
    locale:         validLocale(body.locale),
    timezone:       validTimezone(body.timezone),
    defaultOgImage: safeUrlOrEmpty(body.defaultOgImage),
    tagline:        safeString(body.tagline),
  };
}

export function identityRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      res.render("site-config-identity", {
        config,
        activeTab: "identity",
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const identity = parseIdentityBody(req.body);
      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, { identity }, userIdent);
      await writeSiteJson(updated);
      res.redirect("/site-config/identity?saved=1");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
