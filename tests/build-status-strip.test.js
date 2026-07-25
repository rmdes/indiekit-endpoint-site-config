import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import nunjucks from "nunjucks";

// The publish-flow build-status strip is the server-rendered no-JS mirror of
// editor.js's polling states. These tests extract the strip block from the
// shared editor view (same extraction technique as editor-i18n.test.js) and
// render it standalone through real nunjucks — stub __() echoes the locale
// key — to pin each branch, including the never-started branch and its
// republish escape-hatch form.

const here = path.dirname(fileURLToPath(import.meta.url));
const viewSource = readFileSync(
  path.join(here, "../views/site-config-design-homepage.njk"),
  "utf8",
);

// Capture from the strip's opening guard through its closing </div> (anchored
// on the noscript note — the last markup inside the strip container).
const stripMatch = viewSource.match(
  /\{% if success == "published" %\}([\s\S]*?<\/noscript>\s*<\/div>)/,
);

const render = (locals) => {
  const env = new nunjucks.Environment(null, { autoescape: true });
  env.addFilter("date", () => "DATE");
  return env.renderString(stripMatch[1], {
    __: (key) => key,
    surfaceBase: "/site-config/design/homepage",
    ...locals,
  });
};

const republishForm = (html) =>
  html.match(/<form[^>]*data-sc-build-republish[^>]*>/)?.[0];

test("view contains the publish build-status strip block", () => {
  assert.ok(stripMatch, "strip block found in the view");
});

test("notStarted branch renders the missed-publish copy with a VISIBLE republish form", () => {
  // Stale ok + buildNotStarted: the notStarted branch must win over "Live".
  const html = render({
    buildStatus: { state: "ok", finishedAt: "2026-06-12T09:59:00.000Z", stuck: false },
    buildNotStarted: true,
  });
  assert.ok(html.includes("siteConfig.design.buildStatus.notStarted"));
  assert.ok(!html.includes("siteConfig.design.buildStatus.live"));
  const form = republishForm(html);
  assert.ok(form, "republish form present");
  assert.ok(!form.includes("hidden"), "form visible for the no-JS notStarted branch");
  assert.ok(form.includes('action="/site-config/design/homepage/publish"'));
  assert.ok(html.includes("siteConfig.design.buildStatus.republish"));
});

test("stuck branch keeps its copy and shows the republish form server-side too", () => {
  const html = render({
    buildStatus: { state: "building", stuck: true },
    buildNotStarted: false,
  });
  assert.ok(html.includes("siteConfig.design.buildStatus.stuck"));
  const form = republishForm(html);
  assert.ok(form, "republish form present");
  assert.ok(!form.includes("hidden"));
});

test("building branch is unchanged and the republish form stays hidden", () => {
  const html = render({
    buildStatus: { state: "building", stuck: false, lastOkDurationSeconds: 27 },
    buildNotStarted: false,
  });
  assert.ok(html.includes("siteConfig.design.buildStatus.building"));
  assert.ok(republishForm(html).includes("hidden"));
});

test("ok branch is unchanged (Live · time) and the republish form stays hidden", () => {
  const html = render({
    buildStatus: { state: "ok", finishedAt: "2026-06-12T10:00:27.000Z", stuck: false },
    buildNotStarted: false,
  });
  assert.ok(html.includes("siteConfig.design.buildStatus.live"));
  assert.ok(!html.includes("siteConfig.design.buildStatus.notStarted"));
  assert.ok(republishForm(html).includes("hidden"));
});

test("failed branch is unchanged (error excerpt + retry hint) and the republish form stays hidden", () => {
  const html = render({
    buildStatus: { state: "failed", stuck: false, error: "Eleventy exited 1" },
    buildNotStarted: false,
  });
  assert.ok(html.includes("siteConfig.design.buildStatus.failed"));
  assert.ok(html.includes("Eleventy exited 1"));
  assert.ok(html.includes("siteConfig.design.buildStatus.retryHint"));
  assert.ok(republishForm(html).includes("hidden"));
});

test("unknown branch is unchanged and the republish form stays hidden", () => {
  const html = render({
    buildStatus: { state: "unknown", stuck: false },
    buildNotStarted: false,
  });
  assert.ok(html.includes("siteConfig.design.buildStatus.unknown"));
  assert.ok(republishForm(html).includes("hidden"));
});
