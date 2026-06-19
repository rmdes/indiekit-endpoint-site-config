/**
 * v4 composition validation (spec §2.2 node shapes, §2.3 closed vocabulary,
 * §4 caps). Token policy per spec: unknown variant TOKENS are dropped with a
 * warning ("anything else is dropped at save"); structural problems, unknown
 * block types, schema violations and cap breaches are errors.
 *
 * Variant tokens are scoped per node kind (spec §2.3 table): containers carry
 * layout tokens (width/columns/span/gap/stackBelow/sticky), sections carry
 * block tokens (surface/listStyle/align). A token on the wrong node kind is
 * dropped with a warning, same as an unknown token.
 *
 * Throw-free by contract on any plain-data input (hostile docs, garbage
 * catalogs) and depth-guarded against pathologically nested trees.
 * @module validators/composition
 */
import { validateConfigAgainstSchema } from "./block-schema.js";
import { validatePageTarget } from "./page-route.js";

const KINDS = new Set(["homepage", "collection", "postType", "page"]);
const ROLES = new Set(["root", "main", "complementary", "contentinfo", "banner", "region"]);
const AS = new Set(["stack", "columns", "grid"]);
const STATUSES = new Set(["draft", "published"]);

// Spec §2.3 closed vocabulary, split by node kind. NOTE: `span` is classed
// container-level for now (a grid-12 child is expected to be a container);
// revisit in Phase 4 if sections become direct grid-12 children.
const CONTAINER_VARIANT_TOKENS = {
  width: new Set(["narrow", "default", "wide", "full"]),
  columns: new Set(["2-1", "1-2", "1-1", "thirds", "grid-12"]),
  span: new Set([3, 4, 6, 8, 9, 12]),
  gap: new Set(["tight", "normal", "loose"]),
  stackBelow: new Set(["sm", "md", "lg"]),
  sticky: "boolean",
};
const SECTION_VARIANT_TOKENS = {
  surface: new Set(["plain", "card", "accent"]),
  listStyle: new Set(["grid", "list", "compact"]),
  align: new Set(["start", "center"]),
};

const MAX_SECTIONS = 24;
const MAX_CUSTOM_HTML = 3;
// Hostile trees survive structuredClone yet can nest thousands of levels —
// without a guard the recursive walk blows the stack. Real compositions are
// a handful of levels deep; 32 is generous.
const MAX_DEPTH = 32;

/**
 * Keep only tokens from the closed vocabulary for this node kind; drop
 * everything else (unknown tokens, wrong-scope tokens, wrong-typed values)
 * with a warning. Spec §2.3: "anything else is dropped at save".
 * @param {unknown} variant
 * @param {object} tokens CONTAINER_VARIANT_TOKENS or SECTION_VARIANT_TOKENS
 * @param {string[]} warnings Accumulator (mutated)
 * @param {string} path Node path for warning messages
 * @returns {object | undefined} Filtered variant, or undefined when empty
 */
