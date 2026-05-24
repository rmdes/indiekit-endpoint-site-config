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
import {
  getSurfacePalette,
  derivePaletteFromBase,
} from "../render/derive-palette.js";
import { resolveTier2Defaults } from "../render/resolve-tier2.js";
import { ROLE_KEYS } from "../storage/defaults.js";

const VALID_PRESETS = new Set([...Object.keys(SURFACE_PRESETS), "custom"]);

/**
 * Accent suggestions exposed in the admin form as quick-pick swatches.
 * Per Theming v2 spec §11.7 — these populate the accentBase color input
 * with a click; the underlying accentBase remains a free color picker.
 *
 * @type {ReadonlyArray<{slug: string, label: string, hex: string}>}
 */
export const ACCENT_SUGGESTIONS = Object.freeze([
  Object.freeze({ slug: "amber",    label: "Amber",    hex: "#b45309" }),
  Object.freeze({ slug: "blue",     label: "Blue",     hex: "#2563eb" }),
  Object.freeze({ slug: "teal",     label: "Teal",     hex: "#0d9488" }),
  Object.freeze({ slug: "purple",   label: "Purple",   hex: "#7c3aed" }),
  Object.freeze({ slug: "rose",     label: "Rose",     hex: "#e11d48" }),
  Object.freeze({ slug: "emerald",  label: "Emerald",  hex: "#059669" }),
  Object.freeze({ slug: "orange",   label: "Orange",   hex: "#ea580c" }),
  Object.freeze({ slug: "slate",    label: "Slate",    hex: "#475569" }),
]);

/**
 * Surface presets exposed in the admin form. v1 ships 3; Theming v2 spec
 * §11.7 plans 5 (adds warm-gray + stone) but those land in Phase 2c. The
 * "custom" option is appended in the view.
 *
 * @type {ReadonlyArray<{slug: string, label: string}>}
 */
export const SURFACE_PRESET_OPTIONS = Object.freeze([
  Object.freeze({ slug: "warm-stone",   label: "Warm Stone" }),
  Object.freeze({ slug: "cool-slate",   label: "Cool Slate" }),
  Object.freeze({ slug: "neutral-zinc", label: "Neutral Zinc" }),
]);

/**
 * Compute the palette-derived Tier 2 defaults for both light and dark modes.
 * The view uses this to pre-populate the role color inputs (when no override
 * is set) so users see a sensible starting color rather than a fallback gray.
 *
 * Returns a shape compatible with the role-override macro:
 *   { heading: { light, dark }, fg: { light, dark }, ... }
 *
 * @param {string} surfacePreset
 * @param {Record<string|number, string> | null} surfaceCustom
 * @param {string} accentBase
 * @returns {Record<string, { light: string, dark: string }>}
 */
export function computeRoleDefaults(surfacePreset, surfaceCustom, accentBase) {
  const surface = getSurfacePalette(surfacePreset, surfaceCustom);
  const accent = derivePaletteFromBase(accentBase);
  const lightDefaults = resolveTier2Defaults(surface, accent, "light");
  const darkDefaults = resolveTier2Defaults(surface, accent, "dark");
  const out = {};
  for (const role of ROLE_KEYS) {
    out[role] = { light: lightDefaults[role], dark: darkDefaults[role] };
  }
  return out;
}

/**
 * Pure form-body parser. Returns either:
 *   { ok: true, patch: { branding: { ... } } }  on success
 *   { ok: false, status: 400, message: "..." }  on validation failure
 *
 * Extracted from the POST handler so it can be unit-tested without an
 * Express request, MongoDB connection, or filesystem writes. The POST
 * handler is then a thin wrapper that does the I/O.
 *
 * Forward-compat semantics: when a role's _light/_dark/_inherit fields
 * are entirely absent from the body, the existing override (from
 * `currentRoles`) is preserved. Forms that don't render every role
 * therefore won't wipe roles they didn't expose.
 *
 * @param {Record<string, unknown>} body - Form body (from express.urlencoded)
 * @param {Record<string, unknown>} currentRoles - The current roles map from
 *   the persisted config; used for the "field absent" fallback.
 * @returns {
 *   | { ok: true, patch: { branding: object } }
 *   | { ok: false, status: number, message: string }
 * }
 */
