/**
 * Category merge (Category Governance, Layer 4 — runs through the L2 tab).
 *
 * Merging/renaming categories must reach the BUILD, which reads `.md` frontmatter
 * (not the partial MongoDB `posts` collection). This module rewrites the category
 * in `.md` frontmatter with a TARGETED text edit — replacing only the category
 * value(s) and preserving the rest of the file byte-for-byte. We deliberately do
 * NOT gray-matter.stringify: that re-dumps the entire YAML block (js-yaml would
 * normalize `date:` timezones and could reformat other fields, which can break
 * the theme's `| date` filter).
 *
 * Real frontmatter forms (verified on rmendes): inline unquoted `category: X`
 * and block array `category:\n  - X\n  - Y` (also unquoted, may contain URLs).
 * No inline-array or quoted forms exist.
 *
 * @module storage/category-merge
 */

/**
 * Rewrite a post's `.md` frontmatter category per a rename map (oldName→newName).
 * Block arrays are de-duplicated after rename (Politics+politics→politics once).
 * Returns the (possibly unchanged) content + a `changed` flag.
 *
 * @param {string} content - full `.md` file content
 * @param {Object<string,string>} renameMap - exact category name → new name
 * @returns {{ content: string, changed: boolean }}
 */
export function rewriteCategoryFrontmatter(content, renameMap) {
  // Frontmatter must be at the very start: `---\n … \n---\n`.
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
  if (!fmMatch) return { content, changed: false };

  const [full, open, fmBody, close] = fmMatch;
  const eol = open.includes("\r\n") ? "\r\n" : "\n";
  const lines = fmBody.split(/\r?\n/);
  const out = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(/^category:[ \t]+(\S.*?)[ \t]*$/);
    const isBlock = /^category:[ \t]*$/.test(line);

    if (inline) {
      const val = inline[1];
      const to = renameMap[val];
      if (to !== undefined && to !== val) {
        out.push(`category: ${to}`);
        changed = true;
      } else {
        out.push(line);
      }
    } else if (isBlock) {
      out.push(line); // the `category:` line
      const items = [];
      let indent = "  - ";
      let j = i + 1;
      while (j < lines.length) {
        const m = lines[j].match(/^([ \t]+-[ \t]+)(.*?)[ \t]*$/);
        if (!m) break;
        indent = m[1];
        const itemVal = m[2];
        const to = renameMap[itemVal];
        if (to !== undefined && to !== itemVal) changed = true;
        items.push(to !== undefined ? to : itemVal);
        j++;
      }
      // De-dupe (a merge can collapse two casings into one).
      const seen = new Set();
      for (const v of items) {
        if (seen.has(v)) {
          changed = true;
          continue;
        }
        seen.add(v);
        out.push(`${indent}${v}`);
      }
      i = j - 1; // skip the consumed `- item` lines
    } else {
      out.push(line);
    }
  }

  if (!changed) return { content, changed: false };
  return { content: open + out.join(eol) + close + content.slice(full.length), changed: true };
}

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateCensusCache } from "./category-census.js";

/**
 * Apply a rename map to MongoDB `posts` docs (rename old→new in
 * properties.category + de-dupe), in JS so the logic matches the .md edit.
 * Only touches docs that have an affected category. Returns docs updated.
 * @param {object} db - Indiekit.database
 * @param {Object<string,string>} renameMap
 * @returns {Promise<number>}
 */
export async function syncMongoCategories(db, renameMap) {
  const posts = db.collection("posts");
  const oldNames = Object.keys(renameMap);
  if (oldNames.length === 0) return 0;
  let updated = 0;
  const cursor = posts.find({ "properties.category": { $in: oldNames } });
  for await (const doc of cursor) {
    const cats = doc.properties && doc.properties.category;
    let next;
    if (Array.isArray(cats)) {
      const mapped = cats.map((c) => (renameMap[c] !== undefined ? renameMap[c] : c));
      next = [...new Set(mapped)];
    } else if (typeof cats === "string" && renameMap[cats] !== undefined) {
      next = renameMap[cats];
    } else {
      continue;
    }
    await posts.updateOne({ _id: doc._id }, { $set: { "properties.category": next } });
    updated += 1;
  }
  return updated;
}

/**
 * Apply a category rename/merge: rewrite every matching `.md` frontmatter under
 * contentDir AND sync MongoDB `posts` (so a later Micropub edit won't revert it).
 * @param {string} contentDir
 * @param {object|null} db - Indiekit.database (null → skip Mongo)
 * @param {Object<string,string>} renameMap - exact category name → canonical name
 * @returns {Promise<{filesChanged:number, docsUpdated:number}>}
 */
export async function applyCategoryMerge(contentDir, db, renameMap) {
  let files = [];
  try {
    files = readdirSync(contentDir, { recursive: true, encoding: "utf8" });
  } catch {
    files = [];
  }
  let filesChanged = 0;
  for (const rel of files) {
    if (typeof rel !== "string" || !rel.endsWith(".md")) continue;
    const path = join(contentDir, rel);
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { content: next, changed } = rewriteCategoryFrontmatter(content, renameMap);
    if (!changed) continue;
    try {
      writeFileSync(path, next, "utf8");
      filesChanged += 1;
    } catch (error) {
      console.warn(`[categories] merge: failed to write ${rel}: ${error.message}`);
    }
  }

  let docsUpdated = 0;
  if (db) {
    try {
      docsUpdated = await syncMongoCategories(db, renameMap);
    } catch (error) {
      console.warn(`[categories] merge: MongoDB sync failed: ${error.message}`);
    }
  }
  invalidateCensusCache();
  return { filesChanged, docsUpdated };
}
