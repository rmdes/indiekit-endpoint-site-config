import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentityFromEnv, maybeSeedFromEnv } from "../lib/storage/seed-from-env.js";

// Helper to save/restore env vars (since tests may run in any order)
function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try { return fn(); }
  finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("buildIdentityFromEnv returns null when no env vars set", () => {
  withEnv({ SITE_NAME: undefined, SITE_DESCRIPTION: undefined, AUTHOR_NAME: undefined, SITE_TIMEZONE: undefined, SITE_LOCALE: undefined }, () => {
    assert.equal(buildIdentityFromEnv(), null);
  });
});

test("buildIdentityFromEnv maps SITE_NAME to identity.name", () => {
  withEnv({ SITE_NAME: "Test Site" }, () => {
    const result = buildIdentityFromEnv();
    assert.equal(result.name, "Test Site");
  });
});

test("buildIdentityFromEnv maps AUTHOR_NAME to identity.name when SITE_NAME unset", () => {
  withEnv({ SITE_NAME: undefined, AUTHOR_NAME: "Jane Doe" }, () => {
    const result = buildIdentityFromEnv();
    assert.equal(result.name, "Jane Doe");
    assert.equal(result.defaultAuthor, undefined, "v3 schema has no defaultAuthor field");
  });
});

test("buildIdentityFromEnv: SITE_NAME wins over AUTHOR_NAME when both set", () => {
  withEnv({ SITE_NAME: "Site Name", AUTHOR_NAME: "Author Name" }, () => {
    const result = buildIdentityFromEnv();
    assert.equal(result.name, "Site Name");
  });
});

test("buildIdentityFromEnv maps multiple env vars together", () => {
  withEnv({
    SITE_NAME: "A Node on the Web",
    SITE_DESCRIPTION: "Personal site",
    AUTHOR_NAME: "Rick Mendes",
    SITE_TIMEZONE: "Europe/Brussels",
    SITE_LOCALE: "en"
  }, () => {
    const result = buildIdentityFromEnv();
    assert.equal(result.name, "A Node on the Web", "SITE_NAME wins over AUTHOR_NAME");
    assert.equal(result.description, "Personal site");
    assert.equal(result.timezone, "Europe/Brussels");
    assert.equal(result.locale, "en");
    assert.equal(result.defaultAuthor, undefined, "v3 schema has no defaultAuthor field");
  });
});

test("buildIdentityFromEnv only includes set vars (no nulls)", () => {
  withEnv({ SITE_NAME: "Just Name", SITE_DESCRIPTION: undefined, AUTHOR_NAME: undefined }, () => {
    const result = buildIdentityFromEnv();
    assert.deepEqual(Object.keys(result), ["name"]);
  });
});

test("seeds homepageConfig with DEFAULTS_HOMEPAGE when collection empty", async () => {
  let homepageDoc = null;
  let siteDoc = null;
  const Indiekit = {
    database: {
      collection(name) {
        if (name === "siteConfig") {
          return {
            async findOne() { return siteDoc; },
            async insertOne(doc) { siteDoc = doc; return { acknowledged: true }; },
            async replaceOne(_filter, doc) { siteDoc = doc; return { acknowledged: true }; },
          };
        }
        if (name === "homepageConfig") {
          return {
            async findOne() { return homepageDoc; },
            async insertOne(doc) { homepageDoc = doc; return { acknowledged: true }; },
          };
        }
      },
    },
  };

  await withEnv({ SITE_NAME: "Seeded Site" }, async () => {
    await maybeSeedFromEnv(Indiekit);
  });

  assert.ok(homepageDoc, "homepageConfig should be seeded");
  assert.equal(homepageDoc._id, "homepage");
  assert.equal(homepageDoc.layout, "two-column");
});

test("does not re-seed homepageConfig when already present", async () => {
  const existingHomepage = { _id: "homepage", layout: "single-column" };
  let homepageDoc = existingHomepage;
  let siteDoc = null;
  let insertCalls = 0;
  const Indiekit = {
    database: {
      collection(name) {
        if (name === "siteConfig") {
          return {
            async findOne() { return siteDoc; },
            async insertOne(doc) { siteDoc = doc; return { acknowledged: true }; },
            async replaceOne(_filter, doc) { siteDoc = doc; return { acknowledged: true }; },
          };
        }
        if (name === "homepageConfig") {
          return {
            async findOne() { return homepageDoc; },
            async insertOne(doc) {
              insertCalls += 1;
              homepageDoc = doc;
              return { acknowledged: true };
            },
          };
        }
      },
    },
  };

  await withEnv({ SITE_NAME: "Already Configured" }, async () => {
    await maybeSeedFromEnv(Indiekit);
  });

  assert.equal(insertCalls, 0, "insertOne must not be called when homepage already exists");
  assert.equal(homepageDoc.layout, "single-column", "existing homepage layout preserved");
});
