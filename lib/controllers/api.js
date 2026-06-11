import express from "express";
import { getSiteConfig, mergeWithDefaults } from "../storage/get-site-config.js";
import { getHomepageConfig } from "../storage/get-homepage-config.js";
import { renderThemeCss } from "../render/write-theme-css.js";
import { parseBrandingForm } from "./branding.js";
import { validateBranding } from "../validators/contrast.js";

/**
 * Public API router — unauthenticated, safe to expose. These endpoints reveal
 * NO plugin-loadout information: `/preview` renders sample theme HTML and
 * `/homepage.json` is a deliberately public read-only view (PII stripped) for
 * external SSG/theme consumers. Mounted under `routesPublic` in index.js.
 */
export function publicApiRouter(Indiekit) {
  const router = express.Router();

  /**
   * GET /site-config/api/preview
   *
   * Renders a live preview of a theme — either the persisted state (when no
   * query params are present) or a pending state derived from query params.
   *
   * The branding form's color pickers submit `input` events to the iframe
   * (debounced ~200ms) and re-set the iframe's src with a serialized form
   * snapshot. This endpoint runs the same parser the POST handler uses —
   * with `skipContrastCheck: true` so a low-contrast color choice can
   * still be PREVIEWED, only blocked from being SAVED.
   *
   * Query params (all optional):
   *   surfacePreset            — Tier 1 input
   *   accentBase               — Tier 1 input (hex)
   *   accentPreset             — metadata
   *   mode                     — light | dark | auto
   *   surfaceCustom_<tone>     — when surfacePreset=custom
   *   roles_<role>_inherit=1   — inherit palette default
   *   roles_<role>_light/dark  — override (both required if neither inherit)
   *   typography_sans/serif/mono/hosting
   *   previewMode              — light | dark | auto (overrides mode for preview only)
   *
   * The endpoint always returns 200 with HTML; for invalid inputs (e.g. bad
   * accent hex), it falls back to the persisted state with a warning banner
   * so the user can SEE the broken state and recover from it.
   */
  router.get("/preview", async (req, res, next) => {
    try {
      const persisted = await getSiteConfig(Indiekit);
      const hasQuery = req.query && Object.keys(req.query).length > 0;

      let configForPreview = persisted;
      let parseError = null;
      let contrastResults = [];

      if (hasQuery) {
        // Bridge multipart-friendly query params to the urlencoded shape
        // parseBrandingForm expects. Express already gives us a plain
        // object via req.query — Object.entries casts arrays to strings
        // when a key appears more than once (we ignore that edge case).
        const parsed = parseBrandingForm(
          req.query,
          persisted.branding?.roles || {},
          { skipContrastCheck: true },
        );

        if (parsed.ok) {
          // Build a synthetic full config: take the persisted state and
          // overlay the pending branding subtree. mergeWithDefaults guards
          // against missing keys.
          configForPreview = mergeWithDefaults({
            ...persisted,
            branding: {
              ...persisted.branding,
              ...parsed.patch.branding,
            },
          });
        } else {
          parseError = parsed.message;
        }
      }

      // Per-mode preview override: the iframe's light/dark toggle button
      // sets `previewMode` independent of the persisted mode setting.
      const previewMode =
        typeof req.query.previewMode === "string" &&
        ["light", "dark", "auto"].includes(req.query.previewMode)
          ? req.query.previewMode
          : configForPreview.branding.mode;

      // Run contrast check on the preview's resolved state so the iframe
      // can show whether the visible colors are passing. Wrapped in try
      // so a broken accentBase doesn't blow up the preview.
      try {
        contrastResults = validateBranding(configForPreview.branding);
      } catch {
        contrastResults = [];
      }

      // Preview always emits both light + dark (class-scoped) so the iframe's
      // Light/Dark toggle works regardless of the saved mode. `previewMode`
      // only selects which side is shown FIRST (via the toggle JS below).
      const themeCss = renderThemeCss(configForPreview, { preview: true });
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.send(renderPreviewHtml({
        themeCss,
        config: configForPreview,
        previewMode,
        parseError,
        contrastResults,
      }));
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /site-config/api/homepage.json (PUBLIC)
   *
   * Public read-only view of the homepage config. Intended for external
   * theme/SSG consumers (Eleventy, Hugo, Astro, etc.) that need to render
   * the same layout shape Indiekit's own theme renders.
   *
   * Mounted under `routesPublic` (no auth). To avoid leaking PII, the
   * `updatedBy` field (admin user URL) is stripped before sending.
   *
   * Security headers:
   *   - `Cache-Control: no-store` — operators flip layouts frequently
   *   - `X-Content-Type-Options: nosniff` — defense-in-depth against MIME
   *     confusion for a JSON endpoint that could be embedded in pages
   */
  router.get("/homepage.json", async (req, res, next) => {
    try {
      const homepage = await getHomepageConfig(Indiekit);
      const { updatedBy, ...publicShape } = homepage;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.json(publicShape);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Admin-only API router — mounted on the protected (authenticated) router in
 * index.js. These discovery endpoints reveal the installed plugin loadout
 * (which plugins registered sections/widgets), so they must NEVER be exposed
 * publicly. Auth is genuinely enforced by the protected parent mount.
 */
export function adminApiRouter(Indiekit) {
  const router = express.Router();

  /**
   * GET /site-config/api/sections
   *
   * Discovery endpoint — returns the list of sections discovered from all
   * registered plugins via the `homepageSections` collector. Consumed by the
   * admin UI views (homepage composer) to populate the available-sections
   * picker.
   */
  router.get("/sections", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(Indiekit.config?.application?.discoveredSections || []);
  });

  /**
   * GET /site-config/api/widgets
   *
   * Discovery endpoint — returns the list of widgets discovered from all
   * registered plugins via the `homepageWidgets` collector. Consumed by the
   * admin UI views (sidebar composer).
   */
  router.get("/widgets", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(Indiekit.config?.application?.discoveredWidgets || []);
  });

  /**
   * GET /site-config/api/blog-widgets
   *
   * Discovery endpoint — returns the list of blog-post-specific widgets
   * discovered from all registered plugins via the `blogPostWidgets`
   * collector. Consumed by the admin UI views (blog post sidebar composer).
   */
  router.get("/blog-widgets", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(Indiekit.config?.application?.discoveredBlogPostWidgets || []);
  });

  return router;
}

/**
 * Render the preview HTML body. Includes a comprehensive sample of theme
 * elements (heading, body text, link, action button, card, focus state,
 * alert pills) so users see how each token affects real surfaces.
 *
 * The light/dark mode toggle is a vanilla `<button>` with inline JS that sets
 * an explicit `.light` OR `.dark` class on the document element (mutually
 * exclusive) AND persists the choice in localStorage. Because the preview
 * theme CSS (rendered with { preview: true }) ships both class-scoped blocks,
 * the toggle always works — independent of the saved mode and the host OS
 * color-scheme preference. The persisted choice is read on load and applied.
 *
 * Exported for unit testing.
 */
export function renderPreviewHtml({ themeCss, config, previewMode, parseError, contrastResults }) {
  const locale = config.identity?.locale || "en";
  const siteName = config.identity?.name || "Untitled site";
  const tagline = config.identity?.tagline || "";
  const description = config.identity?.description || "Sample description for the preview.";

  const failures = (contrastResults || []).filter((r) => r.status === "fail");
  const warnings = (contrastResults || []).filter((r) => r.status === "warn");

  // The button toggles `.dark` on <html> regardless of preview mode so
  // operators can flip between sides without re-saving.
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8">
  <title>Preview</title>
  <style>
${themeCss}
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background: rgb(var(--c-bg));
      color: rgb(var(--c-fg));
      padding: 1.5rem;
      min-height: 100vh;
    }
    h1, h2, h3 { font-family: var(--font-serif); color: rgb(var(--c-heading)); margin: 0 0 0.5rem; }
    h1 { font-size: 1.75rem; }
    h2 { font-size: 1.25rem; margin-top: 1.5rem; }
    h3 { font-size: 1rem; }
    p  { line-height: 1.6; margin: 0 0 0.75rem; color: rgb(var(--c-fg)); }
    .muted { color: rgb(var(--c-fg-muted)); font-size: 0.875rem; }
    a { color: rgb(var(--c-link)); text-decoration: underline; }
    .button {
      background: rgb(var(--c-action));
      color: rgb(var(--c-action-fg));
      padding: 0.5rem 1rem;
      border-radius: 0.4rem;
      display: inline-block;
      font-weight: 600;
      border: none;
      cursor: pointer;
    }
    .button:focus {
      outline: 2px solid rgb(var(--c-focus));
      outline-offset: 2px;
    }
    .card {
      background: rgb(var(--c-surface));
      border: 1px solid rgb(var(--c-border));
      border-radius: 0.5rem;
      padding: 1rem;
      margin-block: 1rem;
    }
    code {
      font-family: var(--font-mono);
      background: rgb(var(--c-surface));
      padding: 0.1em 0.3em;
      border-radius: 0.2em;
      border: 1px solid rgb(var(--c-border));
    }
    .pills { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-block: 0.75rem; }
    .pill {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .pill--success { background: rgb(var(--c-success)); color: rgb(var(--c-success-fg)); }
    .pill--warning { background: rgb(var(--c-warning)); color: rgb(var(--c-warning-fg)); }
    .pill--danger  { background: rgb(var(--c-danger));  color: rgb(var(--c-danger-fg)); }

    .pv-toolbar {
      position: sticky;
      top: 0;
      display: flex;
      gap: 0.5rem;
      align-items: center;
      padding: 0.5rem 0.75rem;
      margin: -1.5rem -1.5rem 1rem;
      background: rgb(var(--c-surface));
      border-bottom: 1px solid rgb(var(--c-border));
      font-size: 0.75rem;
    }
    .pv-toggle {
      background: transparent;
      color: rgb(var(--c-fg));
      border: 1px solid rgb(var(--c-border));
      padding: 0.25rem 0.6rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font: inherit;
    }
    .pv-toggle--active {
      background: rgb(var(--c-action));
      color: rgb(var(--c-action-fg));
      border-color: rgb(var(--c-action));
    }
    .pv-note { color: rgb(var(--c-fg-muted)); margin-left: auto; }
    .pv-error {
      background: rgb(var(--c-danger));
      color: rgb(var(--c-danger-fg));
      padding: 0.5rem 0.75rem;
      border-radius: 0.25rem;
      margin-block-end: 1rem;
      font-size: 0.875rem;
    }
    .pv-warn {
      background: rgb(var(--c-warning));
      color: rgb(var(--c-warning-fg));
      padding: 0.5rem 0.75rem;
      border-radius: 0.25rem;
      margin-block-end: 1rem;
      font-size: 0.875rem;
    }
    .pv-fail {
      background: rgb(var(--c-danger));
      color: rgb(var(--c-danger-fg));
      padding: 0.5rem 0.75rem;
      border-radius: 0.25rem;
      margin-block-end: 1rem;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="pv-toolbar">
    <button type="button" class="pv-toggle" data-pv-mode="light">Light</button>
    <button type="button" class="pv-toggle" data-pv-mode="dark">Dark</button>
    <span class="pv-note">Mode: ${escapeHtml(previewMode)}</span>
  </div>

  ${parseError ? `<div class="pv-error">Preview parse error: ${escapeHtml(parseError)}</div>` : ""}
  ${failures.length > 0 ? `<div class="pv-fail">Contrast fails: ${escapeHtml(failures.map((f) => f.message).join("; "))}</div>` : ""}
  ${warnings.length > 0 ? `<div class="pv-warn">Contrast warnings: ${escapeHtml(warnings.map((w) => w.message).join("; "))}</div>` : ""}

  <h1>${escapeHtml(siteName)}</h1>
  ${tagline ? `<p class="muted">${escapeHtml(tagline)}</p>` : ""}
  <p>${escapeHtml(description)}</p>

  <p>This paragraph contains <a href="#">a sample link</a> and some <code>inline code</code> alongside <span class="muted">muted secondary text</span>.</p>

  <h2>Card surface</h2>
  <div class="card">
    <h3>Card heading</h3>
    <p>Cards use the <code>surface</code> role for their background and <code>border</code> for the outline. Body text inside cards inherits the page foreground color.</p>
    <button class="button" type="button">Primary action</button>
  </div>

  <h2>Alert tokens</h2>
  <p class="muted">Fixed Tier 3 colors — not user-configurable.</p>
  <div class="pills">
    <span class="pill pill--success">Success</span>
    <span class="pill pill--warning">Warning</span>
    <span class="pill pill--danger">Danger</span>
  </div>

  <h2>Focus ring</h2>
  <p class="muted">Tab to the button below to see the focus outline.</p>
  <p><button class="button" type="button">Focusable</button></p>

  <script>
    (function () {
      var KEY = 'sc.preview.mode';
      var stored = null;
      try { stored = localStorage.getItem(KEY); } catch (e) {}
      var html = document.documentElement;
      var buttons = document.querySelectorAll('[data-pv-mode]');

      function apply(mode) {
        if (mode === 'dark') {
          html.classList.add('dark');
          html.classList.remove('light');
        } else {
          html.classList.add('light');
          html.classList.remove('dark');
        }
        buttons.forEach(function (b) {
          var active = b.getAttribute('data-pv-mode') === mode;
          b.classList.toggle('pv-toggle--active', active);
        });
      }

      // Initial state: stored preference > URL-given previewMode > light
      var initial = stored || ${JSON.stringify(previewMode === "dark" ? "dark" : "light")};
      apply(initial);

      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var mode = btn.getAttribute('data-pv-mode');
          try { localStorage.setItem(KEY, mode); } catch (e) {}
          apply(mode);
        });
      });
    })();
  </script>
</body>
</html>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
