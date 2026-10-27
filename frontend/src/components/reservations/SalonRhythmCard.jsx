// "Tider for aftaler" — a salon's start times and its break between
// customers (R6, 27 Oct 2026; rubric S3 and S8). Indstillinger, salons only.
//
//   • Starttider: every 15 or every 30 minutes (slot_granularity_min). A new
//     salon starts on 30 (the server sets it with the first chair); a salon
//     that already took bookings keeps the 15 it had until the owner picks.
//   • Pause mellem kunder: 0, 5, 10 or 15 minutes (service_buffer_min) after
//     every appointment booked online. The owner can still book a customer in
//     closer herself.
//
// One tap saves (PUT /reservations/settings with the one key); the answer is
// the fresh settings, handed straight back to the parent. A failed save says
// so and the control shows what is stored.
import { useEffect, useRef, useState } from "react";
import { Check, Timer } from "lucide-react";
import api from "../../services/api";

export const STEP_CHOICES = [15, 30];
export const BUFFER_CHOICES = [0, 5, 10, 15];

/** The first few start times a step gives from 10:00, written the way the
 *  owner reads a clock ("10.00" in Danish, "10:00" in English). */
export function exampleTimes(step, lang = "da", count = 3) {
  const sep = lang === "da" ? "." : ":";
  const n = Number(step) > 0 ? Number(step) : 15;
  return Array.from({ length: count }, (_, i) => {
    const m = 10 * 60 + i * n;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}${sep}${String(m % 60).padStart(2, "0")}`;
  });
}

// The one segmented choice of the rhythm cards; the restaurant's Starttider
// (R8, StartTimesChoice) uses it too.
export function Choice({ label, options, value, onPick, busy, testid }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testid}
      className="flex w-full sm:inline-flex sm:w-auto rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-white dark:bg-[rgb(var(--surface-card))]"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy}
            onClick={() => onPick(o.value)}
            className={
              "flex-1 sm:flex-none h-9 max-sm:min-h-0! px-3 rounded-md text-sm max-sm:text-[13px] font-medium whitespace-nowrap transition-colors " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-green-accent))] " +
              (on
                ? "bg-gray-900 text-white dark:bg-gray-600 dark:text-white"
                : "text-gray-700 dark:text-gray-300 hover:bg-gray-900/[0.06] dark:hover:bg-gray-800")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function SalonRhythmCard({ t, lang = "da", settings = null, onSaved }) {
  const stored = {
    slot_granularity_min: Number(settings?.slot_granularity_min) || 15,
    service_buffer_min: Number(settings?.service_buffer_min) || 0,
  };
  // The choice being saved, shown at once; cleared when the answer lands.
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const shown = (key) => (pending && pending.key === key ? pending.value : stored[key]);

  const choose = async (key, value) => {
    if (pending || value === stored[key]) return;
    setPending({ key, value });
    setError("");
    setSaved(false);
    try {
      const res = await api.put("/reservations/settings", { settings: { [key]: value } });
      if (res?.data) onSaved?.(res.data);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e?.response?.data?.detail?.error || t("rsvpSettingsSaveError", "Couldn't save settings."));
    } finally {
      setPending(null);
    }
  };

  const step = shown("slot_granularity_min");
  const buffer = shown("service_buffer_min");
  // A step the owner stored some other way (60, or by hand) is shown as the
  // one that applies, never hidden behind a choice it is not.
  const steps = STEP_CHOICES.includes(step) ? STEP_CHOICES : [...STEP_CHOICES, step].sort((a, b) => a - b);

  return (
    <section
      data-testid="salon-rhythm-card"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 max-sm:p-3 space-y-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
            <Timer className="w-4 h-4 text-gray-400" aria-hidden />
            {t("rsvpRhythmTitle", "Appointment times")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("rsvpRhythmIntro", "How customers pick a time on your booking page.")}
          </p>
        </div>
        {saved && (
          <span role="status" className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
            <Check className="w-3.5 h-3.5" aria-hidden /> {t("rsvpSaved", "Saved")}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
          {t("rsvpStartTimesLabel", "Start times")}
        </p>
        <Choice
          label={t("rsvpStartTimesLabel", "Start times")}
          testid="salon-start-times"
          options={steps.map((n) => ({ value: n, label: t("rsvpStartTimesEvery", "Every {n} min", { n }) }))}
          value={step}
          busy={!!pending}
          onPick={(v) => choose("slot_granularity_min", v)}
        />
        <p className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
          {t("rsvpStartTimesExample", "Customers can pick {times} …", { times: exampleTimes(step, lang).join(", ") })}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
          {t("rsvpBufferLabel", "Break between customers")}
        </p>
        <Choice
          label={t("rsvpBufferLabel", "Break between customers")}
          testid="salon-buffer"
          options={BUFFER_CHOICES.map((n) => ({
            value: n,
            label: n === 0 ? t("rsvpBufferNone", "None") : t("rsvpBufferMin", "{n} min", { n }),
          }))}
          value={buffer}
          busy={!!pending}
          onPick={(v) => choose("service_buffer_min", v)}
        />
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {buffer > 0
            ? t("rsvpBufferHint", "Added after every appointment booked online, so you have time to get ready. You can still book a customer in closer yourself.")
            : t("rsvpBufferHintNone", "Customers can book back to back.")}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
