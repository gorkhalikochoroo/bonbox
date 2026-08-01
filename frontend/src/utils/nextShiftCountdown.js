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
