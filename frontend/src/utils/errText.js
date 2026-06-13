/**
 * errText — coerce ANY axios/API error into a safe, human-readable string.
 *
 * THE BUG THIS PREVENTS (shipped P0, 2026-06-13):
 *   FastAPI 422 responses carry `detail` as an ARRAY of validation objects
 *   ({type, loc, msg, input}). Code that did `setError(err.response.data.detail)`
 *   then rendered `{error}` as a React child handed React a raw object →
 *   "Objects are not valid as a React child" (minified error #31) → the whole
 *   app fell into the error boundary. A handled error became a white-screen.
 *
 *   `detail` can be: a string (most HTTPException), an array (422 validation),
 *   or an object ({code, reason, ...} for our structured errors). This helper
 *   always returns a STRING so it is safe to render directly.
 *
 * Usage:
 *   import { errText } from "../utils/errText";
 *   setError(errText(err, t("somethingWentWrong")));
 */
export function errText(err, fallback = "Something went wrong. Try again.") {
  const detail = err?.response?.data?.detail;

  // FastAPI 422 → array of {type, loc, msg, input}. Surface the first message
  // (and field name when present) rather than dumping the object.
  if (Array.isArray(detail)) {
    const first = detail[0] || {};
    const msg = typeof first.msg === "string"
      ? first.msg.replace(/^Value error,\s*/, "")
      : "";
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
    if (msg && field && field !== "body") return `${field}: ${msg}`;
    if (msg) return msg;
    return fallback;
  }

  // Plain-string detail (the common HTTPException shape).
  if (typeof detail === "string" && detail.trim()) return detail;

  // Structured object detail ({code, reason, error, message, ...}). Pull a
  // string field if one exists; never return the object itself.
  if (detail && typeof detail === "object") {
    const s = detail.reason || detail.error || detail.message || detail.code;
    if (typeof s === "string" && s.trim()) return s;
  }

  // Other shapes the API sometimes uses, then the network-layer message.
  const top = err?.response?.data?.message || err?.response?.data?.reason;
  if (typeof top === "string" && top.trim()) return top;
  if (typeof err?.message === "string" && err.message.trim()) return err.message;

  return fallback;
}

export default errText;
