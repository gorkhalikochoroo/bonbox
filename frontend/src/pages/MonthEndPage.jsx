import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarX, LockOpen, Receipt, Inbox, Scale, Landmark, Gift, CircleCheck,
  ChevronLeft, ChevronRight, Download, FileText, Send, FileWarning, ArrowLeftRight, History,
} from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useAsyncData } from "../hooks/useAsyncData";
import { useConfirm } from "../hooks/useConfirm";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency, formatOwnerMoney } from "../utils/currency";
import { formatDateClear, localIso } from "../utils/dateFormat";
import { saveFile } from "../utils/download";
import { errText } from "../utils/errText";
import { PageHeader, Button, SectionBanner, LoadFailed, UpgradeNudge } from "../components/ui";
import PageShell from "../components/ui/PageShell";

/**
 * Månedsafslutning — what is still open for a period, and the revisor package.
 *
 * One list a revisor would otherwise ask about one mail at a time: days with
 * no daily close, closes not locked, expenses without a bilag, drafts still in
 * the Godkend-kø, cash differences over the kasserapport tolerance, bank lines
 * not reconciled, gavekort checks. Each item links to the screen that fixes
 * it. Below: the package itself — download on every plan, "Send pakken" from
 * the plan that sends. Open items never block a send; the mail lists them.
 *
 * The figures are the server's (/api/revisor-package/checklist), so this page,
 * the summary PDF and the e-mail can never disagree about what is open.
 */

const ICONS = {
  closes_missing: CalendarX,
  closes_unlocked: LockOpen,
  bilag_missing: Receipt,
  bilag_unreadable: FileWarning,
  drafts_pending: Inbox,
  cash_differences: Scale,
  sales_variance: ArrowLeftRight,
  bank_unmatched: Landmark,
  gavekort_checks: Gift,
};

// The figures a sent package stated (server: revisor_package.package_figures).
const COUNT_FIGURES = new Set(["antal_udgifter", "udgifter_med_bilag"]);

function monthPeriod(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: localIso(start), end: localIso(end) };
}

function weekPeriod(d) {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { start: localIso(mon), end: localIso(sun) };
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

/** Early in a month the job is LAST month; after the 10th, this one. A link
 *  may name the month (?month=YYYY-MM — the dashboard banner, a revisor's
 *  question about a given month). */
function defaultAnchor(now = new Date()) {
  try {
    const m = /^(\d{4})-(\d{2})$/.exec(new URLSearchParams(window.location.search).get("month") || "");
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 15);
  } catch { /* no window */ }
  return now.getDate() <= 10 ? new Date(now.getFullYear(), now.getMonth() - 1, 15) : now;
}

function sendErrorText(err, t, lang) {
  const d = err?.response?.data?.detail;
  if (d && typeof d === "object") {
    const msg = lang === "da" ? (d.message_da || d.message) : (d.message || d.message_da);
    if (msg) return msg;
  }
  return errText(err, t("meSendFailed", "The package couldn't be sent right now. You can still download it."));
}

