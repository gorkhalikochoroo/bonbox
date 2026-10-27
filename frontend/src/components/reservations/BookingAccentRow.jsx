// The colour of the booking page, chosen where the owner manages booking
// (Reservationer → Indstillinger, right under the page's name), booking R5.
//
// One tap: the guest's picked chips (party, day, time) and the main button
// take the colour. It is business_profile.accent_color — the same field as
// Profile → Logo & accent, which also colours the faktura and the gavekort —
// so there is one colour, set in two places, and the row says so.
//
// The text on the colour is picked by contrast (utils/accentColor.js): a
// light gold gets dark text, never an unreadable white. The small preview
// draws the two pieces with the page's own rules (index.css "BOOKING
// ACCENT"), so what the owner sees here is what a guest gets.
//
// No colour from a link: the snippet has no ?accent=, the owner chooses here.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import api from "../../services/api";
import { ACCENT_PRESETS, BOOKING_LOOK_EVENT, accentStyle, accentTokens, normalizeHex } from "../../utils/accentColor";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[rgb(var(--surface-card))]";

// Phone: two rows of four 44 px squares. Eight in one row came out 35 px at
// 390 (walk 27 Oct P3-3), under the 40 px tap floor. From sm: 40 px squares
// in a row. min-h-0! releases the coarse-pointer floor so the size is exact.
const SWATCH =
  "relative w-11 h-11 min-h-0! sm:w-10 sm:h-10 rounded-lg transition-[box-shadow,scale] duration-150 " +
  "inline-flex items-center justify-center disabled:cursor-not-allowed " + FOCUS;

function announce() {
  try {
    window.dispatchEvent(new Event(BOOKING_LOOK_EVENT));
  } catch {
    /* no window (tests) — nothing listens */
  }
}

export default function BookingAccentRow({ t }) {
  // loading | ready | locked (402: no plan and booking off) | error
  const [status, setStatus] = useState("loading");
  const [palette, setPalette] = useState({});
  const [current, setCurrent] = useState(null); // "#RRGGBB" | null (Standard)
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(""); // "" | "saved" | "error"
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .get("/business/brand")
      .then((r) => {
        if (!alive) return;
        setPalette(r?.data?.accent_palette || {});
        setCurrent(normalizeHex(r?.data?.accent_color));
        setStatus("ready");
      })
      .catch((err) => {
        if (alive) setStatus(err?.response?.status === 402 ? "locked" : "error");
      });
    return () => {
      alive = false;
    };
  }, [tries]);

  const presets = ACCENT_PRESETS.filter((name) => normalizeHex(palette[name]));
  const tokens = accentTokens(current);

  const choose = async (name) => {
    const next = name ? normalizeHex(palette[name]) : null;
    if (saving || next === current) return;
    const before = current;
    setCurrent(next); // one tap: the swatch answers at once
    setSaving(true);
    setNote("");
    try {
      const r = await api.patch("/business/brand", { accent_color: name });
      setCurrent(normalizeHex(r?.data?.accent_color));
      setNote("saved");
      announce();
    } catch {
      setCurrent(before);
      setNote("error");
    } finally {
      setSaving(false);
    }
  };

  const label = (name) => t(`rsvpAccentName_${name}`);

  return (
    <div
      data-testid="rsvp-booking-accent"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
    >
      <div className="min-w-0">
        <h2 id="rsvp-accent-label" className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t("rsvpAccentTitle")}
        </h2>
        <p className="mt-0.5 text-[13px] text-gray-600 dark:text-gray-300 leading-snug">{t("rsvpAccentHint")}</p>
      </div>

      {status === "loading" && (
        <div className="h-10 sm:h-9 rounded-lg bg-gray-100 dark:bg-white/[0.06] motion-safe:animate-[bbBreathe_1.6s_ease-in-out_infinite]" aria-hidden="true" />
      )}

      {status === "locked" && (
        <p data-testid="rsvp-accent-locked" className="text-[13px] text-gray-600 dark:text-gray-300">
          {t("rsvpAccentLocked")}
        </p>
      )}

      {status === "error" && (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-[13px] text-gray-600 dark:text-gray-300">{t("rsvpAccentLoadError")}</p>
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              setTries((n) => n + 1);
            }}
            className={"h-10 sm:h-9 min-h-0! px-3 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 " + FOCUS}
          >
            {t("rsvpAccentRetry")}
          </button>
        </div>
      )}

      {status === "ready" && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
          <div
            role="radiogroup"
            aria-labelledby="rsvp-accent-label"
            className="grid grid-cols-4 gap-3 w-fit sm:flex sm:flex-wrap sm:gap-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!current}
              aria-label={t("rsvpAccentStandard")}
              title={t("rsvpAccentStandard")}
              disabled={saving}
              onClick={() => choose(null)}
              data-testid="rsvp-accent-standard"
              className={
                SWATCH + " overflow-hidden " +
                (!current
                  ? "ring-2 ring-gray-900 dark:ring-gray-100 ring-offset-2 ring-offset-white dark:ring-offset-[rgb(var(--surface-card))]"
                  : "ring-1 ring-gray-900/10 dark:ring-white/15")
              }
            >
              {/* BonBox's own look: the ink chip and the green button. */}
              <span className="absolute inset-y-0 left-0 w-1/2 bg-gray-900" aria-hidden="true" />
              <span className="absolute inset-y-0 right-0 w-1/2 bg-bb-green-dark" aria-hidden="true" />
              {!current && <Check className="relative w-4 h-4 text-white" strokeWidth={2.25} aria-hidden="true" />}
            </button>
            {presets.map((name) => {
              const hex = normalizeHex(palette[name]);
              const on = current === hex;
              const sw = accentTokens(hex);
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={label(name)}
                  title={label(name)}
                  disabled={saving}
                  onClick={() => choose(name)}
                  data-testid={`rsvp-accent-${name}`}
                  className={
                    SWATCH + " " +
                    (on
                      ? "ring-2 ring-gray-900 dark:ring-gray-100 ring-offset-2 ring-offset-white dark:ring-offset-[rgb(var(--surface-card))]"
                      : "ring-1 ring-gray-900/10 dark:ring-white/15")
                  }
                  style={{ backgroundColor: sw.bg }}
                >
                  {on && <Check className="w-4 h-4" style={{ color: sw.fg }} strokeWidth={2.25} aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          {/* What a guest gets: a picked time and the main button, drawn with
              the booking page's own rules (data-bb-accent + its classes). */}
          <div
            data-testid="rsvp-accent-preview"
            data-bb-accent={tokens ? "" : undefined}
            style={accentStyle(tokens)}
            className="flex items-center gap-2"
            aria-hidden="true"
          >
            <span className="bb-tile bb-pick inline-flex items-center justify-center h-9 px-3 rounded-xl border text-[14px] font-medium tabular-nums bg-gray-900 border-gray-900 text-white dark:bg-gray-100 dark:border-gray-100 dark:text-gray-900">
              19:00
            </span>
            <span className="bb-cta bb-accent-main inline-flex items-center justify-center h-9 px-4 rounded-xl text-[14px] font-semibold bg-bb-green-dark text-white shadow-[0_1px_2px_rgb(16_24_40/0.18)]">
              {t("rsvpContinue")}
            </span>
          </div>
        </div>
      )}

      {status === "ready" && (
        <p className="text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
          {note === "saved"
            ? t("rsvpAccentSaved")
            : note === "error"
              ? t("rsvpSettingsSaveError")
              : t("rsvpAccentShared")}
        </p>
      )}
    </div>
  );
}
