import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";
import { DEFAULTS, ROLE_KEYS, emptyRoles } from "../lib/storage/defaults-site.js";

test("mergeWithDefaults returns defaults when input is empty", () => {
  const result = mergeWithDefaults({});
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.identity.locale, "en");
  assert.equal(result.branding.surfacePreset, "warm-stone");
  assert.equal(result.branding.mode, "auto");
  assert.equal(result.features.webmentions, true);
});

test("mergeWithDefaults overrides only provided values", () => {
  const result = mergeWithDefaults({
    identity: { name: "chardonsbleus.org" },
  });
  assert.equal(result.identity.name, "chardonsbleus.org");
  assert.equal(result.identity.locale, "en");
});

test("mergeWithDefaults preserves nested overrides for branding roles", () => {
  const result = mergeWithDefaults({
    branding: {
      roles: { heading: { light: "#001a33", dark: "#e6f0ff" } },
    },
  });
  assert.deepEqual(result.branding.roles.heading, {
    light: "#001a33",
    dark: "#e6f0ff",
  });
  // Untouched roles still default to null
  assert.equal(result.branding.roles.fg, null);
});

test("mergeWithDefaults preserves explicit null source values", () => {
  const result = mergeWithDefaults({
    branding: { surfaceCustom: null },
  });
  assert.equal(result.branding.surfaceCustom, null);
});

test("mergeWithDefaults replaces arrays rather than concatenating", () => {
  const result = mergeWithDefaults({
    navigation: {
      items: [{ label: "About", url: "/about/", external: false }],
    },
  });
  assert.equal(result.navigation.items.length, 1);
  assert.equal(result.navigation.items[0].label, "About");
});

test("DEFAULTS exposes schemaVersion 3", () => {
  assert.equal(DEFAULTS.schemaVersion, 3);
});

test("DEFAULTS.branding has the v3 shape — no flat colors block", () => {
  // Verify the old v1 `colors` block is gone
  assert.equal(DEFAULTS.branding.colors, undefined);
  // Verify the new v2 keys are present
  assert.equal(DEFAULTS.branding.mode, "auto");
  assert.equal(DEFAULTS.branding.accentBase, "#b45309");
  assert.equal(DEFAULTS.branding.accentPreset, "amber");
  assert.ok(DEFAULTS.branding.roles);
  for (const role of ROLE_KEYS) {
    assert.equal(
      DEFAULTS.branding.roles[role],
      null,
      `Expected branding.roles.${role} === null in defaults`,
    );
  }
});

test("emptyRoles returns a fresh object with all role keys set to null", () => {
  const r1 = emptyRoles();
  const r2 = emptyRoles();
  assert.notStrictEqual(r1, r2, "Should return a fresh object each call");
  for (const role of ROLE_KEYS) {
    assert.equal(r1[role], null);
  }
});

test("ROLE_KEYS contains all 10 Tier 2 roles per the v2 spec", () => {
  const expected = [
    "bg",
    "fg",
    "fgMuted",
    "heading",
    "link",
    "action",
    "actionFg",
    "surface",
    "border",
    "focus",
  ];
  for (const key of expected) {
    assert.ok(ROLE_KEYS.includes(key), `ROLE_KEYS missing "${key}"`);
  }
  assert.equal(ROLE_KEYS.length, expected.length);
});

test("DEFAULTS.branding.history starts as an empty array", () => {
  assert.ok(Array.isArray(DEFAULTS.branding.history));
  assert.equal(DEFAULTS.branding.history.length, 0);
});
