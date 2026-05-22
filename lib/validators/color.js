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
