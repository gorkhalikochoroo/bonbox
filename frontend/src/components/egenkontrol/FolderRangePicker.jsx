/**
 * The Kontrolmappe's period (R1b, owner and manager): "Seneste 30 dage" (the
 * default), "Denne måned", "Sidste måned", "Seneste 3 måneder" and "Vælg
 * datoer". One period drives BOTH the folder on screen and the PDF, so what
 * the owner sees is what the file holds. At most 92 days per file (the
 * server's rule, and the reason "Seneste 3 måneder" is today − 91 … today);
 * the last day can never be after the venue's today.
 */
import { useState } from "react";
import Chip from "../ui/Chip";
import { RANGE_MAX_DAYS, rangePreset, rangeProblem } from "./ekLogic";

const PRESETS = [
  ["last30", "ekRangeLast30"],
  ["thisMonth", "ekRangeThisMonth"],
  ["lastMonth", "ekRangeLastMonth"],
  ["last92", "ekRangeLast92"],
  ["custom", "ekRangeCustom"],
];

const FIELD =
  "h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 text-[15px] " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 font-display tabular-nums";

export default function FolderRangePicker({ value, onChange, today, t }) {
  const preset = value?.preset || "last30";
  const [from, setFrom] = useState(value?.from || "");
  const [to, setTo] = useState(value?.to || today || "");
  const [problem, setProblem] = useState(null);

  const pick = (p) => {
    setProblem(null);
    if (p === "custom") {
      const cur = value?.from && value?.to ? value : rangePreset("last30", today);
      setFrom(cur.from || "");
      setTo(cur.to || "");
      onChange?.({ preset: "custom", from: cur.from, to: cur.to });
      return;
    }
    onChange?.({ preset: p, ...rangePreset(p, today) });
  };

  const setCustom = (f, tt) => {
    setFrom(f);
    setTo(tt);
    const bad = rangeProblem(f, tt, today);
    setProblem(bad);
    if (!bad) onChange?.({ preset: "custom", from: f, to: tt });
  };

  return (
    <div className="mb-4" data-testid="ek-range">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("ekRangeLabel")}>
        {PRESETS.map(([p, key]) => (
          <Chip key={p} className="h-10" selected={preset === p} onClick={() => pick(p)} data-testid={`ek-range-${p}`}>
            {t(key)}
          </Chip>
        ))}
      </div>
      {preset === "custom" ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ek-range-from" className="block text-[13px] text-gray-700 dark:text-gray-300 mb-1">{t("ekRangeFrom")}</label>
            <input id="ek-range-from" type="date" className={FIELD} value={from} max={today || undefined} onChange={(e) => setCustom(e.target.value, to)} />
          </div>
          <div>
            <label htmlFor="ek-range-to" className="block text-[13px] text-gray-700 dark:text-gray-300 mb-1">{t("ekRangeTo")}</label>
            <input id="ek-range-to" type="date" className={FIELD} value={to} max={today || undefined} onChange={(e) => setCustom(from, e.target.value)} />
          </div>
          <p className="text-[13px] text-gray-600 dark:text-gray-400">{t("ekRangeMax", { days: RANGE_MAX_DAYS })}</p>
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-2 text-[13.5px] text-red-700 dark:text-red-400" data-testid="ek-range-error">
          {t(problem === "range_too_long" ? "ekErrRangeTooLong" : "ekErrRangeBad")}
        </p>
      ) : null}
    </div>
  );
}
