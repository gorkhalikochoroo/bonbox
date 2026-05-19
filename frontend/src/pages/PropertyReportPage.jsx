import { useEffect, useState, useMemo } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { localIso } from "../utils/dateFormat";

/**
 * Property Financial Report — the daily close every Danish chain restaurant
 * already prints from Aloha / Restwave / Pos+ at 22:00. We render the same
 * numbers in the same layout so a restaurant owner who has never seen BonBox
 * can read it in 5 seconds.
 *
 * UX rules (per Manoj):
 *   • Big numbers, not tables
 *   • Plain English/Danish — never POS jargon
 *   • Visual bars for the channel split (where did money come from?)
 *   • Pills for payment methods (how was money paid?)
 *   • One-tap "Send to my accountant" so it actually leaves the screen
 *   • Mobile-first — owners check at 23:00 in the back office on their phone
 */
export default function PropertyReportPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const currency = user?.currency || "DKK";

  // Default to TODAY in user's local time — localIso (not toISOString)
  // so a Danish owner closing at 01:14 CEST doesn't see yesterday.
  const todayStr = localIso();
  const [reportDate, setReportDate] = useState(todayStr);
  const [cutoffHour, setCutoffHour] = useState(6); // Danish restaurant 6am-6am
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api
      .get("/property-report", {
        params: { date: reportDate, day_cutoff_hour: cutoffHour },
      })
      .then((r) => {
        setReport(r.data);
        if (r.data?._error) setError(r.data._error);
      })
      .catch((e) => {
        setError(e.response?.data?.detail || "Could not load report");
      })
      .finally(() => setLoading(false));
  }, [reportDate, cutoffHour]);

  const fmt = (n) => Number(n || 0).toLocaleString();
  const totals = report?.totals || {};
  const channels = report?.order_channels || [];
  const tenders = report?.tender_media || [];
  const exceptions = report?.exceptions || {};

  // Plain-English headline ("Strong day", "Quiet day", etc.) for instant
  // gut-check before owner reads any numbers.
  const headline = useMemo(() => {
    if (loading || !report) return null;
    const rev = totals.total_revenue || 0;
    if (rev === 0) {
      return { tone: "neutral", emoji: "📭", text: t("noSalesYet") || "No sales recorded yet today" };
    }
    if (totals.voids_count > 5) {
      return { tone: "warn", emoji: "⚠️", text: `${totals.voids_count} ${t("voidsToday") || "voids today — worth a look"}` };
    }
    return { tone: "good", emoji: "✅", text: `${fmt(rev)} ${currency} ${t("inSalesToday") || "in sales today"}` };
  }, [loading, report, totals, currency, t]);

  // Friendly date label like "Wednesday, 4 May 2026"
  const friendlyDate = useMemo(() => {
    if (!reportDate) return "";
    try {
      return new Date(reportDate + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
    } catch { return reportDate; }
  }, [reportDate]);

  /**
   * Download the Copenhagen-clean A4 PDF rendered server-side by
   * services/property_report_pdf.py. Replaces the old window.print()
   * which produced a screenshot of the web page rather than a proper
   * accountant-handoff document.
   *
   * The user selects the date in the form; we pass it through to the
   * backend so the same filter / cutoff logic applies as on screen.
   * Failure surfaces a toast — never silently no-ops.
   */
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const handlePrint = async () => {
    if (downloadingPdf) return;
    setDownloadingPdf(true);
    setError("");
    try {
      const res = await api.get("/property-report/pdf", {
        params: { date: reportDate, day_cutoff_hour: cutoffHour },
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `daily-report_${reportDate}.pdf`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        window.URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      // axios with responseType: "blob" wraps the error body as a
      // Blob too — even when it's actually JSON. Read it as text →
      // try-parse → surface the real backend message instead of
      // always falling through to the generic copy.
      let backendMsg = "";
      try {
        const data = e?.response?.data;
        if (data instanceof Blob) {
          const text = await data.text();
          try {
            const parsed = JSON.parse(text);
            backendMsg = typeof parsed?.detail === "string"
              ? parsed.detail
              : parsed?.detail?.message || "";
          } catch {
            // Non-JSON body — treat it as raw text if short enough
            if (text && text.length < 240) backendMsg = text;
          }
        } else if (typeof data?.detail === "string") {
          backendMsg = data.detail;
        }
      } catch { /* ignore — fall through to generic */ }

      const status = e?.response?.status;
      const detail = backendMsg
        || (status === 429
            ? "Too many exports — wait a minute and try again."
            : status === 404
            ? "PDF endpoint not found. The deploy may still be rolling out — try again in a minute."
            : status === 401 || status === 403
            ? "Sign in again — your session may have expired."
            : null)
        || (t("pdfDownloadFailed") || "Could not download the report — please try again.");
      setError(detail);
      setTimeout(() => setError(""), 6000);
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleEmailAccountant = () => {
    // Use mailto: with a pre-filled subject + body. Owner picks recipient
    // (their accountant) — we never store accountant email.
    //
    // Body layout matches the on-screen Tax breakdown so the accountant
    // sees the same numbers in the email as the owner sees in the app:
    //   • B2C ('incl'): Gross − Moms = Net
    //   • B2B ('excl'): Net + Moms = Total customer paid
    //   • 'none': flat total
    if (!report) return;
    const subject = `${user?.business_name || "BonBox"} — ${friendlyDate}`;
    const momsMode = totals.moms_mode || "incl";
    const ratePct = totals.moms_rate_pct || 25;
    const lines = [
      `${t("dailyClose") || "Daily Close"} — ${friendlyDate}`,
      "",
      `${t("totalRevenue") || "Total Revenue"}: ${fmt(totals.total_revenue)} ${currency}`,
      "",
    ];
    if (momsMode === "incl") {
      // Danish revisor convention: show MOMS as positive owed amount, not
      // as a negative extraction. Matches the property_report_pdf rewrite.
      lines.push(
        `${t("grossSalesInclMoms") || "Gross sales (incl. Moms)"}: ${fmt(totals.gross_sales || totals.taxable_sales)} ${currency}`,
        `${t("netSalesKept") || "Net sales (excl. Moms)"}: ${fmt(totals.all_sales_net)} ${currency}`,
        `${t("momsOwed") || `Moms ${ratePct}% (owed to SKAT)`}: ${fmt(totals.tax_collected)} ${currency}`,
      );
    } else if (momsMode === "excl") {
      lines.push(
        `${t("netSalesExclMoms") || "Net sales (excl. Moms)"}: ${fmt(totals.all_sales_net)} ${currency}`,
        `${t("momsAddedOnTop") || `Moms added on top (${ratePct}%)`}: +${fmt(totals.tax_collected)} ${currency}`,
        `${t("totalCustomerPaid") || "Total customer paid"}: ${fmt(totals.gross_sales)} ${currency}`,
      );
    } else {
      lines.push(
        `${t("totalSales") || "Total sales"}: ${fmt(totals.all_sales_net)} ${currency}`,
      );
    }
    lines.push("", "— Sent from BonBox");
    const body = lines.join("\n");
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  // Channel-color palette — DYNAMIC. Built from /order-channels at mount
  // time so owner-customised colors + new aggregator channels (Foodpanda,
  // Hungry.dk, etc.) render correctly without a frontend deploy.
  //
  // Fallback: if the /order-channels call fails we use FALLBACK_PALETTE
  // (frozen snapshot of the SYSTEM_CHANNELS defaults), so the report
  // still renders sensibly even with a backend outage.
  //
  // Tailwind v4 JIT note: every class string used here must appear
  // literally in source — see CHANNEL_PALETTE_BY_COLOR below.
  const CHANNEL_COLOR = useDynamicChannelPalette();
  const channelMaxAmount = Math.max(1, ...channels.map((c) => c.amount));

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6 max-w-4xl mx-auto pb-32 md:pb-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            {t("todaysFloor") || "Today's Floor"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {friendlyDate} · {cutoffHour === 6 ? (t("sixAmToSixAm") || "06:00 to 06:00 next day") : `${cutoffHour}:00 to ${cutoffHour}:00`}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <input
            type="date"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200"
            max={todayStr}
          />
        </div>
      </div>

      {/* Cutoff toggle — plain language, not "day_cutoff_hour=6" */}
      <div className="flex flex-wrap items-center gap-2 mb-4 print:hidden">
        <span className="text-xs text-gray-500 dark:text-gray-400">{t("dayBoundary") || "When does your day end?"}</span>
        {[
          { hr: 0,  label: t("midnight") || "Midnight (00:00)" },
          { hr: 4,  label: "04:00" },
          { hr: 6,  label: t("sixAm") || "06:00 (restaurant)" },
        ].map((opt) => (
          <button
            key={opt.hr}
            onClick={() => setCutoffHour(opt.hr)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
              cutoffHour === opt.hr
                ? "bg-emerald-600 text-white"
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
          {t("loading") || "Loading…"}
        </div>
      )}

      {!loading && report && (
        <>
          {/* HEADLINE — plain-English instant gut check */}
          {headline && (
            <div className={`rounded-2xl px-5 py-4 mb-4 border flex items-center gap-3 ${
              headline.tone === "good"
                ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800"
                : headline.tone === "warn"
                ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800"
                : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700"
            }`}>
              <span className="text-2xl shrink-0">{headline.emoji}</span>
              <div className="text-base font-semibold text-gray-800 dark:text-gray-100">
                {headline.text}
              </div>
            </div>
          )}

          {/* HERO — total revenue, big and proud */}
          <div className="bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-900/30 dark:to-blue-900/30 rounded-2xl p-6 sm:p-8 border border-emerald-200/60 dark:border-emerald-800/40 mb-4">
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 tracking-widest uppercase">
              {t("totalRevenue") || "Total Revenue"}
            </p>
            <p className="text-4xl sm:text-5xl font-extrabold text-gray-900 dark:text-white mt-1">
              {fmt(totals.total_revenue)} <span className="text-2xl sm:text-3xl text-gray-400">{currency}</span>
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              {channels.reduce((s, c) => s + (c.checks || 0), 0)} {t("ordersToday") || "orders"}
              {" · "}
              {channels.reduce((s, c) => s + (c.guests || 0), 0)} {t("guestsToday") || "guests"}
            </p>
          </div>

          {/* CHANNELS — visual bars, not a table */}
          {channels.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm mb-4">
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">
                {t("whereMoneyCameFrom") || "Where the money came from"}
              </h2>
              <p className="text-xs text-gray-400 mb-4">
                {t("channelBreakdown") || "Order channel breakdown"}
              </p>
              <div className="space-y-3">
                {channels.map((c) => {
                  const palette = CHANNEL_COLOR[c.channel] || CHANNEL_COLOR.other;
                  const barWidth = Math.max((c.amount / channelMaxAmount) * 100, 4);
                  const pct = totals.total_revenue > 0
                    ? Math.round((c.amount / totals.total_revenue) * 100)
                    : 0;
                  return (
                    <div key={c.channel}>
                      <div className="flex items-baseline justify-between mb-1.5">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
                          <span>{palette.emoji}</span>
                          {c.label}
                        </span>
                        <span className="text-sm font-semibold text-gray-900 dark:text-white">
                          {fmt(c.amount)} {currency}
                          <span className="text-xs text-gray-400 ml-2 font-normal">{pct}%</span>
                        </span>
                      </div>
                      <div className="h-2.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${palette.bg} rounded-full transition-all`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      {/* Sub-line: orders + averages — only if we have data */}
                      <p className="text-[11px] text-gray-400 mt-1">
                        {c.checks} {c.checks === 1 ? (t("order") || "order") : (t("ordersTodayPlural") || "orders")}
                        {c.avg_per_check > 0 && (
                          <> · {t("avgPerOrder") || "avg"} {fmt(Math.round(c.avg_per_check))} {currency}</>
                        )}
                        {c.guests > 0 && (
                          <> · {c.guests} {t("guestsTodayPlural") || "guests"}</>
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TENDER MEDIA — payment-method pills */}
          {tenders.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm mb-4">
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">
                {t("howCustomersPaid") || "How customers paid"}
              </h2>
              <p className="text-xs text-gray-400 mb-4">
                {t("tenderBreakdown") || "Payment method breakdown"}
              </p>
              <div className="flex flex-wrap gap-2">
                {tenders.map((tm) => (
                  <div
                    key={tm.method}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600"
                  >
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{tm.label}</span>
                    <span className="text-sm font-bold text-gray-900 dark:text-white">{fmt(tm.amount)}</span>
                    <span className="text-xs text-gray-400">×{tm.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAX — Moms breakdown, mode-aware.
              The Tax breakdown layout depends on whether the seller's
              prices include Moms (B2C, default) or are net B2B prices:
                • B2C ('incl'): Gross 22,854 − Moms 4,570.80 = Net 18,283.20
                • B2B ('excl'): Net 22,854 + Moms 5,713.50 = Total 28,567.50
              The numbers themselves come straight from the backend so
              there's no duplicate math here — this just picks the
              right labels + signs for the mode.

              Old behavior (pre-fix): always rendered as if B2C, which
              meant B2B users saw "Moms −5,713.50" (misleading minus
              sign — Moms is added on top in B2B, not subtracted)
              with "Net Sales 22,854" (same as Taxable Sales = looked
              like a math error). */}
          {(() => {
            const momsMode = totals.moms_mode || "incl";
            const ratePct = totals.moms_rate_pct || 25;
            const moms = totals.tax_collected || 0;
            const heading = momsMode === "none"
              ? (t("taxSummaryNoVat") || "Tax breakdown")
              : `${t("taxSummaryPrefix") || "Tax breakdown"} (${t("moms") || "Moms"} ${ratePct}%)`;
            return (
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm mb-4">
                <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">
                  {heading}
                </h2>
                <p className="text-xs text-gray-400 mb-4">
                  {t("forSkat") || "For Skat / your accountant"}
                </p>
                {momsMode === "incl" && (
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t("grossSalesInclMoms") || "Gross sales (incl. Moms)"}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {fmt(totals.gross_sales || totals.taxable_sales)} {currency}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t("momsExtracted") || `Moms extracted (${ratePct}%)`}
                      </span>
                      <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                        −{fmt(moms)} {currency}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline border-t border-gray-100 dark:border-gray-700 pt-2.5 mt-1">
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                        {t("netSalesKept") || "Net sales (what you keep)"}
                      </span>
                      <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                        {fmt(totals.all_sales_net)} {currency}
                      </span>
                    </div>
                  </div>
                )}
                {momsMode === "excl" && (
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t("netSalesExclMoms") || "Net sales (excl. Moms)"}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {fmt(totals.all_sales_net)} {currency}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t("momsAddedOnTop") || `Moms added on top (${ratePct}%)`}
                      </span>
                      <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">
                        +{fmt(moms)} {currency}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline border-t border-gray-100 dark:border-gray-700 pt-2.5 mt-1">
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                        {t("totalCustomerPaid") || "Total customer paid"}
                      </span>
                      <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                        {fmt(totals.gross_sales)} {currency}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">
                      {t("b2bPriceNote") ||
                        "Your prices are entered as net (B2B). Customers pay the gross amount on the right; you owe Moms to Skat."}
                    </p>
                  </div>
                )}
                {momsMode === "no_sales" && (
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t("totalSales") || "Total sales"}
                      </span>
                      <span className="text-base font-bold text-gray-900 dark:text-white">
                        {fmt(totals.all_sales_net)} {currency}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {t("noSalesForDateHint") ||
                        "No sales recorded for this date — no Moms to report. Once sales arrive, Moms will calculate automatically."}
                    </p>
                  </div>
                )}
                {momsMode === "none" && (
                  <div className="space-y-2.5">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t("totalSales") || "Total sales"}
                      </span>
                      <span className="text-base font-bold text-gray-900 dark:text-white">
                        {fmt(totals.all_sales_net)} {currency}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {t("noVatHint") ||
                        "No VAT applied — your jurisdiction has 0% rate, or all sales on this date were tax-exempt."}
                    </p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* EXCEPTIONS — only show if non-zero so we don't clutter quiet days */}
          {(exceptions.voids > 0 || exceptions.manager_voids > 0 ||
            exceptions.error_correct > 0 || totals.returns_count > 0) && (
            <div className="bg-amber-50 dark:bg-amber-900/15 rounded-2xl p-5 sm:p-6 border border-amber-200 dark:border-amber-800/40 mb-4">
              <h2 className="text-base font-semibold text-amber-800 dark:text-amber-300 mb-1">
                {t("staffExceptions") || "Things to look at"}
              </h2>
              <p className="text-xs text-amber-700/70 dark:text-amber-400/70 mb-3">
                {t("operationalAlerts") || "Voids, manager overrides, and corrections"}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {exceptions.voids > 0 && (
                  <Stat label={t("voids") || "Voids"} value={exceptions.voids} amount={totals.voids_amount} currency={currency} />
                )}
                {exceptions.manager_voids > 0 && (
                  <Stat label={t("managerVoids") || "Manager Voids"} value={exceptions.manager_voids} />
                )}
                {exceptions.error_correct > 0 && (
                  <Stat label={t("errorCorrects") || "Error Corrects"} value={exceptions.error_correct} />
                )}
                {totals.returns_count > 0 && (
                  <Stat label={t("returns") || "Returns"} value={totals.returns_count} amount={totals.returns_amount} currency={currency} />
                )}
              </div>
            </div>
          )}

          {/* ACTIONS — print + email accountant */}
          <div className="flex flex-wrap gap-2 mt-6 print:hidden">
            <button
              onClick={handlePrint}
              disabled={downloadingPdf}
              className="flex-1 sm:flex-none px-5 py-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-semibold transition disabled:opacity-50"
            >
              {downloadingPdf
                ? `⏳ ${t("generatingPdf") || "Generating PDF…"}`
                : `📄 ${t("downloadPdf") || "Download PDF"}`}
            </button>
            <button
              onClick={handleEmailAccountant}
              className="flex-1 sm:flex-none px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold transition"
            >
              ✉️ {t("emailAccountant") || "Email to accountant"}
            </button>
          </div>

          {error && (
            <div className="mt-4 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-300">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, amount, currency }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-amber-200/40 dark:border-amber-800/30">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
        {label}
      </p>
      <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">{value}</p>
      {amount != null && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
          {Number(amount || 0).toLocaleString()} {currency}
        </p>
      )}
    </div>
  );
}


/* ─── Dynamic channel palette ────────────────────────────────────────
 *
 * The channels list (and their colors / emojis) used to be hardcoded in
 * this file. As of May 2026, owners can add/edit channels via
 * /channel-settings — we fetch their catalogue at mount and build the
 * palette from it.
 *
 * Tailwind v4 detail: every class string used here MUST appear literally
 * somewhere in source files. The CHANNEL_PALETTE_BY_COLOR map below is
 * how we keep this contract — server returns a fragment like "stone-900"
 * and we look up the full triple of classnames we want to apply.
 */

const CHANNEL_PALETTE_BY_COLOR = {
  "emerald-500": { bg: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  "orange-500":  { bg: "bg-orange-500",  chip: "bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  "cyan-500":    { bg: "bg-cyan-500",    chip: "bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300" },
  "stone-900":   { bg: "bg-stone-900",   chip: "bg-stone-100 text-stone-900 dark:bg-stone-800 dark:text-stone-100" },
  "stone-400":   { bg: "bg-stone-400",   chip: "bg-stone-100 text-stone-600 dark:bg-stone-800/60 dark:text-stone-400" },
  "pink-500":    { bg: "bg-pink-500",    chip: "bg-pink-50 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300" },
  "blue-500":    { bg: "bg-blue-500",    chip: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  "violet-500":  { bg: "bg-violet-500",  chip: "bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  "amber-500":   { bg: "bg-amber-500",   chip: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  "rose-500":    { bg: "bg-rose-500",    chip: "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" },
  "teal-500":    { bg: "bg-teal-500",    chip: "bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" },
  "indigo-500":  { bg: "bg-indigo-500",  chip: "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" },
  "lime-500":    { bg: "bg-lime-500",    chip: "bg-lime-50 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300" },
  "slate-500":   { bg: "bg-slate-500",   chip: "bg-slate-50 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300" },
  "gray-500":    { bg: "bg-gray-500",    chip: "bg-gray-50 text-gray-700 dark:bg-gray-700 dark:text-gray-300" },
};

function paletteFor(color) {
  return CHANNEL_PALETTE_BY_COLOR[color] || CHANNEL_PALETTE_BY_COLOR["gray-500"];
}

// Frozen fallback used when /order-channels can't be fetched. Matches the
// backend services/channel_defaults.SYSTEM_CHANNELS dataset so the visual
// output is the same as before this refactor.
const FALLBACK_PALETTE = {
  dine_in:   { ...paletteFor("emerald-500"), emoji: "🍽" },
  takeaway:  { ...paletteFor("orange-500"),  emoji: "🥡" },
  wolt:      { ...paletteFor("cyan-500"),    emoji: "🛵" },
  uber_eats: { ...paletteFor("stone-900"),   emoji: "🛵" },
  foodora:   { ...paletteFor("pink-500"),    emoji: "🛵" },
  just_eat:  { ...paletteFor("stone-400"),   emoji: "🛵" },
  web:       { ...paletteFor("violet-500"),  emoji: "💻" },
  phone:     { ...paletteFor("blue-500"),    emoji: "📞" },
  catering:  { ...paletteFor("amber-500"),   emoji: "🎉" },
  other:     { ...paletteFor("gray-500"),    emoji: "•" },
};

function useDynamicChannelPalette() {
  const [palette, setPalette] = useState(FALLBACK_PALETTE);
  useEffect(() => {
    let cancelled = false;
    api
      .get("/order-channels")
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res.data) ? res.data : [];
        if (rows.length === 0) {
          setPalette(FALLBACK_PALETTE);
          return;
        }
        const next = { ...FALLBACK_PALETTE };
        for (const r of rows) {
          if (!r?.slug) continue;
          const p = paletteFor(r.color);
          next[r.slug] = {
            ...p,
            emoji: r.emoji || FALLBACK_PALETTE[r.slug]?.emoji || "•",
          };
        }
        next.other = next.other || paletteFor("gray-500");
        setPalette(next);
      })
      .catch(() => {
        // Backend down or user unauthenticated — fallback is fine
        if (!cancelled) setPalette(FALLBACK_PALETTE);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return palette;
}
