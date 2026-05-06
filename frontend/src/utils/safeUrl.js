/**
 * URL safety helpers — defense-in-depth against javascript:/data:/vbscript:
 * URI smuggling. Use BEFORE assigning user/server-supplied URLs to anything
 * the browser will dereference: <a href>, <img src>, <iframe src>,
 * window.location.href, window.open, etc.
 *
 * The whole codebase relies on React's default escaping for text rendering;
 * these helpers are the equivalent layer for navigation/asset URLs, where
 * React doesn't escape anything (the URL itself is the payload).
 *
 * Returns the original string when safe, null otherwise. Callers should
 * treat null as "render nothing / do not navigate" — never fall back to a
 * default that an attacker could influence.
 */

const MAX_URL_LEN = 4096;

function _parseAbsoluteUrl(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_URL_LEN) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Safe for <a href>, window.location, window.open targets pointing to a
 * third-party site. https only — no http (avoids accidental downgrade to
 * a plaintext man-in-the-middle vector).
 */
export function safeExternalUrl(value) {
  const u = _parseAbsoluteUrl(value);
  if (!u) return null;
  return u.protocol === "https:" ? value : null;
}

/**
 * Safe for <img src>. Allows https (remote assets) and same-origin blob:
 * (locally-created object URLs for previews). Rejects everything else,
 * including data: — a data:image/svg+xml URL can ship inline scripts that
 * fire on load via <svg onload=…>.
 */
export function safeImageUrl(value) {
  const u = _parseAbsoluteUrl(value);
  if (!u) return null;
  if (u.protocol === "https:") return value;
  if (u.protocol === "blob:") {
    try {
      const sameOrigin = value.startsWith(`blob:${window.location.origin}/`);
      return sameOrigin ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}
