import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS_SITE, ROLE_KEYS, emptyRoles } from "../lib/storage/defaults-site.js";

test("DEFAULTS_SITE has schemaVersion 3", () => {
  assert.equal(DEFAULTS_SITE.schemaVersion, 3);
});

test("DEFAULTS_SITE.identity has the rich field set", () => {
  const id = DEFAULTS_SITE.identity;
  for (const key of ["name", "siteName", "avatar", "title", "pronoun", "bio", "description",
                     "locality", "country", "org", "url", "email", "keyUrl"]) {
    assert.ok(key in id, `identity missing key: ${key}`);
  }
  assert.ok(Array.isArray(id.categories), "categories must be an array");
  assert.ok(Array.isArray(id.social), "social must be an array");
});

test("DEFAULTS_SITE has no layout subtree", () => {
  assert.equal(DEFAULTS_SITE.layout, undefined);
});

test("DEFAULTS_SITE.navigation.items is an empty array", () => {
  assert.ok(Array.isArray(DEFAULTS_SITE.navigation.items));
  assert.equal(DEFAULTS_SITE.navigation.items.length, 0);
});

test("DEFAULTS_SITE.branding preserves Path D shape", () => {
  const b = DEFAULTS_SITE.branding;
  assert.equal(b.surfacePreset, "warm-stone");
  assert.equal(b.accentBase, "#b45309");
  assert.equal(b.mode, "auto");
  assert.ok(b.roles && typeof b.roles === "object");
  assert.ok(Array.isArray(b.history));
});

test("ROLE_KEYS and emptyRoles still exported", () => {
  assert.equal(ROLE_KEYS.length, 10);
  const roles = emptyRoles();
  for (const k of ROLE_KEYS) assert.equal(roles[k], null);
});
