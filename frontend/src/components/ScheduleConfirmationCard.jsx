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
    toneClass = "border-emerald-200 bg-emerald-50/60 dark:bg-emerald-900/10 text-emerald-800 dark:text-emerald-300";
    icon = "✓";
    message = (t("scheduleConfirmAll") || "All {n} staff confirmed this week's schedule.")
      .replace("{n}", String(total_staff));
  } else if (none_confirmed) {
    toneClass = "border-amber-200 bg-amber-50/40 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300";
    icon = "◯";
    message = (t("scheduleConfirmNone") ||
      "Schedule sent to {total} staff — none have confirmed yet. They'll see it when they open their link.")
      .replace("{total}", String(total_staff));
  } else {
    toneClass = "border-amber-200 bg-amber-50/30 dark:bg-amber-900/10 text-gray-800 dark:text-gray-200";
    icon = "◐";
    message = (t("scheduleConfirmPartial") || "{confirmed} of {total} staff confirmed this week.")
      .replace("{confirmed}", String(confirmed_staff))
      .replace("{total}", String(total_staff));
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
