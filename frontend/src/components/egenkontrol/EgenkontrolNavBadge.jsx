/**
 * The sidebar's count next to "Egenkontrol": missing readings + open
 * deviations, from the shared status poll. Nothing at 0, while loading or on
 * an error — a badge only ever says that something needs a reading.
 *
 * `rail` — the I dag rail's own badge shape (today.css .td-badge), in the
 * tone I dag's "Kræver dig" gives the same server finding: amber for a
 * missing reading, red once a deviation is open (diagnostics_service
 * _detect_egenkontrol_due: warn / urgent).
 */
import CheckStatusPill from "../ui/CheckStatusPill";
import { useLanguage } from "../../hooks/useLanguage";
import useEgenkontrolStatus, { attentionCount } from "./useEgenkontrolStatus";

export default function EgenkontrolNavBadge({ rail = false } = {}) {
  const { t } = useLanguage();
  const status = useEgenkontrolStatus();
  const count = attentionCount(status);
  if (!count) return null;
  if (rail) {
    const urgent = Number(status?.open_deviations || 0) > 0;
    return (
      <span
        className={`td-badge ${urgent ? "b-urgent" : "b-warn"}`}
        aria-label={t("tdBadgeAria", { count })}
        title={t("tdBadgeAria", { count })}
        data-testid="ek-nav-badge"
      >
        {count > 99 ? "99+" : count}
      </span>
    );
  }
  return (
    <CheckStatusPill
      variant="count"
      tone="bad"
      className="shrink-0 ml-auto"
      aria-label={t("ekBadgeMissing", { count })}
      title={t("ekBadgeMissing", { count })}
      data-testid="ek-nav-badge"
    >
      {count > 99 ? "99+" : count}
    </CheckStatusPill>
  );
}
