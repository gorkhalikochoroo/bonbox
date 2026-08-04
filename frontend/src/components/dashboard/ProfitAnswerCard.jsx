/**
 * ProfitAnswerCard — the dashboard hero. Answers the only question an owner
 * opens the app for: "am I making money this month, how much is really mine,
 * and where's it going?" — without making them read a chart and subtract.
 *
 * One headline (Overskud), a single bar splitting every krone of revenue into
 * Udgifter (red) + Overskud (green), an honest MOMS heads-up (gross revenue
 * isn't all yours), and the biggest cost driver. Every number is real and
 * already in the dashboard payload (ctx.summary) — month_profit, the
 * revenue/expense split, prev_month_profit, month_moms (filing-engine, never
 * hand-rolled), top_expense_category — so adding/editing/deleting anything
 * moves all of it together via the bonbox-data-changed refetch.
 *
 * Doctrine: gray-900 headline + status colours only (red cost / green profit /
 * amber the taxman), rounded-xl, Inter, calm. Degrades gracefully when the
 * /summary fallback omits the two newer fields (chip + MOMS line just hide).
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { TrendingUp, TrendingDown, Minus, Info, ArrowDownRight } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";
import Amount from "../ui/Amount";

export default function ProfitAnswerCard({ ctx = {} }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const locale = lang === "da" ? "da-DK" : "en-GB";

  const s = ctx?.summary || {};
  const revenue = Number(s.month_revenue || 0);
  const expenses = Number(s.month_expenses || 0);
  const profit = Number(s.month_profit ?? revenue - expenses);
  const prevProfit = s.prev_month_profit;
  const moms = Number(s.month_moms || 0);
  const topCat = s.top_expense_category;
  const topAmt = Number(s.top_expense_amount || 0);

  const cardCls =
    "rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition";

  const monthName = (() => {
    try {
      return new Date().toLocaleDateString(locale, { month: "long" });
    } catch {
      return "";
    }
  })();

  const eyebrow = (
    <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2.5">
      {t("profitEyebrow", "How it's going")} · {monthName}
    </div>
  );

  // Nothing logged yet — invite, don't show a zero.
  if (revenue === 0 && expenses === 0) {
    return (
      <div onClick={() => navigate("/sales")} className={cardCls} data-component="ProfitAnswerCard">
        {eyebrow}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("profitEmpty", "Log a sale and an expense to see your profit.")}
        </p>
      </div>
    );
  }

  const isLoss = profit < 0;

  // vs. last month — only when there's a real positive prior month to divide by.
  let pct = null;
  if (typeof prevProfit === "number" && prevProfit > 0) {
    pct = Math.round(((profit - prevProfit) / prevProfit) * 100);
  }
  const prevMonthName = (() => {
    try {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      return d.toLocaleDateString(locale, { month: "short" });
    } catch {
      return "";
    }
  })();
  const TrendIcon = pct == null ? null : pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;
  // Calm hero: the arrow + colored text ARE the signal — no pill fill.
  const chipCls =
    pct > 0
      ? "text-emerald-700 dark:text-emerald-300"
      : pct < 0
        ? "text-red-600 dark:text-red-400"
        : "text-gray-500 dark:text-gray-400";

  // Bar — of every krone of revenue, how much is cost, how much is SKAT's,
  // and how much is actually the owner's.
  //
  // This used to split revenue two ways, expenses and "is yours", which left
  // the MOMS sitting inside the owner's share — while the footnote three lines
  // below said that same money "goes to SKAT". The card had the figure in hand
  // and still called it theirs. Revenue here is MOMS-INCLUSIVE, so a krone of
  // MOMS was never the business's money to count.
  const yours = Math.max(0, profit - moms);
  const expensePct = revenue > 0 ? Math.min(100, Math.round((expenses / revenue) * 100)) : 100;
  const momsPct = revenue > 0 ? Math.min(100 - expensePct, Math.round((moms / revenue) * 100)) : 0;
  const profitPct = Math.max(0, 100 - expensePct - momsPct);

  return (
    <div onClick={() => navigate("/reports")} className={cardCls} data-component="ProfitAnswerCard">
      {eyebrow}

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {isLoss ? t("profitLossLabel", "Loss this month") : t("profitLabel", "Profit this month")}
          </div>
          <Amount
            value={profit}
            size="hero"
            className={isLoss ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}
          />
        </div>
        {pct != null && TrendIcon && (
          <span className={`inline-flex items-center gap-1 text-sm font-semibold mb-1 tabular-nums ${chipCls}`}>
            <TrendIcon className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" /> {pct > 0 ? "+" : ""}{pct}% {t("profitVs", "vs.")} {prevMonthName}
          </span>
        )}
      </div>

      <div className="mt-4">
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          {t("profitOfRevenue", "Of your revenue")}{" "}
          <Amount value={revenue} size="body" className="text-gray-900 dark:text-gray-100" />
        </div>
        <div className="flex h-7 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
          <div className="bg-red-500 dark:bg-red-600" style={{ width: `${expensePct}%` }} />
          {/* Amber, the same colour the MOMS footnote already uses — this is
              money the owner is holding, not money they earned. */}
          {momsPct > 0 && (
            <div className="bg-amber-500 dark:bg-amber-600" style={{ width: `${momsPct}%` }} />
          )}
          <div className="bg-emerald-500 dark:bg-emerald-600" style={{ width: `${profitPct}%` }} />
        </div>
        <div className="flex justify-between text-xs mt-1.5 tabular-nums gap-3">
          <span className="text-red-600 dark:text-red-400">
            <Amount value={expenses} /> {t("profitToExpenses", "to expenses")}
          </span>
          {moms > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              <Amount value={moms} /> {t("profitToSkat", "to SKAT")}
            </span>
          )}
          {!isLoss && (
            <span className="text-emerald-700 dark:text-emerald-400 text-right">
              {/* profit MINUS moms. The claim "is yours" is a statement about
                  the owner's own money and has to survive being read alone. */}
              <Amount value={yours} /> {t("profitIsYours", "is yours")}
            </span>
          )}
        </div>
      </div>

      {(moms > 0 || (topCat && topAmt > 0)) && (
        <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 flex flex-col gap-2">
          {moms > 0 && (
            <div className="flex items-start gap-2 text-[13px] text-gray-500 dark:text-gray-400">
              <Info className="w-4 h-4 text-gray-400 shrink-0 mt-px" aria-hidden="true" />
              <span>
                {t("profitMomsNote", "Revenue is incl. MOMS — about")}{" "}
                <Amount value={moms} className="font-medium text-amber-600 dark:text-amber-400" />{" "}
                {t("profitMomsNote2", "goes to SKAT.")}
              </span>
            </div>
          )}
          {topCat && topAmt > 0 && (
            <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400">
              <ArrowDownRight className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <span>
                {t("profitTopExpense", "Biggest expense")}:{" "}
                <span className="font-medium text-gray-900 dark:text-gray-100">{topCat}</span> ·{" "}
                <Amount value={topAmt} />
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
