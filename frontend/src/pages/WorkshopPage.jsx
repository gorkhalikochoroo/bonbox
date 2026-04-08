import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

const STATUS_FLOW = ["received", "diagnosing", "waiting_parts", "in_progress", "completed", "delivered", "invoiced"];
const STATUS_COLORS = {
  received: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  diagnosing: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  waiting_parts: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  in_progress: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  delivered: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  invoiced: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
};
const STATUS_LABELS = {
  received: "Received", diagnosing: "Diagnosing", waiting_parts: "Waiting Parts",
  in_progress: "In Progress", completed: "Completed", delivered: "Delivered", invoiced: "Invoiced",
};

export default function WorkshopPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const nav = useNavigate();
  const currency = displayCurrency(user?.currency);

  const [tab, setTab] = useState("board"); // board | jobs | mechanics
  const [summary, setSummary] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [mechanics, setMechanics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get("/workshop/summary").then(r => setSummary(r.data)).catch(() => {}),
      api.get("/workshop/jobs").then(r => setJobs(r.data)).catch(() => {}),
      api.get("/workshop/mechanics").then(r => setMechanics(r.data)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center text-gray-400">{t("loading") || "Loading..."}</div>;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold dark:text-white">🔧 {t("workshop") || "Workshop"}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Job cards, vehicles, mechanics</p>
          </div>
          <button onClick={() => nav("/workshop/new-job")}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold text-sm transition">
            + New Job
          </button>
        </div>
      </FadeIn>

      {/* KPI Cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard icon="🚗" label="In Workshop" value={summary.vehicles_in_workshop}
            sub={Object.entries(summary.status_breakdown || {}).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")} />
          <KpiCard icon="💰" label="Week Revenue" value={`${summary.week_revenue?.toLocaleString()} ${currency}`} />
          <KpiCard icon="📊" label="Avg Job Value" value={`${summary.avg_job_value?.toLocaleString()} ${currency}`} />
          <KpiCard icon="⏱️" label="Avg Turnaround" value={summary.avg_turnaround_days ? `${summary.avg_turnaround_days}d` : "—"} />
        </div>
      )}

      {/* Alerts */}
      {summary?.alerts?.length > 0 && (
        <div className="space-y-2">
          {summary.alerts.map((a, i) => (
            <div key={i} className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {a.icon} {a.title}
            </div>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        {[
          { id: "board", label: "Job Board", icon: "📋" },
          { id: "jobs", label: "All Jobs", icon: "📑" },
          { id: "mechanics", label: "Mechanics", icon: "👨‍🔧" },
        ].map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
              tab === tb.id ? "bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"
                : "text-gray-500 dark:text-gray-400"
            }`}>
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {tab === "board" && <JobBoard jobs={jobs} currency={currency} nav={nav} />}
      {tab === "jobs" && <JobList jobs={jobs} currency={currency} nav={nav} />}
      {tab === "mechanics" && <MechanicView data={mechanics} currency={currency} />}
    </div>
  );
}

function KpiCard({ icon, label, value, sub }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
      <p className="text-xs text-gray-500 dark:text-gray-400">{icon} {label}</p>
      <p className="text-xl font-bold mt-1 dark:text-white">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   JOB BOARD — kanban-style columns per status
   ═══════════════════════════════════════════════════════════ */
function JobBoard({ jobs, currency, nav }) {
  const activeStatuses = STATUS_FLOW.filter(s => s !== "invoiced");
  const byStatus = {};
  activeStatuses.forEach(s => { byStatus[s] = []; });
  jobs.forEach(j => { if (byStatus[j.status]) byStatus[j.status].push(j); });

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex gap-3 min-w-[900px]">
        {activeStatuses.map(status => (
          <div key={status} className="flex-1 min-w-[160px]">
            <div className={`text-xs font-bold uppercase px-2 py-1.5 rounded-t-lg ${STATUS_COLORS[status]}`}>
              {STATUS_LABELS[status]} ({byStatus[status].length})
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/50 rounded-b-lg p-2 space-y-2 min-h-[120px]">
              {byStatus[status].map(j => (
                <div key={j.id} onClick={() => nav(`/workshop/job/${j.id}`)}
                  className="bg-white dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700 cursor-pointer hover:shadow-md transition text-xs">
                  <p className="font-bold text-blue-600 dark:text-blue-400">{j.job_number}</p>
                  <p className="font-semibold dark:text-white mt-0.5">{j.vehicle?.plate_number}</p>
                  <p className="text-gray-500 dark:text-gray-400">{j.vehicle?.make} {j.vehicle?.model}</p>
                  {j.vehicle?.customer_name && <p className="text-gray-400 truncate">{j.vehicle.customer_name}</p>}
                  {j.assigned_mechanic && <p className="text-gray-400">🔧 {j.assigned_mechanic}</p>}
                  {j.received_date && (
                    <p className="text-gray-400 mt-1">
                      {Math.max(0, Math.round((Date.now() - new Date(j.received_date).getTime()) / 86400000))}d ago
                    </p>
                  )}
                </div>
              ))}
              {byStatus[status].length === 0 && (
                <p className="text-xs text-gray-300 dark:text-gray-600 text-center py-4">Empty</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   JOB LIST — mobile-friendly card view
   ═══════════════════════════════════════════════════════════ */
function JobList({ jobs, currency, nav }) {
  if (!jobs.length) {
    return <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border dark:border-gray-700">
      <p className="text-4xl mb-3">🔧</p>
      <p className="font-semibold dark:text-white">No job cards yet</p>
      <p className="text-sm text-gray-400 mt-1">Create your first job card to get started.</p>
    </div>;
  }

  return (
    <div className="space-y-3">
      {jobs.map(j => (
        <div key={j.id} onClick={() => nav(`/workshop/job/${j.id}`)}
          className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700 shadow-sm cursor-pointer hover:shadow-md transition">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-blue-600 dark:text-blue-400 text-sm">{j.job_number}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[j.status]}`}>
                  {STATUS_LABELS[j.status]}
                </span>
              </div>
              <p className="font-semibold dark:text-white mt-1">{j.vehicle?.plate_number} — {j.vehicle?.make} {j.vehicle?.model}</p>
              {j.vehicle?.customer_name && <p className="text-sm text-gray-500 dark:text-gray-400">{j.vehicle.customer_name}</p>}
            </div>
            <div className="text-right">
              {j.grand_total > 0 && <p className="font-bold text-green-600 dark:text-green-400">{j.grand_total?.toLocaleString()} {currency}</p>}
              {j.assigned_mechanic && <p className="text-xs text-gray-400">🔧 {j.assigned_mechanic}</p>}
            </div>
          </div>
          {j.complaint_description && (
            <p className="text-xs text-gray-400 mt-2 line-clamp-1">{j.complaint_description}</p>
          )}
        </div>
      ))}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MECHANIC LEADERBOARD
   ═══════════════════════════════════════════════════════════ */
function MechanicView({ data, currency }) {
  if (!data?.mechanics?.length) {
    return <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border dark:border-gray-700">
      <p className="text-4xl mb-3">👨‍🔧</p>
      <p className="font-semibold dark:text-white">No mechanic data yet</p>
      <p className="text-sm text-gray-400 mt-1">Add labor entries to job cards to see mechanic performance.</p>
    </div>;
  }

  const maxRevenue = Math.max(...data.mechanics.map(m => m.total_revenue));

  return (
    <div className="space-y-4">
      {data.insight && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-xl p-4 text-sm text-blue-700 dark:text-blue-300">
          💡 {data.insight}
        </div>
      )}

      {data.mechanics.map((m, i) => (
        <div key={m.name} className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold dark:text-white">#{i + 1}</span>
              <span className="font-semibold dark:text-white">{m.name}</span>
            </div>
            <span className="font-bold text-green-600 dark:text-green-400">{m.total_revenue.toLocaleString()} {currency}</span>
          </div>
          {/* Revenue bar */}
          <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2 mb-3">
            <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${(m.total_revenue / maxRevenue) * 100}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs text-gray-500 dark:text-gray-400">
            <div><span className="font-medium dark:text-gray-300">{m.total_jobs}</span> jobs</div>
            <div><span className="font-medium dark:text-gray-300">{m.total_hours}h</span> total</div>
            <div><span className="font-medium dark:text-gray-300">{m.revenue_per_hour.toLocaleString()}</span> {currency}/hr</div>
          </div>
        </div>
      ))}
    </div>
  );
}
