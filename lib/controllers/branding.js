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
import { ROLE_KEYS, DEFAULTS, emptyRoles } from "../storage/defaults-site.js";
import {
  validateBranding,
  partitionContrastResults,
} from "../validators/contrast.js";

const VALID_PRESETS = new Set([...Object.keys(SURFACE_PRESETS), "custom"]);

/** Maximum number of history snapshots retained per spec §11.2. */
export const HISTORY_LIMIT = 10;

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
 * Surface presets exposed in the admin form. Phase 2c ships all 5 per
 * Theming v2 spec §11.7. The "custom" option is appended in the view.
 *
 * @type {ReadonlyArray<{slug: string, label: string}>}
 */
export const SURFACE_PRESET_OPTIONS = Object.freeze([
  Object.freeze({ slug: "warm-stone", label: "Warm Stone" }),
  Object.freeze({ slug: "clay",       label: "Clay" }),
  Object.freeze({ slug: "stone",      label: "Stone (Neutral)" }),
  Object.freeze({ slug: "cool-slate", label: "Cool Slate" }),
  Object.freeze({ slug: "sage",       label: "Sage" }),
]);

/**
 * The seven sections that the per-section reset button can target.
 *
 * @type {ReadonlyArray<"palette" | "text" | "interaction" | "structure" | "advanced" | "typography" | "all">}
 */
