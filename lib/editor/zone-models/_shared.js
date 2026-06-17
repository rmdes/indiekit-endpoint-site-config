/**
 * Shared zone-model helpers — the recognition/rebuild primitives common to
 * every per-surface zone-model (homepage, listing, …). Extracted VERBATIM
 * from the original homepage zone-model so behavior is byte-for-byte
 * unchanged: the per-surface models differ only in WHICH container shapes
 * they accept, not in HOW a single container is matched.
 *
 * STRICTNESS IS THE CONTRACT (see homepage.js for the full rationale): these
 * helpers match precisely the migrator's container shapes and nothing else.
 * Extra keys ⇒ reject (build rebuilds containers from scratch, so any
 * unrecognized key would be silently dropped on save). Never throw, never
 * lossy-coerce.
 *
 * Pure module: no db, no Indiekit, no fs.
 * @module editor/zone-models/_shared
 */

// The migrator's complementary (sidebar) variant token, replicated EXACTLY
// (migrate-v3-to-v4.js: stack(..., { sticky: true })).
export const COMPLEMENTARY_VARIANT = Object.freeze({ sticky: true });

// Exact own-key sets per recognized container slot. Extra keys ⇒ reject:
// build rebuilds containers from scratch, so any unrecognized key would be
// silently dropped on save.
export const PLAIN_STACK_KEYS = ["block", "id", "as", "role", "children"];
export const VARIANT_CONTAINER_KEYS = ["block", "id", "as", "role", "variant", "children"];

/** @param {unknown} value @returns {boolean} */
export const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Flat deep-equal for variant objects (variants are single-level maps of
 * primitive tokens).
 * @param {unknown} actual
 * @param {object} expected
 * @returns {boolean}
 */
export function variantEquals(actual, expected) {
  if (!isPlainObject(actual)) return false;
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length) return false;
  return keys.every((key) => actual[key] === expected[key]);
}

/**
 * Recognize a container node in one of the migrator's exact slot shapes.
 * @param {unknown} node
 * @param {object} shape
 * @param {string} shape.as
 * @param {string} shape.role
 * @param {object} [shape.variant] Required variant (exact match); absent ⇒
 *   the node must carry NO variant key at all
 * @returns {boolean}
 */
export function matchesContainer(node, { as, role, variant }) {
  if (!isPlainObject(node) || node.block !== "container") return false;
  if (typeof node.id !== "string" || node.id === "") return false;
  if (node.as !== as || node.role !== role) return false;
  if (!Array.isArray(node.children)) return false;
  const expectedKeys = variant ? VARIANT_CONTAINER_KEYS : PLAIN_STACK_KEYS;
  const keys = Object.keys(node).sort();
  if (keys.length !== expectedKeys.length || !expectedKeys.every((k) => keys.includes(k))) {
    return false;
  }
  if (variant && !variantEquals(node.variant, variant)) return false;
  return true;
}

/** Zone children must be section nodes only — a nested container ⇒ reject. */
export const allSections = (children) =>
  children.every((child) => isPlainObject(child) && child.block === "section");
