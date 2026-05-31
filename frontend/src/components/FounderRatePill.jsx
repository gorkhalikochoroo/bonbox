/**
 * FounderRatePill — Task #85 landing page urgency widget.
 *
 * Renders a live "X / 100 founder seats taken" pill at the top of
 * the landing hero.  Backed by the public, rate-limited
 * /api/public/founder-rate-status endpoint — no auth needed, no PII
 * returned.
 *
 * Three render states:
 *   1. Loading       — render an invisible placeholder so the hero
 *                      layout doesn't jump on first paint.
 *   2. Locked (claimed < max) — emerald pill with the live count.
 *   3. Sold out      — amber pill saying founder rate is closed.
 *                      Kept visible so existing visitors see the
 *                      pricing was real, not bait-and-switch.
 *
 * Defensive: fetch failures collapse to the invisible state.  The
 * landing page must never look broken because of a counter side-show.
 */
import { useLanguage } from "../hooks/useLanguage";
import useFounderRateStatus from "../hooks/useFounderRateStatus";

export default function FounderRatePill() {
  const { t } = useLanguage();
  const { status, valid } = useFounderRateStatus();

  if (!valid) return null;

  const { claimed, max_slots, available, locked } = status;

  if (!locked) {
    // Founder rate sold out — be honest about it, keep the pill
    // visible so the social proof ("we got 100 cafés!") still works.
    return (
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5
                   bg-amber-50 border border-amber-200/80 rounded-full
                   text-[12px] font-medium text-amber-800 mb-4"
        role="status"
        aria-label={t("founderRateSoldOutAria", { max_slots })}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        {t("founderRateSoldOut", { max_slots })}
      </div>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5
                 bg-amber-50 border border-amber-200/80 rounded-full
                 text-[12px] font-medium text-amber-800 mb-4"
      role="status"
      aria-label={t("founderRateAvailableAria", { available, max_slots })}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      {t("founderRateAvailable", { claimed, max_slots })}
    </div>
  );
}
