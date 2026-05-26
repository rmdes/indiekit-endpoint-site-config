/**
 * Plugin discovery — scan Indiekit.endpoints for homepageSections / homepageWidgets / blogPostWidgets.
 * Merges with built-in presets, stores on Indiekit.config.application.
 * @module discovery/scan-plugins
 */

import { BUILTIN_SECTIONS } from "../presets/builtin-sections.js";
import { BUILTIN_WIDGETS } from "../presets/builtin-widgets.js";
import { BUILTIN_BLOG_POST_WIDGETS } from "../presets/builtin-blog-post-widgets.js";

function validEntry(entry) {
  return entry && typeof entry.id === "string" && entry.id !== ""
                && typeof entry.label === "string" && entry.label !== "";
}

export function scanPlugins(Indiekit, ownEndpoint) {
  const sections        = [...BUILTIN_SECTIONS];
  const widgets         = [...BUILTIN_WIDGETS];
  const blogPostWidgets = [...BUILTIN_BLOG_POST_WIDGETS];

  for (const endpoint of Indiekit.endpoints || []) {
    if (endpoint === ownEndpoint) continue;
    try {
      const ep = endpoint;
      if (ep.homepageSections) {
        for (const s of ep.homepageSections) {
          if (!validEntry(s)) {
            console.warn(`[site-config] skipping malformed section from ${ep.name}`);
            continue;
          }
          sections.push({ ...s, sourcePlugin: ep.name });
        }
      }
      if (ep.homepageWidgets) {
        for (const w of ep.homepageWidgets) {
          if (!validEntry(w)) {
            console.warn(`[site-config] skipping malformed widget from ${ep.name}`);
            continue;
          }
          widgets.push({ ...w, sourcePlugin: ep.name });
        }
      }
      if (ep.blogPostWidgets) {
        for (const w of ep.blogPostWidgets) {
          if (!validEntry(w)) continue;
          blogPostWidgets.push({ ...w, sourcePlugin: ep.name });
        }
      }
    } catch (error) {
      console.warn(`[site-config] failed to read discovery getters from ${endpoint.name}: ${error.message}`);
    }
  }

  Indiekit.config.application.discoveredSections        = sections;
  Indiekit.config.application.discoveredWidgets         = widgets;
  Indiekit.config.application.discoveredBlogPostWidgets = [...blogPostWidgets, ...widgets];

  console.log(
    `[site-config] discovered ${sections.length} sections, ` +
    `${widgets.length} widgets, ` +
    `${Indiekit.config.application.discoveredBlogPostWidgets.length} blog-post widgets`
  );
}
