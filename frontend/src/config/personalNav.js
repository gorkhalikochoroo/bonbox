/* ─── Personal-mode navigation ─────────────────────────────────────────
   The personal user's destinations, in ONE place, projected onto the two
   surfaces that render them (sidebar + mobile bottom bar) — mirroring how
   navManifest.js works for the business app.

   Deliberately NOT folded into NAV_MANIFEST: every consumer of that
   manifest (Cmd-K, /more, the sidebar group builder, the pillar/tier/
   activation axes) is business-shaped, and a personal entry would have to
   opt out of all of it. Kept separate and small.

   Why one list: mode already had three independent readers, and two of
   them disagreed. The sidebar showed personalNav while the bottom bar
   showed Home/Sales/Today — a business bar under a personal sidebar, on
   the same screen. A second hand-maintained list is how that happens
   again, so the surfaces project from this one instead.

   `surfaces` is the same vocabulary navManifest uses.
   /contact is sidebar-only ON PURPOSE: App.jsx registers it OUTSIDE the
   ProtectedRoute/Layout group, so a bottom tab pointing at it would
   unmount the very bar you tapped. */

export const PERSONAL_NAV = [
  { to: "/personal", icon: "User",          labelKey: "dashboard", tabLabelKey: "navHome",     surfaces: ["sidebar", "bottomNav"] },
  { to: "/loans",    icon: "Banknote",      labelKey: "loanTracker", tabLabelKey: "loanTracker", surfaces: ["sidebar", "bottomNav"] },
  { to: "/contact",  icon: "MessageCircle", labelKey: "contact",   surfaces: ["sidebar"] },
];

export function personalNavFor(surface) {
  return PERSONAL_NAV.filter((d) => d.surfaces.includes(surface));
}

/** Bottom-bar tabs for personal mode: /personal · "+" · /loans.
    Three slots in a bar built for five, centre "+" still centred. The two
    dropped tabs would each have lied: /more renders the business grid
    (MorePage resolves a personal account to the "general" type and admits
    Reports/MOMS/Tax/Vagtplan), and /contact leaves the shell. */
export function personalTabs() {
  const [home, loans] = personalNavFor("bottomNav");
  return [
    { to: home.to, icon: "User", labelKey: home.tabLabelKey },
    // Centre "+" — chrome, carries no route. QuickAdd resolves its own mode.
    { icon: "Plus", labelKey: "add", isCenter: true },
    { to: loans.to, icon: "Banknote", labelKey: loans.tabLabelKey },
  ];
}
