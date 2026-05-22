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

test("mergeWithDefaults preserves explicit null source values", () => {
  const result = mergeWithDefaults({
    branding: { surfaceCustom: null },
  });
  assert.equal(result.branding.surfaceCustom, null);
});

test("mergeWithDefaults replaces arrays rather than concatenating", () => {
  const result = mergeWithDefaults({
    layout: {
      navItems: [
        { label: "About", url: "/about/", external: false },
      ],
    },
  });
  assert.equal(result.layout.navItems.length, 1);
  assert.equal(result.layout.navItems[0].label, "About");
});

test("mergeWithDefaults does not mutate DEFAULTS", () => {
  const before = JSON.stringify({
    locale: result_locale_helper().identity.locale,
    primary: result_locale_helper().branding.colors.primary,
  });
  mergeWithDefaults({
    identity: { locale: "fr" },
    branding: { colors: { primary: "#ff0000" } },
  });
  const after = JSON.stringify({
    locale: result_locale_helper().identity.locale,
    primary: result_locale_helper().branding.colors.primary,
  });
  assert.equal(before, after);
});

function result_locale_helper() {
  return mergeWithDefaults({});
}

test("mergeWithDefaults: scalar source overrides object target (mixed-type collision)", () => {
  // Edge case: user explicitly clears a section by sending a non-object value.
  // Current semantics: scalar wins, object replaced.
  const result = mergeWithDefaults({
    branding: { colors: "invalid-value" },
  });
  assert.equal(result.branding.colors, "invalid-value");
});
