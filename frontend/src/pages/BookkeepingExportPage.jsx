import { useEffect, useState } from "react";
import api from "../services/api";
import { trackEvent } from "../hooks/useEventLog";

/**
 * Bookkeeping Export — push BonBox data into the user's existing
 * accounting platform (Dinero / Billy / e-conomic / generic CSV).
 *
 * This is the "complement, not replace" promise made real. The user's
 * accountant sees clean books in their familiar tool. BonBox stays as the
 * operations + AI layer above.
 *
 * No payment processing — the file is a CSV download, then the user runs
 * the CSV through their bookkeeping platform's importer.
 */
export default function BookkeepingExportPage() {
  const [formats, setFormats] = useState([]);
  const [selected, setSelected] = useState("dinero");
  const [start, setStart] = useState(() => {
    // Default: first day of last calendar month
    const today = new Date();
    const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 86400000);
    const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
    return lastMonthStart.toISOString().slice(0, 10);
  });
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [downloading, setDownloading] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get("/exports/formats").then((res) => setFormats(res.data || [])).catch(() => {});
  }, []);

  const currentFormat = formats.find((f) => f.id === selected);

  const handleDownload = async () => {
    setDownloading(true);
    setErr("");
    setMsg("");
    try {
      const res = await api.get(`/exports/${selected}`, {
        params: { start, end },
        responseType: "blob",
      });
      // Defense: backend may legitimately return JSON in a 200 if it has an
      // _error flag (e.g., empty range). Sniff the content-type before treating
      // as a CSV download.
      const ctype = res.headers?.["content-type"] || res.headers?.["Content-Type"] || "";
      if (ctype.includes("application/json")) {
        const text = await res.data.text();
        try {
          const json = JSON.parse(text);
          setErr(json?.detail || "Export returned no data.");
          return;
        } catch (_) {
          setErr("Unexpected response from the server.");
          return;
        }
      }
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `bonbox-${selected}-${start}-to-${end}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      trackEvent("bookkeeping_export", "exports", `${selected} ${start}..${end}`);
      setMsg(`Exported! Now open ${currentFormat?.label || selected} and import the file.`);
      setTimeout(() => setMsg(""), 6000);
    } catch (e) {
      // Backend now returns a structured 422 with detail when something fails
      // mid-export. The response body is a Blob (because we asked for one),
      // so read it as text to extract the helpful detail message.
      let detail = "";
      const blob = e?.response?.data;
      if (blob && typeof blob.text === "function") {
        try {
          const text = await blob.text();
          const json = JSON.parse(text);
          detail = json?.detail || "";
        } catch (_) {
          detail = "";
        }
      }
      setErr(detail || "Could not generate export — please try a different date range.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">Send to your accountant</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 max-w-xl">
        Export sales + expenses as a clean CSV that imports directly into Dinero,
        Billy, e-conomic, or any generic accounting tool. BonBox stays as your
        operational + AI layer; your accountant keeps using what they already know.
      </p>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-5 sm:p-6 mt-6 space-y-5">
        {/* Format picker */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Bookkeeping platform
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {formats.map((f) => (
              <button
                key={f.id}
                onClick={() => setSelected(f.id)}
                className={`px-3 py-3 rounded-xl text-sm font-medium border transition text-left
                  ${selected === f.id
                    ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-300 ring-1 ring-green-200/60"
                    : "bg-white dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">From</label>
            <input
              type="date"
              value={start}
              onChange={(e) => { setStart(e.target.value); setErr(""); setMsg(""); }}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">To</label>
            <input
              type="date"
              value={end}
              onChange={(e) => { setEnd(e.target.value); setErr(""); setMsg(""); }}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200"
            />
          </div>
        </div>

        {/* Quick range chips */}
        <div className="flex flex-wrap gap-2">
          {[
            { label: "This month", days: 0, fromFirstOfMonth: true },
            { label: "Last month", days: -30, fromFirstOfMonth: true, lastMonth: true },
            { label: "Last 7 days", days: 7 },
            { label: "This quarter", days: 90 },
            { label: "Year to date", days: 0, fromYearStart: true },
          ].map((r) => (
            <button
              key={r.label}
              onClick={() => {
                const today = new Date();
                let s, e;
                if (r.fromYearStart) {
                  s = new Date(today.getFullYear(), 0, 1);
                  e = today;
                } else if (r.lastMonth) {
                  const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
                  e = new Date(firstOfThisMonth.getTime() - 86400000);
                  s = new Date(e.getFullYear(), e.getMonth(), 1);
                } else if (r.fromFirstOfMonth) {
                  s = new Date(today.getFullYear(), today.getMonth(), 1);
                  e = today;
                } else {
                  s = new Date(today.getTime() - r.days * 86400000);
                  e = today;
                }
                setStart(s.toISOString().slice(0, 10));
                setEnd(e.toISOString().slice(0, 10));
                // Clear stale error/success when user picks a new range so the
                // previous "Could not generate export" doesn't linger.
                setErr("");
                setMsg("");
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Instructions for the selected format */}
        {currentFormat?.instructions && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-3.5">
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wide mb-1">
              How to import
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200 leading-relaxed">
              {currentFormat.instructions.split("→").map((part, i, arr) => (
                <span key={i}>
                  {part}
                  {i < arr.length - 1 && (
                    <strong className="font-bold text-blue-900 dark:text-blue-100 mx-0.5">→</strong>
                  )}
                </span>
              ))}
            </p>
          </div>
        )}

        {/* Action */}
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            File: <span className="font-mono">bonbox-{selected}-{start}-to-{end}.csv</span>
          </div>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg shadow-sm transition"
          >
            {downloading ? "Generating…" : "Download CSV"}
          </button>
        </div>

        {msg && (
          <p className="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">{msg}</p>
        )}
        {err && (
          <p className="text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{err}</p>
        )}
      </div>

      {/* Reassurance */}
      <div className="mt-6 grid sm:grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="text-xl mb-1">🔒</div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">Returns excluded</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Returned sales aren't double-counted.</div>
        </div>
        <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="text-xl mb-1">📊</div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">VAT-aware</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">25% Moms by default; tax-exempt items marked correctly.</div>
        </div>
        <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="text-xl mb-1">📁</div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">UTF-8 with BOM</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Opens cleanly in Excel + Google Sheets.</div>
        </div>
      </div>

      {/* Trademark notice — referenced platform names belong to their owners */}
      <p className="mt-6 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed">
        Dinero, Billy, and e-conomic are trademarks of their respective owners.
        BonBox is not affiliated with or endorsed by any of these companies.
        We provide CSV exports as an interoperability convenience for our users.
      </p>
    </div>
  );
}
