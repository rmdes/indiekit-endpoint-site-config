import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWithDefaults } from "../lib/storage/get-site-config.js";

test("mergeWithDefaults returns defaults when input is empty", () => {
  const result = mergeWithDefaults({});
  assert.equal(result.identity.locale, "en");
  assert.equal(result.branding.surfacePreset, "warm-stone");
  assert.equal(result.features.webmentions, true);
});

test("mergeWithDefaults overrides only provided values", () => {
  const result = mergeWithDefaults({
    identity: { name: "chardonsbleus.org" },
  });
  assert.equal(result.identity.name, "chardonsbleus.org");
  assert.equal(result.identity.locale, "en");  // still default
});

test("mergeWithDefaults preserves nested overrides", () => {
  const result = mergeWithDefaults({
    branding: { colors: { primary: "#1f3a8a" } },
  });
  assert.equal(result.branding.colors.primary, "#1f3a8a");
  assert.equal(result.branding.colors.link, "#3b82f6");  // default
});
