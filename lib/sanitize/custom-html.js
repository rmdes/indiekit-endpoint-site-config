/**
 * Sanitize operator-supplied custom-html block content at WRITE time, so the
 * theme's `| safe` render points only ever emit clean HTML. Rich-content
 * allowlist: formatting, lists, tables, figures, details. Explicitly NO
 * script/iframe/object/embed/form/input/button/svg/math/link/meta/base,
 * no style attributes, no event handlers. External links are forced to
 * rel="noopener noreferrer". Spec §6.
 * @module sanitize/custom-html
 */

import DOMPurify from "isomorphic-dompurify";

const CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "strong", "em", "b", "i", "u", "s", "del", "ins",
    "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "blockquote", "pre", "code", "kbd", "samp", "var",
    "a", "abbr", "cite", "q", "time", "mark", "small",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "figure", "figcaption", "img",
    "hr", "details", "summary",
    "span", "div", "section", "aside", "header", "footer", "address",
  ],
  ALLOWED_ATTR: [
    "href", "title", "alt", "src", "width", "height",
    "class", "id", "lang", "dir",
    "colspan", "rowspan", "scope",
    "datetime", "rel", "type", "start", "reversed", "open", "loading",
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style", "onload", "onerror", "onclick", "onmouseover"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "svg", "math", "link", "meta", "base", "style"],
};

/**
 * @param {unknown} raw
 * @returns {string} clean HTML ("" for non-string input)
 */
export function sanitizeCustomHtml(raw) {
  if (typeof raw !== "string") return "";
  const clean = DOMPurify.sanitize(raw, CONFIG);
  return clean.replace(
    /<a\s+([^>]*\bhref="https?:\/\/[^"]*"[^>]*)>/gi,
    (m, attrs) => (/\brel=/i.test(attrs) ? m : `<a ${attrs} rel="noopener noreferrer">`),
  );
}
