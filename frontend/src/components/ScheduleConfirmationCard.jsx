/**
 * ScheduleConfirmationCard — owner side of the bidirectional schedule
 * confirmation loop.
 *
 * Reads /staff/schedule-confirmation-summary and shows a small calm
 * chip on the dashboard:
 *
 *   ✓ 3 of 4 staff confirmed this week's schedule
 *   ◐ 1 of 4 confirmed — Jonas, Maria not yet seen
 *
 * Every sentence here is about CONFIRMATIONS, which are real events the staff
 * portal records. None of them may describe a delivery: this component has no
 * evidence that anything was ever sent to anyone, and the counts it is handed
 * (total_staff) are roster sizes for the week, not recipients. The none-state
 * used to say "Schedule sent to {total} staff" off the back of that number.
 *
 * Self-hides when:
 *   • No published shifts this week (total_staff = 0) — nothing to confirm
 *   • Everyone confirmed AND we've already shown the celebration once
 *     (less noise for the owner)
 *
 * No nagging, no "send reminder" buttons — that's an anti-pattern.
 * The link IS the reminder; the staff clicks when they're ready.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";


export default function ScheduleConfirmationCard() {
  const { t } = useLanguage();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get("/staff/schedule-confirmation-summary")
      .then((res) => { if (alive) setSummary(res.data); })
      .catch(() => { /* silent — non-critical */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return null;
  if (!summary) return null;
  // No published schedule for the week → nothing to render
  if (!summary.total_staff || summary.total_staff === 0) return null;

  const { total_staff, confirmed_staff, all_confirmed, none_confirmed } = summary;

  // Three states:
  //   1. None confirmed → calm reminder
  //   2. Some confirmed → progress chip
  //   3. All confirmed → quiet celebration
  let toneClass, icon, message;
  if (all_confirmed) {
    toneClass = "border-gray-100 bg-gray-50/60 dark:bg-gray-800/50 text-gray-800 dark:text-gray-300";
    icon = "✓";
    // t(key, fallback) — NOT `t(key) || fallback`. t() returns the key itself
    // when a key is missing, so the `||` never fires and the owner reads
    // "scheduleConfirmAll" rendered as text. Same shape below.
    message = t("scheduleConfirmAll", "All {n} staff confirmed this week's schedule.", {
      n: total_staff,
    });
  } else if (none_confirmed) {
    toneClass = "border-amber-200 bg-amber-50/40 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300";
    icon = "◯";
    // WAS: "Schedule sent to {total} staff — none have confirmed yet."
    //
    // {total} is `total_staff` from /staff/schedule-confirmation-summary, which
    // counts the distinct staff who HAVE A PUBLISHED SHIFT this week. It is the
    // roster for the week. It is not, and never was, a count of anything sent:
    // publishing notifies only staff with an email on file, the portal link is
    // something the owner copies out by hand, and an owner who has done neither
    // still got this sentence telling them the vagtplan had been sent to four
    // people. It then explained their silence for them — "they'll see it when
    // they open their link" — which reads as a delivery that is merely waiting
    // to be picked up.
    //
    // Across 51 venues not one staff link has ever been opened. For every one
    // of those owners this card asserted a delivery that never happened, and
    // the reassurance is why the silence looked normal.
    //
    // Now it states only what the endpoint actually measured: how many people
    // have shifts, and that none of them have confirmed. A new key, because the
    // Danish for the old sentence carries the same false claim.
    message = t(
      "scheduleConfirmNoneHonest",
      "None of the {total} staff with shifts this week have confirmed yet.",
      { total: total_staff },
    );
  } else {
    toneClass = "border-amber-200 bg-amber-50/30 dark:bg-amber-900/10 text-gray-800 dark:text-gray-200";
    icon = "◐";
    message = t("scheduleConfirmPartial", "{confirmed} of {total} staff confirmed this week.", {
      confirmed: confirmed_staff,
      total: total_staff,
    });
  }

  return (
    <div
      role="status"
      className={`rounded-xl border px-4 py-2.5 mb-4 flex items-center gap-3 text-sm ${toneClass}`}
    >
      <span className="text-base shrink-0" aria-hidden>{icon}</span>
      <span className="flex-1 min-w-0">{message}</span>
    </div>
  );
}
