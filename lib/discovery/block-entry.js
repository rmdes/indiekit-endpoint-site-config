/**
 * Blocks contract v2 — entry validation (spec §3.1). validBlockEntry is the
 * STRICT gate for plugin-declared `get blocks()` entries (it keeps schema-less
 * or malformed entries out of block-catalog.json).
 *
 * Phase 7d follow-up: the legacy adapter (convertMiniDsl + synthesizeLegacyEntry,
 * which turned the retired homepageSections/homepageWidgets/blogPostWidgets
 * getters into catalog entries) was REMOVED — no plugin declares those getters
 * anymore (site-config replaced @rmdes/indiekit-endpoint-homepage in May 2026).
 * @module discovery/block-entry
 */
import {
  validateSchemaDefinition,
  validateConfigAgainstSchema,
} from "../validators/block-schema.js";

export const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const REGIONS = new Set(["main", "sidebar", "footer", "hero"]);
export const SURFACES = new Set(["homepage", "collection", "postType", "standalone"]);
export const DATA_SOURCES = new Set(["file", "collections", "config", "api"]);
export const GENERIC_RENDERERS = new Set([
  "feed", "cards", "list", "media-grid", "key-value",
  "stat", "timeline", "tag-cloud", "prose", "embed",
]);

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
  // defaultConfig must validate against the entry's OWN schema — otherwise
  // every add of this block seeds a config the config form then rejects
  // (D3's fixture friction). Structural gate first: validateConfigAgainstSchema
  // treats non-object configs as empty with ok:true, which would let a
  // string/array defaultConfig slip through.
  if (entry.defaultConfig !== undefined && schemaResult.ok) {
    if (
      entry.defaultConfig === null ||
      typeof entry.defaultConfig !== "object" ||
      Array.isArray(entry.defaultConfig)
    ) {
      errors.push("defaultConfig does not validate against schema: must be an object");
    } else {
      const configResult = validateConfigAgainstSchema(entry.defaultConfig, entry.schema);
      if (!configResult.ok) {
        errors.push(
          `defaultConfig does not validate against schema: ${configResult.errors.join("; ")}`,
        );
      }
    }
  }
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
