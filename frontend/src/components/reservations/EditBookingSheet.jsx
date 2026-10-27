// The edit sheet of a booking on the book — moved here verbatim from
// ReservationsPage (fix round 27 Oct; MERGE §5 item 4) so the door screen's
// own build can load it on first use (stand/standSheet.jsx) and keep its
// 200 kB budget. The owner app imports it as before.
import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import Button from "../ui/Button";
import PartySizeChips from "./PartySizeChips";
import { hm, openTimesFor, sittingMinutes } from "../../utils/bookingTimes";
import { roomFullText } from "../../utils/bookingRefusal";
import { snapStart } from "../../utils/snapStart";
import { useEscToClose, useSheetFocus } from "../../hooks/useSheetFocus";

// ─── Edit booking — "move us to 20:00 / we're 6 not 4" without the dishonest
// cancel-and-recreate (which falsely notified the guest "aflyst"). PATCHes the
// booking through the same occupancy machinery; a taken slot is an honest 409.
export default function EditBookingSheet({
  reservation, t, busy, error, onSubmit, onClose, openHours = null, bookingRules = null,
  warning = null, onClearWarning = null,
  // A salon appointment has one customer: no party size to edit, and the
  // name is the customer's (vertical-fit audit, Oct 2026). The stored party
  // size is kept and sent back unchanged.
  isProvider = false,
  // Appointment words (salon, shop, repair trade) — the labels only.
  apptWords = isProvider,
  // A shop or a workshop asks no allergies (allergens.collects_allergies on
  // the server, which stores none for it): the field shows only to clear one
  // a booking already carries (Push 8 review).
  noAllergy = false,
}) {
  const r = reservation;
  const origDate = r.starts_at ? r.starts_at.slice(0, 10) : "";
  const origTime = r.starts_at ? r.starts_at.slice(11, 16) : "18:00";
  const [date, setDate] = useState(origDate);
  const [time, setTime] = useState(origTime);
  const [party, setParty] = useState(String(r.party_size || 2));
  const [timeNote, setTimeNote] = useState("");
  // The same open-hours times as New booking — moving a booking offered
  // 06:00–23:45, closed days and starts that run past closing included.
  const sitting = sittingMinutes(parseInt(party, 10) || 2, bookingRules);
  const editTimes = openTimesFor(date || origDate, openHours, sitting);
  // A bigger party sits longer; a new day may open later. Either way the
  // start moves to the nearest one that fits, and the sheet says so.
  const snapTime = (len, onDate, n) => {
    const { to, note } = snapStart({ dateIso: onDate, time, openHours, sitting: len, n, service: false, t });
    setTime(to);
    setTimeNote(note);
  };
  const [name, setName] = useState(r.guest_name || "");
  const [phone, setPhone] = useState(r.guest_phone || "");
  // The note could be read here but not changed — the one field a phone call
  // most often updates ("they'll bring a high chair").
  const initialNote = r.guest_notes || "";
  const [note, setNote] = useState(initialNote);
  // Allergy is the reason the stand has an urgent chime at all, and until now
  // there was nowhere to type one. Seeded from the row so leaving it alone
  // sends nothing (see the changed-only guard on submit).
  const initialAllergy = r.allergy_note || "";
  const initialSeverity = r.allergy_severity || "";
  const [allergyNote, setAllergyNote] = useState(initialAllergy);
  const [severity, setSeverity] = useState(initialSeverity);
  // A shop or a workshop: the server stores no allergy, so an older note can
  // only go — and then all of it (note, severity and tags) goes. Typing in
  // the old field silently erased the note and left a bare "Alvorlig" (Push 8
  // review). Tags count too: a workshop's public page once offered the 14 EU
  // food allergens, so "Nødder" ticked with no note showed in the drawer with
  // no way to remove it (Push 8 review, round 6).
  const initialTags = Array.isArray(r.allergen_tags) ? r.allergen_tags : [];
  const oldAllergyOnly = noAllergy && !!(initialAllergy || initialSeverity || initialTags.length > 0);
  const [oldAllergyRemoved, setOldAllergyRemoved] = useState(false);
  const severities = [
    { v: "", label: t("rsvpSevNone", "Ingen") },
    { v: "preference", label: t("rsvpSevPreference", "Præference") },
    { v: "intolerance", label: t("rsvpSevIntolerance", "Intolerance") },
    { v: "severe", label: t("rsvpSevSevere", "Alvorlig") },
  ];
  useEscToClose(onClose, busy);
  const dialogRef = useSheetFocus();
  const changed = () => warning && onClearWarning && onClearWarning();
  const save = (allowOverflow = false) => {
    const body = {
      guest_name: name.trim() || null,
      guest_phone: phone.trim() || null,
    };
    // Time and party only when they changed: a phone-number fix on a seated
    // table must not be refused as "can't move a started booking".
    if (date !== origDate || time !== origTime) body.starts_at = `${date}T${time}:00`;
    const p = Math.max(1, Math.min(100, parseInt(party, 10) || r.party_size));
    if (p !== r.party_size) body.party_size = p;
    // Only send allergy when the host actually touched it. Sending it
    // unchanged would mark a pending AI allergy suggestion "confirmed"
    // as a side effect of editing a phone number — deciding something
    // the host never looked at.
    if (oldAllergyOnly) {
      if (oldAllergyRemoved) {
        body.allergy_note = "";
        body.allergy_severity = "";
        body.allergen_tags = [];
      }
    } else {
      if (allergyNote.trim() !== initialAllergy) body.allergy_note = allergyNote.trim();
      if (severity !== initialSeverity) body.allergy_severity = severity;
    }
    if (note.trim() !== initialNote) body.guest_notes = note.trim();
    if (allowOverflow) body.allow_overflow = true;
    onSubmit(body, { time });
  };
  return (
    <div ref={dialogRef} tabIndex={-1} aria-labelledby="rsvp-edit-title" className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center outline-none" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      {/* Fields scroll; the answer and Save stay pinned at the bottom — the
          button sat below the fold at 1366×768 and on every phone. A form, so
          the keyboard's Go saves. */}
      <form
        onSubmit={(e) => { e.preventDefault(); if (!busy) save(false); }}
        className="relative w-full sm:max-w-sm flex flex-col max-h-[90vh] overflow-hidden bg-white dark:bg-[rgb(var(--surface-raised))] rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] shadow-2xl animate-fadeIn"
      >
        {/* Title and close stay put while the fields scroll. */}
        <div
          className="shrink-0 flex items-start justify-between gap-3 pt-5 pb-1"
          style={{ paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
        >
          <h3 id="rsvp-edit-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {apptWords ? t("rsvpEditTitleAppt", "Edit appointment") : t("rsvpEditTitle", "Edit reservation")}
          </h3>
          <button type="button" onClick={onClose} aria-label={t("close", "Close")}
            className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-3 pb-5 space-y-4"
          style={{ paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
        >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="eb-date" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("rsvpDateLabel", "Date")}</label>
            <input id="eb-date" type="date" value={date}
              onChange={(e) => {
                if (!e.target.value) return;
                setDate(e.target.value);
                snapTime(sitting, e.target.value, parseInt(party, 10) || 2);
                changed();
              }}
              className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 dark:[color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent" />
          </div>
          <div>
            <label htmlFor="eb-time" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("rsvpTimeLabel", "Time")}</label>
            <select id="eb-time" value={time} onChange={(e) => { setTime(e.target.value); setTimeNote(""); changed(); }}
              className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent">
              {/* The booking's own time stays listed even when it is outside
                  today's hours, so opening Edit never silently moves it. */}
              {(editTimes.times.includes(time) ? editTimes.times : [...editTimes.times, time].sort()).map((q) => <option key={q} value={q}>{hm(q)}</option>)}
            </select>
          </div>
        </div>
        {editTimes.closed && (
          <p className="-mt-2 text-[12px] text-gray-600 dark:text-gray-300">
            {t("rsvpClosedThatDayShort", "You're closed that day.")}
          </p>
        )}
        {timeNote && !editTimes.closed && (
          <p role="status" className="-mt-2 text-[12px] text-gray-600 dark:text-gray-300">{timeNote}</p>
        )}
        {!isProvider && (
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{apptWords ? t("rsvpPartySizeAppt", "People") : t("rsvpPartySize", "Party size")}</label>
          {/* Was [1,2,3,4,5,6,8]: opening Edit on a party of 7, 9, 10 or 12
              showed the whole row unselected — the booking said seven and
              the sheet showed nothing. (It saved 7 correctly; the host just
              had no way to see that without tapping a chip and losing it.) */}
          <PartySizeChips
            value={party}
            onChange={(v) => {
              setParty(v);
              const n = parseInt(v, 10) || 2;
              snapTime(sittingMinutes(n, bookingRules), date || origDate, n);
              changed();
            }}
            t={t}
            apptWords={apptWords}
          />
        </div>
        )}
        <div>
          <label htmlFor="eb-name" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {apptWords ? t("rsvpNbGuestNameProvider", "Customer's name") : t("rsvpNbGuestName", "Guest name")}
          </label>
          <input id="eb-name" value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent" />
        </div>
        <div>
          <label htmlFor="eb-phone" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("rsvpPhone", "Phone (optional)")}</label>
          <input id="eb-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
            className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent" />
        </div>
        {/* Same order and words as New booking: note, then the allergy with
            its severity under it — the two sheets disagreed on all three. */}
        <div>
          <label htmlFor="eb-note" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("rsvpNewNote", "Note (optional)")}</label>
          <input id="eb-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
            placeholder={apptWords
              ? t("rsvpNewNotePhAppt", "What it's for, any wishes…")
              : t("rsvpNewNotePh", "Birthday, high chair, window table…")}
            className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent" />
        </div>
        {oldAllergyOnly && (
        <div data-old-allergy="">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpEditOldAllergyAppt", "Allergy from an older booking")}
          </p>
          {oldAllergyRemoved ? (
            <div className="mt-1.5 flex items-center justify-between gap-3 min-h-[44px]">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t("rsvpEditOldAllergyRemovedAppt", "Removed when you save.")}
              </p>
              <Button variant="ghost" size="md" onClick={() => setOldAllergyRemoved(false)}>
                {t("rsvpEditOldAllergyUndoAppt", "Undo")}
              </Button>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center justify-between gap-3 min-h-[44px]">
              <p className="min-w-0 text-sm text-gray-900 dark:text-gray-100 break-words">
                {[
                  initialTags.map((k) => t(`allergen_${k}`, k)).join(", "),
                  initialAllergy,
                  severities.find((sv) => sv.v && sv.v === initialSeverity)?.label,
                ].filter(Boolean).join(" · ")}
              </p>
              <Button variant="secondary" size="md" onClick={() => setOldAllergyRemoved(true)}>
                {t("rsvpEditOldAllergyRemoveAppt", "Remove")}
              </Button>
            </div>
          )}
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            {t("rsvpEditOldAllergyHintAppt", "We no longer ask about allergies here. You can remove it.")}
          </p>
        </div>
        )}
        {!noAllergy && (
        <div>
          <label htmlFor="eb-allergy" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpNewAllergy", "Allergy (optional)")}
          </label>
          <input id="eb-allergy" value={allergyNote} onChange={(e) => setAllergyNote(e.target.value)}
            placeholder={t("rsvpNewAllergyPh", "e.g. nuts, gluten")}
            maxLength={2000}
            className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent" />
          {(allergyNote.trim() || severity) && (
            <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label={t("rsvpEditAllergy", "Allergi")}>
              {severities.filter((sv) => sv.v).map((sv) => {
                const on = sv.v === severity;
                return (
                  <button key={sv.v} type="button" aria-pressed={on}
                    // Tapping the chosen one again clears it, as in New booking.
                    onClick={() => setSeverity(on ? "" : sv.v)}
                    className={"h-10 px-3 rounded-lg border text-sm font-medium " + (on
                      ? sv.v === "severe"
                        ? "bg-red-600 text-white border-red-600"
                        : "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                      : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600")}>
                    {sv.label}
                  </button>
                );
              })}
            </div>
          )}
          {severity === "severe" && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-red-700 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              {t("rsvpEditAllergySevereHint", "Alvorlig vises med rødt i bogen og på værtsskærmen. En ændring her giver ingen lyd — sig det selv til køkkenet.")}
            </p>
          )}
        </div>
        )}
        </div>
        <div
          className="shrink-0 border-t border-gray-100 dark:border-[rgb(var(--surface-line))] px-5 pt-3 space-y-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
        >
          {/* The same answer New booking gives — six on a two-top, a sitting
              past closing, a taken table — with the owner's way through. */}
          {warning && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5 text-sm text-gray-800 dark:text-gray-100 space-y-2.5">
              <div className="font-semibold flex items-start gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                <span>{roomFullText(warning, t, sitting, { edit: true })}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="md" disabled={busy} onClick={() => save(true)}>
                  {t("rsvpEditSaveAnyway", "Save anyway")}
                </Button>
                {!warning.tooBig && (
                  <Button
                    variant="ghost"
                    size="md"
                    disabled={busy}
                    onClick={() => { onClearWarning(); document.getElementById("eb-time")?.focus(); }}
                  >
                    {t("rsvpPickAnotherTime", "Pick another time")}
                  </Button>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-3 py-2 rounded-lg text-sm">{error}</div>
          )}
          <Button type="submit" variant="primary" size="lg" busy={busy} className="w-full justify-center">
            {t("rsvpEditSave", "Save changes")}
          </Button>
        </div>
      </form>
    </div>
  );
}
