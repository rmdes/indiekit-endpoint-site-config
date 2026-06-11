/**
 * Regression tests for the 2026-06-06 branding bug report.
 *
 * Bug A  — the live-preview Light/Dark toggle was inert whenever the saved
 *          mode was "light" or "dark", because renderThemeCss only emits both
 *          a light AND a dark block for mode="auto". The preview is a design
 *          tool and must ALWAYS be toggleable, independent of the saved mode.
 *
 * Bug A.2 — the toggle JS only ever toggled `.dark`; it never added `.light`,
 *          so on a dark-preference OS "Light" could not win over the media
 *          query. The preview now uses explicit `.light` / `.dark` classes.
 *
 * Bug B  — three surface presets (stone, neutral-zinc, warm-gray) were near
 *          identical Tailwind neutrals; stone and neutral-zinc even shared an
 *          identical tone-50 (#fafafa), so switching produced no visible
 *          change in light mode (where the page bg is tone-50).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderThemeCss } from "../lib/render/write-theme-css.js";
import { renderPreviewHtml } from "../lib/controllers/api.js";
import { publicApiRouter } from "../lib/controllers/api.js";
import { SURFACE_PRESETS } from "../lib/render/surface-presets.js";
import { SURFACE_PRESET_OPTIONS } from "../lib/controllers/branding.js";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";
import express from "express";

// ─── Bug A: preview render path emits both modes regardless of saved mode ──

test("renderThemeCss({preview}) emits :root, .light AND .dark even when mode=light", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const css = renderThemeCss(config, { preview: true });
  assert.match(css, /:root\s*\{/, "must keep a :root block");
  assert.match(css, /\.light\s*\{/, "preview must emit an explicit .light block");
  assert.match(css, /\.dark\s*\{/, "preview must emit a .dark block so the toggle works");
});

test("renderThemeCss({preview}) emits both modes even when mode=dark", () => {
  const config = mergeWithDefaults({ branding: { mode: "dark" } });
  const css = renderThemeCss(config, { preview: true });
  assert.match(css, /\.light\s*\{/);
  assert.match(css, /\.dark\s*\{/);
});

test("renderThemeCss({preview}) .dark block carries dark surface values (warm-stone 950)", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const css = renderThemeCss(config, { preview: true });
  // warm-stone surface-950 = #0f0e0d = 15 14 13 (the dark-mode bg).
  // Scope to the .dark { ... } block so a stray ".dark" elsewhere can't fool us.
  const darkBlock = css.match(/\.dark\s*\{([\s\S]*?)\}/);
  assert.ok(darkBlock, "expected a .dark { ... } block");
  assert.match(darkBlock[1], /--c-bg:\s+15 14 13;/);
});

test("renderThemeCss({preview}) does NOT depend on the prefers-color-scheme media query", () => {
  // Preview is operator-driven: explicit class toggle, not OS preference.
  const config = mergeWithDefaults({ branding: { mode: "auto" } });
  const css = renderThemeCss(config, { preview: true });
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)/);
});

// ─── Production path is UNCHANGED (regression guard) ───────────────────────

test("renderThemeCss() production mode=light still emits ONLY :root (no dark blocks)", () => {
  const config = mergeWithDefaults({ branding: { mode: "light" } });
  const css = renderThemeCss(config);
  assert.match(css, /:root\s*\{/);
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /^\.dark\s*\{$/m);
});

test("renderThemeCss() production mode=auto unchanged (keeps @media + .dark)", () => {
  const config = mergeWithDefaults({ branding: { mode: "auto" } });
  const css = renderThemeCss(config);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{/);
  assert.match(css, /\.dark\s*\{/);
});

// ─── Bug A.2: toggle JS adds an explicit .light class ──────────────────────

test("renderPreviewHtml toggle JS adds the .light class (not only .dark)", () => {
  const config = mergeWithDefaults({});
  const html = renderPreviewHtml({
    themeCss: ":root {}",
    config,
    previewMode: "light",
    parseError: null,
    contrastResults: [],
  });
  assert.match(html, /classList\.add\('light'\)/, "Light toggle must add a .light class");
  assert.match(html, /classList\.add\('dark'\)/, "Dark toggle must add a .dark class");
});

// ─── Bug A end-to-end: preview route always toggleable ─────────────────────

function makeApp(initial) {
  const Indiekit =
    initial == null
      ? { database: null }
      : {
          database: {
            collection() {
              return { async findOne() { return { _id: "primary", ...initial }; } };
            },
          },
        };
  const app = express();
  app.use("/site-config/api", publicApiRouter(Indiekit));
  return app;
}

async function fetchAgainst(app, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${pathAndQuery}`);
        resolve({ status: res.status, body: await res.text() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
  });
}

test("GET /preview with a light-mode config STILL ships a .dark block (toggle works)", async () => {
  const app = makeApp({ branding: { mode: "light" } });
  const res = await fetchAgainst(app, "/site-config/api/preview");
  assert.equal(res.status, 200);
  assert.match(res.body, /\.dark\s*\{/);
  assert.match(res.body, /\.light\s*\{/);
});

// ─── Bug B: surface presets are visually distinct ──────────────────────────

test("every surface preset has a UNIQUE tone-50 (the light-mode page background)", () => {
  const tone50 = Object.entries(SURFACE_PRESETS).map(([slug, p]) => [slug, p[50]]);
  const seen = new Map();
  for (const [slug, hex] of tone50) {
    const dup = seen.get(hex);
    assert.equal(
      dup,
      undefined,
      `Presets "${dup}" and "${slug}" share an identical tone-50 (${hex}) — they look the same in light mode`,
    );
    seen.set(hex, slug);
  }
});

test("surface presets diverge meaningfully at the mid tone (500)", () => {
  const dist = (a, b) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r1, g1, b1] = p(a);
    const [r2, g2, b2] = p(b);
    return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
  };
  const presets = Object.entries(SURFACE_PRESETS);
  for (let i = 0; i < presets.length; i++) {
    for (let j = i + 1; j < presets.length; j++) {
      const [slugA, a] = presets[i];
      const [slugB, b] = presets[j];
      const d = dist(a[500], b[500]);
      // Threshold 10: the original bug had the redundant grays within ~4 of
      // their neighbours. The closest LEGITIMATE pair is warm-stone vs stone
      // (~11.4) — an intentional "warm neutral vs true neutral" distinction.
      assert.ok(
        d >= 10,
        `Presets "${slugA}" and "${slugB}" are too similar at tone 500 (distance ${d.toFixed(1)})`,
      );
    }
  }
});

test("SURFACE_PRESET_OPTIONS exposes the 5 presets, each resolving to a palette", () => {
  const slugs = SURFACE_PRESET_OPTIONS.map((o) => o.slug).sort();
  assert.deepEqual(slugs, ["clay", "cool-slate", "sage", "stone", "warm-stone"]);
  // Every offered preset must resolve to a real palette.
  for (const o of SURFACE_PRESET_OPTIONS) {
    assert.ok(SURFACE_PRESETS[o.slug], `option ${o.slug} has no palette`);
  }
});
