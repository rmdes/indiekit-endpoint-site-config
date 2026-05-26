/**
 * Social link entry validators.
 * @module validators/social
 */

import { isValidUrl } from "./identity.js";

export const SOCIAL_ICONS = Object.freeze([
  "",
  "github", "gitlab", "forgejo", "codeberg", "sourcehut",
  "linkedin", "bluesky", "mastodon", "activitypub", "pixelfed",
  "twitter", "facebook", "instagram", "threads", "reddit",
  "hackernews", "indieweb",
  "youtube", "twitch", "flickr", "spotify", "bandcamp",
  "soundcloud", "funkwhale", "lastfm", "peertube", "bookwyrm",
  "matrix", "discord", "signal", "telegram", "xmpp",
  "rss", "email", "keybase", "orcid", "website",
]);

export const REL_VALUES = Object.freeze(["me", "me atproto"]);

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isValidSocialLink(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.name !== "string" || entry.name.trim() === "") return false;
  if (!isValidUrl(entry.url)) return false;
  const rel = entry.rel || "me";
  if (!REL_VALUES.includes(rel)) return false;
  const icon = entry.icon ?? "";
  if (!SOCIAL_ICONS.includes(icon)) return false;
  return true;
}

/**
 * @param {unknown} input
 * @returns {Array<{name: string, url: string, rel: string, icon: string}>}
 */
export function sanitizeSocialList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = {
      name: (entry.name || "").trim(),
      url:  (entry.url  || "").trim(),
      rel:  (entry.rel  || "me").trim(),
      icon: (entry.icon || "").trim(),
    };
    if (isValidSocialLink(candidate)) out.push(candidate);
  }
  return out;
}
