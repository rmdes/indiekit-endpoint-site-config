import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIdentityBody } from "../lib/controllers/identity.js";

test("parseIdentityBody picks up rich fields", () => {
  const body = {
    name: "Ricardo Mendes",
    siteName: "Node on the web",
    avatar: "https://rmendes.net/me.jpg",
    title: "Middleware Engineer",
    pronoun: "he/him",
    bio: "Brussels-based",
    description: "Longer bio here",
    locality: "Brussels",
    country: "Belgium",
    org: "Acme",
    url: "https://rmendes.net",
    email: "rick@example.com",
    keyUrl: "https://rmendes.net/keys/key.txt",
    categories: "indieweb, devops, brussels",
    locale: "en",
    timezone: "Europe/Brussels",
    defaultOgImage: "https://rmendes.net/og.png",
    tagline: "A Node on the Web",
  };
  const id = parseIdentityBody(body);
  assert.equal(id.name, "Ricardo Mendes");
  assert.equal(id.siteName, "Node on the web", "site title is distinct from the person name");
  assert.equal(id.email, "rick@example.com");
  assert.deepEqual(id.categories, ["indieweb", "devops", "brussels"]);
  assert.equal(id.locale, "en");
  assert.equal(id.timezone, "Europe/Brussels");
});

test("parseIdentityBody handles social array from indexed form fields", () => {
  const body = {
    name: "X",
    social: {
      "0": { name: "GitHub", url: "https://github.com/rmdes", rel: "me", icon: "github" },
      "1": { name: "Bluesky", url: "https://bsky.app/profile/me", rel: "me atproto", icon: "bluesky" },
      "2": { name: "", url: "" }, // dropped
    },
  };
  const id = parseIdentityBody(body);
  assert.equal(id.social.length, 2);
  assert.equal(id.social[0].name, "GitHub");
  assert.equal(id.social[1].rel, "me atproto");
});

test("parseIdentityBody falls back to defaults on invalid locale/timezone", () => {
  const body = { name: "X", locale: "english", timezone: "Garbage" };
  const id = parseIdentityBody(body);
  assert.equal(id.locale, "en");
  assert.equal(id.timezone, "UTC");
});

test("parseIdentityBody rejects javascript: URLs", () => {
  const body = { name: "X", url: "javascript:alert(1)" };
  const id = parseIdentityBody(body);
  assert.equal(id.url, ""); // invalid URL → empty
});
