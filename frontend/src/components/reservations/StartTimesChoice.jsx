// "Starttider" on the hours card of a restaurant, a café, a shop or a
// workshop (R8, rubric R9): guests get a time every 15, 30 or 60 minutes.
// The same setting a salon picks on "Tider for aftaler" (R6,
// slot_granularity_min) — one key, one engine grid, the same segmented
// control. It is part of the hours card and saved with its Gem (one save
// per card); the example starts from the card's first open period, so the
// owner sees the times guests will see ("17.30, 18.00, 18.30 …").
import { Choice } from "./SalonRhythmCard";
import { exampleStarts } from "../../utils/bookingHours";

export const TABLE_STEP_CHOICES = [15, 30, 60];

export default function StartTimesChoice({ t, lang = "da", value = 15, onPick, hours, apptWords = false, busy = false }) {
  // A step stored some other way (10, 20 …) is shown as the one that
  // applies, never hidden behind a choice it is not.
  const steps = TABLE_STEP_CHOICES.includes(value)
    ? TABLE_STEP_CHOICES
    : [...TABLE_STEP_CHOICES, value].sort((a, b) => a - b);
  const times = exampleStarts(hours, value, lang).join(", ");
  return (
    <div className="space-y-1.5 pt-1" data-testid="table-start-times">
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
        {t("rsvpStartTimesLabel", "Start times")}
      </p>
      <Choice
        label={t("rsvpStartTimesLabel", "Start times")}
        testid="table-start-times-choice"
        options={steps.map((n) => ({ value: n, label: t("rsvpStartTimesEvery", "Every {n} min", { n }) }))}
        value={value}
        busy={busy}
        onPick={(v) => onPick?.(v)}
      />
      <p className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
        {apptWords
          ? t("rsvpStartTimesExample", "Customers can pick {times} …", { times })
          : t("rsvpStartTimesExampleGuests", "Guests can pick {times} …", { times })}
      </p>
    </div>
  );
}
