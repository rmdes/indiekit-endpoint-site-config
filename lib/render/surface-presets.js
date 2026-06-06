// Surface presets — the neutral/tinted base palettes offered in the branding
// admin. Each is an 11-step tone ramp (50 lightest → 950 darkest).
//
//   warm-stone — warm taupe/brown (original rmendes.net palette)
//   cool-slate — blue-gray (Tailwind "slate")
//   stone      — true neutral gray (Tailwind "neutral")
//   sage       — green-tinted neutral
//   clay       — terracotta/rose-tinted warm
//
// `cool-slate` and `stone` ramps are from Tailwind CSS (MIT License,
// Copyright (c) Tailwind Labs, Inc. — https://tailwindcss.com/docs/colors).
export const SURFACE_PRESETS = Object.freeze({
  "warm-stone": Object.freeze({
    50:  "#faf8f5", 100: "#f4f2ee", 200: "#e8e5df",
    300: "#d5d0c8", 400: "#a09a90", 500: "#7a746a",
    600: "#5c5750", 700: "#3f3b35", 800: "#2a2722",
    900: "#1c1b19", 950: "#0f0e0d",
  }),
  "cool-slate": Object.freeze({
    50:  "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0",
    300: "#cbd5e1", 400: "#94a3b8", 500: "#64748b",
    600: "#475569", 700: "#334155", 800: "#1e293b",
    900: "#0f172a", 950: "#020617",
  }),
  // Sage — green-tinted neutral.
  "sage": Object.freeze({
    50:  "#f3f7f1", 100: "#e6efe3", 200: "#cfe0ca",
    300: "#aecaa6", 400: "#82a878", 500: "#5e8a5a",
    600: "#496e47", 700: "#3a5638", 800: "#283a27",
    900: "#1a271a", 950: "#0e150e",
  }),
  // Clay — terracotta/rose-tinted warm.
  "clay": Object.freeze({
    50:  "#faf4f1", 100: "#f4e7e1", 200: "#e8d2c7",
    300: "#d8b3a2", 400: "#c08b73", 500: "#a8705a",
    600: "#8a5642", 700: "#6d4334", 800: "#492d23",
    900: "#2f1d16", 950: "#1a0f0b",
  }),
  "stone": Object.freeze({
    // Tailwind "neutral" — the truest gray with no warm or cool bias.
    50:  "#fafafa", 100: "#f5f5f5", 200: "#e5e5e5",
    300: "#d4d4d4", 400: "#a3a3a3", 500: "#737373",
    600: "#525252", 700: "#404040", 800: "#262626",
    900: "#171717", 950: "#0a0a0a",
  }),
});
