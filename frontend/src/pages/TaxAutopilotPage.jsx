// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";
import { UpgradeNudge, PageHeader, Button, StatCard, SectionBanner, Icon } from "../components/ui";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "—"; }

export default function TaxAutopilotPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { hasFeature } = useEntitlements();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Bilagsnummer compliance audit (DK only) — fetched in parallel
  const [audit, setAudit] = useState(null);
  // BusinessProfile — needed to pre-fill accountant_email on the
  // filing PDF send button. Fetched in parallel.
  const [businessProfile, setBusinessProfile] = useState(null);
  // Tax preferences (filing frequency / Moms inclusion / has employees) —
  // these directly drive the deadlines + estimates on this page, so the panel
  // belongs here rather than buried in More → Profile.
  const [tax, setTax] = useState({ filing_frequency: "", prices_include_moms: true, has_employees: false });
  const [taxMsg, setTaxMsg] = useState("");
  const [taxSaving, setTaxSaving] = useState(false);

  useEffect(() => { fetchData(); }, []);

  // Pull BusinessProfile (independent of the heavy /tax/overview call) so
  // the filing-PDF send-to-accountant card can pre-fill the recipient.
  useEffect(() => {
    api.get("/business").then((r) => {
      setBusinessProfile(r.data || null);
    }).catch(() => { /* keep null */ });
  }, []);

  // Pre-fill the preferences card from /auth/me (independent of /tax/overview
  // so a slow overview call doesn't block the form).
  useEffect(() => {
    api.get("/auth/me").then((res) => {
      setTax({
        filing_frequency: res.data?.tax_filing_frequency || "",
        prices_include_moms: res.data?.prices_include_moms !== false,
        has_employees: !!res.data?.has_employees,
      });
    }).catch(() => { /* defaults already set */ });
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [ovRes, auditRes] = await Promise.allSettled([
        api.get("/tax/overview"),
        api.get("/tax/voucher-audit"),
      ]);
      if (ovRes.status === "fulfilled") setData(ovRes.value.data);
      else throw new Error("overview failed");
      if (auditRes.status === "fulfilled") setAudit(auditRes.value.data);
    } catch { setError("Could not load tax data"); }
    setLoading(false);
  };

  const saveTaxPrefs = async () => {
    setTaxSaving(true);
    setTaxMsg("");
    try {
      await api.patch("/auth/profile", {
        tax_filing_frequency: tax.filing_frequency || null,
        prices_include_moms: tax.prices_include_moms,
        has_employees: tax.has_employees,
      });
      setTaxMsg("Saved — deadlines will refresh.");
      // Re-fetch so the page reflects the new frequency immediately.
      fetchData();
      setTimeout(() => setTaxMsg(""), 3500);
    } catch (e) {
      setTaxMsg(e?.response?.data?.detail || "Couldn't save.");
    } finally {
      setTaxSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="mb-3 animate-pulse text-gray-400">
            <Icon name="Receipt" size={36} className="mx-auto" />
          </div>
          <p className="text-gray-500 dark:text-gray-400">Loading tax data...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <Icon name="Receipt" size={36} className="text-gray-400 mx-auto mb-4" />
        <p className="text-red-600">{error}</p>
        <Button variant="ghost" onClick={fetchData} className="mt-4">{t("tryAgain")}</Button>
      </div>
    );
  }

  const { tax_name, authority, rate_pct, frequency, upcoming_deadlines, current_month, ytd, alerts, daily_close_reconciliation: recon } = data;
  const nextDeadline = upcoming_deadlines?.[0];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <PageHeader
        eyebrow="REPORTS"
        title="Tax Autopilot"
        subtitle={`Generates filing-ready PDF — you upload to ${authority}. We watch every sale and expense and surface the next deadline.`}
        actions={
          <div className="text-right">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{tax_name} ({rate_pct}%)</p>
            <p className="text-xs text-gray-500">{authority} • {frequency}</p>
          </div>
        }
      />

      {/* ─── HOW IT WORKS (dismissible) ─── */}
      <DismissibleTip
        id="tax-autopilot-intro-v1"
        icon="🧭"
        title="How Tax Autopilot works"
      >
        <p className="mb-1.5">
          We watch every Sale and Expense, calculate the {tax_name} you owe, and generate a
          filing-ready PDF — you upload it to {authority} (or hand it to your revisor).
        </p>
        <p>
          Set your <strong>filing frequency</strong> below — it&rsquo;s the single setting
          that controls everything. DK cafés &amp; small retail are usually <em>half-yearly</em>.
        </p>
      </DismissibleTip>

      {/* ─── TAX PREFERENCES (drives deadlines + Moms math) ─── */}
      <TaxPrefsCard
        tax={tax}
        setTax={setTax}
        saving={taxSaving}
        msg={taxMsg}
        onSave={saveTaxPrefs}
      />

      {/* ─── COUNTDOWN HERO — semantic color (red=overdue, amber=soon, emerald=on track).
          Solid color (not gradient), no rainbow shadow — calmer than the previous
          tech-glow gradient but the urgency cue stays. ─── */}
      {nextDeadline && (
        <div className={`rounded-xl p-6 text-white border ${
          nextDeadline.status === "overdue" || nextDeadline.status === "urgent"
            ? "bg-red-600 border-red-700"
            : nextDeadline.status === "soon"
            ? "bg-amber-600 border-amber-700"
            : "bg-gray-900 border-gray-700"
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
              <p className="text-sm opacity-80">{t("estimatedAmount")}</p>
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

      {/* ─── FILING-READY PDF (Task #51 — Pro tier) ─── */}
      {nextDeadline && (
        <FilingPdfCard
          deadline={nextDeadline}
          taxName={tax_name}
          currency={currency}
          businessProfile={businessProfile}
          unlocked={hasFeature("tax_filing_pdf")}
        />
      )}

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => {
            const severity =
              alert.severity === "critical" ? "critical" :
              alert.severity === "warning" ? "warn" :
              alert.severity === "positive" ? "success" : "info";
            const icon =
              alert.severity === "critical" ? "AlertTriangle" :
              alert.severity === "warning" ? "AlertTriangle" :
              alert.severity === "positive" ? "CheckCircle2" : "FileText";
            return (
              <SectionBanner key={i} severity={severity} icon={icon} title={alert.title}>
                <p>{alert.detail}</p>
                {alert.action && (
                  <p className="text-xs mt-2 font-medium">{alert.action}</p>
                )}
              </SectionBanner>
            );
          })}
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={`This Month ${tax_name}`}
          value={`${fmt(current_month.vat_payable)} ${currency}`}
          helper={current_month.month}
          accent={current_month.vat_payable > 0 ? "warn" : "success"}
        />
        <StatCard
          label="Month Sales"
          value={`${fmt(current_month.sales_total)} ${currency}`}
          helper={`Output: ${fmt(current_month.output_vat)}`}
        />
        <StatCard
          label="Month Expenses"
          value={`${fmt(current_month.expenses_total)} ${currency}`}
          helper={`Input: ${fmt(current_month.input_vat)}`}
        />
        <StatCard
          label={`YTD ${tax_name}`}
          value={`${fmt(ytd.vat_payable)} ${currency}`}
          helper={`${ytd.year}`}
          accent={ytd.vat_payable > 0 ? "warn" : "success"}
        />
      </div>

      {/* ─── DAILY CLOSE RECONCILIATION ─── */}
      {recon && recon.current_month && (
        <ReconCard recon={recon} taxName={tax_name} currency={currency} />
      )}

      {/* ─── BILAGSNUMMER COMPLIANCE (DK Bogføringsloven 2024) ─── */}
      {user?.currency === "DKK" && audit && !audit._error && (
        <ComplianceCard audit={audit} />
      )}

      {/* ─── UPCOMING DEADLINES TABLE ─── */}
      {upcoming_deadlines?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <h2 className="font-bold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
            <Icon name="Calendar" size={18} className="text-gray-500" /> Upcoming Deadlines
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">{t("period")}</th>
                  <th className="text-left py-2 px-2">{t("deadline")}</th>
                  <th className="text-right py-2 px-2">{t("sales")}</th>
                  <th className="text-right py-2 px-2">Output {tax_name}</th>
                  <th className="text-right py-2 px-2">Input {tax_name}</th>
                  <th className="text-right py-2 px-2">{t("payable")}</th>
                  <th className="text-center py-2 px-2">{t("status")}</th>
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
                    <td className="py-3 px-2 text-right text-emerald-600">{fmt(dl.input_vat)}</td>
                    <td className={`py-3 px-2 text-right font-bold ${dl.estimated_amount >= 0 ? "text-orange-600" : "text-emerald-600"}`}>
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
      <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
        <h2 className="font-bold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
          <Icon name="BarChart3" size={18} className="text-gray-500" /> Year-to-Date Summary ({ytd.year})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-3">Sales ({tax_name} collected)</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">{t("totalSales")}</span>
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
                <span className="text-sm text-gray-600 dark:text-gray-400">{t("totalExpenses")}</span>
                <span className="text-sm font-medium text-gray-800 dark:text-white">{fmt(ytd.expenses_total)} {currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">Input {tax_name}</span>
                <span className="text-sm font-bold text-emerald-600">{fmt(ytd.input_vat)} {currency}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Net {tax_name} Payable</span>
          <span className={`text-xl font-bold ${ytd.vat_payable >= 0 ? "text-orange-600" : "text-emerald-600"}`}>
            {ytd.vat_payable >= 0 ? "" : "Refund: "}{fmt(Math.abs(ytd.vat_payable))} {currency}
          </span>
        </div>
      </div>

      {/* Link to VAT report */}
      <div className="flex justify-center">
        <a href="/vat-report" className="text-sm text-emerald-600 dark:text-gray-300 hover:underline">
          View detailed VAT report & export PDF →
        </a>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, color, currency }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm text-center">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   FilingPdfCard — Task #51 / Pro-tier closing-the-loop artifact.

   Closes the gap between "MOMS Autopilot shows you owe X" and the
   actual SKAT.dk filing. Owner taps Download → pre-filled MOMS-
   angivelse PDF lands in their downloads → review/sign/upload.

   Two buttons:
     • Download PDF (per-tier gating: emerald CTA on Pro, locked
       gray button + UpgradeNudge on Free/Starter)
     • Email to my revisor (uses businessProfile.accountant_email
       — same pattern as the daily-close range PDF)

   For locked tiers the numbers ARE shown so the user can FEEL the
   gap — "I owe 35.561 kr, and the PDF that would save me time is
   one tap away if I upgrade".
   ────────────────────────────────────────────────────────────── */
function FilingPdfCard({ deadline, taxName, currency, businessProfile, unlocked }) {
  const { t } = useLanguage();
  const [downloading, setDownloading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [show402, setShow402] = useState(false);

  const periodStart = deadline?.period_start;
  const periodEnd = deadline?.period_end;
  const periodLabel = deadline?.period_label || "—";
  const accountantEmail = (businessProfile?.accountant_email || "").trim();

  const downloadPdf = async () => {
    setDownloading(true);
    setStatus("");
    setError("");
    try {
      const url = `/tax/filing-pdf?period_start=${periodStart}&period_end=${periodEnd}`;
      const res = await api.get(url, { responseType: "blob" });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `MA-${periodStart?.replace(/-/g, "")}-${periodEnd?.replace(/-/g, "")}.pdf`;
      a.click();
      window.URL.revokeObjectURL(objectUrl);
      setStatus(t("filingPdfDownloaded") || "PDF downloaded.");
      setTimeout(() => setStatus(""), 5000);
    } catch (e) {
      if (e?.response?.status === 402) {
        setShow402(true);
      } else {
        setError(
          e?.response?.data?.detail?.message ||
          (t("filingPdfDownloadFailed") || "Couldn't generate the PDF — try again."),
        );
        setTimeout(() => setError(""), 6000);
      }
    } finally {
      setDownloading(false);
    }
  };

  const sendToAccountant = async () => {
    if (!accountantEmail) {
      setError(t("filingPdfNeedsAccountantEmail") || "Set your accountant's email on Profile first.");
      setTimeout(() => setError(""), 6000);
      return;
    }
    setSending(true);
    setStatus("");
    setError("");
    try {
      const url = `/tax/filing-pdf/send-to-accountant?period_start=${periodStart}&period_end=${periodEnd}`;
      const r = await api.post(url, { cc_self: true });
      if (r.data?.ok) {
        setStatus(`✓ ${t("filingPdfSent") || "Sent to"} ${r.data.sent_to}`);
        setTimeout(() => setStatus(""), 6000);
      }
    } catch (e) {
      if (e?.response?.status === 402) {
        setShow402(true);
      } else if (e?.response?.status === 400 && e?.response?.data?.detail?.code === "no_accountant_email") {
        setError(t("filingPdfNeedsAccountantEmail") || "Set your accountant's email on Profile first.");
        setTimeout(() => setError(""), 6000);
      } else {
        setError(
          e?.response?.data?.detail?.message ||
          (t("filingPdfSendFailed") || "Couldn't send the email — try again."),
        );
        setTimeout(() => setError(""), 6000);
      }
    } finally {
      setSending(false);
    }
  };

  const fmtNum = (n) => (n != null ? Math.round(n).toLocaleString() : "—");
  const output = deadline?.output_vat || 0;
  const input = deadline?.input_vat || 0;
  const net = deadline?.estimated_amount || 0;

  return (
    <>
      <div className={`relative rounded-xl p-5 sm:p-6 shadow-sm border ${
        unlocked
          ? "bg-gray-50 dark:bg-gray-800/50 border-gray-100/70 dark:border-gray-800/60"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"
      }`}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold tracking-wider uppercase text-gray-700 dark:text-emerald-400">
              {unlocked ? "Pro" : "Pro · Låst"} · {t("filingPdfPro") || "Filing-ready PDF"}
            </p>
            <h3 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100 mt-1">
              {t("filingPdfReady") || "Klar til at indberette?"} · {periodLabel}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t("filingPdfSubtitle") || "Pre-filled MOMS-angivelse — download, sign, upload to SKAT.dk."}
            </p>
          </div>
          <div className="text-2xl shrink-0" aria-hidden="true">📑</div>
        </div>

        {/* The three numbers (always visible — even on Free, so they feel the gap) */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
          <div className="rounded-lg bg-white/70 dark:bg-gray-800/50 px-3 py-2.5 border border-gray-100 dark:border-gray-700/50">
            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Output {taxName}
            </p>
            <p className="text-sm sm:text-base font-bold text-orange-600 mt-0.5">
              {fmtNum(output)} <span className="text-[10px] font-normal text-gray-400">{currency}</span>
            </p>
          </div>
          <div className="rounded-lg bg-white/70 dark:bg-gray-800/50 px-3 py-2.5 border border-gray-100 dark:border-gray-700/50">
            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Input {taxName}
            </p>
            <p className="text-sm sm:text-base font-bold text-blue-600 mt-0.5">
              {fmtNum(input)} <span className="text-[10px] font-normal text-gray-400">{currency}</span>
            </p>
          </div>
          <div className="rounded-lg bg-white/70 dark:bg-gray-800/50 px-3 py-2.5 border border-gray-100 dark:border-gray-700/50">
            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t("filingPdfNet") || "Net til SKAT"}
            </p>
            <p className={`text-sm sm:text-base font-bold mt-0.5 ${net >= 0 ? "text-gray-700 dark:text-emerald-400" : "text-gray-600 dark:text-gray-300"}`}>
              {fmtNum(net)} <span className="text-[10px] font-normal text-gray-400">{currency}</span>
            </p>
          </div>
        </div>

        {/* Status / error banners */}
        {status && (
          <div className="mb-3 text-xs px-3 py-2 rounded-md bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-100/70 dark:border-gray-800/60">
            {status}
          </div>
        )}
        {error && (
          <div className="mb-3 text-xs px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200/70 dark:border-red-800/60">
            {error}
          </div>
        )}

        {/* Buttons */}
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <button
            type="button"
            disabled={downloading || !unlocked}
            onClick={unlocked ? downloadPdf : () => setShow402(true)}
            className={
              unlocked
                ? "inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-medium transition-colors disabled:opacity-60"
                : "inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-sm font-medium cursor-not-allowed"
            }
            aria-label={t("filingPdfDownload") || "Download filing PDF"}
          >
            <span aria-hidden="true">{unlocked ? "⬇️" : "🔒"}</span>
            {downloading ? (t("filingPdfDownloading") || "Generating…") : (t("filingPdfDownload") || "Download PDF")}
          </button>

          <button
            type="button"
            disabled={sending || !unlocked}
            onClick={unlocked ? sendToAccountant : () => setShow402(true)}
            className={
              unlocked
                ? "inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium border border-gray-200 dark:border-gray-700 transition-colors disabled:opacity-60"
                : "inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-sm font-medium border border-gray-200 dark:border-gray-700 cursor-not-allowed"
            }
            aria-label={t("filingPdfEmailRevisor") || "Email to my revisor"}
          >
            <span aria-hidden="true">{unlocked ? "✉️" : "🔒"}</span>
            {sending
              ? (t("filingPdfSending") || "Sending…")
              : accountantEmail
                ? (t("filingPdfEmailRevisor") || "Email to my revisor")
                : (t("filingPdfSetRevisorEmail") || "Add revisor's email")
            }
          </button>
        </div>

        {!unlocked && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3 leading-relaxed">
            {t("filingPdfUpsell") ||
              "Download a pre-filled MOMS-angivelse — saves ~30 min per filing. Sign, then upload to SKAT.dk or forward to your revisor."}
          </p>
        )}
      </div>

      {/* 402 upsell dialog */}
      {show402 && (
        <UpgradeNudge
          intent="dialog"
          tier="pro"
          icon="📑"
          benefit={t("filingPdfUpgradeBenefit") || "Pre-filled MOMS-angivelse — file in 90 seconds, not 30 minutes."}
          ctaLabel={t("seePlans") || "See plans"}
          onTry={() => setShow402(false)}
        />
      )}
    </>
  );
}


/* ──────────────────────────────────────────────────────────────
   TaxPrefsCard — moved here from More → Profile so the settings
   that drive this page's calculations live next to their effect.
   ────────────────────────────────────────────────────────────── */
function TaxPrefsCard({ tax, setTax, saving, msg, onSave }) {
  const { t } = useLanguage();
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="mb-4">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("taxPreferences")}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Controls deadlines and Moms calculations across every report.
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            Filing frequency
          </label>
          <select
            value={tax.filing_frequency}
            onChange={(e) => setTax({ ...tax, filing_frequency: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            <option value="">{t("useDefaultForCountry")}</option>
            <option value="half_yearly">Half-yearly (DK SMBs &lt; 5M kr — most cafés / retail)</option>
            <option value="quarterly">Quarterly (DK businesses 5–50M kr)</option>
            <option value="monthly">Monthly (DK businesses &gt; 50M kr / NPR / INR)</option>
            <option value="bimonthly">Bimonthly (NOK only)</option>
          </select>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={tax.prices_include_moms}
            onChange={(e) => setTax({ ...tax, prices_include_moms: e.target.checked })}
            className="mt-0.5 w-4 h-4 rounded border-gray-300 dark:border-gray-600 accent-green-600"
          />
          <div className="text-sm">
            <div className="font-medium text-gray-800 dark:text-gray-100">{t("myPricesIncludeMoms")}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Default for B2C (cafés, retail) — you enter what the customer pays. Uncheck if you invoice B2B with net prices.
            </div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={tax.has_employees}
            onChange={(e) => setTax({ ...tax, has_employees: e.target.checked })}
            className="mt-0.5 w-4 h-4 rounded border-gray-300 dark:border-gray-600 accent-green-600"
          />
          <div className="text-sm">
            <div className="font-medium text-gray-800 dark:text-gray-100">I have employees</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Surfaces A-skat + AM-bidrag deadlines (10th of next month) here.
            </div>
          </div>
        </label>

        {msg && <p className="text-xs text-gray-700 dark:text-emerald-400">{msg}</p>}

        <Button
          variant="primary"
          type="button"
          disabled={saving}
          busy={saving}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save tax preferences"}
        </Button>
      </div>
    </div>
  );
}


function ReconCard({ recon, taxName, currency }) {
  const { t } = useLanguage();
  const cm = recon.current_month;
  const yt = recon.ytd;

  const statusStyles = {
    matched:             { bg: "bg-gray-50 dark:bg-gray-800/50",  border: "border-gray-100 dark:border-gray-800", badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", icon: "\u2705", label: "Matched" },
    minor_discrepancy:   { bg: "bg-amber-50 dark:bg-amber-900/20",  border: "border-amber-200 dark:border-amber-800", badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", icon: "\u26a0\ufe0f", label: "Minor Diff" },
    major_discrepancy:   { bg: "bg-red-50 dark:bg-red-900/20",      border: "border-red-200 dark:border-red-800",     badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",       icon: "\ud83d\udea8", label: "Mismatch" },
    no_data:             { bg: "bg-gray-50 dark:bg-gray-800",       border: "border-gray-200 dark:border-gray-700",   badge: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400",     icon: "\u2014",  label: "No Closes" },
  };

  const s = statusStyles[cm.status] || statusStyles.no_data;

  return (
    <div className={`rounded-xl p-5 border ${s.border} ${s.bg} shadow-sm`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
          <span>📋</span> Daily Close Reconciliation
        </h2>
        <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${s.badge}`}>
          {s.icon} {s.label}
        </span>
      </div>

      {cm.status === "no_data" ? (
        <div className="text-center py-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">No confirmed daily closes this month yet.</p>
          <a href="/daily-close" className="text-sm text-emerald-600 dark:text-gray-300 hover:underline mt-1 inline-block">
            Go to Daily Close &rarr;
          </a>
        </div>
      ) : (
        <>
          {/* Current month comparison */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t("fromDailyCloses")}</p>
              <p className="text-xl font-bold text-gray-800 dark:text-white">{fmt(cm.moms_from_closes)} <span className="text-sm font-normal text-gray-400">{currency}</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                {cm.closes_count} close{cm.closes_count !== 1 ? "s" : ""}
                {cm.manual_count > 0 && <> &middot; {cm.manual_count} from receipt</>}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{t("fromSalesRecords")}</p>
              <p className="text-xl font-bold text-gray-800 dark:text-white">{fmt(cm.moms_from_sales)} <span className="text-sm font-normal text-gray-400">{currency}</span></p>
              <p className="text-xs text-gray-400 mt-0.5">{t("calculatedFromTxns")}</p>
            </div>
          </div>

          {/* Discrepancy bar */}
          {cm.discrepancy !== null && cm.discrepancy !== 0 && (
            <div className="mt-3 pt-3 border-t border-gray-200/60 dark:border-gray-700/60 flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("difference")}</span>
              <span className={`text-sm font-bold ${
                Math.abs(cm.discrepancy) <= cm.moms_from_sales * 0.02
                  ? "text-emerald-600" : Math.abs(cm.discrepancy) <= cm.moms_from_sales * 0.1
                  ? "text-amber-600" : "text-red-600"
              }`}>
                {cm.discrepancy > 0 ? "+" : ""}{fmt(cm.discrepancy)} {currency}
                {cm.discrepancy_pct != null && <span className="text-xs font-normal text-gray-400 ml-1">({cm.discrepancy_pct}%)</span>}
              </span>
            </div>
          )}

          {/* YTD line */}
          {yt && yt.closes_count > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-200/40 dark:border-gray-700/40 flex items-center justify-between text-xs text-gray-400">
              <span>YTD: {yt.closes_count} closes &rarr; {fmt(yt.moms_from_closes)} {taxName}</span>
              <span>Sales &rarr; {fmt(yt.moms_from_sales)} {taxName}</span>
            </div>
          )}

          {/* Link */}
          <div className="mt-3 text-center">
            <a href="/daily-close" className="text-xs text-emerald-600 dark:text-gray-300 hover:underline">
              View Daily Close History &rarr;
            </a>
          </div>
        </>
      )}
    </div>
  );
}


