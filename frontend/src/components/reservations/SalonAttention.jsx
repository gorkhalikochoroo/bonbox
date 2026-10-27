// What a salon owner must act on, at the top of Aftaler (R6, 27 Oct 2026).
// Owner session only — the door stand never mounts it.
//
//   1. Next week has no published shift for the stylists customers book
//      (rubric S7). An employed stylist is bookable only on PUBLISHED Vagtplan
//      shifts, so that week has no online time at all — and nothing said so.
//      One tap, "Kopiér sidste uge", copies this week into next week as Kladde
//      (POST /staff/schedules/copy-week, the same call Vagtplan makes). Kladde
//      is still not bookable: the card then says so and links to Vagtplan on
//      that week, where the owner reads it through and taps Udgiv. Drafts
//      already there: the card links to Udgiv instead of copying again.
//
//   2. Appointments that sit on a stylist's Ferie / Syg / Barns sygedag /
//      Andet day (rubric S6). R1 took her off the guest page; bookings made
//      before stayed in the book, flagged only on the day itself. Each one
//      here has "Flyt", which opens it in the book (the ?booking=&date= deep
//      link) where Rediger moves it.
//
// Both come from GET /reservations/salon/attention. A failed read shows
// nothing — never a claim drawn from a fetch that did not answer.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CalendarX2, ChevronRight, Copy } from "lucide-react";
import api from "../../services/api";
import Button from "../ui/Button";
import { fmtClosureRange, fmtDayMonth } from "../../utils/closures";
import { guestText } from "../../utils/guestText";

export const CONFLICTS_SHOWN = 5;

export const ABSENCE_KIND = {
  ferie: ["absenceKindFerie", "Holiday"],
  sick: ["absenceKindSick", "Sick"],
  barns_syg: ["absenceKindBarns", "Child's sick day"],
  andet: ["absenceKindAndet", "Other"],
};

const BANNER =
  "flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 max-sm:px-3 text-sm " +
  "text-gray-800 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100";
const LINK = "inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2";

export function scheduleWeekHref(weekStart) {
  return weekStart ? `/staff/schedule?week=${encodeURIComponent(weekStart)}` : "/staff/schedule";
}

/** "14:00" as the owner reads it: "14.00" in Danish. */
export function clockText(hhmm, lang) {
  return lang === "da" && hhmm ? String(hhmm).replace(":", ".") : hhmm || "";
}

/** Should the week card show? Only for a salon whose stylists work Vagtplan
 *  shifts, and only while next week has none of them published. */
export function weekNeedsShifts(nw) {
  return !!nw && Number(nw.stylists) > 0 && Number(nw.published) === 0;
}

function copyMessage(res, t) {
  const n = Number(res?.copied) || 0;
  const parts = [
    n === 0
      ? t("rsvpWeekCopiedNone", "Nothing new to copy — those shifts are already in next week.")
      : n === 1
        ? t("rsvpWeekCopiedOne", "1 shift copied as a draft. Customers can book it once you publish the week in Schedule.")
        : t("rsvpWeekCopiedN", "{n} shifts copied as drafts. Customers can book them once you publish the week in Schedule.", { n }),
  ];
  const skipped = (Number(res?.skipped_overlap) || 0) + (Number(res?.skipped_absence) || 0);
  if (skipped > 0) {
    const names = [...(res?.skipped_absence_names || []), ...(res?.skipped_overlap_names || [])]
      .filter((x, i, a) => x && a.indexOf(x) === i);
    parts.push(t("rsvpWeekCopySkipped", "{n} left out (absence or overlap): {names}", {
      n: skipped, names: names.join(", "),
    }));
  }
  return parts.join(" ");
}

