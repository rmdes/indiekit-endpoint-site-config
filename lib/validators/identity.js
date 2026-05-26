/**
 * Identity field validators.
 * @module validators/identity
 */

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CATEGORY_LEN = 100;

/**
 * @param {unknown} value
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {boolean}
 */
export function isValidUrl(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return false;
  if (value === "") return allowEmpty;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {boolean}
 */
export function isValidEmail(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return false;
  if (value === "") return allowEmpty;
  return EMAIL_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidLocale(value) {
  if (typeof value !== "string") return false;
  return LOCALE_RE.test(value);
}

/**
 * Normalize categories input to a trimmed, non-empty string array.
 * Accepts CSV strings or arrays.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeCategoriesInput(value) {
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCategoriesList(value) {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (typeof entry !== "string") return false;
    if (entry.length > MAX_CATEGORY_LEN) return false;
  }
  return true;
}
