import { test } from "node:test";
import assert from "node:assert/strict";
import { adminApiRouter } from "../lib/controllers/api.js";
import { BUILTIN_BLOCKS } from "../lib/presets/builtin-blocks.js";

// Stub Indiekit with a mock db holding a v3 homepage doc and a populated
// blockCatalog (request-time read, same convention as the discovery routes).
// `compositionsExisting` controls which composition ids the mock reports as
// already present. replaceOne THROWS — the endpoint is dryRun-only and must
// never write; any write attempt fails the test loudly.
function makeIndiekit({ compositionsExisting = [], v3doc } = {}) {
  const source =
    v3doc === undefined
      ? {
          _id: "homepage",
          layout: "two-column",
          hero: { enabled: true, showSocial: true },
          sections: [{ type: "recent-posts", config: { maxItems: 5 } }],
          sidebar: [{ type: "author-card", config: {} }],
          blogListingSidebar: [],
          blogPostSidebar: [],
          footer: [],
        }
      : v3doc;
  return {
    database: {
      collection(name) {
        return {
          async findOne(query) {
            if (name === "homepageConfig") return source;
            if (name === "compositions") {
              return compositionsExisting.includes(query._id)
                ? { _id: query._id }
                : null;
            }
            return null;
          },
          async replaceOne() {
            throw new Error("migration-preview must never write (dryRun only)");
          },
        };
      },
    },
    config: { application: { blockCatalog: BUILTIN_BLOCKS } },
  };
}

// Same wrapper as tests/api-discovery.test.js — drive the express router
// directly, no HTTP listener.
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

test("GET /api/migration-preview returns freshly-computed docs + seed state, no-store", async () => {
  const router = adminApiRouter(
    makeIndiekit({ compositionsExisting: ["homepage"] }),
  );
  const response = await callRoute(router, "GET", "/migration-preview");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.body.report.valid, true);
  assert.equal(response.body.report.dryRun, true);
  assert.ok(response.body.docs.find((d) => d._id === "homepage"));
  // Current compositions-collection state: only "homepage" pre-exists in the
  // mock; the two sidebar surfaces are absent (and the v3 sidebars are empty
  // anyway, so the migrator computes no docs for them).
  assert.deepEqual(response.body.seeded, ["homepage"]);
});

test("migration-preview with no v3 source returns the uniform skipped report", async () => {
  const router = adminApiRouter(makeIndiekit({ v3doc: null }));
  const response = await callRoute(router, "GET", "/migration-preview");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.report.skipped, true);
  assert.deepEqual(response.body.docs, []);
  assert.deepEqual(response.body.seeded, []);
});

test("migration-preview without a database returns 503", async () => {
  const router = adminApiRouter({
    config: { application: { blockCatalog: BUILTIN_BLOCKS } },
  });
  const response = await callRoute(router, "GET", "/migration-preview");
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.ok(response.body.error);
});
