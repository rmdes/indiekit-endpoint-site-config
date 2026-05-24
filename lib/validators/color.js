/**
 * Color and theming-input validators.
 *
 * Hex validation uses a regex rather than culori because the responsibilities
 * are different: this module guards user input (predicate + normalize); the
 * palette derivation layer (lib/render/derive-palette.js) uses culori for
 * OKLCH conversion and scale generation. Keeping the two paths separate avoids
 * pulling a 50kb color library into the validator's hot path.
 *
 * @module validators/color
 */

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const VALID_MODES = new Set(["light", "dark", "auto"]);

const REQUIRED_SCALE_KEYS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidHexColor(value) {
  return typeof value === "string" && HEX_RE.test(value);
}

/**
 * Normalize a hex string to lowercase 6-digit form (or 8-digit for alpha).
 * 3-digit hex is expanded.
 *
 * @param {unknown} value
 * @returns {string | null} Lowercased hex, or null if invalid.
 */
export function normalizeHex(value) {
  if (!isValidHexColor(value)) return null;
  const v = value.toLowerCase();
  if (v.length === 4) {
    return "#" + v[1].repeat(2) + v[2].repeat(2) + v[3].repeat(2);
  }
  return v;
}

/**
 * @param {unknown} value
 * @returns {boolean} true if value is one of "light" | "dark" | "auto".
 */
export function isValidMode(value) {
  return typeof value === "string" && VALID_MODES.has(value);
}

/**
 * A ColorOverride is `{ light: hex, dark: hex }` — both required when present.
 * `null` is also valid (means "inherit palette-derived default") but this
 * predicate only checks the object form; callers handle the null case.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidColorOverride(value) {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  return isValidHexColor(value.light) && isValidHexColor(value.dark);
}

/**
 * A palette scale object must contain all 11 standard keys
 * (50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950),
 * each mapped to a valid hex.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPaletteScale(value) {
  if (!value || typeof value !== "object") return false;
  for (const k of REQUIRED_SCALE_KEYS) {
    if (!isValidHexColor(value[k])) return false;
  }
  return true;
}
