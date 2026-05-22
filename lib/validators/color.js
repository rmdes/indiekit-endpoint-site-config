// Hex validation uses a regex rather than culori because the responsibilities
// are different: this module guards user input (predicate + normalize); the
// palette derivation layer (lib/render/derive-palette.js) uses culori for
// OKLCH conversion and scale generation. Keeping the two paths separate avoids
// pulling a 50kb color library into the validator's hot path.
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isValidHexColor(value) {
  return typeof value === "string" && HEX_RE.test(value);
}

export function normalizeHex(value) {
  if (!isValidHexColor(value)) return null;
  const v = value.toLowerCase();
  if (v.length === 4) {
    return "#" + v[1].repeat(2) + v[2].repeat(2) + v[3].repeat(2);
  }
  return v;
}
