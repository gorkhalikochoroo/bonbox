/**
 * A revisor login is never sent to the verification wall. Its session is
 * read-only — the server refuses the code request and the code check for an
 * accountant — so the wall would be a dead end. And a revisor login made from
 * an invite link that was never e-mailed is deliberately left unconfirmed
 * (server: accountant_signup): that flag only decides that the inbox owner's
 * first e-mail sign-in takes the login over. It is not a step for the revisor.
 *
 * utils/verifySkip (the 7-day "Spring over for nu") re-exports it for
 * postLoginPath and its callers.
 */
export function verifyWallSkipsRole(user) {
  return String(user?.role || "").toLowerCase() === "accountant";
}
