/**
 * Where the welcome wizard's finish is going — while it gets there.
 *
 * finishOnboarding stamps onboarding_completed_at, refreshes the user and
 * then navigates to its destination ("Du er klar" /getting-started for a
 * café, with { revisorInviteHeld } as router state when the revisor invite
 * was saved but not mailed). React Router 7 applies that navigation as a
 * transition, so the refreshed user renders FIRST while the location is still
 * /onboarding — and the "already completed → /dashboard" guards (App.jsx
 * OnboardingRoute, OnboardingPage's own effect) replaced the destination and
 * its state with /dashboard (release gate R-b, 9 Oct: "Du er klar" and the
 * held-invite line were never shown after the wizard).
 *
 * The wizard records its destination here before it refreshes the user; the
 * guards send a completed user THERE (with the same state) while it is fresh,
 * and to /dashboard otherwise. The completed-user bounce itself stays: it is
 * what keeps the back button out of the wizard.
 */

// A finish is one click and one round-trip; after this the guards go back
// to /dashboard.
export const FINISH_TARGET_TTL_MS = 10_000;

let target = null;

/** The wizard is finishing: it is going to `to` (with router `state`). */
export function setFinishTarget(to, state, now = Date.now()) {
  target = typeof to === "string" && to.startsWith("/")
    ? { to, state: state || null, at: now }
    : null;
}

/** The finish in progress — { to, state } — or null. */
export function finishTarget(now = Date.now()) {
  if (!target) return null;
  if (now - target.at > FINISH_TARGET_TTL_MS) {
    target = null;
    return null;
  }
  return target;
}

export function clearFinishTarget() {
  target = null;
}

/** Where a completed user who meets /onboarding goes: the finish's own
 *  destination while it is in progress, else the dashboard. */
export function completedOnboardingRedirect(now = Date.now()) {
  const ft = finishTarget(now);
  return ft ? { to: ft.to, state: ft.state } : { to: "/dashboard", state: null };
}
