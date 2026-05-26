import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOCIAL_ICONS, REL_VALUES, isValidSocialLink, sanitizeSocialList,
} from "../lib/validators/social.js";

test("SOCIAL_ICONS includes the expected platforms", () => {
  for (const icon of ["github", "mastodon", "bluesky", "linkedin", "rss", "email"]) {
    assert.ok(SOCIAL_ICONS.includes(icon), `missing icon: ${icon}`);
  }
});

test("REL_VALUES includes me and 'me atproto'", () => {
  assert.ok(REL_VALUES.includes("me"));
  assert.ok(REL_VALUES.includes("me atproto"));
});

test("isValidSocialLink accepts a complete entry", () => {
  assert.equal(isValidSocialLink({
    name: "GitHub",
    url: "https://github.com/rmdes",
    rel: "me",
    icon: "github",
  }), true);
});

test("isValidSocialLink rejects invalid URL", () => {
  assert.equal(isValidSocialLink({
    name: "X",
    url: "not-a-url",
    rel: "me",
    icon: "github",
  }), false);
});

test("isValidSocialLink rejects missing url", () => {
  assert.equal(isValidSocialLink({
    name: "X",
    rel: "me",
    icon: "github",
  }), false);
});

test("isValidSocialLink allows empty icon", () => {
  assert.equal(isValidSocialLink({
    name: "Custom",
    url: "https://example.com",
    rel: "me",
    icon: "",
  }), true);
});

test("isValidSocialLink rejects unknown icon", () => {
  assert.equal(isValidSocialLink({
    name: "X", url: "https://example.com", rel: "me", icon: "myspace",
  }), false);
});

test("sanitizeSocialList filters out invalid entries", () => {
  const input = [
    { name: "GitHub", url: "https://github.com/rmdes", rel: "me", icon: "github" },
    { name: "Bad", url: "not-a-url", rel: "me", icon: "github" }, // dropped
    { name: "", url: "" }, // dropped
  ];
  const out = sanitizeSocialList(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "GitHub");
});

test("sanitizeSocialList trims fields and defaults rel to 'me'", () => {
  const input = [
    { name: " GitHub ", url: "https://github.com/rmdes ", icon: "github" },
  ];
  const out = sanitizeSocialList(input);
  assert.equal(out[0].name, "GitHub");
  assert.equal(out[0].url, "https://github.com/rmdes");
  assert.equal(out[0].rel, "me");
});

test("sanitizeSocialList returns empty for non-array input", () => {
  assert.deepEqual(sanitizeSocialList(null), []);
  assert.deepEqual(sanitizeSocialList("foo"), []);
});
