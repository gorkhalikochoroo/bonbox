/**
 * MomsCountdownCard — the single most anxiety-reducing widget for a DK
 * business owner. Shows:
 *   • days until the next Moms filing
 *   • estimated amount owed (output - input)
 *   • visual urgency (green → amber → red as deadline approaches)
 *
 * Why on the Dashboard (Free tier): every DK biz owner thinks about
 * filings monthly. A single glance answers "am I prepared?" — the
 * highest-leverage stress reducer we can ship at zero cost. Pulls from
 * the existing /api/tax/overview endpoint (already used by /tax page),
 * so there's no new backend work.
 *
 * Defense:
 *   • All numeric fields run through `Number()` with a safe fallback
 *   • The whole card silently no-ops on 404 / 503 / null — owner sees
 *     nothing instead of a broken card
 *   • Card hides itself entirely when there's no upcoming deadline data
 *     (e.g. new account before tax preferences are saved)
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { Card, Icon } from "./ui";
import { useLanguage } from "../hooks/useLanguage";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtAmount(n, currency = "DKK") {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toLocaleString("da-DK", { maximumFractionDigits: 0 })} ${currency}`;
}

export default function MomsCountdownCard() {
  const { t } = useLanguage();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get("/tax/overview")
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) {
    // Keep a low-noise skeleton — never block the rest of the dashboard
    return (
      <Card variant="subtle" className="animate-pulse">
        <div className="h-4 bg-stone-200 dark:bg-stone-700 rounded w-1/3 mb-3" />
        <div className="h-8 bg-stone-200 dark:bg-stone-700 rounded w-1/2" />
      </Card>
    );
  }

  const deadlines = data?.upcoming_deadlines || [];
  const next = deadlines.find((d) => d?.type === "vat" || d?.type === "moms") || deadlines[0];

  // No data = silently hide. New accounts without tax preferences shouldn't
  // see a broken-looking card.
  if (!next || !next.date) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(next.date + "T00:00:00");
  const daysLeft = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  // Urgency tiers — same thresholds the existing TaxPage uses
  let tone, toneText, toneRing;
  if (daysLeft < 0) {
    tone = "bg-red-50 dark:bg-red-900/15";
    toneText = "text-red-700 dark:text-red-300";
    toneRing = "ring-red-200 dark:ring-red-800/40";
  } else if (daysLeft <= 14) {
    tone = "bg-amber-50 dark:bg-amber-900/15";
    toneText = "text-amber-700 dark:text-amber-300";
    toneRing = "ring-amber-200 dark:ring-amber-800/40";
  } else {
    tone = "bg-emerald-50 dark:bg-emerald-900/15";
    toneText = "text-emerald-700 dark:text-emerald-300";
    toneRing = "ring-emerald-200 dark:ring-emerald-800/40";
  }

  const currency = data?.currency || "DKK";
  const owed = next.estimated_amount ?? data?.ytd?.vat_payable ?? null;
  const output = data?.ytd?.output_vat ?? null;
  const input = data?.ytd?.input_vat ?? null;

  // Friendly headline — daysLeft handles all three cases
  let countdown;
  if (daysLeft < 0) {
    countdown = t("momsOverdueBy", "Overdue by {n} days").replace("{n}", String(Math.abs(daysLeft)));
  } else if (daysLeft === 0) {
    countdown = t("momsDueToday", "Due today");
  } else if (daysLeft === 1) {
    countdown = t("momsDueTomorrow", "Due tomorrow");
  } else {
    countdown = t("momsDueInDays", "{n} days").replace("{n}", String(daysLeft));
  }

  return (
    <Link
      to="/tax"
      className={`block rounded-xl ring-1 ${toneRing} ${tone} p-5 hover:shadow-sm transition-shadow`}
      aria-label={t("momsCountdownAria", "Open Tax Autopilot")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <Icon name="Calculator" size={16} className={toneText} />
            <span className={`text-xs font-semibold uppercase tracking-wider ${toneText}`}>
              {t("nextMomsFiling", "Next Moms filing")}
            </span>
          </div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <div className="text-3xl font-bold text-stone-900 dark:text-stone-100 leading-none">
              {countdown}
            </div>
            <div className="text-sm text-stone-500 dark:text-stone-400">
              {fmtDate(next.date)}
              {next.period_label ? ` · ${next.period_label}` : ""}
            </div>
          </div>
          {owed != null && (
            <div className="mt-2 text-sm text-stone-600 dark:text-stone-300">
              {t("momsEstimatedOwed", "Estimated")}:{" "}
              <span className="font-semibold text-stone-900 dark:text-stone-100">
                {fmtAmount(owed, currency)}
              </span>
              {output != null && input != null && (
                <span className="text-stone-400 dark:text-stone-500 ml-1.5">
                  · {t("output", "Output")} {fmtAmount(output, currency)} · {t("input", "Input")} {fmtAmount(input, currency)}
                </span>
              )}
            </div>
          )}
        </div>
        <Icon name="ChevronDown" size={18} className="-rotate-90 text-stone-400 shrink-0 mt-1" />
      </div>
    </Link>
  );
}
