import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { errText } from "../utils/errText";

/**
 * AdminSupportPage — the founder's triage inbox for in-app support tickets
 * (SupportChip → POST /api/support/tickets). Lives under the PLATFORM nav
 * group at /admin/support, guarded by SuperAdminRoute (frontend) +
 * require_super_admin (server, the real gate).
 *
 * Priority (Pro) tickets sort first (server-ordered). Each row expands to the
 * full body + auto-captured page/browser context. open/responded tickets get a
 * reply box that POSTs /support/admin/tickets/{id}/respond — which emails the
 * owner the reply and closes the loop ("we'll reply by email" made true).
 *
 * Fetch ALL then filter client-side: the server status filter is an exact
 * match, so a server-side "open" query would DROP "responded" tickets
 * (Reply-keep-open) and they'd silently vanish. "Active" = open + responded.
 */

function relativeTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso);
  if (isNaN(then)) return iso;
  const sec = Math.floor((Date.now() - then.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return then.toLocaleDateString();
}

function statusBadge(s) {
  switch (s) {
    case "open": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
    case "responded": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
    case "closed": return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
    default: return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  }
}

function prettyContext(ctx) {
  if (!ctx) return null;
  try {
    const o = JSON.parse(ctx);
    const parts = [];
    if (o.page) parts.push(`page ${o.page}`);
    if (o.ua) parts.push(o.ua);
    if (o.ts) parts.push(new Date(o.ts).toLocaleString());
    return parts.join(" · ");
  } catch {
    return String(ctx).slice(0, 300);
  }
}

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState([]);
  const [count, setCount] = useState(0);
  const [filter, setFilter] = useState("active"); // active (open+responded) | all | closed
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [replyById, setReplyById] = useState({});
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get("/support/admin/tickets");
      setTickets(r.data?.tickets || []);
      setCount(r.data?.count || 0);
    } catch (e) {
      setError(errText(e, "Failed to load tickets"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    if (filter === "closed") return tickets.filter((tk) => tk.status === "closed");
    if (filter === "active") return tickets.filter((tk) => tk.status !== "closed");
    return tickets;
  }, [tickets, filter]);

  const openCount = useMemo(
    () => tickets.filter((tk) => tk.status !== "closed").length,
    [tickets],
  );

  const respond = async (ticket, close) => {
    const text = (replyById[ticket.id] || "").trim();
    if (!text) return;
    setBusyId(ticket.id);
    try {
      await api.post(`/support/admin/tickets/${ticket.id}/respond`, {
        response_text: text.slice(0, 5000),
        close,
      });
      setReplyById((m) => ({ ...m, [ticket.id]: "" }));
      setExpandedId(null);
      await load();
    } catch (e) {
      setError(errText(e, "Failed to send reply"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5 pb-24">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link to="/admin" className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">
            ← Platform admin
          </Link>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1">Support inbox</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            In-app tickets from owners (the SupportChip). Priority (Pro) first. Replies email the owner.
          </p>
        </div>
        {openCount > 0 && (
          <span className="px-2.5 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs font-semibold">
            {openCount} open
          </span>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4 sm:p-5">
        {/* Filter bar */}
        <div className="mb-3 flex items-center gap-2">
          {["active", "all", "closed"].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs font-medium rounded-md capitalize transition ${
                filter === f
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {f}
            </button>
          ))}
          <button
            type="button"
            onClick={load}
            className="ml-auto px-3 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Refresh
          </button>
        </div>

        {error && <div className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</div>}
        {loading ? (
          <div className="py-6 text-center text-sm text-gray-400">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400">
            No {filter === "all" ? "" : filter} tickets. {filter === "active" && "You're all caught up. 🎉"}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {visible.map((tk) => {
              const isOpen = expandedId === tk.id;
              const canReply = tk.status === "open" || tk.status === "responded";
              return (
                <div key={tk.id} className="py-3">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isOpen ? null : tk.id)}
                    className="w-full text-left flex items-start gap-2"
                  >
                    {tk.is_priority && <span title="Pro priority" className="text-amber-500 mt-0.5">★</span>}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{tk.subject}</span>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${statusBadge(tk.status)}`}>{tk.status}</span>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{tk.kind}</span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                        {tk.owner_email || "unknown"} · {relativeTime(tk.created_at)}
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="mt-3 pl-1 space-y-3">
                      <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">{tk.body}</p>
                      {prettyContext(tk.context) && (
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 break-words">↳ {prettyContext(tk.context)}</p>
                      )}
                      {tk.response_text && (
                        <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap border-l-2 border-emerald-500 pl-3">
                          <span className="text-[11px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-semibold block mb-1">Your reply</span>
                          {tk.response_text}
                        </div>
                      )}
                      {canReply && (
                        <div className="space-y-2">
                          <textarea
                            rows={3}
                            value={replyById[tk.id] || ""}
                            onChange={(e) => setReplyById((m) => ({ ...m, [tk.id]: e.target.value }))}
                            placeholder="Reply to the owner (emailed to them)…"
                            maxLength={5000}
                            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-gray-900 outline-none resize-none"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => respond(tk, true)}
                              disabled={busyId === tk.id || !(replyById[tk.id] || "").trim()}
                              className="px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 text-xs font-semibold disabled:opacity-50"
                            >
                              {busyId === tk.id ? "Sending…" : "Reply & close"}
                            </button>
                            <button
                              type="button"
                              onClick={() => respond(tk, false)}
                              disabled={busyId === tk.id || !(replyById[tk.id] || "").trim()}
                              className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 text-xs font-medium hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                            >
                              Reply, keep open
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {count > 0 && (
          <div className="mt-3 text-[11px] text-gray-400">{visible.length} of {count} (max 200 fetched)</div>
        )}
      </div>
    </div>
  );
}
