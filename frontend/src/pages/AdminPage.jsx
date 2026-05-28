import { useEffect, useMemo, useState, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import api from "../services/api";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell,
} from "recharts";

/**
 * Super-admin platform dashboard.
 *
 * Frontend route is cosmetically gated (SuperAdminRoute in App.jsx). The REAL
 * enforcement lives server-side in services/admin_security.py — every endpoint
 * here goes through 7 independent layers (JWT → role → email allowlist →
 * verified → account age → brute-force lockout → audit log) and returns a
 * generic 404 on any failure to avoid leaking which check failed.
 *
 * If the user is not actually a super_admin, every fetch on this page returns
 * a 404 and the cards stay empty — no data ever leaves the server.
 */
export default function AdminPage() {
  const { user } = useAuth();

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [businessTypes, setBusinessTypes] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [features, setFeatures] = useState([]);
  const [retention, setRetention] = useState(null);
  const [signups, setSignups] = useState([]);
  const [securityEvents, setSecurityEvents] = useState([]);
  const [recentErrors, setRecentErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [ov, us, bt, cur, ft, rt, su, se, er] = await Promise.all([
          api.get("/admin/overview"),
          api.get("/admin/users", { params: { limit: 100 } }),
          api.get("/admin/business-types"),
          api.get("/admin/currency-distribution"),
          api.get("/admin/feature-usage", { params: { days: 30 } }),
          api.get("/admin/retention"),
          api.get("/admin/signups-timeline", { params: { days: 30 } }),
          api.get("/admin/security-events", { params: { limit: 30 } }),
          api.get("/admin/recent-errors", { params: { limit: 20 } }).catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        setOverview(ov.data);
        setUsers(us.data);
        setBusinessTypes(bt.data);
        setCurrencies(cur.data);
        setFeatures(ft.data);
        setRetention(rt.data);
        setSignups(su.data);
        setSecurityEvents(se.data);
        setRecentErrors(er.data || []);
      } catch (e) {
        if (cancelled) return;
        const status = e.response?.status;
        // 404 = guard rejected (could be any of the 7 layers — we don't know
        // and we don't need to know). 401 = token expired. Anything else = bug.
        if (status === 404) setError("Access denied");
        else if (status === 401) setError("Session expired — please log in again");
        else setError("Failed to load admin data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Local map of full-id → email, primed from the loaded `users` list. Any id
  // *not* in this map (because it falls outside the 100-row pagination window)
  // is resolved lazily via /admin/users?search=<prefix> on click.
  // MUST be declared before any conditional return — Rules of Hooks.
  const userById = useMemo(() => {
    const m = {};
    for (const u of users) m[u.id] = u;
    return m;
  }, [users]);

  if (loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 dark:bg-gray-700 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-xl p-6">
          <h2 className="text-lg font-bold mb-1">Admin access unavailable</h2>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  const PIE_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6 pb-24">
      {/* Admin-mode banner — visual reminder this is privileged */}
      <div className="bg-gray-50 dark:bg-gray-800/50 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-red-700 dark:text-red-400 font-bold">
            🛡️ Super Admin Mode
          </div>
          <div className="text-sm text-gray-700 dark:text-gray-300">
            Signed in as <span className="font-mono">{user?.email}</span>. All access is audited.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href="/admin/training"
            className="px-3 py-1.5 text-xs font-semibold bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg transition"
          >
            🧠 Training dashboard →
          </a>
          {overview && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(overview.as_of).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Total Users" value={overview?.total_users ?? 0} accent="green" />
        <KpiCard label="Verified" value={overview?.verified_users ?? 0} accent="blue" sub={`${pct(overview?.verified_users, overview?.total_users)}%`} />
        <KpiCard label="DAU" value={overview?.dau ?? 0} sub="last 24h" />
        <KpiCard label="WAU" value={overview?.wau ?? 0} sub="last 7d" />
        <KpiCard label="MAU" value={overview?.mau ?? 0} sub="last 30d" />
        <KpiCard label="Signups (7d)" value={overview?.signups_7d ?? 0} accent="green" />
        <KpiCard label="Activation Rate" value={`${overview?.activation_rate ?? 0}%`} sub={`${overview?.activated_users ?? 0} active`} />
        <KpiCard label="Total Events" value={overview?.total_events ?? 0} sub="all time" />
      </div>

      {/* Retention */}
      {retention && (
        <Section title="Retention" subtitle="Users who returned after signing up">
          <div className="grid grid-cols-3 gap-3">
            {["d1", "d7", "d30"].map((k) => (
              <div key={k} className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4">
                <div className="text-xs uppercase text-gray-500 dark:text-gray-400 tracking-wide">{k.toUpperCase()} Retention</div>
                <div className="text-2xl font-bold text-gray-800 dark:text-gray-100 mt-1">{retention[k].rate}%</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{retention[k].retained} of {retention[k].eligible} eligible</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Signups timeline */}
      {signups.length > 0 && (
        <Section title="Signups (last 30 days)">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={signups}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="signups" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Vertical + currency breakdown side-by-side */}
      <div className="grid md:grid-cols-2 gap-4">
        {businessTypes.length > 0 && (
          <Section title="Business Types" subtitle="Vertical distribution (RQ2 fuel)">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={businessTypes} dataKey="count" nameKey="business_type" cx="50%" cy="50%" outerRadius={80} label>
                    {businessTypes.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Section>
        )}
        {currencies.length > 0 && (
          <Section title="Currency / Geography" subtitle="Proxy for market reach">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={currencies} dataKey="count" nameKey="currency" cx="50%" cy="50%" outerRadius={80} label>
                    {currencies.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Section>
        )}
      </div>

      {/* Feature usage */}
      {features.length > 0 && (
        <Section title="Feature usage (last 30 days)" subtitle="Most-visited pages across all users — your activation north stars">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={features.slice(0, 15)} layout="vertical" margin={{ left: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="page" tick={{ fontSize: 10 }} width={100} />
                <Tooltip />
                <Bar dataKey="total_views" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* User list */}
      <Section title="Users" subtitle={`${users.length} most recent`}>
        {/* Anti-spam control */}
        <SpamCleanupBar onCleaned={() => api.get("/admin/users", { params: { limit: 100 } }).then(r => setUsers(r.data))} />

        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm text-gray-900 dark:text-gray-100">
            <thead className="text-xs uppercase text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-2 py-2 w-6"></th>
                <th className="text-left px-2 py-2">Email</th>
                <th className="text-left px-2 py-2">Business</th>
                <th className="text-left px-2 py-2">Type</th>
                <th className="text-left px-2 py-2">Tier</th>
                <th className="text-right px-2 py-2">Sales</th>
                <th className="text-right px-2 py-2">Events</th>
                <th className="text-right px-2 py-2">Active days</th>
                <th className="text-left px-2 py-2">Last seen</th>
                <th className="text-left px-2 py-2">Joined</th>
                <th className="text-right px-2 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                // Online status from last_active timestamp
                const lastActive = u.last_active ? new Date(u.last_active) : null;
                const minsSince = lastActive ? (Date.now() - lastActive.getTime()) / 60000 : Infinity;
                let dotClass = "bg-gray-300 dark:bg-gray-600";  // offline / never
                let dotTitle = "Offline";
                if (minsSince < 5) { dotClass = "bg-emerald-500"; dotTitle = "Online (active in last 5 min)"; }
                else if (minsSince < 60) { dotClass = "bg-yellow-500"; dotTitle = "Recently active (within an hour)"; }
                else if (minsSince < 60 * 24) { dotClass = "bg-blue-400"; dotTitle = "Active today"; }
                return (
                  <tr key={u.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30 ${u.is_locked ? "bg-red-50/40 dark:bg-red-900/10" : ""}`}>
                    <td className="px-2 py-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} title={dotTitle} aria-label={dotTitle}></span>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">
                      {u.email}
                      {u.email_verified ? (
                        <span
                          className="ml-1 text-emerald-600 dark:text-emerald-400"
                          title="Email verified — completed the 6-digit code flow"
                          aria-label="verified"
                        >✓</span>
                      ) : (
                        <span
                          className="ml-1 text-red-500"
                          title="Email not verified — never completed the 6-digit code flow (likely bot/abandoned)"
                          aria-label="unverified"
                        >⚠</span>
                      )}
                      {u.role === "super_admin" && <span className="ml-1 text-purple-500" title="Super admin">🛡️</span>}
                      {u.is_locked && <span className="ml-1 px-1 bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded text-[10px] font-sans" title={u.locked_reason || "Account locked"}>🔒 LOCKED</span>}
                    </td>
                    <td className="px-2 py-2">{u.business_name || "—"}</td>
                    <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-300">{u.business_type}</td>
                    <td className="px-2 py-2"><TierChip user={u} /></td>
                    <td className="px-2 py-2 text-right font-mono">
                      {u.sale_count}
                      {u.is_activated && <span className="ml-1 text-emerald-600" title="Activated">✓</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">{u.event_count}</td>
                    <td className="px-2 py-2 text-right font-mono">{u.active_days}</td>
                    <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-300">{u.last_active ? relativeTime(u.last_active) : "never"}</td>
                    <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-300">{relativeTime(u.created_at)}</td>
                    <td className="px-2 py-2 text-right">
                      <LockToggle user={u} onChange={() => api.get("/admin/users", { params: { limit: 100 } }).then(r => setUsers(r.data))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Security audit log */}
      <Section title="🛡️ Security audit log" subtitle="Recent admin access attempts — successful and denied">
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-xs text-gray-900 dark:text-gray-100">
            <thead className="uppercase text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-2 py-2">When</th>
                <th className="text-left px-2 py-2">Event</th>
                <th className="text-left px-2 py-2">User</th>
                <th className="text-left px-2 py-2">IP</th>
                <th className="text-left px-2 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {securityEvents.map((s) => {
                const denied = s.event_type.startsWith("admin_denied");
                return (
                  <tr key={s.id} className={`border-b border-gray-100 dark:border-gray-800 ${denied ? "bg-red-50/40 dark:bg-red-900/10" : ""}`}>
                    <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">{relativeTime(s.created_at)}</td>
                    <td className="px-2 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${denied ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300" : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"}`}>
                        {s.event_type}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <UserIdResolver userId={s.user_id} userById={userById} />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-gray-600 dark:text-gray-300">{s.ip_address || "—"}</td>
                    <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">{s.detail || "—"}</td>
                  </tr>
                );
              })}
              {securityEvents.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-gray-500 dark:text-gray-400">No events recorded yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Recent server errors — Sentry alternative for solo-founder phase */}
      <Section title="🐛 Recent server errors" subtitle="Last 20 unhandled exceptions in the API. Empty = healthy.">
        {recentErrors.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-2">
            No errors logged. (Either all is well, or the migration just ran — refresh later.)
          </p>
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-xs text-gray-900 dark:text-gray-100">
              <thead className="uppercase text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="text-left px-2 py-2">When</th>
                  <th className="text-left px-2 py-2">Status</th>
                  <th className="text-left px-2 py-2">Method · Path</th>
                  <th className="text-left px-2 py-2">Type</th>
                  <th className="text-left px-2 py-2">Message</th>
                  <th className="text-left px-2 py-2">User · IP</th>
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 dark:border-gray-800 align-top">
                    <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      {e.created_at ? relativeTime(e.created_at) : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                        {e.status_code || "?"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-gray-700 dark:text-gray-300 truncate max-w-[260px]">
                      {e.method} {e.path}
                    </td>
                    <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">{e.error_type}</td>
                    <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300 truncate max-w-[280px]" title={e.message}>
                      {e.message}
                    </td>
                    <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      <UserIdResolver userId={e.user_id} userById={userById} />
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="font-mono">{e.ip_address || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ───── Helpers ───── */

/**
 * Renders a truncated 8-char user_id as a clickable chip that reveals the full
 * email + business name when expanded. Falls back to `/admin/users?search=<prefix>`
 * for ids outside the loaded paginated window.
 */
function UserIdResolver({ userId, userById }) {
  // ALL hooks must run on every render — keep them at the top, no early returns.
  const [expanded, setExpanded] = useState(false);
  const [resolved, setResolved] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const prefix = userId ? userId.slice(0, 8) : "";
  const cached = userId ? userById?.[userId] : null;
  const display = resolved || cached;

  const onClick = useCallback(async (e) => {
    e.stopPropagation();
    if (!userId) return;
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (cached || resolved) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get("/admin/users", { params: { search: prefix, limit: 5 } });
      const match = (r.data || []).find((u) => u.id === userId) || (r.data && r.data[0]);
      if (match) setResolved(match);
      else setError("not found");
    } catch (err) {
      setError(err.response?.status === 404 ? "denied" : "error");
    } finally {
      setLoading(false);
    }
  }, [expanded, cached, resolved, prefix, userId]);

  // Render-time guard — safe here because all hooks have already run.
  if (!userId) return <span className="text-gray-400">—</span>;

  return (
    <span className="inline-block">
      <button
        type="button"
        onClick={onClick}
        className="font-mono text-gray-600 dark:text-gray-300 hover:text-emerald-600 dark:hover:text-emerald-400 hover:underline cursor-pointer"
        title={expanded ? "Click to collapse" : "Click to resolve to email"}
      >
        {prefix}
      </button>
      {expanded && (
        <span className="ml-2 inline-flex items-center gap-1 text-xs">
          {loading && <span className="text-gray-400">resolving…</span>}
          {!loading && display && (
            <span className="px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded text-gray-700 dark:text-gray-300">
              {display.email}
              {display.business_name && <span className="text-emerald-600/70 dark:text-emerald-400/70"> · {display.business_name}</span>}
              {display.role === "super_admin" && <span title="Super admin" className="ml-1">🛡️</span>}
              {display.email_verified ? (
                <span title="Email verified" className="ml-1 text-gray-700 dark:text-gray-300">✓</span>
              ) : (
                <span title="Email not verified" className="ml-1 text-red-500">⚠</span>
              )}
            </span>
          )}
          {!loading && !display && error && (
            <span className="px-1.5 py-0.5 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-300">
              {error === "not found" ? "no match (likely deleted)" : error}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Lock/unlock toggle for a user row. Refuses to act on super_admin or self
 * (matches backend guard) by simply hiding for super_admin and showing a
 * disabled button if you somehow encounter your own row.
 */
function LockToggle({ user, onChange }) {
  const { user: me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Hide for super_admin rows entirely — can't lock those anyway.
  if (user.role === "super_admin") {
    return <span className="text-xs text-gray-400">—</span>;
  }
  // Don't show on own row (defensive — backend will also refuse)
  if (me && me.id === user.id) {
    return <span className="text-xs text-gray-400">self</span>;
  }

  async function toggle() {
    setErr(null);
    if (user.is_locked) {
      if (!window.confirm(`Unlock ${user.email}?\nThis re-enables login for this account.`)) return;
      setBusy(true);
      try {
        await api.post(`/admin/users/${user.id}/unlock`);
        onChange?.();
      } catch (e) {
        setErr(e.response?.data?.detail || "failed");
      } finally {
        setBusy(false);
      }
    } else {
      const reason = window.prompt(
        `Lock ${user.email}?\n\nThis will:\n• Invalidate their current session\n• Block all future logins\n• Audited via SecurityEvent\n\nReason (optional, max 255 chars):`,
        ""
      );
      if (reason === null) return; // user cancelled
      setBusy(true);
      try {
        await api.post(`/admin/users/${user.id}/lock`, { reason: (reason || "").slice(0, 255) });
        onChange?.();
      } catch (e) {
        setErr(e.response?.data?.detail || "failed");
      } finally {
        setBusy(false);
      }
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className={`px-2 py-0.5 rounded text-[11px] font-semibold transition ${
          user.is_locked
            ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800/50"
            : "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60"
        } ${busy ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
        title={user.is_locked ? "Click to unlock" : "Click to lock this account"}
      >
        {busy ? "…" : user.is_locked ? "Unlock" : "Lock"}
      </button>
      {err && <span className="text-[10px] text-red-500" title={err}>!</span>}
    </span>
  );
}

function TierChip({ user }) {
  // Tier display per user. effective_plan() resolves stored plan + active
  // trial server-side; we only render the chip + (for trial) the days-left
  // countdown. DK terminology lock — labels stay English here (admin-only
  // surface, not customer-facing UI chrome).
  const tier = (user.tier || "free").toLowerCase();
  const styles = {
    free:    { bg: "bg-gray-100 dark:bg-gray-800",       text: "text-gray-700 dark:text-gray-300",       label: "Free"    },
    trial:   { bg: "bg-amber-100 dark:bg-amber-900/40",  text: "text-amber-700 dark:text-amber-300",     label: "Trial"   },
    starter: { bg: "bg-blue-100 dark:bg-blue-900/40",    text: "text-blue-700 dark:text-blue-300",       label: "Starter" },
    pro:     { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-300", label: "Pro"  },
  };
  const s = styles[tier] || styles.free;
  // Trial countdown — show days remaining as a small companion line so
  // the admin can scan "trial expires soon" risk at a glance.
  let trialSub = null;
  if (tier === "trial" && user.trial_ends_at) {
    const endsAt = new Date(user.trial_ends_at);
    const days = Math.ceil((endsAt.getTime() - Date.now()) / 86400000);
    if (Number.isFinite(days)) trialSub = `${days}d`;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${s.bg} ${s.text}`}>{s.label}</span>
      {trialSub && <span className="text-[10px] text-gray-500 dark:text-gray-400">{trialSub}</span>}
    </span>
  );
}

function KpiCard({ label, value, sub, accent }) {
  // Per doctrine: tiles are neutral. Accent (dot/icon) carries signal, not the surface.
  const accentClass = "border-gray-100 dark:border-gray-700";
  return (
    <div className={`bg-white dark:bg-gray-900 ${accentClass} border rounded-xl p-3`}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400 font-medium">{label}</div>
      <div className="text-2xl font-bold text-gray-800 dark:text-gray-100 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-base sm:text-lg font-bold text-gray-800 dark:text-gray-100">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

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


/**
 * Spam-cleanup control bar.
 *   1. "Find spam" button → calls /admin/spam-candidates → shows count + preview
 *   2. "Clean N accounts" button (only if count > 0) → calls /admin/cleanup-spam?confirm=true
 *   3. After delete → green confirmation + refreshes user list
 *
 * Defense:
 *   • Two-step UX (preview before delete) — can't accidentally nuke users.
 *   • Backend filter requires `confirm=true` query param even when called.
 *   • Preview shows what WOULD be deleted so admin can sanity-check.
 */
function SpamCleanupBar({ onCleaned }) {
  const [candidates, setCandidates] = useState(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState(null);

  const findSpam = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await api.get("/admin/spam-candidates", { params: { min_age_days: 3 } });
      setCandidates(r.data);
      setConfirmOpen(false);
    } catch (e) {
      setResult({ error: e.response?.data?.detail || "Failed to scan" });
    }
    setLoading(false);
  };

  const cleanSpam = async () => {
    setLoading(true);
    try {
      const r = await api.post("/admin/cleanup-spam?confirm=true&min_age_days=3");
      setResult(r.data);
      setCandidates(null);
      setConfirmOpen(false);
      onCleaned?.();
    } catch (e) {
      setResult({ error: e.response?.data?.detail || "Cleanup failed" });
    }
    setLoading(false);
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-2 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40">
      <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">🧹 Spam cleanup</span>
      <button
        onClick={findSpam}
        disabled={loading}
        className="px-3 py-1 text-xs font-medium rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-900/60 disabled:opacity-50"
      >
        {loading ? "Scanning…" : "Find spam (unverified, no activity, ≥3 days old)"}
      </button>

      {candidates && (
        <>
          <span className="text-xs text-amber-700 dark:text-amber-400 font-medium">
            Found <b>{candidates.count}</b> spam candidates
          </span>
          {candidates.count > 0 && !confirmOpen && (
            <button
              onClick={() => setConfirmOpen(true)}
              className="px-3 py-1 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-700 text-white"
            >
              Clean {candidates.count} accounts
            </button>
          )}
          {confirmOpen && (
            <span className="flex items-center gap-2">
              <span className="text-xs text-red-700 dark:text-red-400 font-semibold">Confirm delete {candidates.count}?</span>
              <button
                onClick={cleanSpam}
                disabled={loading}
                className="px-3 py-1 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-3 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600"
              >
                Cancel
              </button>
            </span>
          )}
        </>
      )}

      {result?.deleted >= 0 && (
        <span className="text-xs text-gray-700 dark:text-gray-300 font-medium">
          ✓ Deleted {result.deleted} accounts. {result.skipped_with_data > 0 && `Skipped ${result.skipped_with_data} with data.`}
        </span>
      )}
      {result?.error && (
        <span className="text-xs text-red-700 dark:text-red-400">{result.error}</span>
      )}
    </div>
  );
}
