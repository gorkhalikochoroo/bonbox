/**
 * Where a sign-in should land, from the login page's ?next= — e.g.
 * bonbox.dk/staff sends a signed-out visitor to /login?next=/staff/schedule.
 *
 * Only a path on THIS site is accepted: it must start with one "/" — never
 * "//host" or "/\host" (both read as another site), a scheme, or a control
 * character — and it never points back at the sign-in pages themselves.
 * Anything else is null, and the sign-in lands where it always did.
 */
export function safeNextPath(search) {
  let raw;
  try {
    raw = new URLSearchParams(search || "").get("next");
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = raw.split(/[?#]/)[0];
  if (path === "/login" || path.startsWith("/login/") || path === "/register") return null;
  return raw;
}
