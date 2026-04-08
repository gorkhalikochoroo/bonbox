import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "—"; }

export default function TaxAutopilotPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get("/tax/overview");
      setData(res.data);
    } catch { setError("Could not load tax data"); }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🧾</div>
          <p className="text-gray-500 dark:text-gray-400">Loading tax data...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">🧾</div>
        <p className="text-red-500">{error}</p>
        <button onClick={fetchData} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const { tax_name, authority, rate_pct, frequency, upcoming_deadlines, current_month, ytd, alerts } = data;
  const nextDeadline = upcoming_deadlines?.[0];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <FadeIn><h1 className="text-2xl font-bold text-gray-800 dark:text-white">🧾 Tax Autopilot</h1></FadeIn>
        <div className="text-right">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{tax_name} ({rate_pct}%)</p>
          <p className="text-xs text-gray-400">{authority} • {frequency}</p>
        </div>
      </div>

      {/* ─── COUNTDOWN HERO ─── */}
      {nextDeadline && (
        <div className={`rounded-2xl p-6 text-white shadow-lg ${
          nextDeadline.status === "overdue" || nextDeadline.status === "urgent"
            ? "bg-gradient-to-br from-red-600 to-red-700"
            : nextDeadline.status === "soon"
            ? "bg-gradient-to-br from-yellow-600 to-orange-600"
            : "bg-gradient-to-br from-emerald-600 to-green-700"
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm opacity-80">Next {tax_name} Filing</p>
              <p className="text-4xl font-bold mt-1">
                {nextDeadline.days_until < 0 ? `${Math.abs(nextDeadline.days_until)} days overdue!` :
                 nextDeadline.days_until === 0 ? "Due TODAY!" :
                 `${nextDeadline.days_until} days`}
              </p>
              <p className="text-sm opacity-80 mt-1">
                Deadline: {nextDeadline.deadline} • {nextDeadline.period_label}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm opacity-80">Estimated Amount</p>
              <p className="text-3xl font-bold mt-1">
                {fmt(nextDeadline.estimated_amount)} <span className="text-lg opacity-80">{currency}</span>
              </p>
              <p className="text-xs opacity-70 mt-1">
                Output: {fmt(nextDeadline.output_vat)} • Input: {fmt(nextDeadline.input_vat)}
              </p>
            </div>
          </div>
          {/* Progress bar to deadline */}
          {nextDeadline.days_until > 0 && nextDeadline.days_until <= 90 && (
            <div className="mt-4">
              <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white/60 rounded-full transition-all"
                  style={{ width: `${Math.max(5, 100 - (nextDeadline.days_until / 90 * 100))}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "critical" ? "border-red-600 bg-red-50 dark:bg-red-900/20" :
              alert.severity === "warning" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
              alert.severity === "positive" ? "border-green-500 bg-green-50 dark:bg-green-900/20" :
              "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
            }`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{alert.icon}</span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{alert.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{alert.detail}</p>
                  {alert.action && (
                    <p className="text-xs text-green-700 dark:text-green-400 mt-2 font-medium">💡 {alert.action}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label={`This Month ${tax_name}`}
          value={fmt(current_month.vat_payable)}
          sub={current_month.month}
          color={current_month.vat_payable > 0 ? "text-orange-600" : "text-green-600"}
          currency={currency}
        />
        <MetricCard
          label="Month Sales"
          value={fmt(current_month.sales_total)}
          sub={`Output: ${fmt(current_month.output_vat)}`}
          color="text-green-600"
          currency={currency}
        />
        <MetricCard
          label="Month Expenses"
          value={fmt(current_month.expenses_total)}
          sub={`Input: ${fmt(current_month.input_vat)}`}
          color="text-blue-600"
          currency={currency}
        />
        <MetricCard
          label={`YTD ${tax_name}`}
          value={fmt(ytd.vat_payable)}
          sub={`${ytd.year}`}
          color={ytd.vat_payable > 0 ? "text-orange-600" : "text-green-600"}
          currency={currency}
        />
      </div>

      {/* ─── UPCOMING DEADLINES TABLE ─── */}
      {upcoming_deadlines?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">📅 Upcoming Deadlines</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">Period</th>
                  <th className="text-left py-2 px-2">Deadline</th>
                  <th className="text-right py-2 px-2">Sales</th>
                  <th className="text-right py-2 px-2">Output {tax_name}</th>
                  <th className="text-right py-2 px-2">Input {tax_name}</th>
                  <th className="text-right py-2 px-2">Payable</th>
                  <th className="text-center py-2 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {upcoming_deadlines.map((dl, i) => (
                  <tr key={i} className={`border-b dark:border-gray-700/50 ${
                    dl.status === "overdue" ? "bg-red-50/50 dark:bg-red-900/10" :
                    dl.status === "urgent" ? "bg-yellow-50/50 dark:bg-yellow-900/10" : ""
                  }`}>
                    <td className="py-3 px-2 font-medium text-gray-700 dark:text-gray-300">{dl.period_label}</td>
                    <td className="py-3 px-2 text-gray-500">{dl.deadline}</td>
                    <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">{fmt(dl.sales_total)}</td>
                    <td className="py-3 px-2 text-right text-orange-500">{fmt(dl.output_vat)}</td>
                    <td className="py-3 px-2 text-right text-green-500">{fmt(dl.input_vat)}</td>
                    <td className={`py-3 px-2 text-right font-bold ${dl.estimated_amount >= 0 ? "text-orange-600" : "text-green-600"}`}>
                      {fmt(dl.estimated_amount)} {currency}
                    </td>
                    <td className="py-3 px-2 text-center">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                        dl.status === "overdue" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" :
                        dl.status === "urgent" ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300" :
                        dl.status === "soon" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" :
                        dl.status === "approaching" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" :
                        "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                      }`}>
                        {dl.status === "overdue" ? "🚨 Overdue" :
                         dl.status === "urgent" ? "⏰ Urgent" :
                         dl.status === "soon" ? "📅 Soon" :
                         dl.status === "approaching" ? "📋 Coming" :
                         "✅ Upcoming"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── YTD BREAKDOWN ─── */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 dark:text-white mb-4">📊 Year-to-Date Summary ({ytd.year})</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-3">Sales ({tax_name} collected)</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">Total Sales</span>
                <span className="text-sm font-medium text-gray-800 dark:text-white">{fmt(ytd.sales_total)} {currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">Output {tax_name}</span>
                <span className="text-sm font-bold text-orange-600">{fmt(ytd.output_vat)} {currency}</span>
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-3">Expenses ({tax_name} deductible)</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">Total Expenses</span>
                <span className="text-sm font-medium text-gray-800 dark:text-white">{fmt(ytd.expenses_total)} {currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">Input {tax_name}</span>
                <span className="text-sm font-bold text-green-600">{fmt(ytd.input_vat)} {currency}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Net {tax_name} Payable</span>
          <span className={`text-xl font-bold ${ytd.vat_payable >= 0 ? "text-orange-600" : "text-green-600"}`}>
            {ytd.vat_payable >= 0 ? "" : "Refund: "}{fmt(Math.abs(ytd.vat_payable))} {currency}
          </span>
        </div>
      </div>

      {/* Link to VAT report */}
      <div className="flex justify-center">
        <a href="/vat-report" className="text-sm text-green-600 dark:text-green-400 hover:underline">
          View detailed VAT report & export PDF →
        </a>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, color, currency }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}
