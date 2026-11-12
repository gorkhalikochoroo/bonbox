/**
 * The sidebar's count next to "Egenkontrol": missing readings + open
 * deviations, from the shared status poll. Nothing at 0, while loading or on
 * an error — a badge only ever says that something needs a reading.
 */
import CheckStatusPill from "../ui/CheckStatusPill";
import { useLanguage } from "../../hooks/useLanguage";
import useEgenkontrolStatus, { attentionCount } from "./useEgenkontrolStatus";

export default function EgenkontrolNavBadge() {
  const { t } = useLanguage();
  const status = useEgenkontrolStatus();
  const count = attentionCount(status);
  if (!count) return null;
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