export const RESET_SECTIONS = Object.freeze([
  "palette",
  "text",
  "interaction",
  "structure",
  "advanced",
  "typography",
  "all",
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
 * Build a fresh history snapshot from the current branding subtree.
 * Strips the existing `history` field so snapshots don't nest.
 *
 * @param {object} branding - Current branding subtree
 * @param {string} userIdent - Email/profile identifier of the saver (kept
 *   in MongoDB but stripped from the public site-config.json by the JSON
 *   writer — see lib/render/write-site-json.js).
 * @returns {{ snapshot: object, savedAt: string, savedBy: string }}
 */
export function buildHistorySnapshot(branding, userIdent) {
  const { history: _drop, ...rest } = branding || {};
  return {
    snapshot: rest,
    savedAt: new Date().toISOString(),
    savedBy: userIdent || "unknown",
  };
}

/**
 * Prepend a snapshot to the history ring, capped at HISTORY_LIMIT entries.
 *
 * @param {Array<object>} history - Existing history ring (may be undefined)
 * @param {object} snapshot
 * @returns {Array<object>} Fresh array
 */
export function prependHistory(history, snapshot) {
  const next = [snapshot, ...(Array.isArray(history) ? history : [])];
  return next.slice(0, HISTORY_LIMIT);
}

/**
 * Pure form-body parser. Returns either:
 *   { ok: true, patch: { branding: { ... } } }            on success
 *   { ok: true, patch: ..., warnings: [...] }             on success with warnings
 *   { ok: false, status: 400, message, contrastErrors? }  on validation failure
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
 * Phase 2c adds APCA contrast validation: critical token pairs (body vs bg,
 * heading vs bg, link vs bg, action-fg vs action) are evaluated for both
 * light and dark resolved values. Fails block the save (returns ok:false);
 * warnings are returned alongside the patch so the controller can flash them.
 *
 * @param {Record<string, unknown>} body - Form body (from express.urlencoded)
 * @param {Record<string, unknown>} currentRoles - The current roles map from
 *   the persisted config; used for the "field absent" fallback.
 * @param {object} [options]
 * @param {boolean} [options.skipContrastCheck=false] - When true, contrast
 *   validation is skipped entirely. Used by the live preview endpoint, which
 *   must always succeed so the user can SEE a contrast problem to fix it.
 * @returns {
 *   | { ok: true, patch: { branding: object }, warnings: Array, resolved: object }
 *   | { ok: false, status: number, message: string, contrastErrors?: Array }
 * }
 */
export function parseBrandingForm(body, currentRoles = {}, options = {}) {
  body = body || {};
  const skipContrastCheck = options.skipContrastCheck === true;

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

  const branding = {
    surfacePreset,
    surfaceCustom,
    accentBase,
    accentPreset,
    mode,
    roles,
    typography,
  };

  // ── Contrast validation (Phase 2c) ──────────────────────────────────
  // Resolve both light and dark Tier 2 maps and check critical token pairs.
  // Hard-fails block the save with a 400; warnings are returned alongside
  // the patch so the controller can flash them on redirect.
  if (!skipContrastCheck) {
    const contrastResults = validateBranding(branding);
    const { failures, warnings } = partitionContrastResults(contrastResults);
    if (failures.length > 0) {
      return {
        ok: false,
        status: 400,
        message:
          "Contrast check failed — " +
          failures.map((f) => f.message).join("; "),
        contrastErrors: failures,
      };
    }
    return {
      ok: true,
      patch: { branding },
      warnings,
    };
  }

  return {
    ok: true,
    patch: { branding },
    warnings: [],
  };
}

/**
 * Produce a fresh branding subtree for a "reset to defaults" of a specific
 * section. Each section corresponds to the form groupings in the admin view.
 *
 * Reset semantics — the goal is to discard the user's overrides for the
 * section and let palette-derived defaults take over. For "palette" we
 * restore the default surface preset and accent base.
 *
 * @param {object} currentBranding - The current branding subtree
 * @param {"palette" | "text" | "interaction" | "structure" | "advanced" | "typography" | "all"} section
 * @returns {object} Fresh branding subtree
 */
export function resetBrandingSection(currentBranding, section) {
  const base = { ...currentBranding };
  // Always start from a fresh roles object so we don't mutate the caller's.
  const roles = { ...(currentBranding.roles || {}) };
  base.roles = roles;

  if (section === "all") {
    // Wipe everything except history (history is mutated by the caller
    // who first snapshotted the pre-reset state).
    return {
      surfacePreset: DEFAULTS.branding.surfacePreset,
      surfaceCustom: DEFAULTS.branding.surfaceCustom,
      accentBase: DEFAULTS.branding.accentBase,
      accentPreset: DEFAULTS.branding.accentPreset,
      mode: DEFAULTS.branding.mode,
      roles: emptyRoles(),
      typography: { ...DEFAULTS.branding.typography },
      logo: currentBranding.logo ?? DEFAULTS.branding.logo,
      favicon: currentBranding.favicon ?? DEFAULTS.branding.favicon,
      history: currentBranding.history || [],
    };
  }

  if (section === "palette") {
    base.surfacePreset = DEFAULTS.branding.surfacePreset;
    base.surfaceCustom = DEFAULTS.branding.surfaceCustom;
    base.accentBase = DEFAULTS.branding.accentBase;
    base.accentPreset = DEFAULTS.branding.accentPreset;
    base.mode = DEFAULTS.branding.mode;
    return base;
  }

  if (section === "text") {
    roles.heading = null;
    roles.fg = null;
    roles.fgMuted = null;
    return base;
  }

  if (section === "interaction") {
    roles.link = null;
    roles.action = null;
    roles.focus = null;
    return base;
  }

  if (section === "structure") {
    roles.surface = null;
    roles.border = null;
    return base;
  }

  if (section === "advanced") {
    roles.bg = null;
    roles.actionFg = null;
    return base;
  }

  if (section === "typography") {
    base.typography = { ...DEFAULTS.branding.typography };
    return base;
  }

  // Unknown section — return unchanged (defensive)
  return currentBranding;
}

/**
 * Re-run contrast validation on a branding subtree and report whether any
 * critical pair warns or fails. Used by the /reset and /revert handlers to
 * flash a (non-blocking) warning when a restored/reset state isn't legible.
 *
 * Reuses the exact validator call convention the save handler relies on
 * (`validateBranding` → `partitionContrastResults`). Wrapped in try/catch
 * because palette derivation throws on a malformed accentBase — a validation
 * hiccup must never block the operator's escape hatch, so we degrade to "no
 * issues" rather than throwing.
 *
 * @param {object} branding - Branding subtree (reset/restored state)
 * @returns {boolean} true when at least one pair is "warn" or "fail"
 */
function brandingHasContrastIssues(branding) {
  try {
    const results = validateBranding(branding);
    return results.some((r) => r.status === "warn" || r.status === "fail");
  } catch {
    return false;
  }
}

/**
 * Branding controller (Theming v2 — Phase 2c).
 *
 * Exposes the 12-control taxonomy plus Phase 2c production-readiness work:
 *   - APCA contrast validation (hard block + soft warn)
 *   - Version history (snapshot on save, revert endpoint)
 *   - Reset-to-defaults (per-section + all)
 *
 * Routes:
 *   GET  /            — Render the branding form + history + preview iframe
 *   POST /            — Save branding patch (snapshots prior state to history)
 *   POST /reset       — Reset a section to defaults (snapshots prior state)
 *   POST /revert      — Revert to a specific history entry (snapshots prior state)
 *
 * Save flow:
 *   1. parseBrandingForm → validated patch object + contrast warnings/errors.
 *   2. Snapshot current branding to history[0] (slice to HISTORY_LIMIT).
 *   3. saveSiteConfig → deep-merge into MongoDB doc.
 *   4. writeSiteJson + writeThemeCss + writeCriticalCss → artifacts.
 *   5. Redirect to ?saved=1 (and ?warn=1 when contrast warnings exist).
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

      // Compute live contrast status for the current persisted state so
      // the view can show inline warnings even before the user touches
      // anything. Wrapped in try/catch because a broken accentBase would
      // throw in palette derivation.
      let contrastResults = [];
      try {
        contrastResults = validateBranding(config.branding);
      } catch (error) {
        contrastResults = [];
      }
      const { failures: contrastFailures, warnings: contrastWarnings } =
        partitionContrastResults(contrastResults);

      res.render("site-config-branding", {
        config,
        activeTab: "branding",
        // Flash flags: the admin Nunjucks env doesn't expose `request`, so
        // the redirect query params must be passed through as locals.
        saved: req.query?.saved,
        warn: req.query?.warn,
        reverted: req.query?.reverted,
        reset: req.query?.reset,
        resetSection: req.query?.section,
        curatedFonts: CURATED_FONTS,
        roleDefaults,
        // Attach each preset's tone ramp (50→950) so the view can render a
        // swatch strip — letting operators SEE each palette's identity before
        // selecting it (the light-end tones look similar; the ramp shows the
        // full character of each preset).
        surfacePresets: SURFACE_PRESET_OPTIONS.map((opt) => ({
          ...opt,
          ramp: Object.values(SURFACE_PRESETS[opt.slug] || {}),
        })),
        accentSuggestions: ACCENT_SUGGESTIONS,
        contrastResults,
        contrastFailures,
        contrastWarnings,
        historyEntries: Array.isArray(config.branding.history)
          ? config.branding.history
          : [],
        resetSections: RESET_SECTIONS,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const existing = await getSiteConfig(Indiekit);
      const result = parseBrandingForm(
        req.body || {},
        existing.branding?.roles || {},
      );
      if (!result.ok) {
        return res.status(result.status).send(result.message);
      }

      const userIdent = Indiekit.config?.publication?.me || "unknown";

      // Snapshot the current state BEFORE applying the patch so the user
      // can revert. The snapshot is stored alongside the patch in the
      // same write so MongoDB sees one atomic transition.
      const snapshot = buildHistorySnapshot(existing.branding || {}, userIdent);
      const nextHistory = prependHistory(existing.branding?.history, snapshot);

      // Merge the new branding patch with the new history ring.
      const patch = {
        branding: {
          ...result.patch.branding,
          history: nextHistory,
        },
      };

      const updated = await saveSiteConfig(Indiekit, patch, userIdent);
      await writeSiteJson(updated);
      await writeThemeCss(updated);
      await writeCriticalCss(updated);

      // Redirect with warn=1 query param so the view can surface the
      // contrast warnings on the next render.
      const warnFlag = result.warnings && result.warnings.length > 0 ? "&warn=1" : "";
      res.redirect(`/site-config/branding?saved=1${warnFlag}`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/reset", async (req, res, next) => {
    try {
      const section = (req.body && req.body.section) || "all";
      if (!RESET_SECTIONS.includes(section)) {
        return res.status(400).send(`Unknown reset section: ${section}`);
      }

      const existing = await getSiteConfig(Indiekit);
      const userIdent = Indiekit.config?.publication?.me || "unknown";

      // Snapshot pre-reset state so the user can undo the reset itself.
      const snapshot = buildHistorySnapshot(existing.branding || {}, userIdent);
      const nextHistory = prependHistory(existing.branding?.history, snapshot);

      const resetBranding = resetBrandingSection(existing.branding || {}, section);
      resetBranding.history = nextHistory;

      const updated = await saveSiteConfig(
        Indiekit,
        { branding: resetBranding },
        userIdent,
      );
      await writeSiteJson(updated);
      await writeThemeCss(updated);
      await writeCriticalCss(updated);

      // Re-run contrast validation on the reset state. A reset that restores
      // palette-derived defaults should normally pass, but custom surfaces /
      // accents can still produce low-contrast pairs — flash a warning so the
      // operator knows. Never block the reset (flash-only escape hatch).
      const hasIssues = brandingHasContrastIssues(resetBranding);
      const warnFlag = hasIssues ? "&warn=1" : "";
      res.redirect(
        `/site-config/branding?reset=1&section=${encodeURIComponent(section)}${warnFlag}`,
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/revert", async (req, res, next) => {
    try {
      const indexRaw = req.body && req.body.index;
      const index = Number.parseInt(indexRaw, 10);
      if (!Number.isInteger(index) || index < 0 || index >= HISTORY_LIMIT) {
        return res.status(400).send(`Invalid history index: ${indexRaw}`);
      }

      const existing = await getSiteConfig(Indiekit);
      const history = Array.isArray(existing.branding?.history)
        ? existing.branding.history
        : [];
      const entry = history[index];
      if (!entry || !entry.snapshot) {
        return res.status(404).send(`No history entry at index ${index}`);
      }

      const userIdent = Indiekit.config?.publication?.me || "unknown";

      // Snapshot current state so the user can undo the revert itself.
      const snapshot = buildHistorySnapshot(existing.branding || {}, userIdent);
      const nextHistory = prependHistory(history, snapshot);

      // Restore the snapshot, attaching the new history ring.
      const restored = {
        ...entry.snapshot,
        history: nextHistory,
      };

      const updated = await saveSiteConfig(
        Indiekit,
        { branding: restored },
        userIdent,
      );
      await writeSiteJson(updated);
      await writeThemeCss(updated);
      await writeCriticalCss(updated);

      // Re-run contrast validation on the restored state. A historical snapshot
      // may have been saved before a stricter threshold (or with a since-changed
      // palette), so it can fail contrast now — flash a warning. Never block the
      // revert (operators need an escape hatch back to a known-good state).
      const hasIssues = brandingHasContrastIssues(restored);
      const warnFlag = hasIssues ? "&warn=1" : "";
      res.redirect(`/site-config/branding?reverted=1${warnFlag}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// Re-exported for tests / future controllers
export { isValidHexColor };
