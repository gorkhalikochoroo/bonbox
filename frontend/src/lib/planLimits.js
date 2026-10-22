/**
 * The plan limits BonBox prints — ONE place for the landing's price cards.
 *
 * Source of truth: backend/app/services/billing.py PLAN_CAPS (the gate that
 * actually answers 402). This is its display mirror, the same pattern as
 * lib/planPrices.js for config.py PLAN_PRICES_DKK: a test (planLimits.test.js)
 * reads billing.py and fails if a number here drifts from it.
 *
 * Only what a card line states is mirrored, keyed exactly as in billing.py:
 *   team_users              login seats (the owner counts as one: "dig + 2" = 3)
 *   branches                locations ("afdelinger")
 *   staff_members           people on the Vagtplan roster
 *   reservations_per_month  -1 = unlimited
 *   z_report_scans_per_day  Z-bon photo reads a day (the Gratis line)
 *   kasse_extracts_per_day  the Kasserapport photo path; the Gratis line's
 *                           "3 om dagen" must hold on both paths
 *   daily_close_export_days a period export's longest span (Gratis: 7 days)
 *   bookable_resources_max  tables / resources on the floor plan, -1 =
 *                           unlimited (the Gratis line's "op til 3 borde";
 *                           landing fix round, 22 Oct)
 *
 * The landing never types these numbers: its copy carries {users}, {branches},
 * {team}, {staff}, {resv}, {tables} and {scans} placeholders filled from here.
 */
export const PLAN_LIMITS = Object.freeze({
  free: Object.freeze({
    team_users: 1,
    branches: 1,
    staff_members: 3,
    reservations_per_month: 20,
    z_report_scans_per_day: 3,
    kasse_extracts_per_day: 3,
    daily_close_export_days: 7,
    bookable_resources_max: 3,
  }),
  starter: Object.freeze({
    team_users: 3,
    branches: 1,
    staff_members: 50,
    reservations_per_month: -1,
    z_report_scans_per_day: 20,
    kasse_extracts_per_day: 40,
    daily_close_export_days: 31,
    bookable_resources_max: -1,
  }),
  pro: Object.freeze({
    team_users: 5,
    branches: 3,
    staff_members: 200,
    reservations_per_month: -1,
    z_report_scans_per_day: 100,
    kasse_extracts_per_day: 200,
    daily_close_export_days: 366,
    bookable_resources_max: -1,
  }),
});

/** Team members besides the owner: "Dig + 2" on Starter (team_users 3). */
export function teamBesidesOwner(plan) {
  return PLAN_LIMITS[plan].team_users - 1;
}
