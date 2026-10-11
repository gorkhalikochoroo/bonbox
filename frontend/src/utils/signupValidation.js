/**
 * Sign-up field checks, shared by /register (push 6) and its tests.
 *
 * These only decide what the owner sees while typing; the server decides for
 * real (backend/app/schemas/auth.py UserRegister, and register's disposable /
 * MX checks).
 */

// A typed address is checked for shape only — the server decides the rest
// (disposable providers, a domain with no mail server).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The e-mail field's own message key, or null. */
export function emailProblem(value) {
  const v = (value || "").trim();
  if (!v) return "suErrEmailEmpty";
  if (!EMAIL_SHAPE.test(v)) return "suErrEmailInvalid";
  return null;
}

/**
 * Where a password stands against the server's rule (8+ characters, at least
 * one letter and one digit — backend schemas/auth.py UserRegister). Letters
 * are any script's (\p{L}), so "æøåæøå12" passes here as it does there.
 */
export function passwordState(value) {
  const v = value || "";
  if (!v) return { ok: false, key: "suPwHint" };
  if (v.length < 8) return { ok: false, key: "suPwNeedMore", vars: { n: 8 - v.length } };
  if (!/\p{Nd}/u.test(v)) return { ok: false, key: "suPwNeedDigit" };
  if (!/\p{L}/u.test(v)) return { ok: false, key: "suPwNeedLetter" };
  if (v.length >= 12) return { ok: true, key: "suPwStrong" };
  return { ok: true, key: "suPwOk" };
}
