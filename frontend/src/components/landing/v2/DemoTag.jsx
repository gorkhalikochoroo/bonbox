import { useLanguage } from "../../../hooks/useLanguage";

/**
 * The visible "Eksempel · demodata" label every demo picture on the landing
 * carries (push 9, B4). It used to be a screen-reader caption only, so a
 * sighted visitor had no way to tell the hero card's figures from a real
 * customer's. Small and quiet on purpose: it labels, it does not decorate.
 *
 * tone="dark" for the charcoal gavekort band and the dark AI panel.
 */
export default function DemoTag({ tone = "light", className = "" }) {
  const { t } = useLanguage();
  const look =
    tone === "dark"
      ? "border-white/15 bg-white/5 text-[#C9C3B8]"
      : "border-slate-200 bg-white text-slate-500";
  return (
    <span
      data-demo-tag="1"
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-[3px] text-[11px] font-medium leading-none ${look} ${className}`}
    >
      {t("landingV2.demoTag", "Example · demo data")}
    </span>
  );
}
