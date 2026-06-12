/**
 * Plugin discovery v2 (spec §3.1). Reads the new `get blocks()` contract
 * alongside the legacy three getters (homepageSections/homepageWidgets/
 * blogPostWidgets), merging everything on Map<id, entry> so duplicate ids
 * can no longer coexist (the old array-concat merge was not idempotent at
 * id level — confirmed latent bug). Precedence per id, higher wins:
 *   built-in < legacy synthesis < plugin `blocks` entry
 * — enforced by processing `blocks` FIRST and guarding those ids via the
 * blockDeclaredIds set (legacy synthesis never overwrites a `blocks`
 * declaration; built-ins are merely the Map seed).
 * Legacy array outputs keep their exact shape for the existing admin UI;
 * the catalog is the NEW parallel output consumed (from Phase 3) via
 * block-catalog.json. The legacy adapter dies in the final cleanup phase.
 *
 * Error containment is two-level: a per-ENDPOINT catch (a throwing `blocks`
 * or legacy getter skips that endpoint's remaining getters) plus a per-ENTRY
 * catch (a poisoned entry — throwing property getter/proxy — skips that
 * entry only, never the plugin's remaining valid entries).
 * @module discovery/scan-plugins
 */
import { BUILTIN_SECTIONS } from "../presets/builtin-sections.js";
import { BUILTIN_WIDGETS } from "../presets/builtin-widgets.js";
import { BUILTIN_BLOG_POST_WIDGETS } from "../presets/builtin-blog-post-widgets.js";
import { BUILTIN_BLOCKS } from "../presets/builtin-blocks.js";
import { validBlockEntry, synthesizeLegacyEntry } from "./block-entry.js";

function validLegacyEntry(entry) {
  return entry && typeof entry.id === "string" && entry.id !== ""
    && typeof entry.label === "string" && entry.label !== "";
}

/** Read entry.id without trusting it (poisoned getters must not escape the warn path). */
function safeId(entry) {
  try {
    return entry?.id;
  } catch {
    return undefined;
  }
}

/**
 * Read ep.name once, throw-proof. A throwing `name` getter would otherwise
 * defeat BOTH catch levels: the inner warn throws, the outer catch's warn
 * reads ep.name again and throws too — scanPlugins escapes to the boot
 * catch and NO discovery output is written at all.
 */
function safeName(ep) {
  try {
    const name = ep?.name;
    return typeof name === "string" ? name : "(unnamed endpoint)";
  } catch {
    return "(unnamed endpoint)";
  }
}

/** Throw-proof error text: `throw null` has no .message — degrade, don't TypeError. */
function errorText(error) {
  return error?.message ?? String(error);
}

const LEGACY_GETTERS = ["homepageSections", "homepageWidgets", "blogPostWidgets"];

export function scanPlugins(Indiekit, ownEndpoint) {
  // Legacy arrays: per-origin Maps so recent-posts-the-section and
  // recent-posts-the-widget keep their distinct defaultConfigs (the catalog
  // is one namespace; the legacy UI arrays are three).
  const sections = new Map(BUILTIN_SECTIONS.map((e) => [e.id, e]));
  const widgets = new Map(BUILTIN_WIDGETS.map((e) => [e.id, e]));
  const blogPostWidgets = new Map(BUILTIN_BLOG_POST_WIDGETS.map((e) => [e.id, e]));
  const legacyMaps = { homepageSections: sections, homepageWidgets: widgets, blogPostWidgets };

  const catalog = new Map(BUILTIN_BLOCKS.map((e) => [e.id, e]));
  const blockDeclaredIds = new Set(); // ids declared via `blocks` — immune to legacy overwrite

  for (const ep of Indiekit?.endpoints || []) {
    if (!ep || ep === ownEndpoint) continue;
    const epName = safeName(ep); // read ONCE, throw-proof — used in every warn path below
    try {
      // New contract first: strict gate, shadows everything for that id.
      for (const raw of Array.isArray(ep.blocks) ? ep.blocks : []) {
        try {
          const result = validBlockEntry(raw);
          if (!result.ok) {
            console.warn(`[site-config] skipping invalid block "${safeId(raw)}" from ${epName}: ${result.errors.join("; ")}`);
            continue;
          }
          // Cross-plugin collision on a `blocks` id: last-wins stays the
          // rule (Map semantics), but silently is not acceptable — surface it.
          if (blockDeclaredIds.has(raw.id)) {
            console.warn(`[site-config] block id "${raw.id}" declared by multiple plugins — ${epName} wins`);
          }
          catalog.set(raw.id, { ...raw, sourcePlugin: epName });
          blockDeclaredIds.add(raw.id);
        } catch (error) {
          console.warn(`[site-config] skipping unreadable block entry from ${epName}: ${errorText(error)}`);
        }
      }
      // Legacy getters: feed the legacy arrays (unchanged contract) AND
      // synthesize catalog entries where no `blocks` declaration exists.
      for (const origin of LEGACY_GETTERS) {
        for (const raw of Array.isArray(ep[origin]) ? ep[origin] : []) {
          try {
            if (!validLegacyEntry(raw)) {
              console.warn(`[site-config] skipping malformed ${origin} entry from ${epName}`);
              continue;
            }
            const tagged = { ...raw, sourcePlugin: epName };
            legacyMaps[origin].set(raw.id, tagged);
            if (!blockDeclaredIds.has(raw.id)) {
              catalog.set(raw.id, synthesizeLegacyEntry(tagged, origin));
            }
          } catch (error) {
            console.warn(`[site-config] skipping unreadable ${origin} entry from ${epName}: ${errorText(error)}`);
          }
        }
      }
    } catch (error) {
      console.warn(`[site-config] plugin scan failed for ${epName}: ${errorText(error)}`);
    }
  }

  const result = {
    catalog: [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sections: [...sections.values()],
    widgets: [...widgets.values()],
    // Preserves the legacy union "blog built-ins + plugin entries + ALL
    // sidebar widgets" — now deduped by first occurrence, the blog-specific
    // entry winning (matches render precedence).
    blogPostWidgets: [...blogPostWidgets.values(), ...widgets.values()]
      .filter((entry, index, all) => all.findIndex((e) => e.id === entry.id) === index),
  };

  Indiekit.config.application.discoveredSections = result.sections;
  Indiekit.config.application.discoveredWidgets = result.widgets;
  Indiekit.config.application.discoveredBlogPostWidgets = result.blogPostWidgets;
  Indiekit.config.application.blockCatalog = result.catalog;

  console.log(
    `[site-config] discovered ${result.sections.length} sections, ` +
    `${result.widgets.length} widgets, ` +
    `${result.blogPostWidgets.length} blog-post widgets, ` +
    `${result.catalog.length} catalog blocks`
  );
  return result;
}
