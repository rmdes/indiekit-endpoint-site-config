/**
 * Blocks contract v2 — entry validation + legacy synthesis (spec §3.1).
 * validBlockEntry is the STRICT gate for plugin-declared `get blocks()`
 * entries (the legacy {id,label} check would pass schema-less entries into
 * block-catalog.json). Legacy getter entries bypass it via
 * synthesizeLegacyEntry, which marks them `legacy: true, version: 0` —
 * Phase 3 treats legacy entries as bespoke-template blocks (today's reality:
 * every legacy type has a theme partial).
 * @module discovery/block-entry
 */
import { validateSchemaDefinition } from "../validators/block-schema.js";

export const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const REGIONS = new Set(["main", "sidebar", "footer", "hero"]);
export const SURFACES = new Set(["homepage", "collection", "postType", "standalone"]);
export const DATA_SOURCES = new Set(["file", "collections", "config", "api"]);
export const GENERIC_RENDERERS = new Set([
  "feed", "cards", "list", "media-grid", "key-value",
  "stat", "timeline", "tag-cloud", "prose", "embed",
]);

// Mirrors RESERVED_PROPERTY_NAMES in validators/block-schema.js: the strict
// walker rejects these, so synthesis must never emit them (legacy entries
// skip validBlockEntry, so a leaked "__proto__" field would otherwise reach
// the catalog unchecked).
const RESERVED_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Strict gate for a plugin-declared v2 block catalog entry.
 * @param {unknown} entry
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validBlockEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, errors: ["entry must be an object"] };
  }
  if (typeof entry.id !== "string" || !KEBAB_ID.test(entry.id)) errors.push("id must be flat kebab-case");
  if (!Number.isInteger(entry.version) || entry.version < 1) errors.push("version must be an integer >= 1");
  if (typeof entry.label !== "string" || entry.label === "") errors.push("label is required");
  const regions = entry.placement?.regions;
  if (!Array.isArray(regions) || regions.length === 0 || !regions.every((r) => REGIONS.has(r))) {
    errors.push(`placement.regions must be a non-empty subset of ${[...REGIONS].join("|")}`);
  }
  const surfaces = entry.placement?.surfaces;
  if (surfaces !== undefined
      && (!Array.isArray(surfaces) || !surfaces.every((s) => SURFACES.has(s)))) {
    errors.push(`placement.surfaces must be a subset of ${[...SURFACES].join("|")}`);
  }
  if (!DATA_SOURCES.has(entry.data?.source)) {
    errors.push(`data.source must be one of ${[...DATA_SOURCES].join("|")}`);
  } else if (entry.data.source === "file" && typeof entry.data.file !== "string") {
    errors.push("data.source file requires data.file");
  } else if (entry.data.source === "collections" && typeof entry.data.key !== "string") {
    errors.push("data.source collections requires data.key");
  }
  const schemaResult = validateSchemaDefinition(entry.schema);
  if (!schemaResult.ok) errors.push(...schemaResult.errors.map((e) => `schema: ${e}`));
  if ("multiple" in entry && typeof entry.multiple !== "boolean") errors.push("multiple must be boolean");
  if ("aliases" in entry
      && (!Array.isArray(entry.aliases) || !entry.aliases.every((a) => typeof a === "string" && KEBAB_ID.test(a)))) {
    errors.push("aliases must be an array of kebab ids");
  }
  if (entry.render?.renderer !== undefined && !GENERIC_RENDERERS.has(entry.render.renderer)) {
    errors.push(`render.renderer must be one of ${[...GENERIC_RENDERERS].join("|")}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Map the legacy mini-DSL configSchema to the frozen JSON Schema subset.
 * Reserved property names (see validators/block-schema.js) are skipped with
 * a warning: assigning properties["__proto__"] would hit the inherited
 * setter, and the strict walker would reject the result anyway — but legacy
 * entries never pass through validBlockEntry, so the skip happens here.
 * @param {unknown} configSchema Legacy mini-DSL map (untrusted plugin input)
 * @returns {{ type: "object", additionalProperties: false, properties: object }}
 */
export function convertMiniDsl(configSchema) {
  const properties = {};
  const source =
    configSchema && typeof configSchema === "object" && !Array.isArray(configSchema)
      ? configSchema
      : {};
  for (const [name, def] of Object.entries(source)) {
    if (RESERVED_PROPERTY_NAMES.has(name)) {
      console.warn(`[site-config] convertMiniDsl: skipping reserved field name "${name}"`);
      continue;
    }
    if (!def || typeof def !== "object") continue;
    const title = typeof def.label === "string" ? { title: def.label } : {};
    switch (def.type) {
      case "number":
        properties[name] = { type: "number", ...title,
          // Number.isFinite (not typeof): NaN/Infinity bounds would emit a
          // schema Task 1's walker rejects, breaking this function's
          // walker-valid-by-construction output invariant.
          ...(Number.isFinite(def.min) ? { minimum: def.min } : {}),
          ...(Number.isFinite(def.max) ? { maximum: def.max } : {}) };
        break;
      case "boolean":
        properties[name] = { type: "boolean", ...title };
        break;
      case "textarea":
        properties[name] = { type: "string", ...title, maxLength: 20000, "x-control": "textarea" };
        break;
      case "array":
        properties[name] = { type: "array", ...title, items: { type: "string" } };
        break;
      default: // "text" and anything unrecognized degrade to bounded string
        properties[name] = { type: "string", ...title, maxLength: 200 };
    }
  }
  return { type: "object", additionalProperties: false, properties };
}

const ORIGIN_PLACEMENT = {
  homepageSections: { regions: ["main"], surfaces: ["homepage"] },
  homepageWidgets: { regions: ["sidebar"], surfaces: ["homepage", "collection"] },
  blogPostWidgets: { regions: ["sidebar"], surfaces: ["postType"] },
};

/**
 * Synthesize a catalog entry from a legacy getter entry (spec §3.1 adapter).
 * Legacy entries get `data: { source: "config" }` as the honest degenerate
 * (legacy getters declare no data contract); Phase 3's dispatcher never reads
 * `data` for `legacy: true` entries (bespoke templates), and Phase 7 replaces
 * each with a real declaration.
 * @param {object} entry Legacy getter entry ({id, label, ...})
 * @param {string} origin Getter the entry came from
 *   ("homepageSections" | "homepageWidgets" | "blogPostWidgets")
 * @returns {object} Catalog-shaped entry marked `legacy: true, version: 0`
 */
export function synthesizeLegacyEntry(entry, origin) {
  // structuredClone: ORIGIN_PLACEMENT holds shared references — handing them
  // out directly would let one caller's mutation bleed into every entry.
  const placement = structuredClone(
    Object.hasOwn(ORIGIN_PLACEMENT, origin)
      ? ORIGIN_PLACEMENT[origin]
      : { regions: ["main"], surfaces: ["homepage"] },
  );
  // Clone defaultConfig too: sharing the input reference would let a mutation
  // through the legacy array or the catalog bleed into the other. The clone
  // must not throw (file invariant) — unclonable values (functions, symbols)
  // degrade to {}.
  let defaultConfig;
  try {
    defaultConfig = structuredClone(entry.defaultConfig || {});
  } catch {
    defaultConfig = {};
  }
  return {
    id: entry.id,
    version: 0,
    legacy: true,
    label: entry.label,
    description: entry.description || "",
    icon: entry.icon || "",
    category: "plugin",
    placement,
    multiple: true,
    schema: convertMiniDsl(entry.configSchema),
    defaultConfig,
    data: { source: "config" },
    sourcePlugin: entry.sourcePlugin,
  };
}
