/* ─── App mode (business | personal) ───────────────────────────────────
   ONE rule, two readers. Layout renders the nav; QuickAdd renders the
   money sheet. They used to derive mode independently — Layout from
   localStorage-then-business_type, QuickAdd from localStorage alone — so
   they could disagree and show a personal sheet under a business sidebar
   (no Sale tab, no Expense tab: the owner's only money-entry path, gone).
   Both now call resolveMode(), so divergence isn't a bug to fix, it's a
   state that can't be written down.

   Personal mode belongs to personal ACCOUNTS, not to whoever tapped a
   button once. business_type is the server's signal and is already
   first-class (archetype.py, pillars.py). Anything else — including the
   "" that Apple/Google sign-in mints before onboarding commits a real
   vertical — is a business, and a business is always in business mode.

   DERIVED, never seeded. mode is recomputed from `user` on every render,
   so it cannot outlive the account it was computed for: if business_type
   flips personal→business mid-session, mode snaps to business on the next
   render. A useState seed would keep the old value with the toggle now
   hidden — which is exactly the trap this file exists to remove.

   Fails closed: an unknown business_type resolves to business (the full
   app), never to the 3-item personal nav. */

const MODE_KEY = "bonbox_mode";

/** Is personal mode this account's to have at all? The toggle's gate. */
export function canUsePersonalMode(user) {
  return user?.business_type === "personal";
}

/** The account's current mode. Pure: reads, never writes. */
export function resolveMode(user) {
  if (!canUsePersonalMode(user)) return "business";
  // Personal accounts only: the stored key is a sub-preference letting a
  // personal user sit in the business app. Default to personal — that is
  // what they signed up for. Any other value is treated as personal, so a
  // corrupt key degrades to the account's own mode rather than stranding
  // them somewhere they can't leave.
  return localStorage.getItem(MODE_KEY) === "business" ? "business" : "personal";
}

/** Where "home" is for this account. A personal user's home is /personal —
    /dashboard is the business dashboard and does no personal gating at all,
    so sending them there hands them someone else's app. Uses resolveMode, not
    canUsePersonalMode, so a personal user who has switched into business mode
    still lands on /dashboard. */
export function homeFor(user) {
  return resolveMode(user) === "personal" ? "/personal" : "/dashboard";
}

export function setStoredMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode / quota */ }
}

/** Drop the key. Called for non-personal accounts (it is unreadable for
    them by definition) and on logout, so a shared device never leaks the
    previous user's mode into the next account. */
export function clearStoredMode() {
  try { localStorage.removeItem(MODE_KEY); } catch { /* private mode */ }
}
