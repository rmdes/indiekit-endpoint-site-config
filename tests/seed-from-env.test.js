import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentityFromEnv } from "../lib/storage/seed-from-env.js";

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

test("buildIdentityFromEnv maps AUTHOR_NAME to identity.defaultAuthor", () => {
  withEnv({ SITE_NAME: undefined, AUTHOR_NAME: "Jane Doe" }, () => {
    const result = buildIdentityFromEnv();
    assert.equal(result.defaultAuthor, "Jane Doe");
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
    assert.equal(result.name, "A Node on the Web");
    assert.equal(result.description, "Personal site");
    assert.equal(result.defaultAuthor, "Rick Mendes");
    assert.equal(result.timezone, "Europe/Brussels");
    assert.equal(result.locale, "en");
  });
});

test("buildIdentityFromEnv only includes set vars (no nulls)", () => {
  withEnv({ SITE_NAME: "Just Name", SITE_DESCRIPTION: undefined, AUTHOR_NAME: undefined }, () => {
    const result = buildIdentityFromEnv();
    assert.deepEqual(Object.keys(result), ["name"]);
  });
});
