/**
 * Plugin discovery v2 (spec §3.1). Reads the new `get blocks()` contract
 * alongside the legacy three getters (homepageSections/homepageWidgets/
 * blogPostWidgets), merging everything on Map<id, entry> so duplicate ids
 * can no longer coexist (the old array-concat merge was not idempotent at
 * id level — confirmed latent bug). Precedence per id, last wins:
 *   built-in < legacy synthesis < plugin `blocks` entry.
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
    try {
      // New contract first: strict gate, shadows everything for that id.
      for (const raw of Array.isArray(ep.blocks) ? ep.blocks : []) {
        try {
          const result = validBlockEntry(raw);
          if (!result.ok) {
            console.warn(`[site-config] skipping invalid block "${safeId(raw)}" from ${ep.name}: ${result.errors.join("; ")}`);
            continue;
          }
          catalog.set(raw.id, { ...raw, sourcePlugin: ep.name });
          blockDeclaredIds.add(raw.id);
        } catch (error) {
          console.warn(`[site-config] skipping unreadable block entry from ${ep.name}: ${error.message}`);
        }
      }
      // Legacy getters: feed the legacy arrays (unchanged contract) AND
      // synthesize catalog entries where no `blocks` declaration exists.
      for (const origin of LEGACY_GETTERS) {
        for (const raw of Array.isArray(ep[origin]) ? ep[origin] : []) {
          try {
            if (!validLegacyEntry(raw)) {
              console.warn(`[site-config] skipping malformed ${origin} entry from ${ep.name}`);
              continue;
            }
            const tagged = { ...raw, sourcePlugin: ep.name };
            legacyMaps[origin].set(raw.id, tagged);
            if (!blockDeclaredIds.has(raw.id)) {
              catalog.set(raw.id, synthesizeLegacyEntry(tagged, origin));
            }
          } catch (error) {
            console.warn(`[site-config] skipping unreadable ${origin} entry from ${ep.name}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      console.warn(`[site-config] plugin scan failed for ${ep?.name}: ${error.message}`);
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
