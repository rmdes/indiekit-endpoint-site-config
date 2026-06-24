import { test } from "node:test";
import assert from "node:assert/strict";
import { publicApiRouter, adminApiRouter } from "../lib/controllers/api.js";

// Phase 7d — the legacy discovery endpoints (/api/sections, /api/widgets,
// /api/blog-widgets) were removed with the legacy three-getter subsystem. No
// consumer remains: the theme reads block-catalog.json and the v4 composition
// editor uses the block catalog directly. Only the public /api/homepage.json
// stays on these routers.

function makeIndiekit() {
  return {
    database: {
      collection() {
        return {
          async findOne() {
            return {
              _id: "homepage", layout: "two-column", hero: { enabled: true, showSocial: true },
              sections: [], sidebar: [], blogListingSidebar: [], blogPostSidebar: [], footer: [],
            };
          },
        };
      },
    },
    config: { application: {} },
  };
}

async function callRoute(router, method, path) {
  return new Promise((resolve) => {
    const req = { method: method.toUpperCase(), url: path, body: {} };
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); },
      send(payload) { this.body = payload; resolve(this); },
    };
    // No route matched → Express calls the final `next()`; model that as 404.
    router.handle(req, res, () => { res.statusCode = 404; resolve(res); });
  });
}

test("legacy discovery routes are gone (404): /sections, /widgets, /blog-widgets", async () => {
  const router = adminApiRouter(makeIndiekit());
  for (const path of ["/sections", "/widgets", "/blog-widgets"]) {
    const res = await callRoute(router, "get", path);
    assert.equal(res.statusCode, 404, `${path} should be 404`);
  }
});

test("GET /api/homepage.json returns the homepage config (public)", async () => {
  const router = publicApiRouter(makeIndiekit());
  const res = await callRoute(router, "get", "/homepage.json");
  assert.equal(res.body.layout, "two-column");
});
