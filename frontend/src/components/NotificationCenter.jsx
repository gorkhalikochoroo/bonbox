import { useState, useEffect, useRef, useCallback } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useLiveAlerts } from "../hooks/useLiveAlerts";

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

export default function NotificationCenter() {
  const { t } = useLanguage();
  // Live host-stand alerts (booking/allergy "pop + sound") live in the same
  // bell so there's one notification surface, not two. The provider owns the
  // toast + sound; here we expose its on/off + sound toggles and merge its
  // unread count + recent feed into this dropdown.
  const live = useLiveAlerts();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
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
  const fetchNotifs = useCallback(async () => {
    setLoading(true);
    const notifs = [];
    const now = new Date();

    try {
      // 1. Expense spike alerts
      const alertRes = await api.get("/email/alerts-preview").catch(() => null);
      if (alertRes?.data?.alerts) {
        alertRes.data.alerts.forEach((a) => {
          notifs.push({
            id: `alert_${a.category || a.type}_${now.toDateString()}`,
            type: "expense",
            icon: "📈",
            title: a.title || t("expenseAlert") || "Expense Alert",
            body: a.message || ((t("unusualSpending") || "{cat}: unusual spending detected").replace("{cat}", a.category)),
            time: now.toISOString(),
            severity: "warning",
          });
        });
      }
    } catch {}

    try {
      // 2. Low stock alerts
      const stockRes = await api.get("/inventory/alerts").catch(() => null);
      if (stockRes?.data && Array.isArray(stockRes.data)) {
        stockRes.data.slice(0, 5).forEach((item) => {
          notifs.push({
            id: `stock_${item.id}`,
            type: "inventory",
            icon: "📦",
            title: t("lowStockTitle") || "Low Stock",
            body: ((t("lowStockBody") || "{name}: {qty} left (min: {min})").replace("{name}", item.name).replace("{qty}", item.quantity).replace("{min}", item.min_threshold)),
            time: now.toISOString(),
            severity: item.quantity <= 0 ? "critical" : "warning",
          });
        });
      }
    } catch {}

    try {
      // 3. Budget warnings
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const budRes = await api.get(`/budgets/summary?month=${month}&mode=business`).catch(() => null);
      if (budRes?.data?.categories) {
        budRes.data.categories
          .filter((c) => c.status === "red" || c.status === "yellow")
          .slice(0, 5)
          .forEach((c) => {
            notifs.push({
              id: `budget_${c.category}_${month}`,
              type: "budget",
              icon: c.status === "red" ? "🔴" : "🟡",
              title: c.status === "red" ? (t("overBudget") || "Over Budget") : (t("nearBudgetLimit") || "Near Budget Limit"),
              body: ((t("budgetUsedFmt") || "{cat}: {pct}% used ({spent} / {limit})").replace("{cat}", c.category).replace("{pct}", c.pct).replace("{spent}", c.spent.toLocaleString()).replace("{limit}", c.limit_amount.toLocaleString())),
              time: now.toISOString(),
              severity: c.status === "red" ? "critical" : "warning",
            });
          });
      }
    } catch {}

    setNotifications(notifs);
    setLoading(false);
  }, []);

  // Fetch on open
  useEffect(() => {
    if (open) fetchNotifs();
  }, [open, fetchNotifs]);

  // Auto-fetch on mount for badge count
  useEffect(() => { fetchNotifs(); }, [fetchNotifs]);

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
        aria-label={t("notifications") || "Notifications"}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4.5 h-4.5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center min-w-[18px] h-[18px] leading-none">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm z-50 overflow-hidden">
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
                      onClick={() => { setOpen(false); live.openReservations(); }}
                      className="w-full text-left px-1 py-1 flex items-start gap-2 rounded hover:bg-white dark:hover:bg-gray-700/40"
                    >
                      <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${a.kind === "cancelled" ? "bg-gray-400" : a.severe ? "bg-red-500" : a.hasAllergy ? "bg-amber-500" : "bg-emerald-500"}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium text-gray-800 dark:text-gray-100 truncate">
                          {a.title}{a.who ? ` · ${a.who}` : ""}
                        </span>
                        {a.hasAllergy && (
                          <span className={`block text-[10.5px] font-medium ${a.severe ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {a.severe ? (t("liveAlertSevereAllergy") || "⚠ Severe allergy noted") : (t("liveAlertAllergy") || "Allergy / dietary note")}
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
            ) : visible.length === 0 ? (
              <div className="p-8 text-center">
                <div className="text-3xl mb-2">🎉</div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("allClearNoNotifs") || "All clear! No notifications."}</p>
              </div>
            ) : (
              visible.map((n) => (
                <div
                  key={n.id}
                  className={`px-4 py-3 border-b border-gray-50 dark:border-gray-700/50 border-l-3 ${
                    severityBorder[n.severity] || "border-l-gray-300"
                  } hover:bg-gray-50 dark:hover:bg-gray-700/30 transition group`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-lg flex-shrink-0 mt-0.5">{n.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{n.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{n.body}</p>
                    </div>
                    <button
                      onClick={() => dismiss(n.id)}
                      className="text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 opacity-0 group-hover:opacity-100 transition text-sm flex-shrink-0"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
