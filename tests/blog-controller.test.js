import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlogBody } from "../lib/controllers/blog.js";

// 6.3-T7: the blogListingSidebar half DISSOLVED into the listing surface
// (collection:default composition, edited in Design → Listing). parseBlogBody
// now owns ONLY blogPostSidebar (6.4's territory).

test("parseBlogBody extracts blogPostSidebar and no longer parses blogListingSidebar", () => {
  const body = {
    blogListingSidebar: JSON.stringify([{ type: "search", config: {} }]),
    blogPostSidebar:    JSON.stringify([{ type: "toc", config: {} }, { type: "share", config: {} }]),
  };
  const result = parseBlogBody(body);
  assert.equal("blogListingSidebar" in result, false);
  assert.equal(result.blogPostSidebar.length, 2);
  assert.equal(result.blogPostSidebar[0].type, "toc");
});

test("parseBlogBody defaults to an empty blogPostSidebar on missing/invalid", () => {
  assert.deepEqual(parseBlogBody({}), { blogPostSidebar: [] });
});

test("parseBlogBody caps blogPostSidebar at 24 entries", () => {
  const many = JSON.stringify(Array.from({ length: 30 }, () => ({ type: "toc", config: {} })));
  const out = parseBlogBody({ blogPostSidebar: many });
  assert.equal(out.blogPostSidebar.length, 24);
});

test("parseBlogBody strips scripts and bounds custom-html content in blogPostSidebar", () => {
  const huge = "a".repeat(30000);
  const widgets = JSON.stringify([
    { type: "custom-html", config: { content: "<p>ok</p><script>alert(1)</script>" } },
    { type: "custom-html", config: { content: huge } },
  ]);
  const out = parseBlogBody({ blogPostSidebar: widgets });
  assert.equal(out.blogPostSidebar[0].config.content.includes("<script"), false);
  assert.ok(out.blogPostSidebar[1].config.content.length <= 20000);
});

test("parseBlogBody coerces a non-string custom-html title to a bounded string in blogPostSidebar", () => {
  const widgets = JSON.stringify([
    { type: "custom-html", config: { title: { evil: 1 }, content: "<p>ok</p>" } },
  ]);
  const out = parseBlogBody({ blogPostSidebar: widgets });
  assert.equal(typeof out.blogPostSidebar[0].config.title, "string");
  assert.ok(out.blogPostSidebar[0].config.title.length <= 200);
});
