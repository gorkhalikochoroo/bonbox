import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { FadeIn } from "../components/AnimationKit";

/**
 * Admin Training dashboard — founder visibility into the kasserapport
 * learning loop. Consumes the 5 super-admin endpoints shipped in 6a59da1:
 *
 *   GET  /api/admin/training/drift               — per-POS confidence drift
 *   GET  /api/admin/training/recent-examples     — recently auto-promoted scans
 *   GET  /api/admin/training/extraction-stats    — cross-user KPIs per POS
 *   POST /api/admin/training/run-drift-now       — trigger drift sweep
 *   POST /api/admin/training/run-pattern-sweep-now — trigger pattern sweep
 *
 * No customer data shown — aggregate stats only. Per-extraction examples
 * link back to extraction_id but the JSON shown is the user-corrected
 * `truth_json`, not raw OCR text (which could contain PII like staff
 * names from kasserapports).
 *
 * Use during the weekly admin triage Manoj plans for Sunday mornings:
 *   1. Glance drift row — anything red/amber means a POS changed format
 *   2. Skim recent examples — spot bad auto-promotions (the validator
 *      missed something)
 *   3. Check stats — %user_corrected trending DOWN means the loop
 *      is working
 *   4. If a prompt was changed mid-week, hit "Run drift now" for
 *      immediate feedback
 */

// Drift signal severity buckets
function severityFor(signal) {
  if (!signal || !signal.signal) return "ok";
  const drop = Number(signal.signal.drop || 0);
  if (drop >= 0.10) return "red";
  if (drop >= 0.05) return "amber";
  return "amber"; // any signal at all means above-threshold drift
}