function filterVariant(variant, tokens, warnings, path) {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    // A PRESENT non-object variant is data loss the author should hear about
    // (drop-with-warning policy); an absent variant is just absent.
    if (variant !== undefined) warnings.push(`${path}: dropped non-object variant`);
    return undefined;
  }
  const kept = {};
  for (const [token, raw] of Object.entries(variant)) {
    // Object.hasOwn, not tokens[token]: a token named "constructor" or
    // "toString" (reachable via JSON.parse) would resolve prototype plumbing
    // and could masquerade as an allowed entry.
    const allowed = Object.hasOwn(tokens, token) ? tokens[token] : undefined;
    if (allowed === "boolean" && typeof raw === "boolean") kept[token] = raw;
    else if (allowed instanceof Set && allowed.has(raw)) kept[token] = raw;
    else warnings.push(`${path}: dropped variant token ${token}=${JSON.stringify(raw)}`);
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Validate a v4 composition document against the block catalog.
 *
 * Returns a normalized `value` alongside `ok`/`errors`/`warnings`. The input
 * document is NEVER mutated — `value` is a fresh tree.
 *
 * IMPORTANT semantics: section configs in `value` are the output of
 * `validateConfigAgainstSchema`, which MATERIALIZES SCHEMA DEFAULTS — so
 * `value` configs may carry keys the input never had. Callers choosing to
 * persist `value` must want that normalization. The Phase 2 migrator persists
 * RAW configs and uses this function only as a gate (validation is a gate,
 * not a transformer, for the migrator). When a tree exists, `value` is
 * populated even when `ok: false` (the early returns for a non-object doc or
 * missing tree carry no `value`) — callers MUST check `ok` before
 * persisting it.
 *
 * @param {unknown} doc Composition document (untrusted plain data)
 * @param {object[]} catalogEntries Block catalog (scanner output or fixture)
 * @param {{ stripUnknown?: boolean }} [options] Forwarded to config
 *   validation: stripUnknown drops unknown config keys with a warning instead
 *   of erroring (migrator mode for legacy configs)
 * @returns {{ ok: boolean, errors: string[], warnings: string[], value?: object }}
 */
export function validateComposition(doc, catalogEntries, options = {}) {
  const errors = [];
  const warnings = [];
  const catalog = new Map(
    (Array.isArray(catalogEntries) ? catalogEntries : [])
      .filter((e) => e && typeof e === "object" && typeof e.id === "string")
      .map((e) => [e.id, e]),
  );
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["composition must be an object"], warnings };
  }
  if (doc.schemaVersion !== 4) {
    let got;
    try {
      got = JSON.stringify(doc.schemaVersion);
    } catch {
      got = String(doc.schemaVersion); // circular plain data must not throw
    }
    errors.push(`schemaVersion must be 4 (got ${got})`);
  }
  if (!KINDS.has(doc.kind)) {
    errors.push(`kind must be one of ${[...KINDS].join("|")}`);
  }
  // 6.5-T2 (defense in depth): a `page` doc carries an operator-chosen
  // `target.route` (the public URL + the Eleventy output path) and a
  // `target.title`. The validator is the PUBLISH-path gate — it rejects a
  // bad/missing target even if the save-time slug guard (validators/
  // page-route.js) was bypassed, so the two layers never share state. This
  // checks SHAPE only (anchored single-segment route + required, length-capped
  // title); reserved-prefix and collision checks belong to the save-time guard
  // over the live DB, not to a pure validator. Other kinds (homepage/
  // collection/postType) keep their target UNVALIDATED — their target is
  // `{}`/`{collection:...}`/`{postType:...}` and is not security-bearing.
  if (doc.kind === "page") {
    const targetCheck = validatePageTarget(doc.target);
    if (!targetCheck.ok) errors.push(...targetCheck.errors);
  }
  if (doc.status !== undefined && !STATUSES.has(doc.status)) {
    errors.push("status must be draft|published");
  }
  if (!doc.tree || typeof doc.tree !== "object" || Array.isArray(doc.tree)) {
    errors.push("tree is required");
    return { ok: false, errors, warnings };
  }

  const seenIds = new Set();
  const typeCounts = new Map();
  let sectionCount = 0;

  const walk = (node, path, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`${path}: node must be an object`);
      // Primitives are immutable (no aliasing risk); arrays are copied so
      // `value` never shares mutable structure with the input.
      return Array.isArray(node) ? [...node] : node;
    }
    if (depth > MAX_DEPTH) {
      errors.push(`${path}: tree exceeds maximum depth ${MAX_DEPTH}`);
      return { ...node };
    }
    if (node.block === "container") {
      const out = { ...node };
      if (!AS.has(node.as)) {
        errors.push(`${path}: container.as must be ${[...AS].join("|")}`);
      }
      if (!ROLES.has(node.role)) {
        errors.push(`${path}: container.role must be ${[...ROLES].join("|")}`);
      }
      out.variant = filterVariant(node.variant, CONTAINER_VARIANT_TOKENS, warnings, path);
      if (out.variant === undefined) delete out.variant;
      // Absent children = legitimate empty container; only a PRESENT
      // non-array value is structural corruption.
      if (node.children !== undefined && !Array.isArray(node.children)) {
        errors.push(`${path}: container.children must be an array`);
        out.children = [];
        return out;
      }
      out.children = (node.children ?? []).map((child, index) =>
        walk(child, `${path}.children[${index}]`, depth + 1),
      );
      return out;
    }
    if (node.block === "section") {
      sectionCount += 1;
      const out = { ...node };
      if (typeof node.id !== "string" || node.id === "") {
        errors.push(`${path}: section.id is required`);
      } else if (seenIds.has(node.id)) {
        errors.push(`${path}: duplicate section id "${node.id}"`);
      } else {
        seenIds.add(node.id);
      }
      out.variant = filterVariant(node.variant, SECTION_VARIANT_TOKENS, warnings, path);
      if (out.variant === undefined) delete out.variant;
      const entry = typeof node.type === "string" ? catalog.get(node.type) : undefined;
      if (!entry) {
        errors.push(`${path}: unknown block type "${node.type}"`);
        return out;
      }
      typeCounts.set(node.type, (typeCounts.get(node.type) || 0) + 1);
      // node.config passes straight through: block-schema's own contract
      // treats null/undefined as empty and warns on other non-objects.
      const configResult = validateConfigAgainstSchema(node.config, entry.schema, options);
      errors.push(...configResult.errors.map((e) => `${path}: ${e}`));
      warnings.push(...configResult.warnings.map((w) => `${path}: ${w}`));
      out.config = configResult.value;
      return out;
    }
    errors.push(`${path}: unknown node kind "${node.block}"`);
    return { ...node };
  };

  const tree = walk(doc.tree, "tree", 0);
  if (sectionCount > MAX_SECTIONS) {
    errors.push(`too many blocks: ${sectionCount} > ${MAX_SECTIONS}`);
  }
  const customHtmlCount = typeCounts.get("custom-html") || 0;
  if (customHtmlCount > MAX_CUSTOM_HTML) {
    errors.push(`custom-html blocks: ${customHtmlCount} > ${MAX_CUSTOM_HTML}`);
  }
  for (const [type, count] of typeCounts) {
    const entry = catalog.get(type);
    if (entry && entry.multiple === false && count > 1) {
      errors.push(`block "${type}" allows only one instance (found ${count})`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, value: { ...doc, tree } };
}
