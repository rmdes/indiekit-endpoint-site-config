import express from "express";
import { getSiteConfig } from "../storage/get-site-config.js";
import { renderThemeCss } from "../render/write-theme-css.js";

export function apiRouter(Indiekit) {
  const router = express.Router();

  router.get("/preview", async (req, res, next) => {
    try {
      const config = await getSiteConfig(Indiekit);
      const themeCss = renderThemeCss(config);
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.send(`<!doctype html>
<html lang="${escapeHtml(config.identity.locale || "en")}">
<head>
  <meta charset="utf-8">
  <title>Preview</title>
  <style>
${themeCss}
    body { font-family: var(--font-sans); background: rgb(var(--c-surface-50)); color: rgb(var(--c-surface-900)); margin: 0; padding: 1.5rem; }
    h1 { font-family: var(--font-serif); color: rgb(var(--c-primary)); margin: 0 0 0.5em; font-size: 1.5em; }
    p { color: rgb(var(--c-surface-700)); line-height: 1.5; margin: 0 0 1em; }
    .button { background: rgb(var(--c-accent-500)); color: rgb(var(--c-surface-50)); padding: 0.4em 0.8em; border-radius: 0.4em; display: inline-block; font-weight: 600; }
    a { color: rgb(var(--c-link)); }
  </style>
</head>
<body>
  <h1>${escapeHtml(config.identity.name || "Untitled site")}</h1>
  <p>${escapeHtml(config.identity.description || "Sample description")}</p>
  <p><a href="#">A sample link</a> and <span class="button">an action button</span>.</p>
</body>
</html>`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
