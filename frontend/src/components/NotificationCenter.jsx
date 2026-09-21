import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useLiveAlerts } from "../hooks/useLiveAlerts";
import { useAsyncData } from "../hooks/useAsyncData";
import { useAuth } from "../hooks/useAuth";
import { formatOwnerMoney } from "../utils/currency";
import { LoadFailed, Icon, Empty } from "./ui";

// Some i18n catalogue strings still open with a "⚠" (the severe-allergy line
// ships one in en, da AND tr). Rendered UI in this app is Lucide only, and the
// catalogue lives in another file, so the mark comes off the string here and
// the row draws its own icon. Narrow on purpose: the warning sign, its
// variation selector, and the whitespace after it — nothing else.
// By code point, not by a literal character: U+26A0 WARNING SIGN and the
// U+FE0F variation selector that follows it in some catalogues.
const LEADING_MARK_CODEPOINTS = new Set([0x26a0, 0xfe0f]);
function stripLeadingMark(s) {
  let out = String(s ?? "");
  while (out.length > 0) {
    const cp = out.codePointAt(0);
    if (!LEADING_MARK_CODEPOINTS.has(cp) && !/\s/.test(out[0])) break;
    out = out.slice(1);
  }
  return out;
}

function useTimeAgo() {
  const { t } = useLanguage();
  return (date) => {
    const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
    if (mins < 1) return t("justNow") || "just now";
    if (mins < 60) return (t("minutesAgo") || "{n}m ago").replace("{n}", mins);
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return (t("hoursAgo") || "{n}h ago").replace("{n}", hrs);
    return (t("daysAgo") || "{n}d ago").replace("{n}", Math.floor(hrs / 24));
  };
}

