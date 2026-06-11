/**
 * Generalized URL validator for block/composition config fields (spec §6).
 * Accepts root-relative paths and https/http absolute URLs; rejects
 * javascript:/data:/file:, localhost, and RFC1918 private ranges (SSRF).
 * Generalizes the hero-only safeHeroLink. Returns the trimmed URL or null.
 * @module validators/config-url
 */

const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|::1)$/i;
const RFC1918 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * @param {unknown} raw
 * @param {{ allowExternal?: boolean }} [opts]
 * @returns {string | null}
 */
export function safeConfigUrl(raw, { allowExternal = true } = {}) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return null;
  if (v.startsWith("/")) return v;
  if (!allowExternal) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (PRIVATE_HOST.test(host) || RFC1918.test(host)) return null;
    return u.href;
  } catch {
    return null;
  }
}
