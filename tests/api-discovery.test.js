import { test } from "node:test";
import assert from "node:assert/strict";
import { publicApiRouter, adminApiRouter } from "../lib/controllers/api.js";

// Stub Indiekit with pre-populated discovered fields and a mock DB
function makeIndiekit() {
  return {
    database: {
      collection() {
        return {
          async findOne() {
            return { _id: "homepage", layout: "two-column", hero: { enabled: true, showSocial: true },
                     sections: [], sidebar: [], blogListingSidebar: [], blogPostSidebar: [], footer: [] };
          },
        };
      },
    },
    config: {
      application: {
        discoveredSections:        [{ id: "hero", label: "Hero" }],
        discoveredWidgets:         [{ id: "search", label: "Search" }],
        discoveredBlogPostWidgets: [{ id: "toc", label: "TOC" }, { id: "search", label: "Search" }],
      },
    },
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
    router.handle(req, res, () => resolve(res));
  });
}

test("GET /api/sections returns discoveredSections", async () => {
  const router = adminApiRouter(makeIndiekit());
  const res = await callRoute(router, "get", "/sections");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ id: "hero", label: "Hero" }]);
});

test("GET /api/widgets returns discoveredWidgets", async () => {
  const router = adminApiRouter(makeIndiekit());
  const res = await callRoute(router, "get", "/widgets");
  assert.deepEqual(res.body, [{ id: "search", label: "Search" }]);
});

test("GET /api/blog-widgets returns discoveredBlogPostWidgets", async () => {
  const router = adminApiRouter(makeIndiekit());
  const res = await callRoute(router, "get", "/blog-widgets");
  assert.equal(res.body.length, 2);
});

test("GET /api/homepage.json returns the homepage config (public)", async () => {
  const router = publicApiRouter(makeIndiekit());
  const res = await callRoute(router, "get", "/homepage.json");
  assert.equal(res.body.layout, "two-column");
});