export default function MonthEndPage() {
  const { user } = useAuth();
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  const { hasFeature, isReady } = useEntitlements();
  const currency = displayCurrency(user?.currency);
  const locale = lang === "da" ? "da-DK" : "en-GB";

  const [kind, setKind] = useState("month");
  const [anchor, setAnchor] = useState(() => defaultAnchor());
  const [customFrom, setCustomFrom] = useState(() => monthPeriod(defaultAnchor()).start);
  const [customTo, setCustomTo] = useState(() => monthPeriod(defaultAnchor()).end);
  const [downloading, setDownloading] = useState(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(null); // {severity, text}
  const sendKey = useRef(null);

  const period = useMemo(() => {
    if (kind === "week") {
      const p = weekPeriod(anchor);
      return { ...p, label: t("meWeekLabel", "Week {n}", { n: isoWeek(anchor) }) + ` · ${formatDateClear(p.start)}–${formatDateClear(p.end)}` };
    }
    if (kind === "custom") {
      return { start: customFrom, end: customTo, label: `${formatDateClear(customFrom)}–${formatDateClear(customTo)}` };
    }
    const p = monthPeriod(anchor);
    const label = anchor.toLocaleDateString(locale, { month: "long", year: "numeric" });
    return { ...p, label: label.charAt(0).toUpperCase() + label.slice(1) };
  }, [kind, anchor, customFrom, customTo, locale, t]);

  const validCustom = kind !== "custom" || (
    /^\d{4}-\d{2}-\d{2}$/.test(customFrom) && /^\d{4}-\d{2}-\d{2}$/.test(customTo)
    && customFrom <= customTo
    && (new Date(customTo) - new Date(customFrom)) / 86400000 < 93
  );

  const q = useAsyncData(
    () => api.get("/revisor-package/checklist", { params: { start: period.start, end: period.end } }),
    [user?.id, period.start, period.end],
    { enabled: !!user?.id && validCustom },
  );
  const data = q.data;
  const items = (data?.items || []).filter((i) => i.applicable || i.key === "closes_missing");
  const openCount = data?.open_count ?? 0;
  // Say no more than was checked (the PDF and the mail follow the same
  // rules, revisor_package.checklist_status): "every day is locked" only
  // when BonBox checks this owner's closes, "so far" while the period runs.
  const checkedUntil = data?.checked_until || null;
  const periodOver = !!(checkedUntil && data?.period?.end && checkedUntil >= data.period.end);
  const closesChecked = !!(data?.items || []).find((i) => i.key === "closes_missing")?.applicable && !!checkedUntil;
  const allClearText = !closesChecked
    ? t("meAllClearNoCloses", "Nothing open — every booked expense with VAT has its receipt.")
    : periodOver
      ? t("meAllClear", "Nothing open — every day is closed and locked, and every booked expense with VAT has its receipt.")
      : t("meAllClearSoFar", "Nothing open so far — every day up to now is closed and locked, and every booked expense with VAT has its receipt.");

  const shift = (dir) => {
    setNotice(null);
    sendKey.current = null;
    setAnchor((a) => (kind === "week"
      ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * dir)
      : new Date(a.getFullYear(), a.getMonth() + dir, 15)));
  };

  const download = async (what) => {
    setDownloading(what);
    setNotice(null);
    try {
      const url = what === "zip" ? "/revisor-package/download" : "/revisor-package/summary.pdf";
      // No automatic retries: a slow 93-day package would otherwise be built
      // up to five times at once on the server. The owner taps again.
      const res = await api.get(url, { params: { start: period.start, end: period.end }, responseType: "blob", timeout: 120000, _noRetry: true });
      const cd = res.headers?.["content-disposition"] || "";
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : (what === "zip" ? `Revisorpakke_${period.start}_${period.end}.zip` : `Oversigt_${period.start}_${period.end}.pdf`);
      const out = await saveFile(res.data, name, { type: what === "zip" ? "application/zip" : "application/pdf" });
      if (!out.ok) setNotice({ severity: "critical", text: t("meDownloadFailed", "The package couldn't be made — try a shorter period.") });
    } catch (e) {
      let text = "";
      const blob = e?.response?.data;
      if (blob && typeof blob.text === "function") {
        try {
          const json = JSON.parse(await blob.text());
          const d = json?.detail;
          text = (d && typeof d === "object" && (lang === "da" ? d.message_da || d.message : d.message || d.message_da)) || (typeof d === "string" ? d : "");
        } catch { /* not JSON */ }
      }
      setNotice({ severity: "critical", text: text || t("meDownloadFailed", "The package couldn't be made — try a shorter period.") });
    } finally {
      setDownloading(null);
    }
  };

  // A period already sent (or maybe sent) goes again only after the owner
  // says so — and when its figures changed, as a correction (RETTELSE).
  const confirmResend = async (sp) => {
    if (!sp) return true;
    const when = formatDateClear(sp.sent_on || "");
    return confirm(sp.changed ? {
      title: t("meResendCorrectedTitle", "Send the corrected package?"),
      message: t("meResendCorrectedMsg", "Your revisor got this period on {date}. The figures have changed since, so the new package is marked RETTELSE and lists what changed.", { date: when }),
      confirmLabel: t("meSendCorrected", "Send corrected package"),
    } : sp.partial ? {
      title: t("meResendTitle", "Send it again?"),
      message: t("meResendPartialMsg", "A package for this period went to {email} on {date}, before the period was over. Send a new package now?", { date: when, email: sp.recipient || "" }),
      confirmLabel: t("meResendCta", "Send again"),
    } : sp.status === "unclear" ? {
      title: t("meResendTitle", "Send it again?"),
      message: t("meResendUnclearMsg", "We couldn't confirm that the package of {date} reached {email}. Ask your revisor first — send it again now?", { date: when, email: sp.recipient || "" }),
      confirmLabel: t("meResendCta", "Send again"),
    } : {
      title: t("meResendTitle", "Send it again?"),
      message: t("meResendMsg", "This period was already sent on {date} to {email}. Nothing has changed since — send the same package again?", { date: when, email: sp.recipient || "" }),
      confirmLabel: t("meResendCta", "Send again"),
    });
  };

  const send = async () => {
    const sp = data?.sent_package || null;
    if (!(await confirmResend(sp))) return;
    if (openCount > 0) {
      const ok = await confirm({
        title: t("meSendConfirmTitle", "Send with open items?"),
        message: t("meSendOpenWarn", "{n} items are open. The e-mail lists them, so your revisor knows the period isn't finished.", { n: openCount }),
        confirmLabel: t("meSendConfirmCta", "Send anyway"),
      });
      if (!ok) return;
    }
    setSending(true);
    setNotice(null);
    if (!sendKey.current) sendKey.current = `me-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await api.post("/revisor-package/send", {
        start: period.start, end: period.end, key: sendKey.current, resend: !!sp,
      }, { timeout: 120000 });
      setNotice({
        severity: "success",
        text: t("meSent", "Sent to {email}. The link works until {date}.", {
          // The owner's local date the link works through (the mail's own words).
          email: res.data?.sent_to || "", date: formatDateClear(res.data?.link_expires_on || (res.data?.link_expires_at || "").slice(0, 10)),
        }),
      });
      sendKey.current = null;
      q.reload();
    } catch (e) {
      // Sent from another tab or device meanwhile: say so (the server's own
      // words) and refresh, so the next tap asks first.
      if (e?.response?.data?.detail?.code === "already_sent") q.reload();
      setNotice({ severity: "critical", text: sendErrorText(e, t, lang) });
      // A refusal (no revisor, opt-out, unverified …) sent nothing: the
      // next tap is a new send, not a replay. So is a send whose outcome is
      // unclear — the owner was just told to ask the revisor first.
      if ((e?.response?.status && e.response.status < 500)
        || e?.response?.data?.detail?.code === "email_unclear") sendKey.current = null;
    } finally {
      setSending(false);
    }
  };

  const entitled = data?.send?.entitled ?? (isReady ? hasFeature("accountant_month_end_bundle") : true);
  const revisorEmail = data?.send?.revisor_email || null;
  // no_revisor / plan have their own lines; daily_cap is only a "tomorrow".
  const sendBlocker = ["email_unverified", "claim_question_open", "opted_out", "demo_recipient",
    "demo_identity", "demo_in_period", "daily_cap"].includes(data?.send?.blocker) ? data.send.blocker : null;
  const last = (data?.last_sends || []).find((s) => s.status === "sent");
  const sentPkg = data?.sent_package || null;
  const figLabel = (k) => ({
    salg_med_moms: t("meFigSalesVat", "Sales with VAT"),
    salg_uden_moms: t("meFigSalesNoVat", "Sales without VAT"),
    moms_af_salg: t("meFigOutputVat", "Output VAT"),
    kob_med_moms: t("meFigPurchases", "Expenses excl. VAT-exempt"),
    moms_af_kob: t("meFigInputVat", "Input VAT"),
    moms_til_skat: t("meFigVatDue", "VAT payable"),
    omsaetning: t("meFigRevenue", "Revenue incl. VAT"),
    udgifter: t("meFigExpenses", "Booked expenses"),
    antal_udgifter: t("meFigExpenseCount", "Number of expenses"),
    udgifter_med_bilag: t("meFigWithReceipt", "Expenses with a receipt"),
  }[k] || k);
  // A changed category row or day (server: revisor_package._detail_changes)
  // names its category or date beside the figure's own label.
  const changeLabel = (c) => {
    if (c.kind === "category_vat") return `${figLabel("moms_af_kob")} — ${c.name}`;
    if (c.kind === "category_gross") return `${figLabel("udgifter")} — ${c.name}`;
    if (c.kind === "day_revenue") return `${figLabel("omsaetning")} ${formatDateClear(c.name)}`;
    return figLabel(c.key);
  };
  const figValue = (k, v) => (COUNT_FIGURES.has(k) ? String(v) : formatOwnerMoney(v, currency, { decimals: 2 }));
  const schedule = data?.send?.schedule || "never";
  const lowerFirst = (x) => (x ? x.charAt(0).toLowerCase() + x.slice(1) : x);
  const scheduleText = schedule === "weekly"
    ? `${lowerFirst(t("rpsWeekly", "Every week"))} (${lowerFirst(t("rpsWeeklyHint", "Monday morning, the week before"))})`
    : `${lowerFirst(t("rpsMonthly", "Every month"))} (${lowerFirst(t("rpsMonthlyHint", "On the 3rd, the month before"))})`;

  const itemTitle = (it) => {
    switch (it.key) {
      case "closes_missing": return t("meItemClosesMissing", "Days without a daily close");
      case "closes_unlocked": return t("meItemClosesUnlocked", "Daily closes not locked");
      case "bilag_missing": return t("meItemBilagMissing", "Expenses without a receipt");
      case "bilag_unreadable": return t("meItemBilagUnreadable", "Receipts BonBox can't fetch");
      case "sales_variance": return t("meItemVariance", "Daily close and till sales disagree");
      case "drafts_pending": return t("meItemDrafts", "Expenses waiting for approval");
      case "cash_differences": return t("meItemCash", "Cash differences over {amount}", { amount: formatOwnerMoney(it.threshold || 100, currency) });
      case "bank_unmatched": return t("meItemBank", "Bank lines not reconciled");
      case "gavekort_checks": return t("meItemGavekort", "Gavekort checks");
      default: return it.key;
    }
  };
  const itemHint = (it) => ({
    closes_missing: t("meHintClosesMissing", "A revisor asks for every trading day."),
    closes_unlocked: t("meHintUnlocked", "A draft isn't counted anywhere until you lock it."),
    bilag_missing: t("meHintBilag", "Without a receipt the input VAT can't be defended."),
    bilag_unreadable: t("meHintBilagUnreadable", "The file behind the receipt is gone — attach it again on the expense."),
    sales_variance: t("meHintVariance", "The day's close and its till sales differ a lot — the revisor needs the two to agree (Bogføringsloven §9)."),
    drafts_pending: t("meHintDrafts", "Not in your MOMS until you approve them."),
    cash_differences: t("meHintCash", "Counted minus expected, per locked day."),
    bank_unmatched: t("meHintBank", "Outgoing lines from your bank import with no matching expense."),
    gavekort_checks: t("meHintGavekort", "The same checks as on the MOMS page and in the momsangivelse (section D4)."),
  }[it.key]);
  const rowText = (it, r) => {
    const d = r.date ? formatDateClear(r.date) : "";
    if (it.key === "cash_differences") return `${d} · ${formatOwnerMoney(r.difference, currency, { decimals: 2 })}`;
    if (it.key === "sales_variance") {
      return `${d} · ${t("meVarianceRow", "close {close}, till sales {sales}", {
        close: formatOwnerMoney(r.close_revenue, currency, { decimals: 2 }),
        sales: formatOwnerMoney(r.sale_sum, currency, { decimals: 2 }),
      })}`;
    }
    if (it.key === "gavekort_checks" && r.amount != null) return `${d} · ${formatOwnerMoney(r.amount, currency, { decimals: 2 })}`;
    if (r.description != null) return `${d} · ${r.description} · ${formatOwnerMoney(r.amount, currency, { decimals: 2 })}`;
    return d;
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={t("taxAutopilotEyebrow", "REPORTS")}
        title={t("meTitle", "Month-end")}
        subtitle={t("meSubtitle", "What's still open for the period — fix it, then send your revisor the package.")}
      />

      {/* Period */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5" role="tablist">
          {[["month", t("mePeriodMonth", "Month")], ["week", t("mePeriodWeek", "Week")], ["custom", t("mePeriodCustom", "Custom")]].map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => { setKind(k); setNotice(null); sendKey.current = null; }}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${kind === k ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {kind !== "custom" ? (
          <div className="inline-flex items-center gap-1">
            <button type="button" onClick={() => shift(-1)} aria-label={t("mePrev", "Previous period")} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 min-w-[9rem] text-center tabular-nums" data-testid="me-period-label">
              {period.label}
            </span>
            <button type="button" onClick={() => shift(1)} aria-label={t("meNext", "Next period")} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="me-from">{t("fromDate", "From")}</label>
            <input id="me-from" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm" />
            <span className="text-gray-400">–</span>
            <label className="sr-only" htmlFor="me-to">{t("toDate", "To")}</label>
            <input id="me-to" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm" />
          </div>
        )}
      </div>

      {/* Checklist */}
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 mb-6" aria-live="polite">
        {q.failed && !data ? (
          <div className="p-4"><LoadFailed onRetry={q.reload} title={t("meLoadFailed", "Couldn't load the checklist.")} /></div>
        ) : !data ? (
          <div className="p-4 space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="h-10 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />)}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              {openCount > 0 ? (
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300" data-testid="me-open-count">
                  {t("meOpenCount", "{n} open", { n: openCount })}
                </p>
              ) : (
                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1.5">
                  <CircleCheck size={16} aria-hidden="true" />
                  {allClearText}
                </p>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400 shrink-0" data-testid="me-checked-until">
                {periodOver
                  ? t("meCheckedUntil", "Checked up to and including {date}.", { date: formatDateClear(checkedUntil) })
                  : checkedUntil
                    ? t("mePeriodNotOver", "The period isn't over — checked up to and including {date}.", { date: formatDateClear(checkedUntil) })
                    : t("mePeriodNotStarted", "The period isn't over — no days to check yet.")}
              </p>
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((it) => {
                const Icon = ICONS[it.key] || Receipt;
                const open = it.applicable && it.count > 0;
                const rows = it.rows || [];
                return (
                  <li key={it.key} className="px-4 py-3" data-testid={`me-item-${it.key}`}>
                    <div className="flex items-start gap-3">
                      <Icon size={18} strokeWidth={1.75} aria-hidden="true"
                        className={`mt-0.5 shrink-0 ${open ? "text-amber-600 dark:text-amber-400" : "text-gray-300 dark:text-gray-600"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className={`text-sm font-medium ${open ? "text-gray-900 dark:text-gray-100" : "text-gray-500 dark:text-gray-400"}`}>
                            {itemTitle(it)}
                          </p>
                          <span className={`text-sm tabular-nums shrink-0 ${open ? "font-semibold text-gray-900 dark:text-gray-100" : "text-gray-400"}`}>
                            {it.applicable ? it.count : "—"}
                            {it.key === "bilag_missing" && open ? ` · ${formatOwnerMoney(it.amount, currency)}` : ""}
                          </span>
                        </div>
                        {!it.applicable && it.key === "closes_missing" ? (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("meNotUsedCloses", "You don't close the day in BonBox — skipped.")}</p>
                        ) : open ? (
                          <>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{itemHint(it)}</p>
                            <ul className="mt-1.5 text-xs text-gray-700 dark:text-gray-300 space-y-0.5">
                              {rows.slice(0, 5).map((r, i) => <li key={r.id || r.date || i} className="truncate">{rowText(it, r)}</li>)}
                              {rows.length > 5 && <li className="text-gray-500">{t("meMore", "+{n} more", { n: rows.length - 5 })}</li>}
                            </ul>
                            {it.key === "closes_missing" && !it.open_days_configured && (
                              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                                {t("meHintOpenDays", "Closed on some weekdays? Set your opening days on Profile so they aren't counted.")}{" "}
                                <Link to="/profile" className="underline underline-offset-2">{t("profile", "Profile")}</Link>
                              </p>
                            )}
                          </>
                        ) : null}
                      </div>
                      {open && (
                        <Link to={it.link} className="shrink-0 self-center text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
                          {t("meFix", "Fix")}
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {/* The package */}
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <FileText size={18} strokeWidth={1.75} className="mt-0.5 text-gray-500 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t("mePackageTitle", "Revisor package")} · {period.label}</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
              {t("mePackageSub", "Summary PDF, CSV files and every receipt — named date_supplier_amount — in one ZIP.")}
            </p>
          </div>
        </div>
        {sentPkg && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-sm ${sentPkg.changed
              ? "border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200"
              : "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300"}`}
            data-testid="me-sent-package"
          >
            <p className="inline-flex items-center gap-1.5">
              <History size={14} aria-hidden="true" />
              {sentPkg.status === "unclear"
                ? t("meSentUnclear", "Possibly sent {date} to {email} — not confirmed.", { date: formatDateClear(sentPkg.sent_on || ""), email: sentPkg.recipient || "" })
                : sentPkg.partial
                  ? t("meSentPartial", "Sent {date} to {email} — before the period was over.", { date: formatDateClear(sentPkg.sent_on || ""), email: sentPkg.recipient || "" })
                  : t("meSentOn", "Sent to your revisor {date} ({email}).", { date: formatDateClear(sentPkg.sent_on || ""), email: sentPkg.recipient || "" })}
            </p>
            {sentPkg.changed && (
              <>
                <p className="font-semibold mt-1" data-testid="me-changed-after-send">
                  {t("meChangedAfterSend", "Changed after it was sent")}
                </p>
                <ul className="mt-0.5 text-xs space-y-0.5">
                  {(sentPkg.changes || []).map((c) => (
                    <li key={c.key}>{changeLabel(c)}: {figValue(c.key, c.before)} → {figValue(c.key, c.after)}</li>
                  ))}
                </ul>
                <p className="text-xs mt-1">
                  {t("meChangedHint", "Send the corrected package — it is marked RETTELSE and lists what changed. Nothing is sent on its own.")}
                </p>
              </>
            )}
          </div>
        )}
        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <Button variant="secondary" onClick={() => download("zip")} busy={downloading === "zip"} disabled={!!downloading || sending || !validCustom}
            iconLeft={downloading !== "zip" && <Download size={14} aria-hidden="true" />}>
            {t("meDownloadZip", "Download package (ZIP)")}
          </Button>
          <Button variant="ghost" onClick={() => download("pdf")} busy={downloading === "pdf"} disabled={!!downloading || sending || !validCustom}>
            {t("meDownloadPdf", "Summary (PDF)")}
          </Button>
          {entitled && revisorEmail && (
            <Button variant="accent" onClick={send} busy={sending} disabled={sending || !!downloading || !data || !validCustom}
              iconLeft={!sending && <Send size={14} aria-hidden="true" />} className="sm:ml-auto">
              {sentPkg?.changed ? t("meSendCorrected", "Send corrected package")
                : sentPkg ? t("meSendAgain", "Send again")
                  : t("meSend", "Send the package")}
            </Button>
          )}
        </div>
        {entitled && revisorEmail && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {t("meSendTo", "To {email}: the summary attached, the full package behind a link that works for 14 days.", { email: revisorEmail })}
          </p>
        )}
        {entitled && revisorEmail && openCount > 0 && (
          <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
            {t("meSendOpenWarn", "{n} items are open. The e-mail lists them, so your revisor knows the period isn't finished.", { n: openCount })}
          </p>
        )}
        {/* Say BEFORE the tap what would stop the mail (an unconfirmed owner
            e-mail, the revisor's opt-out, sample data …) — the download works
            either way. */}
        {entitled && revisorEmail && sendBlocker && (
          <p className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200" role="status" data-testid="me-send-blocker">
            {/* Nothing is queued from this page — the schedule card's "it goes
                out tomorrow" would not be true here. */}
            {sendBlocker === "daily_cap"
              ? t("meBlocked_daily_cap", "Today's limit for mail to your revisor is reached — send it tomorrow, or download it and send it yourself.")
              : t(`rpsBlocked_${sendBlocker}`, sendBlocker)}
          </p>
        )}
        {entitled && !revisorEmail && data && (
          <p className="text-sm text-gray-700 dark:text-gray-300 mt-3">
            {t("meNoRevisor", "Save your revisor's e-mail to send it from BonBox.")}{" "}
            <Link to="/share-recipients#revisorpakke" className="underline underline-offset-2 font-medium">{t("rpsTitle", "Send revisor package")}</Link>
          </p>
        )}
        {!entitled && (
          <div className="mt-3">
            <UpgradeNudge intent="inline" tier="starter" iconName="Send"
              benefit={t("meSendLocked", "BonBox sends the package for you from Starter — you can always download it and send it yourself.")}
              ctaLabel={t("seePlans", "See plans")} />
          </div>
        )}
        {last && !sentPkg && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {t("meLastSent", "Sent {date} to {email}", { date: formatDateClear(last.sent_on || (last.sent_at || "").slice(0, 10)), email: last.recipient || "" })}
          </p>
        )}
        {notice && <SectionBanner className="mt-3" severity={notice.severity} title={notice.text} />}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
          {schedule === "never" ? (
            <Link to="/share-recipients#revisorpakke" className="underline underline-offset-2 font-medium">
              {t("meScheduleOff", "Send it automatically every week or month")}
            </Link>
          ) : (
            <>
              {t("meScheduleOn", "Sent automatically: {schedule}.", { schedule: scheduleText })}{" "}
              <Link to="/share-recipients#revisorpakke" className="underline underline-offset-2 font-medium">
                {t("meScheduleChange", "Change")}
              </Link>
            </>
          )}
        </p>
      </section>
    </PageShell>
  );
}