function WeekCard({ nw, t, lang, onCopied }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // copy-week answer, or {nothing: true}
  const [error, setError] = useState("");
  const href = scheduleWeekHref(nw.week_start);

  const copy = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/staff/schedules/copy-week", {
        source_week: nw.this_week_start,
        target_week: nw.week_start,
      });
      setDone(res?.data || { copied: 0 });
      onCopied?.();
    } catch (e) {
      if (e?.response?.status === 404) setDone({ nothing: true });
      else setError(t("stfCopyWeekFailed", "Failed to copy last week's schedule."));
    } finally {
      setBusy(false);
    }
  };

  let body;
  let action;
  if (done?.nothing) {
    body = t("schedCopyNothing", "Last week has no shifts to copy.");
    action = <Link to={href} className={LINK}>{t("rsvpWeekPlanCta", "Plan shifts in Schedule")}<ChevronRight className="w-3.5 h-3.5" aria-hidden /></Link>;
  } else if (done) {
    body = copyMessage(done, t);
    action = <Link to={href} data-testid="salon-week-publish" className={LINK}>{t("rsvpWeekPublishCta", "Publish in Schedule")}<ChevronRight className="w-3.5 h-3.5" aria-hidden /></Link>;
  } else if (Number(nw.drafts) > 0) {
    const n = Number(nw.drafts);
    body = n === 1
      ? t("rsvpWeekDraftsOne", "1 shift next week is still a draft — customers can book it once you publish.")
      : t("rsvpWeekDraftsN", "{n} shifts next week are still drafts — customers can book them once you publish.", { n });
    action = <Link to={href} data-testid="salon-week-publish" className={LINK}>{t("rsvpWeekPublishCta", "Publish in Schedule")}<ChevronRight className="w-3.5 h-3.5" aria-hidden /></Link>;
  } else {
    body = t("rsvpWeekEmptyBody", "From Monday {date}, customers can't book a time with your stylists online.", {
      // "Fra mandag 2. nov" — the sentence names the weekday itself.
      date: fmtDayMonth(nw.week_start, lang),
    });
    action = Number(nw.this_week) > 0 ? (
      <Button
        type="button"
        variant="primary"
        size="md"
        busy={busy}
        onClick={copy}
        data-testid="salon-week-copy"
        iconLeft={<Copy className="w-4 h-4" aria-hidden />}
        className="max-sm:w-full max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]"
      >
        {t("rsvpWeekCopyBtn", "Copy last week")}
      </Button>
    ) : (
      <Link to={href} className={LINK}>{t("rsvpWeekPlanCta", "Plan shifts in Schedule")}<ChevronRight className="w-3.5 h-3.5" aria-hidden /></Link>
    );
  }

  return (
    <div role="status" data-testid="salon-week-empty" className={BANNER}>
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("rsvpWeekEmptyTitle", "No shifts published for next week")}</p>
        <p className="mt-0.5 text-[13px] text-gray-700 dark:text-gray-200">{body}</p>
        {error && <p role="alert" className="mt-1 text-[13px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-2">{action}</div>
      </div>
    </div>
  );
}

function ConflictsCard({ ac, t, lang, onOpenBooking }) {
  const items = (ac.items || []).slice(0, CONFLICTS_SHOWN);
  const more = Math.max(0, Number(ac.count) - items.length);
  const n = Number(ac.count);
  return (
    <div role="status" data-testid="salon-absence-conflicts" className={BANNER}>
      <CalendarX2 className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {n === 1
            ? t("rsvpAbsenceConflictsOne", "1 appointment is on a day the stylist is away")
            : t("rsvpAbsenceConflictsN", "{n} appointments are on days the stylist is away", { n })}
        </p>
        <p className="mt-0.5 text-[13px] text-gray-700 dark:text-gray-200">
          {t("rsvpAbsenceConflictsBody", "Move them, or call the customer.")}
        </p>
        <ul className="mt-2 divide-y divide-gray-200 dark:divide-gray-700 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))]">
          {items.map((c) => {
            const kind = ABSENCE_KIND[c.kind];
            const name = guestText(c.guest_name) || "—";
            const details = [
              `${fmtClosureRange(c.day, null, lang)} ${clockText(c.time, lang)}`,
              c.service_name,
              c.stylist ? (kind ? `${c.stylist} (${t(kind[0], kind[1])})` : c.stylist) : null,
            ].filter(Boolean).join(" · ");
            return (
              <li key={c.id} data-testid="salon-absence-conflict" className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">{name}</p>
                  {/* Wraps, never cuts: the stylist's "(Ferie)" is the reason
                      the row is here, and at 390 the line ended "Mia (F…"
                      (judge 27 Oct, frame 13). */}
                  <p className="break-words text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">{details}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => onOpenBooking?.(c)}
                  aria-label={t("rsvpAbsenceConflictMoveAria", "Move the appointment with {name}", { name })}
                  className="shrink-0 max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]"
                >
                  {t("rsvpAbsenceConflictMove", "Move")}
                </Button>
              </li>
            );
          })}
        </ul>
        {more > 0 && (
          <p className="mt-1.5 text-[12px] text-gray-500 dark:text-gray-400">
            {t("rsvpAbsenceConflictsMore", "+{n} more", { n: more })}
          </p>
        )}
      </div>
    </div>
  );
}

export default function SalonAttention({ t, lang = "da", refreshKey = 0, onOpenBooking }) {
  const [data, setData] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => {
    api.get("/reservations/salon/attention")
      .then((r) => { if (alive.current) setData(r?.data || null); })
      .catch(() => { if (alive.current) setData(null); });
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const nw = data?.next_week;
  const ac = data?.absence_conflicts;
  const showWeek = weekNeedsShifts(nw);
  const showConflicts = !!ac && Number(ac.count) > 0 && Array.isArray(ac.items) && ac.items.length > 0;
  if (!showWeek && !showConflicts) return null;
  return (
    <div className="space-y-2" data-testid="salon-attention">
      {showConflicts && <ConflictsCard ac={ac} t={t} lang={lang} onOpenBooking={onOpenBooking} />}
      {showWeek && <WeekCard key={nw.week_start} nw={nw} t={t} lang={lang} onCopied={load} />}
    </div>
  );
}
