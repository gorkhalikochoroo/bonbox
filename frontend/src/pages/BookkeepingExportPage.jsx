// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useEffect, useState } from "react";
import api from "../services/api";
import { trackEvent } from "../hooks/useEventLog";
import { useEntitlements } from "../hooks/useEntitlements";
import { sendBundleToAccountant } from "../utils/shareDailyCloseRange";
import { localIso } from "../utils/dateFormat";
import { PageHeader, Button, SectionBanner, Icon, UpgradeNudge } from "../components/ui";

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
  // S8 — Starter+ entitlement. Backend returns a structured 402 on the
  // /api/exports/{format_id} download endpoint; we additionally render
  // a calm UpgradeNudge for Free users so they don't have to wait for
  // the 402 to discover the gate. The /formats listing endpoint is
  // unchanged (no PII) so the picker can still preview what's available.
  const { hasFeature, loading: entLoading } = useEntitlements();
  const exportsUnlocked = hasFeature("custom_export_templates");

  const [formats, setFormats] = useState([]);
  const [selected, setSelected] = useState("dinero");
  const [start, setStart] = useState(() => {
    // Default: first day of last calendar month
    const today = new Date();
    const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 86400000);
    const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
    return localIso(lastMonthStart);
  });
  const [end, setEnd] = useState(() => localIso());
  const [downloading, setDownloading] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  // Needed by the "Send to revisor" button — accountant email + business
  // name come from the user's saved profile.
  const [businessProfile, setBusinessProfile] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    api.get("/exports/formats").then((res) => setFormats(res.data || [])).catch(() => {});
    api.get("/business").then((res) => setBusinessProfile(res.data)).catch(() => {});
    api.get("/auth/me").then((res) => setUser(res.data)).catch(() => {});
    // Allow the dashboard banner (or a deep link) to pre-select a format
    // via ?format=bundle. Falls back silently if the value isn't a real
    // format ID.
    try {
      const params = new URLSearchParams(window.location.search);
      const fmt = params.get("format");
      if (fmt) setSelected(fmt);
    } catch {
      /* ignore — no window, no preselection */
    }
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
      // Use the format's own extension (CSV for most, ZIP for the bundle).
      const ext = currentFormat?.ext || "csv";
      a.download = `bonbox-${selected}-${start}-to-${end}.${ext}`;
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

  /** Send the current export to the saved revisor — share sheet on mobile,
   * download + mailto on desktop. Three paths handled by the share helper.
   *
   * Distinct from handleDownload: this one also opens an email window
   * pre-filled with the revisor's address and a Danish-language body
   * explaining what's in the file. The bundle format is the obvious target
   * here, but the button works for any format.
   */
  const handleSend = async () => {
    setSending(true);
    setErr("");
    setMsg("");
    try {
      const res = await api.get(`/exports/${selected}`, {
        params: { start, end },
        responseType: "blob",
      });
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
      const ext = currentFormat?.ext || "csv";
      const mime = ext === "zip" ? "application/zip" : "text/csv";
      const blob = new Blob([res.data], { type: mime });
      const filename = `bonbox-${selected}-${start}-to-${end}.${ext}`;
      // Use Danish for the email body when the user's language is Danish
      // (default for DK accounts) — revisors are nearly always Danish-speaking.
      const lang = (user?.language === "en") ? "en" : "da";

      const result = await sendBundleToAccountant({
        blob,
        filename,
        accountantEmail: businessProfile?.accountant_email || "",
        accountantName: businessProfile?.accountant_name || "",
        businessName: user?.business_name || businessProfile?.company_name || "",
        fromIso: start,
        toIso: end,
        language: lang,
      });

      trackEvent("bookkeeping_export_send", "exports", `${selected} ${start}..${end} via ${result.channel || "?"}`);

      if (result.ok) {
        if (result.channel === "share") {
          setMsg("Share sheet opened — pick Mail / WhatsApp.");
        } else if (result.channel === "mailto") {
          setMsg(
            businessProfile?.accountant_email
              ? "Email opened — attach the downloaded file and send."
              : "Email opened — add revisor's address on Profile to skip typing it next time.",
          );
        } else {
          setMsg("Downloaded — attach manually to email.");
        }
        setTimeout(() => setMsg(""), 6000);
      } else {
        setErr(result.reason || "Could not open the share. Try the Download button instead.");
        setTimeout(() => setErr(""), 5000);
      }
    } catch (e) {
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
      setErr(detail || "Could not send — please try a different date range.");
    } finally {
      setSending(false);
    }
  };

  // S8 — Free-tier UpgradeNudge fallback. Renders before the form so a
  // Free user sees the upgrade story instead of getting a 402 mid-click.
  // Backend still enforces; this is the calm UX layer.
  if (!entLoading && !exportsUnlocked) {
    return (
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto">
        <PageHeader
          eyebrow="REPORTS"
          title="Send to your accountant"
          subtitle="Clean CSVs for Dinero, Billy, e-conomic, or generic — built so your accountant imports in one click."
        />
        <UpgradeNudge
          intent="card"
          tier="starter"
          benefit="Export to Dinero / Billy / e-conomic / generic CSV — your accountant imports without re-typing a number."
          ctaLabel="See plans"
        />
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto">
      <PageHeader
        eyebrow="REPORTS"
        title="Send to your accountant"
        subtitle="Export sales + expenses as a clean CSV that imports directly into Dinero, Billy, e-conomic, or any generic accounting tool. BonBox stays as your operational + AI layer; your accountant keeps using what they already know."
      />

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 sm:p-6 space-y-5">
        {/* Format picker */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Bookkeeping platform
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {formats.map((f) => {
              const isBundle = f.id === "bundle";
              const active = selected === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setSelected(f.id)}
                  className={`relative px-3 py-3 rounded-xl text-sm font-medium border transition text-left
                    ${active
                      ? (isBundle
                          ? "bg-emerald-50 dark:bg-emerald-900/30 border-emerald-400 dark:border-emerald-600 text-emerald-800 dark:text-emerald-200 ring-2 ring-emerald-300/60"
                          : "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-300 ring-1 ring-green-200/60")
                      : (isBundle
                          ? "bg-emerald-50/40 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/50 text-gray-800 dark:text-gray-200 hover:bg-emerald-50/70"
                          : "bg-white dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700")}`}
                >
                  {isBundle && (
                    <span className="absolute -top-2 -right-2 bg-emerald-600 text-white text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded">
                      ★ Recommended
                    </span>
                  )}
                  {f.label}
                </button>
              );
            })}
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
                setStart(localIso(s));
                setEnd(localIso(e));
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
          <SectionBanner severity="info" title="How to import">
            <p className="leading-relaxed">
              {currentFormat.instructions.split("→").map((part, i, arr) => (
                <span key={i}>
                  {part}
                  {i < arr.length - 1 && (
                    <strong className="font-bold text-gray-900 dark:text-gray-100 text-base mx-1.5">➜</strong>
                  )}
                </span>
              ))}
            </p>
          </SectionBanner>
        )}

        {/* Action */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            File: <span className="font-mono">bonbox-{selected}-{start}-to-{end}.{currentFormat?.ext || "csv"}</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <Button
              variant="secondary"
              onClick={handleDownload}
              disabled={downloading || sending}
              busy={downloading}
            >
              {downloading ? "Generating…" : `Download ${(currentFormat?.ext || "csv").toUpperCase()}`}
            </Button>
            <Button
              variant="accent"
              onClick={handleSend}
              disabled={downloading || sending}
              busy={sending}
              iconLeft={!sending && <Icon name="Send" size={14} />}
              title={
                businessProfile?.accountant_email
                  ? `Email to ${businessProfile.accountant_email}`
                  : "Set revisor's email on Profile to skip typing it"
              }
            >
              {sending ? "Sending…" : "Send to revisor"}
            </Button>
          </div>
        </div>
        {!businessProfile?.accountant_email && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 -mt-2">
            Tip: <a href="/profile" className="text-emerald-700 dark:text-emerald-400 hover:underline font-medium">save your revisor's email on Profile</a> to skip typing it every month.
          </p>
        )}

        {msg && (
          <SectionBanner severity="success" title={msg} />
        )}
        {err && (
          <SectionBanner severity="critical" title={err} />
        )}
      </div>

      {/* Reassurance */}
      <div className="mt-6 grid sm:grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <Icon name="Lock" size={20} className="text-gray-500 mb-1" />
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Returns excluded</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Returned sales aren't double-counted.</div>
        </div>
        <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <Icon name="BarChart3" size={20} className="text-gray-500 mb-1" />
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">MOMS-aware</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">25% MOMS by default; tax-exempt items marked correctly.</div>
        </div>
        <div className="bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <Icon name="FileText" size={20} className="text-gray-500 mb-1" />
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">UTF-8 with BOM</div>
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
