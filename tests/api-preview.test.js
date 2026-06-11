/**
 * API preview controller tests (Theming v2 — Phase 2c).
 *
 * Exercises the live preview endpoint via supertest-style direct router
 * invocation. We synthesize a fake Indiekit application instance with an
 * in-memory database stub so the route can read/merge config without a
 * real MongoDB connection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { publicApiRouter } from "../lib/controllers/api.js";
import { renderPreviewHtml } from "../lib/controllers/api.js";
import { renderThemeCss } from "../lib/render/write-theme-css.js";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";

function makeFakeIndiekit(initial = null) {
  // The route reads via `Indiekit.database.collection("siteConfig").findOne({_id: "primary"})`.
  // null means no database — getSiteConfig falls back to defaults.
  if (initial === null) return { database: null };
  return {
    database: {
      collection() {
        return {
          async findOne() {
            return initial ? { _id: "primary", ...initial } : null;
          },
        };
      },
    },
  };
}

function makeApp(Indiekit) {
  const app = express();
  app.use("/site-config/api", publicApiRouter(Indiekit));
  return app;
}

/**
 * Minimal in-process request helper — avoids pulling in supertest.
 * We start an ephemeral listener, fire `fetch`, then close it.
 */
async function fetchAgainst(app, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const addr = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}${pathAndQuery}`);
        const text = await res.text();
        resolve({ status: res.status, headers: res.headers, body: text });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
  });
}

// ─── /preview happy paths ──────────────────────────────────────────────

test("GET /preview returns 200 HTML with default config (no query params)", async () => {
  const app = makeApp(makeFakeIndiekit(null));
  const res = await fetchAgainst(app, "/site-config/api/preview");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  // CSP-friendly hardening headers
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  // Theme CSS is inlined
  assert.match(res.body, /--c-bg:/);
  assert.match(res.body, /<button class="button"/);
});

test("GET /preview accepts pending-state query params and renders them", async () => {
  const app = makeApp(makeFakeIndiekit(null));
  // Override accentBase via query
  const params = new URLSearchParams({
    surfacePreset: "cool-slate",
    accentBase: "#0d9488",
    accentPreset: "teal",
    mode: "light",
    typography_sans: "Inter",
    typography_serif: "Fraunces",
    typography_mono: "ui-monospace",
    typography_hosting: "self",
  });
  // All roles inherit
  for (const r of ["bg","fg","fgMuted","heading","link","action","actionFg","surface","border","focus"]) {
    params.append(`roles_${r}_inherit`, "1");
  }
  const res = await fetchAgainst(app, `/site-config/api/preview?${params.toString()}`);
  assert.equal(res.status, 200);
  // cool-slate surface-50 is #f8fafc — should be in the inlined theme.css
  assert.match(res.body, /248 250 252/);
});

test("GET /preview gracefully handles a totally bad query (still 200, falls back)", async () => {
  const app = makeApp(makeFakeIndiekit(null));
  // Bad accentBase
  const res = await fetchAgainst(app, "/site-config/api/preview?accentBase=not-a-hex");
  assert.equal(res.status, 200);
  // Should still render (using persisted state as fallback)
  assert.match(res.body, /--c-bg:/);
  // Parse error banner present
  assert.match(res.body, /Preview parse error/i);
});

test("GET /preview always ships both .light and .dark blocks (class-driven toggle)", async () => {
  const app = makeApp(makeFakeIndiekit(null));
  // Even when previewMode=dark, the iframe must still carry the light block so
  // the operator can toggle back. The preview is class-driven, not mode-locked.
  const res = await fetchAgainst(app, "/site-config/api/preview?previewMode=dark");
  assert.equal(res.status, 200);
  assert.match(res.body, /\.light\s*\{/);
  assert.match(res.body, /\.dark\s*\{/);
});

test("GET /preview is OS-independent (no prefers-color-scheme media query)", async () => {
  const app = makeApp(makeFakeIndiekit(null));
  const res = await fetchAgainst(app, "/site-config/api/preview");
  assert.equal(res.status, 200);
  // Operator's explicit toggle wins over host OS — no media query in preview.
  assert.ok(!res.body.includes("@media (prefers-color-scheme: dark)"));
});

test("GET /preview surfaces a fail-state contrast warning banner on the iframe", async () => {
  // Seed a persisted state with a guaranteed-fail role override
  const Indiekit = makeFakeIndiekit({
    branding: {
      mode: "light",
      roles: { fg: { light: "#ffffff", dark: "#ffffff" } },
    },
  });
  const app = makeApp(Indiekit);
  const res = await fetchAgainst(app, "/site-config/api/preview");
  assert.equal(res.status, 200);
  assert.match(res.body, /Contrast fails/);
});

// ─── renderPreviewHtml pure function ───────────────────────────────────

test("renderPreviewHtml escapes the site name (XSS regression)", () => {
  const config = mergeWithDefaults({
    identity: { name: '<script>alert("xss")</script>' },
  });
  const html = renderPreviewHtml({
    themeCss: ":root {}",
    config,
    previewMode: "light",
    parseError: null,
    contrastResults: [],
  });
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /&lt;script&gt;/);
});

test("renderPreviewHtml shows the previewMode label", () => {
  const config = mergeWithDefaults({});
  const html = renderPreviewHtml({
    themeCss: ":root {}",
    config,
    previewMode: "dark",
    parseError: null,
    contrastResults: [],
  });
  assert.match(html, /Mode: dark/);
});

test("renderPreviewHtml inlines the theme.css", () => {
  const config = mergeWithDefaults({});
  const css = renderThemeCss(config);
  const html = renderPreviewHtml({
    themeCss: css,
    config,
    previewMode: "auto",
    parseError: null,
    contrastResults: [],
  });
  // CSS has --c-bg declarations — they should appear in the page
  assert.match(html, /--c-bg:/);
});

test("renderPreviewHtml renders mode-toggle buttons with persisted localStorage hook", () => {
  const config = mergeWithDefaults({});
  const html = renderPreviewHtml({
    themeCss: ":root {}",
    config,
    previewMode: "light",
    parseError: null,
    contrastResults: [],
  });
  assert.match(html, /data-pv-mode="light"/);
  assert.match(html, /data-pv-mode="dark"/);
  assert.match(html, /localStorage/);
});
