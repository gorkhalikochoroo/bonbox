/* ─── ONE party ladder for every sheet that asks "how many?" ───────────
 * There used to be three: Seat-now and Edit offered [1,2,3,4,5,6,8] while
 * New booking offered 1–10 and the public page offers 1–max_party_size.
 * So a booking of 7, 9 or 10 — takeable in New booking, arrivable from the
 * public page — opened in Edit with the whole Party row blank, and the host
 * could not seat a walk-in of 7 at all. The waitlist's add form had a bare
 * number box of its own; it uses this ladder too now.
 *
 * Parties above the ladder exist (the backend accepts 1–100 and the owner
 * can raise max_party_size), so the field also renders the ACTUAL number as
 * a selected chip rather than showing nothing.
 */
import { useState } from "react";

const PARTY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export default function PartySizeChips({ value, onChange, t }) {
  const n = parseInt(value, 10);
  const [other, setOther] = useState("");
  const parsed = (v) => {
    const x = parseInt(v, 10);
    return Number.isFinite(x) && x >= 1 && x <= 100 ? x : null;
  };
  // A real party that is not on the ladder (12, 14 …) gets its own chip at
  // the end — selected, because it IS the booking.
  const offLadder = Number.isFinite(n) && n > 0 && !PARTY_SIZES.includes(n);
  // The typed number IS the party once committed — the box then looks chosen.
  const otherOn = offLadder && String(n) === String(other);
  const chipClass = (on) =>
    "h-11 min-w-[44px] px-3 rounded-lg border text-sm font-medium tabular-nums " +
    // The app's focus ring — it showed the browser's own amber outline.
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 " +
    (on
      ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
      : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600");
  return (
    <div className="flex flex-wrap gap-2 mt-1.5">
      {PARTY_SIZES.map((s) => {
        const on = String(s) === String(value);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(String(s))}
            aria-pressed={on}
            aria-label={s === 1 ? t("rsvpPartyOne", "1 guest") : t("rsvpPartyN", "{n} guests", { n: s })}
            className={chipClass(on)}
          >
            {s}
          </button>
        );
      })}
      {offLadder && String(n) !== String(other) && (
        <button
          type="button"
          onClick={() => onChange(String(n))}
          aria-pressed="true"
          aria-label={t("rsvpPartyN", "{n} guests", { n })}
          className={chipClass(true)}
        >
          {n}
        </button>
      )}
      {/* 11+ could not be entered at all, although the backend takes 1–100.
          A small number box for the big table. */}
      <label className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        <span className="sr-only">{t("rsvpPartyOther", "Other number of guests")}</span>
        {/* No min/max on the box: a "9" typed here met the browser's own
            "must be at least 11" bubble (in English) and Save did nothing.
            The number is checked here, and a ladder number lands on its chip. */}
        <input
          type="number"
          inputMode="numeric"
          placeholder="11+"
          // A draft of its own: committing EVERY keystroke set the party to 1
          // on the "1" of "12". From 11 up it takes over as you type — the
          // chip stayed selected until the box lost focus — and Enter both
          // commits and submits the sheet.
          value={other}
          onChange={(e) => {
            setOther(e.target.value);
            const v = parsed(e.target.value);
            if (v != null && v >= 11) onChange(String(v));
          }}
          onBlur={() => {
            const v = parsed(other);
            if (v == null) { if (other !== "") setOther(""); return; }
            onChange(String(v));
            if (v < 11) setOther("");
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const v = parsed(other);
            if (v == null) { e.preventDefault(); return; }
            onChange(String(v));
            if (v < 11) setOther("");
          }}
          className={"h-11 w-20 px-3 rounded-lg border text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 " + (otherOn
            ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100 placeholder:text-gray-300"
            : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100")}
        />
      </label>
    </div>
  );
}
