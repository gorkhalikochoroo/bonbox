// "Lukkedage og pauser" — close a date for ONLINE booking (Christmas Eve, a
// private party night) and pause online booking until a date (R1 B5/B6,
// 24 Oct 2026). The owner can still write bookings in themselves on those
// days; only the guest page stops taking them.
//
// The server owns the rules and the storage (POST / DELETE
// /api/reservations/closures; reservation_service.clean_closures). Each
// write answers with the fresh list, which goes straight back to the parent.
//
// "Close Christmas Eve" is two taps: the Juleaften chip, then Tilføj.
import { useMemo, useState } from "react";
import { CalendarOff, PauseCircle, X } from "lucide-react";
import { Link } from "react-router-dom";
import api from "../../services/api";
import { useConfirm } from "../../hooks/useConfirm";
import Button from "../ui/Button";
import Input from "../ui/Input";
import {
  activePause,
  CLOSURE_ERRORS,
  CLOSURE_NOTE_MAX,
  closurePresets,
  fmtClosureRange,
  todayIso,
} from "../../utils/closures";

// Phone: 40 px controls with 13 px text (the compact-controls rule).
const PHONE_CTRL = "max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]";
const DATE_INPUT =
  "w-full h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 " +
  "text-sm max-sm:text-[13px] max-sm:min-h-0! text-gray-900 dark:text-gray-100 focus:outline-none " +
  "focus:ring-1 focus:ring-gray-400 focus:border-gray-400";

function errorText(e, t) {
  const code = e?.response?.data?.detail?.error;
  const known = CLOSURE_ERRORS[code];
  if (known) return t(known[0], known[1]);
  return t("rsvpSettingsSaveError", "Couldn't save settings.");
}

