export const CURATED_FONTS = Object.freeze({
  // "system-ui" is a CSS generic — no @font-face needed
  sans:  Object.freeze(["Inter", "Source Sans Pro", "system-ui"]),
  // "Georgia" is system-bundled on all major platforms — no @font-face needed
  serif: Object.freeze(["Fraunces", "Source Serif Pro", "Georgia"]),
  // "ui-monospace" is a CSS generic — no @font-face needed
  mono:  Object.freeze(["ui-monospace", "JetBrains Mono", "Source Code Pro"]),
});

export function isValidFont(name, category = null) {
  if (typeof name !== "string") return false;
  if (category != null) {
    return CURATED_FONTS[category]?.includes(name) ?? false;
  }
  return Object.values(CURATED_FONTS).some((list) => list.includes(name));
}
