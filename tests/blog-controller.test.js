import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlogBody } from "../lib/controllers/blog.js";

test("parseBlogBody extracts both blog sidebars", () => {
  const body = {
    blogListingSidebar: JSON.stringify([{ type: "search", config: {} }]),
    blogPostSidebar:    JSON.stringify([{ type: "toc", config: {} }, { type: "share", config: {} }]),
  };
  const result = parseBlogBody(body);
  assert.equal(result.blogListingSidebar.length, 1);
  assert.equal(result.blogPostSidebar.length, 2);
  assert.equal(result.blogPostSidebar[0].type, "toc");
});

test("parseBlogBody defaults to empty arrays on missing/invalid", () => {
  assert.deepEqual(parseBlogBody({}), { blogListingSidebar: [], blogPostSidebar: [] });
});

test("parseBlogBody caps blogListingSidebar at 24 entries", () => {
  const many = JSON.stringify(Array.from({ length: 30 }, () => ({ type: "search", config: {} })));
  const out = parseBlogBody({ blogListingSidebar: many, blogPostSidebar: "[]" });
  assert.equal(out.blogListingSidebar.length, 24);
});

test("parseBlogBody strips scripts and bounds custom-html content in blogPostSidebar", () => {
  const huge = "a".repeat(30000);
  const widgets = JSON.stringify([
    { type: "custom-html", config: { content: "<p>ok</p><script>alert(1)</script>" } },
    { type: "custom-html", config: { content: huge } },
  ]);
  const out = parseBlogBody({ blogListingSidebar: "[]", blogPostSidebar: widgets });
  assert.equal(out.blogPostSidebar[0].config.content.includes("<script"), false);
  assert.ok(out.blogPostSidebar[1].config.content.length <= 20000);
});

test("parseBlogBody coerces a non-string custom-html title to a bounded string in blogListingSidebar", () => {
  const widgets = JSON.stringify([
    { type: "custom-html", config: { title: { evil: 1 }, content: "<p>ok</p>" } },
  ]);
  const out = parseBlogBody({ blogListingSidebar: widgets, blogPostSidebar: "[]" });
  assert.equal(typeof out.blogListingSidebar[0].config.title, "string");
  assert.ok(out.blogListingSidebar[0].config.title.length <= 200);
});