/* ──────────────────────────────────────────────────────────────
   ComplianceCard — Bilagsnummer audit (DK Bogføringsloven 2024)
   Green badge if no gaps; red list if missing voucher numbers.
   ────────────────────────────────────────────────────────────── */
function ComplianceCard({ audit }) {
  const { year, sales = {}, expenses = {}, is_compliant, regulation } = audit;
  const okSales = sales.is_compliant !== false;
  const okExp = expenses.is_compliant !== false;
  const totalCount = (sales.count || 0) + (expenses.count || 0);

  return (
    <div className={`rounded-xl p-5 shadow-sm border ${
      is_compliant
        ? "bg-gray-50/60 dark:bg-gray-800/50 border-gray-100/60 dark:border-gray-800/40"
        : "bg-amber-50/70 dark:bg-amber-900/10 border-amber-200/60 dark:border-amber-800/40"
    }`}>
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
          is_compliant
            ? "bg-emerald-500 text-white"
            : "bg-amber-500 text-white"
        }`}>
          {is_compliant ? "✓" : "!"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-bold text-gray-800 dark:text-white">
              {is_compliant
                ? "Books are SKAT-compliant"
                : "Voucher gaps detected"}
            </h2>
            <span className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
              {year}
            </span>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
            {regulation || "Bogføringsloven 2024 — sequential bilagsnummer"}
          </p>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <ComplianceCol label="Sales (bilag)" data={sales} ok={okSales} />
            <ComplianceCol label="Expenses (bilag)" data={expenses} ok={okExp} />
          </div>

          {!is_compliant && (
            <div className="mt-4 text-xs text-amber-800 dark:text-amber-300">
              <strong>Missing numbers:</strong>
              {sales.missing?.length > 0 && (
                <span className="ml-1">Sales: {sales.missing.slice(0, 10).join(", ")}{sales.missing.length > 10 ? "…" : ""}</span>
              )}
              {expenses.missing?.length > 0 && (
                <span className="ml-2">Expenses: {expenses.missing.slice(0, 10).join(", ")}{expenses.missing.length > 10 ? "…" : ""}</span>
              )}
            </div>
          )}

          {totalCount > 0 && (
            <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-500">
              {totalCount} voucher{totalCount === 1 ? "" : "s"} this year, traceable end-to-end.
              SKAT auditors check sequence integrity — gaps trigger reviews.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ComplianceCol({ label, data, ok }) {
  return (
    <div className={`rounded-lg p-3 border ${
      ok
        ? "bg-white/60 dark:bg-gray-800/40 border-gray-100/40 dark:border-gray-800/30"
        : "bg-white/60 dark:bg-gray-800/40 border-amber-200/60 dark:border-amber-800/40"
    }`}>
      <div className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">{label}</div>
      <div className="mt-1 text-lg font-bold text-gray-900 dark:text-white">
        #{data.count || 0}
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        Latest: #{data.max || 0} {ok ? "· no gaps ✓" : `· ${data.missing?.length || 0} missing`}
      </div>
    </div>
  );
}
