/**
 * A revisor login is never sent to the verification wall. Its session is
 * read-only — the server refuses the code request and the code check for an
 * accountant — so the wall would be a dead end. And a revisor login made from
 * an invite link that was never e-mailed is deliberately left unconfirmed
 * (server: accountant_signup): that flag only decides that the inbox owner's
 * first e-mail sign-in takes the login over. It is not a step for the revisor.
 *
 * (integrate-1008 keeps this in utils/verifySkip.js, which this branch does
 * not have — it belongs to the 7-day "Spring over for nu" work.)
 */
export function verifyWallSkipsRole(user) {
  return String(user?.role || "").toLowerCase() === "accountant";
}
