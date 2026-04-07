import { useState, useEffect, useRef, useCallback } from "react";
import api from "../services/api";

function timeAgo(date) {
  const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function NotificationCenter() {
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
            title: a.title || "Expense Alert",
            body: a.message || `${a.category}: unusual spending detected`,
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
            title: "Low Stock",
            body: `${item.name}: ${item.quantity} left (min: ${item.min_threshold})`,
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
              title: c.status === "red" ? "Over Budget" : "Near Budget Limit",
              body: `${c.category}: ${c.pct}% used (${c.spent.toLocaleString()} / ${c.limit_amount.toLocaleString()})`,
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

  const severityBorder = { critical: "border-l-red-500", warning: "border-l-amber-500", info: "border-l-blue-500" };

  return (
    <div ref={ref} className="relative">
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
        aria-label="Notifications"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4.5 h-4.5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center min-w-[18px] h-[18px] leading-none">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-white">Notifications</h3>
            {visible.length > 0 && (
              <button onClick={clearAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                Clear all
              </button>
            )}
          </div>

          {/* Body */}
          <div className="max-h-80 overflow-y-auto">
            {loading && visible.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400">Loading...</div>
            ) : visible.length === 0 ? (
              <div className="p-8 text-center">
                <div className="text-3xl mb-2">🎉</div>
                <p className="text-sm text-gray-500 dark:text-gray-400">All clear! No notifications.</p>
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
