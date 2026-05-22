export const CURATED_FONTS = Object.freeze({
  sans: ["Inter", "Source Sans Pro", "system-ui"],
  serif: ["Fraunces", "Source Serif Pro", "Georgia"],
  mono: ["ui-monospace", "JetBrains Mono", "Source Code Pro"],
});

export function isValidFont(name, category = null) {
  if (typeof name !== "string") return false;
  if (category) {
    return CURATED_FONTS[category]?.includes(name) ?? false;
  }
  return Object.values(CURATED_FONTS).some((list) => list.includes(name));
}
