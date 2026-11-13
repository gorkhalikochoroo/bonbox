/**
 * "Ugens egenkontrol" — the weekly look over last week's registrations
 * (R1b, the Målinger tab; owner and manager read it, only the owner marks it
 * reviewed; not fetched on a curtained shared tablet; hidden for a week with
 * no slot and no reading).
 *
 * Every number is the server's (GET /egenkontrol/week: the folder summary
 * for those seven business days — one code path with the Kontrolmappe):
 * readings, late, not registered, deviations and how many are still open,
 * from paper, corrections. Then the deviations that are open now, a hint when
 * the same check keeps going wrong ("… har haft 3 afvigelser på 30 dage.
 * Gennemgå proceduren."), and documents due for review.
 *
 * Honest scope: looking over the registrations is one part of the venue's own
 * control — not all of it. The owner may type a name and a note (verbatim);
 * the server stamps the time. A second tap answers with the first review.
 */
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import Button from "../ui/Button";
import CheckStatusPill from "../ui/CheckStatusPill";
import api from "../../services/api";
import { formatDateClear } from "../../utils/dateFormat";
import { EK_ERROR_KEYS, REVIEW_NAME_MAX, REVIEW_NOTE_MAX, errorCode, formatTemp } from "./ekLogic";

const FIELD =
  "w-full min-h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 text-[15px] " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400";

export default function WeekReviewCard({ enabled = true, isOwner = false, t, lang = "da" }) {
  const [week, setWeek] = useState(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api
      .get("/egenkontrol/week", { _noRetry: true })
      .then((r) => alive && setWeek(r?.data || null))
      .catch(() => alive && setWeek(null));
    return () => {
      alive = false;
    };
  }, [enabled]);

  if (!enabled || !week || !week.has_activity) return null;
  const s = week.summary || {};
  const open = Array.isArray(week.open_deviations) ? week.open_deviations : [];
  const hints = Array.isArray(week.repeat_hints) ? week.repeat_hints : [];
  const docs = Array.isArray(week.documents_review_due) ? week.documents_review_due : [];
  const review = week.review || null;

  const markReviewed = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const text = (v) => (v.trim() ? v : null);
      const res = await api.post(`/egenkontrol/week/${encodeURIComponent(week.iso_week)}/reviewed`, { name: text(name), note: text(note) });
      setWeek((w) => ({ ...w, review: res?.data || w.review, can_review: false }));
    } catch (err) {
      setError(t(EK_ERROR_KEYS[errorCode(err)] || "ekErrSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const counts = [
    ["ekWeekCountReadings", s.readings, "muted"],
    ["ekWeekCountLate", s.slots_late, "warn"],
    ["ekWeekCountMissed", s.slots_missed, "bad"],
    ["ekWeekCountDeviations", s.deviations, "bad"],
    ["ekWeekCountOpen", s.deviations_open, "bad"],
    ["ekWeekCountPaper", s.paper, "muted"],
    ["ekWeekCountCorrections", s.corrections, "muted"],
  ];

  return (
    <section className="mb-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4" data-testid="ek-week-card">
      <h2 className="text-[16px] font-semibold text-gray-900 dark:text-gray-50">
        {t("ekWeekTitle", { week: week.week_number })}
        <span className="ml-2 text-[14px] font-normal text-gray-600 dark:text-gray-400">
          {formatDateClear(week.start)} – {formatDateClear(week.end)}
        </span>
      </h2>
      <ul className="mt-2 flex flex-wrap gap-2 text-[14px]" data-testid="ek-week-counts">
        {counts.map(([k, n, tone]) => (
          <li key={k}>
            <CheckStatusPill tone={Number(n || 0) > 0 ? tone : "muted"}>{t(k, { count: Number(n || 0) })}</CheckStatusPill>
          </li>
        ))}
      </ul>

      {open.length ? (
        <div className="mt-3">
          <p className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">{t("ekWeekOpenNow")}</p>
          <ul className="mt-1 space-y-0.5 text-[14px]">
            {open.map((d) => (
              <li key={d.entry_id}>
                <CheckStatusPill tone="bad" variant="text">
                  {d.check_name} · {formatTemp(d.value_c, lang)} · {formatDateClear(d.recorded_local_date || "")} {d.recorded_local || ""}
                </CheckStatusPill>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hints.length ? (
        <ul className="mt-3 space-y-0.5 text-[14px]" data-testid="ek-week-hints">
          {hints.map((h) => (
            <li key={h.check_id}>
              <CheckStatusPill tone="warn" variant="text">
                {t("ekRepeatHint", { check: h.check_name || "", count: h.count, days: h.days || 30 })}
              </CheckStatusPill>
            </li>
          ))}
        </ul>
      ) : null}

      {docs.length ? (
        <div className="mt-3 text-[14px]" data-testid="ek-week-docs">
          <p className="font-semibold text-gray-900 dark:text-gray-100">{t("ekWeekDocsDue")}</p>
          <ul className="mt-1 space-y-0.5">
            {docs.map((d) => (
              <li key={d.id} className="text-gray-700 dark:text-gray-300">
                {d.title} · {t("ekDocReviewBy", { due: formatDateClear(d.review_due || "") })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-[13.5px] text-gray-600 dark:text-gray-400" data-testid="ek-week-scope">{t("ekWeekScope")}</p>

      {review ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-[14px] text-gray-800 dark:text-gray-200" data-testid="ek-week-reviewed">
          <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
          {t("ekWeekReviewedLine", {
            date: review.reviewed_local_date ? formatDateClear(review.reviewed_local_date) : "",
            time: review.reviewed_local || "",
            name: review.actor_name ? ` · ${review.actor_name}` : "",
          })}
        </p>
      ) : isOwner && week.can_review ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="ek-week-name" className="block text-[13.5px] font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("ekWeekName")}</label>
            <input id="ek-week-name" className={FIELD} value={name} maxLength={REVIEW_NAME_MAX} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ek-week-note" className="block text-[13.5px] font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("ekWeekNote")}</label>
            <input id="ek-week-note" className={FIELD} value={note} maxLength={REVIEW_NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            {error ? <p role="alert" className="mb-2 text-[13.5px] text-red-700 dark:text-red-400">{error}</p> : null}
            <Button variant="primary" className="h-10" busy={busy} disabled={busy} onClick={markReviewed} data-testid="ek-week-mark">
              {t("ekWeekMarkReviewed")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
