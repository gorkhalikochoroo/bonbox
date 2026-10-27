/**
 * The door screen's "session" (R11, rubric B11) — what hooks/useAuth.jsx is,
 * in the door screen's own build only (scripts/standBuild.mjs swaps it in).
 *
 * A paired device has no session: its credential is the link in the address
 * bar (services/standAuth), and the server decides what that reaches. The
 * app's AuthProvider still asked GET /auth/me on every cold start — a 401 the
 * door screen then had to be taught to ignore (R10) — and brought the sign-in
 * code (Google, Apple, magic links, the account cache) along. Here: no user,
 * nothing to load, nothing to ask.
 */
/* eslint-disable react-refresh/only-export-components -- a stand-in must have the same exports as the module it replaces (scripts/standBuild.mjs STAND_SWAPS), hooks and provider together, as hooks/useLanguage.jsx and hooks/useAuth.jsx do. */
const NOBODY = Object.freeze({
  user: null,
  loading: false,
  login: async () => null,
  register: async () => null,
  googleLogin: async () => null,
  appleLogin: async () => null,
  googleOauthLogin: async () => null,
  appleOauthLogin: async () => null,
  logout: async () => {},
  setEmailVerified: () => {},
  needsEmailVerification: () => false,
  refreshUser: async () => null,
});

export function AuthProvider({ children }) {
  return children;
}

export function useAuth() {
  return NOBODY;
}