// `apptWords`: a salon, a shop, a workshop — customers and appointments.
export default function ClosuresCard({ t, lang = "da", closures = [], onChanged, today = todayIso(), apptWords = false }) {
  const confirm = useConfirm();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState("");
  const presets = useMemo(() => closurePresets(today), [today]);
  const list = Array.isArray(closures) ? closures : [];

  const applyPreset = (p) => {
    setFrom(p.from);
    setTo(p.to || "");
    setNote(t(p.note));
    setError("");
  };

  const add = async () => {
    if (!from || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/reservations/closures", {
        from,
        to: to || null,
        note: note.trim() || null,
        kind: "closed",
      });
      setFrom("");
      setTo("");
      setNote("");
      onChanged?.(res.data?.closures || []);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c) => {
    const dates = fmtClosureRange(c.from, c.to, lang);
    const ok = await confirm({
      message: t("rsvpClosureRemoveConfirm", "Open {dates} for online booking again?", { dates }),
      confirmLabel: t("rsvpClosureRemove", "Remove"),
    });
    if (!ok) return;
    setRemoving(c.id);
    setError("");
    try {
      const res = await api.delete(`/reservations/closures/${c.id}`);
      onChanged?.(res.data?.closures || []);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div
      data-testid="rsvp-closures"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
          <CalendarOff className="w-4 h-4 text-gray-400" aria-hidden />
          {t("rsvpClosuresTitle", "Closed dates and pauses")}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {apptWords
            ? t("rsvpClosuresHintAppt", "Customers can't book online on these days. You can still add appointments yourself.")
            : t("rsvpClosuresHint", "Guests can't book online on these days. You can still add bookings yourself.")}
        </p>
      </div>

      {/* Presets prefill the form; nothing is saved until Tilføj. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("rsvpClosuresTitle", "Closed dates and pauses")}>
        {presets.filter((p) => p.from).map((p) => (
          <button
            key={p.id}
            type="button"
            data-testid={`rsvp-closure-preset-${p.id}`}
            onClick={() => applyPreset(p)}
            aria-pressed={from === p.from && (to || null) === (p.to || null)}
            className={
              "inline-flex items-center h-9 max-sm:h-10 max-sm:min-h-0! px-3 rounded-full border text-[13px] font-medium transition-colors " +
              (from === p.from && (to || null) === (p.to || null)
                ? "border-gray-900 bg-gray-900 text-white dark:border-gray-500 dark:bg-gray-600"
                : "border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800")
            }
          >
            {t(p.label)}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="grid grid-cols-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,10rem)_minmax(0,1fr)_auto] gap-2 sm:items-end"
      >
        <label className="block min-w-0">
          <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t("rsvpClosureFrom", "From")}
          </span>
          <input
            type="date"
            data-testid="rsvp-closure-from"
            value={from}
            min={today}
            onChange={(e) => {
              setFrom(e.target.value);
              if (to && e.target.value && to < e.target.value) setTo("");
            }}
            className={DATE_INPUT}
          />
        </label>
        <label className="block min-w-0">
          <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t("rsvpClosureTo", "To (optional)")}
          </span>
          <input
            type="date"
            data-testid="rsvp-closure-to"
            value={to}
            min={from || today}
            onChange={(e) => setTo(e.target.value)}
            className={DATE_INPUT}
          />
        </label>
        <div className="min-w-0">
          <label htmlFor="rsvp-closure-note" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            {apptWords
              ? t("rsvpClosureNoteAppt", "Message to customers (optional)")
              : t("rsvpClosureNote", "Message to guests (optional)")}
          </label>
          <Input
            id="rsvp-closure-note"
            data-testid="rsvp-closure-note"
            value={note}
            maxLength={CLOSURE_NOTE_MAX}
            placeholder={t("rsvpClosureNotePlaceholder", "e.g. Closed on Christmas Eve")}
            onChange={(e) => setNote(e.target.value.slice(0, CLOSURE_NOTE_MAX))}
            suffix={<span className="text-[11px] tabular-nums text-gray-400">{note.length}/{CLOSURE_NOTE_MAX}</span>}
            className={PHONE_CTRL}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          busy={busy}
          disabled={!from || busy}
          data-testid="rsvp-closure-add"
          className={"h-10 " + PHONE_CTRL}
        >
          {t("rsvpClosureAdd", "Add closed date")}
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {list.length === 0 ? (
        <p data-testid="rsvp-closures-empty" className="text-[13px] text-gray-500 dark:text-gray-400">
          {t("rsvpClosureEmpty", "No closed dates. Closed weekdays are set under Opening hours.")}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-100 dark:border-gray-800">
          {list.map((c) => (
            <li key={c.id} data-testid="rsvp-closure-row" className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">{fmtClosureRange(c.from, c.to, lang)}</span>
                  {c.kind === "pause" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                      <PauseCircle className="w-3 h-3" aria-hidden />
                      {t("rsvpPauseBadge", "Pause")}
                    </span>
                  )}
                </p>
                {c.note && (
                  <p className="mt-0.5 text-[13px] text-gray-500 dark:text-gray-400 break-words">{c.note}</p>
                )}
                {Number(c.bookings) > 0 && (
                  <Link
                    to={`/reservations?date=${c.from}`}
                    data-testid="rsvp-closure-bookings"
                    className="mt-1 inline-block text-[13px] font-medium text-amber-700 dark:text-amber-300 underline underline-offset-2"
                  >
                    {Number(c.bookings) === 1
                      ? t("rsvpClosureBookingsOne", "1 booking is already on these days. See it")
                      : t("rsvpClosureBookingsN", "{n} bookings are already on these days. See them", { n: c.bookings })}
                  </Link>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="md"
                busy={removing === c.id}
                onClick={() => remove(c)}
                iconLeft={<X className="w-4 h-4" aria-hidden />}
                className={"shrink-0 " + PHONE_CTRL}
                data-testid="rsvp-closure-remove"
              >
                {t("rsvpClosureRemove", "Remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// "Sæt online booking på pause…" — inside the online-booking switch card.
// A pause starts now: "resten af i dag", or "til og med" a date. While a pause
// covers today, an amber line says until when, with "Genoptag nu" (no
// confirm: resuming only reopens the page).
export function PauseControl({ t, lang = "da", closures = [], onChanged, today = todayIso() }) {
  const [open, setOpen] = useState(false);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pause = activePause(closures, today);

  const post = async (to) => {
    if (busy || !to) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/reservations/closures", { kind: "pause", to });
      setOpen(false);
      setUntil("");
      onChanged?.(res.data?.closures || []);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    if (busy || !pause) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.delete(`/reservations/closures/${pause.id}`);
      onChanged?.(res.data?.closures || []);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (pause) {
    const to = pause.to || pause.from;
    return (
      <div
        role="status"
        data-testid="rsvp-pause-active"
        className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-900/10 px-3 py-2"
      >
        <p className="flex-1 min-w-0 text-[13px] text-amber-900 dark:text-amber-100 flex items-start gap-2">
          <PauseCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span>
            {to === today
              ? t("rsvpPauseActiveToday", "Online booking is paused for the rest of today.")
              : t("rsvpPauseActive", "Online booking is paused until and including {date}.", {
                date: fmtClosureRange(to, null, lang),
              })}
          </span>
        </p>
        <Button type="button" variant="secondary" size="md" busy={busy} onClick={resume}
          data-testid="rsvp-pause-resume" className={PHONE_CTRL}>
          {t("rsvpPauseResume", "Resume now")}
        </Button>
        {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid="rsvp-pause-open"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 min-h-[40px] max-sm:min-h-0! max-sm:h-10"
      >
        <PauseCircle className="w-4 h-4" aria-hidden />
        {t("rsvpPauseOpen", "Pause online booking…")}
      </button>
      {open && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
          <Button type="button" variant="secondary" size="md" busy={busy} onClick={() => post(today)}
            data-testid="rsvp-pause-today" className={PHONE_CTRL}>
            {t("rsvpPauseToday", "Rest of today")}
          </Button>
          {/* Phone: the label on its own line, then the date and Gem side by
              side — on one row the English "Until and including…" pushed
              Save 33 px past a 375 px screen (review, geom-pause-row). */}
          <div data-testid="rsvp-pause-until-row" className="flex flex-wrap sm:flex-nowrap items-center gap-2 min-w-0">
            <label htmlFor="rsvp-pause-until" className="w-full sm:w-auto text-[13px] text-gray-600 dark:text-gray-300 sm:whitespace-nowrap">
              {t("rsvpPauseUntil", "Until and including…")}
            </label>
            <input
              id="rsvp-pause-until"
              type="date"
              data-testid="rsvp-pause-until"
              value={until}
              min={today}
              onChange={(e) => setUntil(e.target.value)}
              className={DATE_INPUT + " flex-1 min-w-0 sm:flex-none sm:w-40"}
            />
            <Button type="button" variant="primary" size="md" disabled={!until || busy}
              onClick={() => post(until)} data-testid="rsvp-pause-save" className={PHONE_CTRL + " shrink-0"}>
              {t("save", "Save")}
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