export function parseBrandingForm(body, currentRoles = {}) {
  body = body || {};

  // ── Tier 1 inputs ────────────────────────────────────────────────────
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
      return {
        ok: false,
        status: 400,
        message: `Custom palette is missing tones: ${missing.join(", ")}`,
      };
    }
  }

  const accentBase = normalizeHex(body.accentBase);
  if (!accentBase) {
    return { ok: false, status: 400, message: "Invalid accentBase" };
  }

  const accentPreset =
    typeof body.accentPreset === "string" && body.accentPreset.length > 0
      ? body.accentPreset
      : null;

  // ── Mode ─────────────────────────────────────────────────────────────
  const mode = isValidMode(body.mode) ? body.mode : "auto";

  // ── Tier 2 role overrides ───────────────────────────────────────────
  const roles = {};
  for (const role of ROLE_KEYS) {
    const inherit = body[`roles_${role}_inherit`] === "1";
    const lightRaw = body[`roles_${role}_light`];
    const darkRaw = body[`roles_${role}_dark`];
    const fieldsPresent =
      inherit
        || lightRaw !== undefined
        || darkRaw !== undefined;

    if (inherit) {
      roles[role] = null;
    } else if (lightRaw !== undefined && darkRaw !== undefined) {
      const light = normalizeHex(lightRaw);
      const dark = normalizeHex(darkRaw);
      if (!light || !dark) {
        return {
          ok: false,
          status: 400,
          message: `Invalid override for role "${role}"`,
        };
      }
      const override = { light, dark };
      if (!isValidColorOverride(override)) {
        return {
          ok: false,
          status: 400,
          message: `Invalid override for role "${role}"`,
        };
      }
      roles[role] = override;
    } else if (!fieldsPresent) {
      // Field not present in body — keep existing value (forward-compat).
      roles[role] = currentRoles[role] ?? null;
    } else {
      // Partial submission (only light OR only dark) is rejected.
      return {
        ok: false,
        status: 400,
        message: `Incomplete override for role "${role}" — both light and dark required`,
      };
    }
  }

  // ── Typography (unchanged from v1) ──────────────────────────────────
  const typography = {
    hosting: ["self", "bunny"].includes(body.typography_hosting)
      ? body.typography_hosting
      : "self",
  };
  for (const cat of ["sans", "serif", "mono"]) {
    const name = body[`typography_${cat}`];
    if (!isValidFont(name, cat)) {
      return {
        ok: false,
        status: 400,
        message: `Invalid font for ${cat}: ${name}`,
      };
    }
    typography[cat] = name;
  }

  return {
    ok: true,
    patch: {
      branding: {
        surfacePreset,
        surfaceCustom,
        accentBase,
        accentPreset,
        mode,
        roles,
        typography,
      },
    },
  };
}

/**
 * Branding controller (Theming v2 — Phase 2b).
 *
 * Exposes the 12-control taxonomy:
 *   - Palette (3): surfacePreset, accentBase, mode
 *   - Text (3): heading, fg (body), fgMuted (muted)
 *   - Interaction (3): link, action, focus
 *   - Structure (2): surface (panel role), border
 *   - Advanced (1, hidden): bg (page background) + actionFg + custom surface tones
 *
 * Form fields per role (10 roles total — Phase 2b exposes 9 to users via UI;
 * actionFg + bg live behind an "advanced" toggle):
 *   roles_<role>_inherit = "1"           → null (inherit palette default)
 *   roles_<role>_light + roles_<role>_dark → { light, dark } override
 *   (If neither is provided, the existing value is preserved — forward-compat.)
 *
 * Save flow:
 *   1. parseBrandingForm → validated patch object.
 *   2. saveSiteConfig → deep-merge into MongoDB doc.
 *   3. writeSiteJson + writeThemeCss + writeCriticalCss → artifacts.
 *   4. Redirect to ?saved=1 (canonical pattern from CV plugin).
 */
export function brandingRouter(Indiekit) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      // Compute palette-derived defaults so the view can pre-populate role
      // color inputs with sensible values (instead of #888) when no override
      // has been set yet. Wrapped in try/catch — bad accentBase shouldn't
      // brick the form; fall back to a neutral default so the user can fix it.
      let roleDefaults;
      try {
        roleDefaults = computeRoleDefaults(
          config.branding.surfacePreset,
          config.branding.surfaceCustom,
          config.branding.accentBase,
        );
      } catch (error) {
        // Surface the recovery to the operator via the page hint, but never
        // crash the GET handler — the form is the user's recovery surface.
        roleDefaults = Object.fromEntries(
          ROLE_KEYS.map((r) => [r, { light: "#888888", dark: "#888888" }]),
        );
      }

      res.render("site-config-branding", {
        config,
        activeTab: "branding",
        curatedFonts: CURATED_FONTS,
        roleDefaults,
        surfacePresets: SURFACE_PRESET_OPTIONS,
        accentSuggestions: ACCENT_SUGGESTIONS,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const existing = await getSiteConfig(Indiekit);
      const result = parseBrandingForm(req.body || {}, existing.branding?.roles || {});
      if (!result.ok) {
        return res.status(result.status).send(result.message);
      }

      const userIdent = Indiekit.config?.publication?.me || "unknown";
      const updated = await saveSiteConfig(Indiekit, result.patch, userIdent);
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
