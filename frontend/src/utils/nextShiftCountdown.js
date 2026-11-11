/**
 * "When am I next working?" — the countdown chip on the staff Schedule screen.
 *
 * Lives outside the page module so it can be unit-tested (and so exporting it
 * does not break fast-refresh on a 4,800-line component file).
 */
export function nextShiftCountdown(shift, t) {
  if (!shift) return null;
  // Local-time parse matches the existing date+start_time pattern elsewhere.
  const target = new Date(`${shift.date}T${shift.start_time || "00:00"}`);
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.getTime() - Date.now();

  if (ms <= 0) return t("portalCountdownNow");

  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return t("portalCountdownSoonMin", { m: totalMin });

  const h = Math.floor(ms / 3600000);
  if (h < 24) {
    const m = Math.floor((ms % 3600000) / 60000);
    return t("portalCountdownIn", { h, m });
  }

  // Beyond a day, answer in days.
  //
  // This used to return null past ~24h, which meant the one question the
  // screen exists to answer went unanswered for most of the week: open the app
  // on Monday for a Wednesday shift and the chip was simply absent. The date is
  // on screen either way, but a date is arithmetic the staffer has to do and a
  // countdown is not.
  //
  // Hours are dropped at this range on purpose — "om 6 dage 4 t" is noise when
  // the useful fact is "not soon". Calm beats precise once nothing is imminent.
  const d = Math.floor(h / 24);
  return d === 1 ? t("portalCountdownTomorrow") : t("portalCountdownDays", { d });
}

/**
 * The words on the home card's chip (canvas "Pine, ivory & brass").
 *
 *   under an hour away  → "Starter om 12 min"       (also the Stempl ind state)
 *   today, started      → "I dag · i gang"
 *   today, later        → "I dag · om 6 t 27 min"   (lower-case "om": mid-chip)
 *   another day         → the countdown first, then the date ("Om 3 dage · tor 14. nov.")
 *
 * `today` says whether the shift is on today's date; `dateLabel` is the date
 * as the card prints it (used for another day only).
 */
export function nextShiftChip(shift, t, { today = false, dateLabel = "" } = {}) {
  if (!shift) return null;
  const target = new Date(`${shift.date}T${shift.start_time || "00:00"}`);
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.getTime() - Date.now();
  if (ms > 0 && ms < 3600000) {
    // Rounded UP: 30 s before the start still reads "om 1 min", never "0".
    return t("portalChipStartsIn", { m: Math.max(1, Math.ceil(ms / 60000)) });
  }
  if (today) {
    if (ms <= 0) return t("portalChipTodayNow");
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return t("portalChipTodayIn", { h, m });
  }
  return [nextShiftCountdown(shift, t), dateLabel].filter(Boolean).join(" · ");
}
