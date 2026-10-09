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
 * guards send a completed user THERE (with the same state) while the finish
 * is in flight and for a short while after its own navigation, and to
 * /dashboard otherwise. The completed-user bounce itself stays: it is
 * what keeps the back button out of the wizard.
 */

// How long the finish's destination still wins AFTER the finish has
// navigated there (a re-render of the /onboarding guard before that
// navigation commits). There is no limit while the finish is still in flight:
// the POST /auth/onboarding/complete and the GET /auth/me before it can take
// far longer than this on a slow phone or a cold server (services/api.js
// retries a 503 and a failed GET on a 2/4/8/12 s backoff — ~26 s), and the
// completed user renders the moment /auth/me answers (review fix, 9 Oct: a
// 10 s window started before the requests sent a slow finish to /dashboard).
export const FINISH_TARGET_TTL_MS = 10_000;

let target = null;

/** The wizard is finishing: it is going to `to` (with router `state`). It
 *  holds, with no expiry, until finishTargetReached() is called. */
export function setFinishTarget(to, state) {
  target = typeof to === "string" && to.startsWith("/")
    ? { to, state: state || null, reachedAt: null }
    : null;
}

/** The finish has run its own navigation: from now on its destination lapses
 *  after FINISH_TARGET_TTL_MS, and the guards go back to /dashboard (what
 *  keeps the back button out of the wizard). */
export function finishTargetReached(now = Date.now()) {
  if (target && target.reachedAt == null) target.reachedAt = now;
}

/** The finish in progress — { to, state } — or null. */
export function finishTarget(now = Date.now()) {
  if (!target) return null;
  if (target.reachedAt != null && now - target.reachedAt > FINISH_TARGET_TTL_MS) {
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