export default function AdminTrainingPage() {
  const [drift, setDrift] = useState(null);
  const [stats, setStats] = useState(null);
  const [examples, setExamples] = useState([]);
  const [examplesLoading, setExamplesLoading] = useState(false);
  const [examplesPosFilter, setExamplesPosFilter] = useState("");
  const [statsDays, setStatsDays] = useState(30);
  const [running, setRunning] = useState(null); // null | "drift" | "patterns"
  const [runResult, setRunResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { void Promise.all([fetchDrift(), fetchStats(30), fetchExamples()]); }, []);
  useEffect(() => { void fetchStats(statsDays); }, [statsDays]);
  useEffect(() => { void fetchExamples(examplesPosFilter); }, [examplesPosFilter]);

  async function fetchDrift() {
    try {
      const res = await api.get("/admin/training/drift");
      setDrift(res.data);
      setError("");
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load drift signals");
    }
  }

  async function fetchStats(days) {
    try {
      const res = await api.get(`/admin/training/extraction-stats?days=${days}`);
      setStats(res.data);
    } catch {
      setStats(null);
    }
  }

  async function fetchExamples(posFilter = "") {
    setExamplesLoading(true);
    try {
      const url = posFilter
        ? `/admin/training/recent-examples?limit=20&pos_system=${encodeURIComponent(posFilter)}`
        : "/admin/training/recent-examples?limit=20";
      const res = await api.get(url);
      setExamples(Array.isArray(res.data) ? res.data : []);
    } catch {
      setExamples([]);
    } finally {
      setExamplesLoading(false);
    }
  }

  async function runDriftNow() {
    setRunning("drift");
    setRunResult(null);
    try {
      const res = await api.post("/admin/training/run-drift-now");
      setRunResult({ kind: "drift", data: res.data });
      await fetchDrift();
    } catch (e) {
      setRunResult({ kind: "error", message: e?.response?.data?.detail || "Failed" });
    } finally {
      setRunning(null);
    }
  }

  async function runPatternsNow() {
    setRunning("patterns");
    setRunResult(null);
    try {
      const res = await api.post("/admin/training/run-pattern-sweep-now");
      setRunResult({ kind: "patterns", data: res.data });
    } catch (e) {
      setRunResult({ kind: "error", message: e?.response?.data?.detail || "Failed" });
    } finally {
      setRunning(null);
    }
  }

  const posSystemsInUse = useMemo(() => {
    const set = new Set();
    if (drift?.systems) drift.systems.forEach((s) => set.add(s.pos_system));
    if (stats?.by_pos) stats.by_pos.forEach((s) => set.add(s.pos_system));
    return Array.from(set).sort();
  }, [drift, stats]);

  return (
    <div className="px-4 sm:px-6 py-6 max-w-5xl mx-auto">
      <FadeIn>
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            🧠 Kasserapport learning
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            Founder dashboard for the auto-improving OCR loop. Drift, stats,
            and recent auto-promoted examples — your weekly Sunday triage view.
          </p>
        </div>
      </FadeIn>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* ─── Drift status ───────────────────────────────────── */}
      <FadeIn>
        <section className="mb-6 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
          <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                Drift monitor
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Per-POS extraction-confidence trend. Cron runs daily 03:00 UTC.
              </p>
            </div>
            <button
              onClick={runDriftNow}
              disabled={running === "drift"}
              className="px-3 py-1.5 text-xs font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg disabled:opacity-50"
            >
              {running === "drift" ? "Running…" : "Run drift now"}
            </button>
          </div>

          {!drift ? (
            <div className="text-sm text-gray-400">Loading…</div>
          ) : (
            <div className="space-y-2">
              {drift.systems.map((row) => (
                <DriftRow key={row.pos_system} row={row} severity={severityFor(row)} />
              ))}
              {drift.systems.length === 0 && (
                <div className="text-sm text-gray-400">No POS systems known yet</div>
              )}
            </div>
          )}

          <div className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
            Last checked: {drift?.checked_at ? new Date(drift.checked_at).toLocaleString() : "—"}
          </div>
        </section>
      </FadeIn>

      {/* ─── Extraction stats ──────────────────────────────── */}
      <FadeIn delay={0.05}>
        <section className="mb-6 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
          <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                Extraction stats
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                %user_corrected trending DOWN over time = learning loop working.
              </p>
            </div>
            <select
              value={statsDays}
              onChange={(e) => setStatsDays(Number(e.target.value))}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
            </select>
          </div>

          {!stats ? (
            <div className="text-sm text-gray-400">Loading…</div>
          ) : stats.by_pos.length === 0 ? (
            <div className="text-sm text-gray-400">
              No extractions in the last {statsDays} days
            </div>
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                    <th className="px-2 py-2">POS</th>
                    <th className="px-2 py-2 text-right">Scans</th>
                    <th className="px-2 py-2 text-right">Avg conf</th>
                    <th className="px-2 py-2 text-right">% flagged</th>
                    <th className="px-2 py-2 text-right">% corrected</th>
                    <th className="px-2 py-2 text-right">Tokens (in/out)</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_pos.map((row) => (
                    <tr key={row.pos_system} className="border-t border-gray-100 dark:border-gray-700/50">
                      <td className="px-2 py-2 font-semibold">{row.pos_system}</td>
                      <td className="px-2 py-2 text-right">{row.total_scans}</td>
                      <td className="px-2 py-2 text-right font-mono">{row.avg_confidence.toFixed(2)}</td>
                      <td className={`px-2 py-2 text-right font-mono ${row.pct_flagged_manual_review > 30 ? "text-amber-600" : ""}`}>
                        {row.pct_flagged_manual_review}%
                      </td>
                      <td className={`px-2 py-2 text-right font-mono ${row.pct_user_corrected > 30 ? "text-amber-600" : "text-green-600"}`}>
                        {row.pct_user_corrected}%
                      </td>
                      <td className="px-2 py-2 text-right text-gray-400 font-mono text-[11px]">
                        {row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </FadeIn>

      {/* ─── Pattern sweep trigger ─────────────────────────── */}
      <FadeIn delay={0.1}>
        <section className="mb-6 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                Correction-pattern sweep
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-md">
                Walks the last 30 days of user corrections per POS, classifies systematic patterns
                (sign-flip, scale, rounding). Cron runs Sunday 03:30 UTC.
              </p>
            </div>
            <button
              onClick={runPatternsNow}
              disabled={running === "patterns"}
              className="px-3 py-1.5 text-xs font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg disabled:opacity-50"
            >
              {running === "patterns" ? "Running…" : "Run pattern sweep now"}
            </button>
          </div>

          {runResult?.kind === "patterns" && (
            <div className="mt-4 px-3 py-2 bg-gray-50 dark:bg-gray-900/40 rounded-lg text-xs">
              <div className="font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sweep complete: {runResult.data.users_swept} users, {runResult.data.patterns_found} patterns
              </div>
              {(runResult.data.patterns || []).slice(0, 10).map((p, i) => (
                <div key={i} className="py-1 border-t border-gray-100 dark:border-gray-700/40 first:border-0">
                  <span className="font-mono text-[11px]">{p.pos_system}</span>
                  {" · "}
                  <span className="text-gray-600 dark:text-gray-400">{p.field_path}</span>
                  {" · "}
                  <span className="font-semibold">{p.direction}</span>
                  {" · "}
                  <span className="text-gray-400">×{p.count}</span>
                </div>
              ))}
              {(runResult.data.patterns || []).length === 0 && (
                <div className="text-gray-400">No patterns detected — clean week.</div>
              )}
            </div>
          )}
          {runResult?.kind === "drift" && (
            <div className="mt-4 px-3 py-2 bg-gray-50 dark:bg-gray-900/40 rounded-lg text-xs">
              <div className="font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sweep complete: {runResult.data.systems_checked} systems, {runResult.data.drifts_detected} drifts
              </div>
              {(runResult.data.alerts || []).map((a, i) => (
                <div key={i} className="py-1 border-t border-gray-100 dark:border-gray-700/40 first:border-0">
                  <span className="font-mono text-[11px] font-bold">{a.pos_system}</span>
                  {" · "}
                  <span className="text-amber-600">{a.alert}</span>
                </div>
              ))}
            </div>
          )}
          {runResult?.kind === "error" && (
            <div className="mt-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-xs">
              {runResult.message}
            </div>
          )}
        </section>
      </FadeIn>

      {/* ─── Recent examples ───────────────────────────────── */}
      <FadeIn delay={0.15}>
        <section className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
          <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                Recently auto-promoted examples
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-md">
                High-confidence scans the validator passed and the owner committed without edits.
                These get injected as few-shot in their next scan.
              </p>
            </div>
            <select
              value={examplesPosFilter}
              onChange={(e) => setExamplesPosFilter(e.target.value)}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700"
            >
              <option value="">All POS</option>
              {posSystemsInUse.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {examplesLoading ? (
            <div className="text-sm text-gray-400">Loading…</div>
          ) : examples.length === 0 ? (
            <div className="text-sm text-gray-400">
              No auto-promoted examples yet
              {examplesPosFilter ? ` for ${examplesPosFilter}` : ""}.
            </div>
          ) : (
            <div className="space-y-2">
              {examples.map((ex) => (
                <ExampleRow key={ex.id} example={ex} />
              ))}
            </div>
          )}
        </section>
      </FadeIn>
    </div>
  );
}


/* ─── Sub-components ─────────────────────────────────────────────────── */

function DriftRow({ row, severity }) {
  const palette = {
    ok:    { bg: "bg-green-50 dark:bg-green-900/20", text: "text-green-700 dark:text-green-300", label: "OK" },
    amber: { bg: "bg-amber-50 dark:bg-amber-900/20", text: "text-amber-700 dark:text-amber-300", label: "Drifting" },
    red:   { bg: "bg-red-50 dark:bg-red-900/20",     text: "text-red-700 dark:text-red-300",     label: "Refresh" },
  }[severity];
  return (
    <div className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg ${palette.bg}`}>
      <div className="flex items-center gap-3">
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${palette.text}`}>
          {palette.label}
        </span>
        <span className="text-sm font-semibold text-gray-800 dark:text-white">
          {row.pos_system}
        </span>
      </div>
      {row.signal ? (
        <div className="text-[11px] text-gray-600 dark:text-gray-300 font-mono text-right">
          {row.signal.baseline_confidence.toFixed(2)} → {row.signal.recent_confidence.toFixed(2)}
          <span className="text-amber-600 dark:text-amber-400 ml-2">
            ↓{(row.signal.drop * 100).toFixed(1)}pp
          </span>
        </div>
      ) : (
        <div className="text-[11px] text-gray-400 dark:text-gray-500">— no drift —</div>
      )}
    </div>
  );
}


function ExampleRow({ example }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-gray-100 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30 transition"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
            {example.pos_system}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {example.notes || "—"}
          </span>
        </div>
        <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
          {example.created_at ? new Date(example.created_at).toLocaleDateString() : "—"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
          <div className="px-3 py-2 text-[10px] text-gray-400 dark:text-gray-500 flex items-center justify-between flex-wrap gap-2">
            <span>example_id: {example.id}</span>
            {example.promoted_from_extraction_id && (
              <span>extraction: {example.promoted_from_extraction_id}</span>
            )}
          </div>
          <pre className="px-3 py-2 text-[11px] font-mono text-gray-700 dark:text-gray-300 max-h-64 overflow-y-auto whitespace-pre-wrap">
            {JSON.stringify(example.truth_json || {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
