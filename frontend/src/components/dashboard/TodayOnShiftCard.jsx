/**
 * TodayOnShiftCard — Zone 1 dashboard card (Task #204, P2.6).
 *
 * Why it exists: the dashboard already had SmartStaffingCard, but that
 * surface answers "what should next week's plan look like?", not the
 * literal #1 question an owner opens BonBox to ask — "who is working
 * RIGHT NOW?". This card fills that hole.
 *
 * Behaviour:
 *   • Fetches GET /api/staff/today on mount + on bonbox-data-changed.
 *   • The backend resolves "today" via business_today_local(user) so
 *     pre-cutoff (06:00 DK default) wall-clock times return yesterday's
 *     business day's shifts.
 *   • Self-vetoes when the owner has no staff members at all — the
 *     parent renderIf gate already covers this (`activations.hasStaff`),
 *     but we also short-circuit defensively so a logged-in user with
 *     stale `staff_configured` doesn't see a spinner forever.
 *   • Sorts shifts by start_time asc (server already does this; client
 *     re-sorts to stay calm if the order changes upstream).
 *   • Empty state copy stays DK ("Ingen vagter i dag — føj en til
 *     vagtplanen") per Manoj's DK terminology lock — `vagtplan` does
 *     NOT translate even in EN UI.
 *   • Premium aesthetic: gray-900 typography, no rainbow, rounded-xl,
 *     no emoji.  Uses the existing `Card` primitive.
 */
import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Calendar, ChevronRight } from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { Card } from "../ui";

export default function TodayOnShiftCard() {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [shifts, setShifts] = useState([]);
  const [error, setError] = useState(false);

  const fetchShifts = useCallback(async () => {
    setError(false);
    try {
      const res = await api.get("/staff/today");
      const arr = Array.isArray(res?.data?.shifts) ? res.data.shifts : [];
      // Defensive sort — backend already orders by start_time but a
      // stale cached response could ship out of order.
      arr.sort((a, b) => String(a.start_time || "").localeCompare(b.start_time || ""));
      setShifts(arr);
    } catch (err) {
      // 401 is handled by the global axios interceptor (redirects to
      // /login).  Other transport errors → render nothing (calm).
      if (err?.response?.status !== 401) setError(true);
      setShifts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchShifts();
    const onDataChanged = () => fetchShifts();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, [fetchShifts]);

  // Calm loading skeleton — same shape as the populated card so the
  // hand-off doesn't jump the layout.
  if (loading) {
    return (
      <Card>
        <div className="h-5 w-40 bg-gray-100 dark:bg-gray-800 rounded animate-pulse mb-3" />
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-4 w-full bg-gray-100 dark:bg-gray-800 rounded animate-pulse"
            />
          ))}
        </div>
      </Card>
    );
  }

  // Transport error → render nothing rather than a broken card.  The
  // dashboard already has 8+ cards; one missing one is noise the owner
  // doesn't need.
  if (error) return null;

  const hasShifts = shifts.length > 0;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar
            size={16}
            strokeWidth={1.75}
            className="text-gray-500 dark:text-gray-400"
            aria-hidden="true"
          />
          <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
            {t("todayOnShiftTitle") || "Today on shift"}
          </h3>
        </div>
        <Link
          to="/staff/schedule"
          className="inline-flex items-center gap-0.5 text-[12px] text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded px-1"
        >
          {t("todayOnShiftViewPlan") || "Vagtplan"}
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>

      {hasShifts ? (
        /* Multi-location (S4): group by location ONLY when today's shifts
           actually span more than one distinct place — a single-venue owner
           (or a day where everyone works the same place) keeps the flat
           list. Unassigned shifts group under no header. */
        (() => {
          const groups = new Map();
          for (const s of shifts) {
            const k = s.branch_name || "";
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(s);
          }
          const grouped = groups.size > 1;
          const row = (s) => (
            <li
              key={s.id}
              className="flex items-baseline gap-2 text-sm text-gray-700 dark:text-gray-200"
            >
              {s.role && (
                <span className="text-gray-500 dark:text-gray-400 shrink-0">
                  {s.role}
                </span>
              )}
              {s.role && (
                <span className="text-gray-300 dark:text-gray-600" aria-hidden="true">
                  ·
                </span>
              )}
              <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                {s.name}
              </span>
              <span className="text-gray-300 dark:text-gray-600" aria-hidden="true">
                ·
              </span>
              <span className="tabular-nums text-gray-600 dark:text-gray-300 shrink-0">
                {s.start_time}–{s.end_time}
              </span>
            </li>
          );
          if (!grouped) return <ul className="space-y-1.5">{shifts.map(row)}</ul>;
          return (
            <div className="space-y-2.5">
              {[...groups.entries()].map(([branch, rows]) => (
                <div key={branch || "-"}>
                  {branch && (
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                      {branch}
                    </div>
                  )}
                  <ul className="space-y-1.5">{rows.map(row)}</ul>
                </div>
              ))}
            </div>
          );
        })()
      ) : (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {t("todayOnShiftEmpty") ||
            "Ingen vagter i dag — føj en til vagtplanen"}{" "}
          <Link
            to="/staff/schedule"
            className="text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline"
          >
            {t("todayOnShiftEmptyCta") || "Åbn vagtplan"}
          </Link>
        </div>
      )}
    </Card>
  );
}