export default function NotificationCenter({ align = "right" }) {
  const { t } = useLanguage();
  // The budget rows below quote money, and money on an owner-facing surface
  // is the owner's currency in the owner's grouping — never the browser's.
  //
  // NOT CLAIMED: that this makes the bell and the budget screen agree. It does
  // not yet. BudgetPage.jsx reads the SAME /budgets/summary payload but still
  // renders it with a bare `.toLocaleString()` plus a bare currency CODE
  // (BudgetPage.jsx:276, 294, 357-358, 371, 375), so the same Mad row reads
  // "12.500 kr. / 14.000 kr." here and "12.500 / 14.000 DKK" there. This is
  // the half of that pair that follows the money rule; closing the gap needs
  // the same formatOwnerMoney/<Amount> pass on BudgetPage, which is a separate
  // file and a separate change.
  const { user } = useAuth();
  const currency = user?.currency || "DKK";
  // Live host-stand alerts (booking/allergy "pop + sound") live in the same
  // bell so there's one notification surface, not two. The provider owns the
  // toast + sound; here we expose its on/off + sound toggles and merge its
  // unread count + recent feed into this dropdown.
  const live = useLiveAlerts();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return JSON.parse(localStorage.getItem("bonbox_dismissed_notifs") || "[]"); } catch { return []; }
  });
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Fetch notifications
  //
  // THE THIRD STATE. All three of these used to be `api.get(...)` wrapped in
  // `.catch(() => null)` inside a `try {} catch {}`, which is the swallow this
  // sweep exists to remove: a dead network, an expired session or a 500 left
  // `notifs` at `[]`, the body fell through to its empty state, and the bell
  // told the owner "All clear! No notifications." That sentence is a claim
  // about the WHOLE business — nothing is over budget, nothing is out of stock,
  // no spending looks unusual — and it must not be made on a fetch that never
  // came back. "Nothing to report" and "I could not ask" are different facts;
  // `failed` below is what lets the bell say the second one.
  //
  // Three separate hooks rather than one combined fetch, deliberately: these
  // are three independent questions, and if stock is down there is no reason
  // to also stop showing the budget warnings we DID get. Whichever ones
  // answered still render; the banner says the list may be short one source.
  //
  // useAsyncData also keeps the last good `data` through a failed reload, so a
  // refresh that fails leaves the owner looking at the alerts that were true a
  // minute ago instead of a blanked dropdown — with the banner saying they are
  // stale. The hooks fetch on mount on their own, which is what the old
  // mount-effect did for the badge count.
  const month = useMemo(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  // 1. Expense spike alerts
  const alerts = useAsyncData(() => api.get("/email/alerts-preview"), []);
  // 2. Low stock alerts
  const stock = useAsyncData(() => api.get("/inventory/alerts"), []);
  // 3. Budget warnings
  const budgets = useAsyncData(
    () => api.get(`/budgets/summary?month=${month}&mode=business`),
    [month],
  );

  const loading = alerts.loading || stock.loading || budgets.loading;
  // ANY unanswered source makes the bell non-authoritative. One missing answer
  // is enough to make "All clear" a guess, so it is enough to suppress it.
  const checkFailed = alerts.failed || stock.failed || budgets.failed;

  const reloadAll = useCallback(() => {
    alerts.reload();
    stock.reload();
    budgets.reload();
  }, [alerts.reload, stock.reload, budgets.reload]);

  const notifications = useMemo(() => {
    const notifs = [];
    const now = new Date();

    // 1. Expense spike alerts
    if (Array.isArray(alerts.data?.alerts)) {
      alerts.data.alerts.forEach((a) => {
        notifs.push({
          id: `alert_${a.category || a.type}_${now.toDateString()}`,
          type: "expense",
          // WAS an emoji ("📈"). `icon` is now a Lucide name resolved through
          // <Icon>; see the render note on the row below.
          icon: "TrendingUp",
          title: a.title || t("expenseAlert") || "Expense Alert",
          body: a.message || ((t("unusualSpending") || "{cat}: unusual spending detected").replace("{cat}", a.category)),
          time: now.toISOString(),
          severity: "warning",
        });
      });
    }

    // 2. Low stock alerts
    if (Array.isArray(stock.data)) {
      stock.data.slice(0, 5).forEach((item) => {
        notifs.push({
          id: `stock_${item.id}`,
          type: "inventory",
          // WAS an emoji ("📦").
          icon: "Package",
          title: t("lowStockTitle") || "Low Stock",
          body: ((t("lowStockBody") || "{name}: {qty} left (min: {min})").replace("{name}", item.name).replace("{qty}", item.quantity).replace("{min}", item.min_threshold)),
          time: now.toISOString(),
          severity: item.quantity <= 0 ? "critical" : "warning",
        });
      });
    }

    // 3. Budget warnings
    if (Array.isArray(budgets.data?.categories)) {
      budgets.data.categories
        .filter((c) => c.status === "red" || c.status === "yellow")
        .slice(0, 5)
        .forEach((c) => {
          // WAS `c.spent.toLocaleString()` / `c.limit_amount.toLocaleString()`.
          // A bare toLocaleString takes its grouping from the BROWSER's locale
          // and emits no currency at all, so a Danish owner whose phone is set
          // to English read "Mad: 87% brugt (12,500 / 14,000)" for money that
          // is kroner. formatOwnerMoney owns the da-DK grouping and the "kr."
          // suffix, and renders "—" for a figure that is missing rather than
          // inventing a 0 for the owner to measure himself against.
          //
          // Whole kroner on a glance surface, but never ROUNDED money: `spent`
          // is a float sum of expense amounts (backend/app/routers/budget.py
          // :102-113), so 12.500,75 has to stay 12.500,75 kr. here instead of
          // becoming a 12.501 kr. the budget screen never shows.
          const money = (v) =>
            formatOwnerMoney(v, currency, { decimals: Number.isInteger(Number(v)) ? 0 : 2 });
          const spent = money(c.spent);
          const limit = money(c.limit_amount);
          // The percentage is the server's. Show it only when it is a real
          // number, so a missing one reads "—%", not "undefined%" — and not
          // "null%" either: Number(null) is 0, which IS finite, so the null a
          // JSON API actually sends for a missing number has to be ruled out
          // BEFORE the finite check, not by it. Same for "" and for a shape
          // that is not a number at all.
          const rawPct = c.pct;
          const pctNum =
            typeof rawPct === "number" || (typeof rawPct === "string" && rawPct.trim() !== "")
              ? Number(rawPct)
              : NaN;
          const pct = Number.isFinite(pctNum) ? String(pctNum) : "—";
          notifs.push({
            id: `budget_${c.category}_${month}`,
            type: "budget",
            // WAS the emoji pair "🔴"/"🟡" — colour carried ALL the meaning, so
            // it said nothing at all to a colour-blind owner and rendered as
            // three different marks across Apple / Windows / Android. Two
            // different Lucide SHAPES carry the over/near distinction, so it
            // survives without colour; the row's left border still carries the
            // urgency, as it did before.
            icon: c.status === "red" ? "AlertCircle" : "AlertTriangle",
            title: c.status === "red" ? (t("overBudget") || "Over Budget") : (t("nearBudgetLimit") || "Near Budget Limit"),
            body: ((t("budgetUsedFmt") || "{cat}: {pct}% used ({spent} / {limit})").replace("{cat}", c.category).replace("{pct}", pct).replace("{spent}", spent).replace("{limit}", limit)),
            time: now.toISOString(),
            severity: c.status === "red" ? "critical" : "warning",
          });
        });
    }

    return notifs;
  }, [alerts.data, stock.data, budgets.data, month, t, currency]);

  // Fetch on open — the dropdown re-asks so the list is current when looked at.
  useEffect(() => {
    if (open) reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Persist dismissed
  useEffect(() => {
    localStorage.setItem("bonbox_dismissed_notifs", JSON.stringify(dismissed));
  }, [dismissed]);

  const dismiss = (id) => setDismissed((prev) => [...prev, id]);
  const clearAll = () => setDismissed(notifications.map((n) => n.id));

  const visible = notifications.filter((n) => !dismissed.includes(n.id));
  const unread = visible.length;
  const liveUnread = live.active ? live.unread : 0;
  const badge = unread + liveUnread;

  const severityBorder = { critical: "border-l-red-500", warning: "border-l-amber-500", info: "border-l-blue-500" };

  // Inline switch for the live-alert toggles (matches the design-system style).
  const Switch = ({ on, set, label }) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => set(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
        ${on ? "bg-gray-900 dark:bg-gray-100" : "bg-gray-200 dark:bg-gray-700"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 shadow-sm transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );

  return (
    <div ref={ref} className="relative">
      {/* Bell button */}
      <button
        onClick={() => { const n = !open; setOpen(n); if (n && live.active) live.markAllRead(); }}
        className="relative p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
        aria-label={checkFailed && badge === 0
          ? t("notifCouldNotCheck", "Couldn't check for notifications")
          : (t("notifications") || "Notifications")}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {badge > 0 ? (
          // The count sat at 10px in a 700 weight — below the 11px floor and
          // off the 400/500/600 ramp, on the one number in the chrome the owner
          // reads from arm's length. 11/600 in the same 18px dot.
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[11px] font-semibold rounded-full flex items-center justify-center min-w-[18px] h-[18px] px-1 leading-none">
            {badge > 9 ? "9+" : badge}
          </span>
        ) : checkFailed ? (
          // A bare bell is itself a claim: "nothing needs you". With a check
          // that never came back we do not know that, so the chrome says so
          // too — an amber dot, not a red count, because this is "unknown",
          // not "urgent". Opening the bell gets the full sentence + Try again.
          <span
            title={t("notifCouldNotCheck", "Couldn't check for notifications")}
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-gray-800"
          />
        ) : null}
      </button>

      {/* Dropdown */}
      {open && (
        <div className={`absolute ${align === "left" ? "left-0" : "right-0"} top-full mt-2 w-80 sm:w-96 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm z-50 overflow-hidden`}>
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-white">{t("notifications") || "Notifications"}</h3>
            {visible.length > 0 && (
              <button onClick={clearAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                {t("clearAll") || "Clear all"}
              </button>
            )}
          </div>

          {/* Live alerts — host-stand "pop + sound" toggle + recent feed */}
          {live.active && (
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-gray-700 dark:text-gray-200">
                  {t("liveAlertTitle") || "Live alerts"}
                </span>
                <Switch on={live.enabled} set={live.setEnabled} label={t("liveAlertEnable") || "Enable alerts"} />
              </div>
              <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
                {t("liveAlertHint") || "Pop + sound when a booking changes or an allergy is noted — on this screen."}
              </p>
              <div className={`mt-2 flex items-center justify-between ${live.enabled ? "" : "opacity-40 pointer-events-none"}`}>
                <span className="text-[12.5px] text-gray-600 dark:text-gray-300">{t("liveAlertSound") || "Sound"}</span>
                <Switch on={live.sound} set={live.setSound} label={t("liveAlertSound") || "Sound"} />
              </div>
              {live.feed.length > 0 && (
                <div className="mt-2 -mx-1 max-h-40 overflow-y-auto">
                  {live.feed.slice(0, 8).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => { setOpen(false); live.openReservations(a); }}
                      className="w-full text-left px-1 py-1 flex items-start gap-2 rounded hover:bg-white dark:hover:bg-gray-700/40"
                    >
                      <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${a.kind === "cancelled" ? "bg-gray-400" : a.severe ? "bg-red-500" : a.hasAllergy ? "bg-amber-500" : "bg-emerald-500"}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium text-gray-800 dark:text-gray-100 truncate">
                          {a.title}{a.who ? ` · ${a.who}` : ""}
                        </span>
                        {a.hasAllergy && (
                          // Was 10.5px — under the 11px floor, on the allergy
                          // line, which is the one line on this surface that
                          // must not be squinted at.
                          //
                          // The severe string also still carries a "⚠" INSIDE
                          // the catalogue — en (useLanguage.jsx:3362), da
                          // (:11799) and tr (i18n/tr.js:3560) all ship one — so
                          // the emoji reached the Danish owner too, on the
                          // highest-stakes row in the bell, rendering as three
                          // different marks across Apple / Windows / Android.
                          // The catalogue is not this file's to edit, and a new
                          // key would cost the real Danish wording, so the mark
                          // is taken off whatever the catalogue returns and the
                          // row draws a Lucide one: the Danish sentence
                          // survives, the emoji does not.
                          <span className={`flex items-start gap-1 text-[11px] font-medium ${a.severe ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {a.severe && <Icon name="AlertTriangle" size={12} className="shrink-0 mt-px" />}
                            <span className="min-w-0">
                              {a.severe
                                ? stripLeadingMark(t("liveAlertSevereAllergy") || "Severe allergy noted")
                                : (t("liveAlertAllergy") || "Allergy / dietary note")}
                            </span>
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Body */}
          <div className="max-h-80 overflow-y-auto">
            {loading && visible.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400">{t("loading") || "Loading..."}</div>
            ) : checkFailed && visible.length === 0 ? (
              // INSTEAD of "All clear", never above it. With nothing to show and
              // a check that did not answer, the only honest screen is the one
              // that admits it and offers the retry.
              <div className="p-4">
                <LoadFailed onRetry={reloadAll} />
              </div>
            ) : visible.length === 0 ? (
              // WAS a 🎉 at text-3xl. A party popper is a celebration, and
              // "nothing needs you today" is not a celebration — it is the calm
              // the owner opened the bell hoping for. It also rendered as three
              // different marks across Apple / Windows / Android. <Empty> is
              // the one empty-state pattern in the app: a Lucide mark in a
              // quiet gray chip, same as every other empty screen.
              <Empty
                icon={CheckCircle2}
                title={t("allClearNoNotifs") || "All clear! No notifications."}
              />
            ) : (
              <>
                {/* Partial answer: some sources replied, at least one did not.
                    The rows below are real, so they stay — the banner is here to
                    say the list may be short one source, not to replace it. */}
                {checkFailed && (
                  <div className="px-3 pt-3">
                    <LoadFailed
                      onRetry={reloadAll}
                      body={t("notifCheckIncomplete", "Some checks didn't come back, so this list may be incomplete.")}
                    />
                  </div>
                )}
                {visible.map((n) => (
                  <div
                    key={n.id}
                    className={`px-4 py-3 border-b border-gray-50 dark:border-gray-700/50 border-l-3 ${
                      severityBorder[n.severity] || "border-l-gray-300"
                    } hover:bg-gray-50 dark:hover:bg-gray-700/30 transition`}
                  >
                    <div className="flex items-start gap-3">
                      {/* WAS `<span className="text-lg">{n.icon}</span>` with an
                          emoji string. The bell sits in both the phone header
                          and the sidebar, on every page, so those four emoji
                          were the app's most-seen glyphs — and they rendered as
                          three different marks depending on the owner's device,
                          announced as "chart increasing" to a screen reader,
                          and clashed with the gray-900 palette. A Lucide
                          outline in the calm gray, deliberately NOT tinted by
                          severity: the row's coloured left border already says
                          how urgent this is, and the mark itself (AlertCircle
                          vs AlertTriangle vs Package vs TrendingUp) says what
                          it is. Tinting the glyph too would repeat the border
                          in colour on every row without adding a fact. */}
                      <Icon
                        name={n.icon}
                        size={18}
                        className="flex-shrink-0 mt-0.5 text-gray-400 dark:text-gray-500"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{n.title}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{n.body}</p>
                      </div>
                      {/* WAS `opacity-0 group-hover:opacity-100`. A phone has no
                          hover, so on the device this product is mostly used on
                          the × sat at opacity 0 permanently — invisible, but a
                          zero-opacity button still takes taps, so the owner's
                          thumb made notifications disappear with nothing on
                          screen to explain it. Always visible, quiet, and given
                          a real 44px box so it is aimable; the negative margins
                          keep the row the height it was.

                          The resting colour is gray-400 / dark gray-500, not
                          gray-300: dismissal writes to bonbox_dismissed_notifs
                          with no undo, and a stock id has no date in it, so one
                          mis-tap silences that low-stock warning for good. A
                          destructive control that permanent may not sit at
                          ~1.5:1 against white — it has to be seen before it is
                          hit. */}
                      <button
                        type="button"
                        onClick={() => dismiss(n.id)}
                        aria-label={t("dismiss") || "Dismiss"}
                        className="flex-shrink-0 -my-1.5 -mr-2 w-11 h-11 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition"
                      >
                        <Icon name="X" size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
