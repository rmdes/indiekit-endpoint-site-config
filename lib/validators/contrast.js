/**
 * APCA contrast validator (Theming v2 — Phase 2c).
 *
 * Validates that the critical Tier 2 token pairs have enough contrast to be
 * legible. Uses APCA Lc rather than WCAG 2.x because APCA correlates much
 * better with perceived contrast in both light and dark backgrounds. The
 * design decision lives in spec §16.3.
 *
 * Lc is signed and roughly in the range -108..+106:
 *   - Positive: text is darker than background (light theme typical)
 *   - Negative: text is lighter than background (dark theme typical)
 * Magnitude (|Lc|) is what matters for legibility.
 *
 * Thresholds (spec §11.1, expressed as absolute Lc):
 *   - Hard fail (block save): |Lc| < 30 body, |Lc| < 45 heading
 *     (rough WCAG 3:1 equivalent — content is effectively unreadable)
 *   - Warn (allow save, flash warning): |Lc| < 45 body, |Lc| < 60 heading
 *     (rough WCAG 4.5:1 equivalent — content is functional but uncomfortable)
 *   - Pass: above the warn threshold
 *
 * We validate light and dark modes independently so a fail on the light side
 * does not flag the (potentially fine) dark side and vice versa.
 *
 * @module validators/contrast
 */

import { calcAPCA } from "apca-w3";
import { resolveBothModes } from "../render/write-theme-css.js";

/**
 * The four critical pairs we audit per the v2 spec §11.1. Each entry:
 *   text  — role whose foreground we are checking
 *   bg    — role we render the text against
 *   kind  — "body" or "heading"  (drives threshold tier)
 *   label — human-readable label for error messages
 *
 * `actionFg` is checked against `action` (the button background) — this is
 * the role pair most likely to silently fail because users rarely think to
 * contrast-check their CTA button text against its custom background.
 *
 * @type {ReadonlyArray<{ text: string, bg: string, kind: "body" | "heading", label: string }>}
 */
export const CRITICAL_PAIRS = Object.freeze([
  Object.freeze({ text: "fg",       bg: "bg",     kind: "body",    label: "Body text" }),
  Object.freeze({ text: "heading",  bg: "bg",     kind: "heading", label: "Heading" }),
  Object.freeze({ text: "link",     bg: "bg",     kind: "body",    label: "Link" }),
  Object.freeze({ text: "actionFg", bg: "action", kind: "body",    label: "Action button text" }),
]);

/**
 * Thresholds per spec §11.1. Hard block when |Lc| < `fail`. Warn when
 * `fail` <= |Lc| < `warn`. Pass otherwise.
 */
const THRESHOLDS = Object.freeze({
  body:    Object.freeze({ fail: 30, warn: 45 }),
  heading: Object.freeze({ fail: 45, warn: 60 }),
});

/**
 * Compute the APCA Lc value for a text/background hex pair.
 * Returns the signed Lc (or null if either input is invalid).
 *
 * @param {string} textColor - Hex string like "#rrggbb"
 * @param {string} bgColor   - Hex string like "#rrggbb"
 * @returns {number | null}
 */
export function computeLc(textColor, bgColor) {
  if (typeof textColor !== "string" || typeof bgColor !== "string") return null;
  try {
    const lc = calcAPCA(textColor, bgColor);
    if (typeof lc !== "number" || Number.isNaN(lc)) return null;
    return lc;
  } catch {
    return null;
  }
}

/**
 * Classify a Lc value against the thresholds for its kind.
 *
 * @param {number} lc
 * @param {"body" | "heading"} kind
 * @returns {"pass" | "warn" | "fail"}
 */
function classify(lc, kind) {
  const t = THRESHOLDS[kind] || THRESHOLDS.body;
  const mag = Math.abs(lc);
  if (mag < t.fail) return "fail";
  if (mag < t.warn) return "warn";
  return "pass";
}

/**
 * Validate the critical Tier 2 token pairs for a single resolved hex map.
 * Returns one entry per pair, including pass entries (callers may want to
 * render them as green badges in a future UI).
 *
 * @param {Record<string, string>} resolved - Tier 2 hex map for one mode
 *   (output of `applyOverrides`). Must contain at least the roles named
 *   in CRITICAL_PAIRS.
 * @param {"light" | "dark"} mode - Tag attached to each result entry so the
 *   view can render mode-specific badges.
 * @returns {Array<{
 *   pair: string,        // e.g. "fg vs bg"
 *   text: string,        // role key
 *   bg: string,          // role key
 *   kind: "body" | "heading",
 *   label: string,
 *   mode: "light" | "dark",
 *   textColor: string,
 *   bgColor: string,
 *   lc: number | null,
 *   status: "pass" | "warn" | "fail",
 *   message: string,
 * }>}
 */
export function validateResolved(resolved, mode) {
  const out = [];
  for (const pair of CRITICAL_PAIRS) {
    const textColor = resolved[pair.text];
    const bgColor = resolved[pair.bg];
    const lc = computeLc(textColor, bgColor);
    if (lc === null) {
      out.push({
        pair: `${pair.text} vs ${pair.bg}`,
        text: pair.text,
        bg: pair.bg,
        kind: pair.kind,
        label: pair.label,
        mode,
        textColor: textColor || "",
        bgColor: bgColor || "",
        lc: null,
        status: "fail",
        message: `${pair.label} (${mode}): could not compute contrast — invalid color`,
      });
      continue;
    }
    const status = classify(lc, pair.kind);
    const rounded = Math.round(lc * 10) / 10;
    const message =
      status === "pass"
        ? `${pair.label} (${mode}): Lc ${rounded} — passes`
        : status === "warn"
        ? `${pair.label} (${mode}): Lc ${rounded} — low contrast, may be hard to read`
        : `${pair.label} (${mode}): Lc ${rounded} — fails contrast, will be unreadable`;
    out.push({
      pair: `${pair.text} vs ${pair.bg}`,
      text: pair.text,
      bg: pair.bg,
      kind: pair.kind,
      label: pair.label,
      mode,
      textColor,
      bgColor,
      lc,
      status,
      message,
    });
  }
  return out;
}

/**
 * Top-level contrast validator. Resolves both light and dark Tier 2 hex maps
 * from a branding subtree, then validates each mode independently. If the
 * configured mode is "light" or "dark", we still check both modes (operators
 * frequently flip modes back and forth) but the view can choose to surface
 * only the active one if it wants.
 *
 * @param {object} branding - Branding subtree from the merged site config
 * @returns {Array<ReturnType<typeof validateResolved>[number]>}
 *   Flat array of result entries — entries are tagged with `.mode` so the
 *   view can group them by light/dark.
 */
export function validateBranding(branding) {
  const { light, dark } = resolveBothModes(branding);
  const mode = branding.mode || "auto";
  if (mode === "light") return validateResolved(light, "light");
  if (mode === "dark") return validateResolved(dark, "dark");
  return [...validateResolved(light, "light"), ...validateResolved(dark, "dark")];
}

/**
 * Split a validation result set into actionable buckets. Convenience for
 * controllers that need to decide "do I block this save or not".
 *
 * @param {Array<ReturnType<typeof validateResolved>[number]>} results
 * @returns {{
 *   failures: typeof results,
 *   warnings: typeof results,
 *   passes: typeof results,
 * }}
 */
export function partitionContrastResults(results) {
  const failures = [];
  const warnings = [];
  const passes = [];
  for (const r of results) {
    if (r.status === "fail") failures.push(r);
    else if (r.status === "warn") warnings.push(r);
    else passes.push(r);
  }
  return { failures, warnings, passes };
}
