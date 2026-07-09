import { useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useEntitlements } from "../hooks/useEntitlements";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import SmartTerminalsCard from "../components/SmartTerminalsCard";
import { UpgradeNudge } from "../components/ui";
import {
  buildShareMessage,
  buildShareTitle,
  formatDanishDateLabel,
  shareCloseSummary,
} from "../utils/shareClose";
import { localIso } from "../utils/dateFormat";

/**
 * Multi-terminal daily close — Mirabelle-format flow.
 *
 *   Step 1 — Scan kasserapport for each terminal (in display_order)
 *   Step 2 — Manual entry: cash counted, MobilePay, gift cards, POS sales
 *   Step 3 — Review: aggregated payload in Mirabelle Excel row order,
 *            cash difference auto-flagged
 *   Step 4 — Send: commits each extraction + creates the close
 *
 * Designed to feel like Caro working the till at midnight: scan, scan,
 * scan, type one cash number, hit send. Should clock under 2 minutes
 * with practice — that's the 90-second close goal Manoj specced.
 */

const _STEPS = ["scan", "manual", "review", "done"];


export default function MultiTerminalClosePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { hasFeature, loading: entLoading } = useEntitlements();
  const currency = displayCurrency(user?.currency);
  // P5 — entitlement gate. The aggregate / close-pdf / close-excel
  // endpoints already return 402 for non-Pro plans, but checking here
  // saves the user a 402 round-trip and renders a calm UpgradeNudge
  // instead of an inline error after they've started scanning.
  const isUnlocked = hasFeature("multi_terminal_close");

  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState("scan");
  const [scans, setScans] = useState({}); // terminal_id → extraction record
  const [manual, setManual] = useState({
    cash_closing: "",
    mobilepay_total: "",
    gift_cards_total: "",
    sales_pos: "",
    closed_by: user?.full_name || user?.email || "",
  });
  const [aggregated, setAggregated] = useState(null);
  const [aggLoading, setAggLoading] = useState(false);
  const [scanning, setScanning] = useState(null); // currently-scanning terminal_id
  const [scanError, setScanError] = useState("");
  const [sending, setSending] = useState(false);
  const [doneSummary, setDoneSummary] = useState(null);
  // Sanity-check confirm gate: if /aggregate flagged today's total as
  // a major deviation, we hold the send() until the owner confirms.
  const [pendingSanity, setPendingSanity] = useState(null);  // null | sanity payload
  const fileInputRefs = useRef({});

  useEffect(() => { fetchTerminals(); }, []);

  async function fetchTerminals() {
    setLoading(true);
    try {
      const res = await api.get("/terminals");
      const list = (res.data || []).filter((t) => t.is_active !== false);
      setTerminals(list);
    } catch (e) {
      // empty list — page will show the "set up terminals first" CTA
      setTerminals([]);
    } finally {
      setLoading(false);
    }
  }

  /* ─── Step 1: scan kasserapport per terminal ──────────────────── */

  async function onPick(terminal, file) {
    if (!file) return;
    setScanning(terminal.id);
    setScanError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("terminal_id", terminal.id);
      const res = await api.post("/kasserapport/extract", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60000, // 60s — extractor is ~6-10s typical, plus upload
      });
      setScans((prev) => ({ ...prev, [terminal.id]: res.data }));
    } catch (e) {
      setScanError(
        e?.response?.data?.detail ||
        t("scanFailed") ||
        "Scan failed — try again or skip this terminal",
      );
    } finally {
      setScanning(null);
    }
  }

  function clearScan(terminalId) {
    setScans((prev) => {
      const next = { ...prev };
      delete next[terminalId];
      return next;
    });
  }

  const scanProgress = useMemo(() => {
    if (!terminals.length) return { done: 0, total: 0 };
    const done = terminals.filter((t) => scans[t.id]).length;
    return { done, total: terminals.length };
  }, [terminals, scans]);

  /* ─── Step 2 → 3: aggregate ───────────────────────────────────── */

  async function goToReview() {
    setAggLoading(true);
    setScanError("");
    try {
      const extraction_ids = Object.values(scans)
        .map((s) => s.extraction_id)
        .filter(Boolean);
      const body = {
        extraction_ids,
        manual: {
          cash_closing: parseFloat(manual.cash_closing) || 0,
          mobilepay_total: parseFloat(manual.mobilepay_total) || 0,
          gift_cards_total: parseFloat(manual.gift_cards_total) || 0,
          sales_pos: parseFloat(manual.sales_pos) || 0,
          closed_by: (manual.closed_by || "").trim() || null,
        },
      };
      const res = await api.post("/kasserapport/aggregate", body);
      setAggregated(res.data);
      setStep("review");
    } catch (e) {
      setScanError(
        e?.response?.data?.detail ||
        t("aggregateFailed") ||
        "Could not consolidate the close",
      );
    } finally {
      setAggLoading(false);
    }
  }

  /* ─── Step 4: commit each extraction + finalize ───────────────── */

  async function send(skipSanityCheck = false) {
    // Live anomaly guard: if /aggregate flagged today's total as a
    // sharp deviation from the same-weekday baseline, hold the send
    // until the owner confirms via the dialog. Skipped when the dialog
    // calls send(true) after their explicit "Yes, send" tap. Free
    // users get `gated: true` from the server — dialog never fires
    // for them (this is an ai_anomaly_detection feature, Starter+).
    const sanity = aggregated?.sanity_check;
    if (!skipSanityCheck && sanity?.flagged && !sanity?.gated) {
      setPendingSanity(sanity);
      return;
    }
    setPendingSanity(null);
    setSending(true);
    setScanError("");
    try {
      // Commit each extraction with the aggregated final_json so the
      // learning loop can promote good ones to examples.
      const aggData = aggregated.aggregated;
      for (const term of aggData.terminals) {
        if (!term.extraction_id) continue;
        const ext = Object.values(scans).find(
          (s) => s.extraction_id === term.extraction_id,
        );
        const finalJson = ext?.data || {};
        try {
          await api.post(`/kasserapport/${term.extraction_id}/commit`, {
            final_json: finalJson,
          });
        } catch {
          // Commit failures are non-fatal — the aggregated close is
          // still recorded; just no learning loop benefit for that one.
        }
      }
      setDoneSummary({
        cards_total: aggData.cards_total,
        payments_total: aggData.payments_total,
        cash_difference: aggData.cash_difference,
        flagged: aggData.cash_diff_flagged,
        terminal_count: aggData.terminals.length,
      });
      setStep("done");
    } catch (e) {
      setScanError(
        e?.response?.data?.detail ||
        t("sendFailed") ||
        "Could not send the report",
      );
    } finally {
      setSending(false);
    }
  }

  /* ─── Render ──────────────────────────────────────────────────── */

  // P5 — Pro entitlement gate. Renders BEFORE the loading spinner so a
  // Free user who deep-links straight to /daily-close/multi (no sidebar
  // entry) lands on the UpgradeNudge instead of the scan UI. The backend
  // re-checks every endpoint anyway — this is just the UX surface.
  if (!entLoading && !isUnlocked) {
    return (
      <div className="px-4 sm:px-6 py-10 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t("multiClose", "Multi-terminal close")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          {t(
            "multiCloseProIntro",
            "Consolidate every POS terminal into one daily close in under 90 seconds — built for chain operators.",
          )}
        </p>
        <UpgradeNudge
          intent="card"
          tier="pro"
          benefit={t(
            "multiCloseUpgradeBenefit",
            "Scan each terminal, hit send: BonBox builds the Mirabelle-format close for every branch.",
          )}
          ctaLabel={t("seePlans", "See plans")}
        />
      </div>
    );
  }

  if (loading || entLoading) {
    return (
      <div className="px-4 sm:px-6 py-12 max-w-3xl mx-auto text-center">
        <div className="text-3xl mb-3 animate-pulse">💳</div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("loading") || "Loading…"}
        </p>
      </div>
    );
  }

  if (terminals.length === 0) {
    /* ─── Smart Terminals — inference-first setup, May 2026 ──────────
     *
     * Replaces the "go to settings" dead-end with: scan first, we
     * propose your terminals from the OCR'd labels, one tap to confirm.
     * After save, we route the already-scanned slips into the freshly-
     * created terminals (by receipt_label match) so the closer can jump
     * straight to manual entry without re-uploading.
     *
     * Power-user fallback: a small link to /terminals stays visible for
     * folks who want the explicit form (multi-branch setups, etc.).
     */
    const handleSmartSetupDone = ({ terminals: created, scans: smartScans }) => {
      setTerminals(created);
      // Route each pre-scanned slip into its newly-created terminal by
      // matching the slip's session.terminal label against each terminal's
      // receipt_label (case-insensitive). Server already auto-routed and
      // returned `auto_routed_terminal_id` if the lookup succeeded — but
      // those scans pre-date the bulk-create, so the server returned null.
      // We re-route client-side so the closer never re-uploads.
      const norm = (s) => (s || "").toString().trim().toLowerCase().replace(/[\s\-_.,;:#]+/g, "");
      const byLabel = new Map();
      for (const term of created) {
        const k = norm(term.receipt_label || term.name);
        if (k) byLabel.set(k, term.id);
      }
      const routed = {};
      for (const sc of (smartScans || [])) {
        const lbl = sc?.data?.session?.terminal;
        const tid = byLabel.get(norm(lbl));
        if (tid) routed[tid] = sc;
      }
      setScans(routed);
    };
    return (
      <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto">
        <FadeIn>
          <div className="mb-5">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              🌙 {t("multiClose") || "Multi-terminal close"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t("smartTerminalsFirstTimeIntro") ||
                "Looks like this is your first multi-terminal close. Let's set it up the easy way."}
            </p>
          </div>
        </FadeIn>
        <SmartTerminalsCard onComplete={handleSmartSetupDone} />
        <p className="text-center text-[11px] text-gray-400 mt-5">
          {t("smartTerminalsAdvancedHint") || "Prefer to set up by hand?"}{" "}
          <a href="/terminals" className="text-emerald-600 hover:underline">
            {t("smartTerminalsAdvancedLink") || "Open Terminals settings"}
          </a>
        </p>
      </div>
    );
  }

  const today = localIso();

  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto">
      <FadeIn>
        <div className="flex items-start justify-between gap-3 mb-5 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              🌙 {t("multiClose") || "Multi-terminal close"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {today} · {scanProgress.done}/{scanProgress.total} {t("terminalsScanned") || "terminals scanned"}
            </p>
          </div>
          <ProgressPill step={step} />
        </div>
      </FadeIn>

      {scanError && (
        <div className="mb-4 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-xl text-sm">
          {scanError}
        </div>
      )}

      {/* ─── STEP 1: scan ───────────────────────────────────────── */}
      {step === "scan" && (
        <FadeIn>
          <div className="space-y-3">
            {terminals.map((term, idx) => {
              const scan = scans[term.id];
              const isScanning = scanning === term.id;
              const isDone = !!scan;
              return (
                <div
                  key={term.id}
                  className={`rounded-xl border p-4 sm:p-5 transition ${
                    isDone
                      ? "bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-700/50"
                      : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                          {idx + 1}/{terminals.length}
                        </span>
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                          {term.name}
                        </h3>
                        {isDone && (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-900 text-white">
                            ✓ {t("scanned") || "Scanned"}
                          </span>
                        )}
                      </div>
                      {scan?.data?.payments && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">
                          {fmtKr(scan.data.payments.card_betalingskort, currency, "Dankort ")}
                          {scan.data.payments.card_softpay
                            ? ` · ${fmtKr(scan.data.payments.card_softpay, currency, "Teller ")}`
                            : ""}
                          {scan.data.payments.amex
                            ? ` · ${fmtKr(scan.data.payments.amex, currency, "Amex ")}`
                            : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {isDone ? (
                        <>
                          <button
                            onClick={() => clearScan(term.id)}
                            className="px-3 py-1.5 min-h-[44px] sm:min-h-0 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                          >
                            {t("rescan") || "Rescan"}
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            ref={(el) => (fileInputRefs.current[term.id] = el)}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => onPick(term, e.target.files?.[0])}
                          />
                          <button
                            onClick={() => fileInputRefs.current[term.id]?.click()}
                            disabled={isScanning}
                            className="px-4 py-2 min-h-[44px] sm:min-h-0 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
                          >
                            {isScanning ? (t("scanning") || "Scanning…") : `📸 ${t("scan") || "Scan"}`}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {scan?.manual_review_needed && (
                    <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                      ⚠ {t("manualReviewHint") || "Numbers couldn't be auto-validated — verify on review screen"}
                    </p>
                  )}
                </div>
              );
            })}

            <div className="pt-3">
              <button
                onClick={() => setStep("manual")}
                disabled={scanProgress.done === 0}
                className="w-full sm:w-auto px-6 py-3 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold rounded-xl disabled:opacity-40 transition"
              >
                {t("continueToManual") || "Continue → Manual entry"}
              </button>
              {scanProgress.done < scanProgress.total && scanProgress.done > 0 && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
                  {(t("partialScansHint") || "{done} of {total} terminals scanned. You can continue and add the rest later.")
                    .replace("{done}", scanProgress.done)
                    .replace("{total}", scanProgress.total)}
                </p>
              )}
            </div>
          </div>
        </FadeIn>
      )}

      {/* ─── STEP 2: manual entry ──────────────────────────────── */}
      {step === "manual" && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
              {t("manualEntryTitle") || "Cash + non-card payments"}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              {t("manualEntrySubtitle") ||
                "BonBox got the card numbers from the kasserapports. Fill in what's not on them."}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ManualField
                label={t("cashCounted") || "Cash counted (kasse beholdning)"}
                value={manual.cash_closing}
                onChange={(v) => setManual({ ...manual, cash_closing: v })}
                currency={currency}
                hint={t("cashCountedHint") || "What's in the till at end of shift"}
              />
              <ManualField
                label={t("mobilepayTotal") || "MobilePay total"}
                value={manual.mobilepay_total}
                onChange={(v) => setManual({ ...manual, mobilepay_total: v })}
                currency={currency}
              />
              <ManualField
                label={t("giftCardsTotal") || "Gift cards accepted"}
                value={manual.gift_cards_total}
                onChange={(v) => setManual({ ...manual, gift_cards_total: v })}
                currency={currency}
              />
              <ManualField
                label={t("salesPosTotal") || "Sales POS (incl. tax)"}
                value={manual.sales_pos}
                onChange={(v) => setManual({ ...manual, sales_pos: v })}
                currency={currency}
                hint={t("salesPosHint") || "What the POS reported as today's gross"}
              />
            </div>

            <div className="mt-5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                {t("closedBy") || "Closed by"}
              </label>
              <input
                type="text"
                value={manual.closed_by}
                onChange={(e) => setManual({ ...manual, closed_by: e.target.value })}
                placeholder={t("closedByPlaceholder") || "e.g. Caro, Anton"}
                className="w-full sm:w-1/2 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
              />
            </div>

            <div className="mt-6 flex gap-2">
              <button
                onClick={() => setStep("scan")}
                className="px-5 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
              >
                ← {t("back") || "Back"}
              </button>
              <button
                onClick={goToReview}
                disabled={aggLoading}
                className="flex-1 sm:flex-none px-6 py-2.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold rounded-xl disabled:opacity-50 transition"
              >
                {aggLoading ? (t("calculating") || "Calculating…") : (t("continueToReview") || "Continue → Review")}
              </button>
            </div>
          </div>
        </FadeIn>
      )}

      {/* ─── STEP 3: review ────────────────────────────────────── */}
      {step === "review" && aggregated && (
        <FadeIn>
          <ReviewView
            aggregated={aggregated}
            currency={currency}
            t={t}
            onBack={() => setStep("manual")}
            onSend={send}
            sending={sending}
          />
        </FadeIn>
      )}

      {/* ─── Sanity-check confirm dialog ─────────────────────────
          Shown when /aggregate flagged today's total as far from the
          owner's same-weekday baseline. Soft, dismissable — they can
          send anyway after reading the message. */}
      {pendingSanity && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPendingSanity(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-md w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("sanityCheckTitle") || "Quick double-check"}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                {pendingSanity.message}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingSanity(null)}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                {t("sanityCheckLetMeCheck") || "Let me check"}
              </button>
              <button
                type="button"
                onClick={() => send(true)}
                className="px-4 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold transition"
              >
                {t("sanityCheckSendAnyway") || "Yes, send"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── STEP 4: done + share ───────────────────────────── */}
      {step === "done" && doneSummary && (
        <FadeIn>
          <DoneView
            doneSummary={doneSummary}
            aggregated={aggregated}
            currency={currency}
            user={user}
            t={t}
            onReset={() => {
              setScans({});
              setManual({
                cash_closing: "",
                mobilepay_total: "",
                gift_cards_total: "",
                sales_pos: "",
                closed_by: user?.full_name || user?.email || "",
              });
              setAggregated(null);
              setDoneSummary(null);
              setStep("scan");
            }}
          />
        </FadeIn>
      )}
    </div>
  );
}


/* ─── Small UI atoms ─────────────────────────────────────────────────── */

function ProgressPill({ step }) {
  const idx = _STEPS.indexOf(step);
  return (
    <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider">
      {_STEPS.map((s, i) => (
        <div
          key={s}
          className={`px-2 py-1 rounded ${
            i < idx ? "bg-gray-900 text-white"
              : i === idx ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900"
              : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
          }`}
        >
          {i + 1}
        </div>
      ))}
    </div>
  );
}

function ManualField({ label, value, onChange, currency, hint }) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
        {label}
      </label>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0,00"
          className="w-full px-3 py-2.5 pr-12 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm font-mono"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-gray-500 font-semibold">
          {currency}
        </span>
      </div>
      {hint && (
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{hint}</p>
      )}
    </div>
  );
}

function ReviewView({ aggregated, currency, t, onBack, onSend, sending }) {
  const agg = aggregated.aggregated;
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
      <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
        {t("reviewTitle") || "Review tonight's close"}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        {t("reviewSubtitle") ||
          "Same row order as your weekly Excel. If anything's off, go back and fix it before sending."}
      </p>

      <div className="rounded-xl bg-gray-50 dark:bg-gray-900/40 divide-y divide-gray-100 dark:divide-gray-700/50">
        {aggregated.excel_rows.map((row, i) => {
          const isFlagged = !!row.flagged;
          const isHeader =
            row.label === "Cash total" ||
            row.label === "Cards total" ||
            row.label === "Payments total" ||
            row.label === "Sales POS (incl tax)" ||
            row.label.startsWith("Total term.");
          return (
            <div
              key={i}
              className={`flex items-center justify-between gap-3 px-3 py-2 ${
                isFlagged
                  ? "bg-amber-50 dark:bg-amber-900/30"
                  : isHeader
                    ? "bg-gray-100/80 dark:bg-gray-800/60"
                    : ""
              }`}
            >
              <span className={`text-xs ${isHeader ? "font-bold text-gray-800 dark:text-white" : "text-gray-600 dark:text-gray-300"}`}>
                {row.label}
              </span>
              <span className={`text-xs font-mono ${
                isFlagged
                  ? "text-amber-700 dark:text-amber-300 font-bold"
                  : isHeader
                    ? "font-bold text-gray-900 dark:text-white"
                    : "text-gray-700 dark:text-gray-300"
              }`}>
                {typeof row.value === "number"
                  ? fmtKr(row.value, currency, "")
                  : (row.value || "—")}
              </span>
            </div>
          );
        })}
      </div>

      {agg.cash_diff_flagged && (
        <div className="mt-4 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-1">
            ⚠ {t("flaggedTitle") || "Cash difference exceeds threshold"}
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {agg.flagged_reason}
          </p>
        </div>
      )}

      <div className="mt-6 flex gap-2">
        <button
          onClick={onBack}
          className="px-5 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
        >
          ← {t("back") || "Back"}
        </button>
        <button
          onClick={onSend}
          disabled={sending}
          className="flex-1 sm:flex-none px-6 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-xl disabled:opacity-50 transition"
        >
          {sending ? (t("sending") || "Sending…") : (t("confirmAndSend") || "Confirm & send")}
        </button>
      </div>
    </div>
  );
}


/* ─── Done step + share-to-team ──────────────────────────────────────── */

function DoneView({ doneSummary, aggregated, currency, user, t, onReset }) {
  const [shareState, setShareState] = useState({ status: "idle", message: "" });
  const [recipients, setRecipients] = useState([]);
  const [pdfState, setPdfState] = useState({ status: "idle", message: "" });
  const [xlsxState, setXlsxState] = useState({ status: "idle", message: "" });

  const aggData = aggregated?.aggregated;
  const businessName = user?.business_name || "";
  const dateLabel = formatDanishDateLabel(new Date());

  // Load configured recipients once when the done view mounts. Wrapped
  // so a fetch failure doesn't break the share UI — closer can still
  // tap the generic Send button. Empty result is fine and common
  // (owner hasn't configured any recipients yet).
  useEffect(() => {
    let cancelled = false;
    api.get("/output-channels")
      .then((res) => {
        if (cancelled) return;
        setRecipients(Array.isArray(res.data) ? res.data : []);
      })
      .catch(() => {
        // silent — recipients are optional
      });
    return () => { cancelled = true; };
  }, []);

  const shareTitle = useMemo(
    () => buildShareTitle({ businessName, dateLabel }),
    [businessName, dateLabel],
  );
  const shareText = useMemo(
    () => buildShareMessage(aggData, { businessName, dateLabel, currency }),
    [aggData, businessName, dateLabel, currency],
  );

  /**
   * Generate the close as a PDF and either:
   *   1. Share via Web Share API with `files: [pdf]` (iOS 15+, Chrome
   *      Android with appropriate permissions), OR
   *   2. Download as a regular file via blob URL.
   *
   * Caller picks via `mode = "share" | "download"`.
   */
  async function doPdf(mode = "download") {
    if (!aggData) return;
    setPdfState({ status: "loading", message: "" });
    try {
      const res = await api.post(
        "/kasserapport/close-pdf",
        { aggregated: aggData, date_label: dateLabel, currency },
        { responseType: "blob" },
      );
      const blob = new Blob([res.data], { type: "application/pdf" });

      // Try Web Share Files API first if requested
      if (mode === "share" && navigator.share && typeof File !== "undefined") {
        try {
          const file = new File(
            [blob],
            `lukning-${(businessName || "bonbox").toLowerCase().replace(/\W+/g, "_")}.pdf`,
            { type: "application/pdf" },
          );
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
              title: shareTitle,
              text: shareText,
              files: [file],
            });
            setPdfState({
              status: "success",
              message: t("pdfShared") || "PDF shared",
            });
            return;
          }
        } catch (e) {
          if (e?.name !== "AbortError") {
            // Fall through to download path
          } else {
            setPdfState({ status: "success", message: t("pdfShared") || "PDF shared" });
            return;
          }
        }
      }

      // Download fallback (also covers desktop browsers)
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        `lukning-${(businessName || "bonbox").toLowerCase().replace(/\W+/g, "_")}-${
          dateLabel.split(" ")[0]?.replace(/\./g, "-") || "today"
        }.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after the click registers (small timeout for Safari quirk)
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPdfState({
        status: "success",
        message: t("pdfDownloaded") || "PDF downloaded",
      });
    } catch (e) {
      setPdfState({
        status: "error",
        message: e?.response?.data?.detail || t("pdfFailed") || "Could not generate PDF",
      });
    }
  }

  /**
   * Generate the close as a Mirabelle-format .xlsx workbook. Same modes
   * as PDF: "share" tries Web Share Files API first, "download" goes
   * straight to blob → <a download>. Owner can paste the rows into their
   * weekly workbook or hand the file to the revisor.
   */
  async function doXlsx(mode = "download") {
    if (!aggData) return;
    setXlsxState({ status: "loading", message: "" });
    try {
      const res = await api.post(
        "/kasserapport/close-excel",
        { aggregated: aggData, date_label: dateLabel, currency },
        { responseType: "blob" },
      );
      const xlsxMime =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const blob = new Blob([res.data], { type: xlsxMime });

      if (mode === "share" && navigator.share && typeof File !== "undefined") {
        try {
          const file = new File(
            [blob],
            `lukning-${(businessName || "bonbox").toLowerCase().replace(/\W+/g, "_")}.xlsx`,
            { type: xlsxMime },
          );
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
              title: shareTitle,
              text: shareText,
              files: [file],
            });
            setXlsxState({
              status: "success",
              message: t("excelShared") || "Excel shared",
            });
            return;
          }
        } catch (e) {
          if (e?.name === "AbortError") {
            setXlsxState({
              status: "success",
              message: t("excelShared") || "Excel shared",
            });
            return;
          }
          // else: fall through to download path
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        `lukning-${(businessName || "bonbox").toLowerCase().replace(/\W+/g, "_")}-${
          dateLabel.split(" ")[0]?.replace(/\./g, "-") || "today"
        }.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setXlsxState({
        status: "success",
        message: t("excelDownloaded") || "Excel downloaded",
      });
    } catch (e) {
      setXlsxState({
        status: "error",
        message:
          e?.response?.data?.detail || t("excelFailed") || "Could not generate Excel",
      });
    }
  }

  async function doShare() {
    if (!shareText) return;
    setShareState({ status: "sharing", message: "" });
    try {
      const res = await shareCloseSummary({ title: shareTitle, text: shareText });
      if (res.ok) {
        setShareState({
          status: "success",
          message: res.channel === "clipboard"
            ? (t("shareCopiedToClipboard") || "Copied to clipboard — paste into your group")
            : (t("shareOpened") || "Share sheet opened"),
        });
      } else {
        setShareState({
          status: "error",
          message: t("shareFailed") || "Could not open share sheet",
        });
      }
    } catch {
      setShareState({
        status: "error",
        message: t("shareFailed") || "Could not open share sheet",
      });
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-800 p-6 sm:p-8">
      <div className="text-center">
        <div className="text-5xl mb-3">✅</div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
          {t("closeSentTitle") || "Lukning sendt"}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          {(t("closeSentSubtitle") ||
            "{count} terminals consolidated. Cash difference: {diff}.")
            .replace("{count}", doneSummary.terminal_count)
            .replace("{diff}", fmtKr(doneSummary.cash_difference, currency, ""))}
        </p>
        {doneSummary.flagged && (
          <div className="text-xs px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 rounded-lg mb-4 inline-block">
            ⚠ {t("flaggedReviewWithOwner") || "Flagged for owner review — exceeds threshold"}
          </div>
        )}
      </div>

      {/* Share-to-team — the killer differentiator. Owner reviews the
          formatted Danish summary, taps "Send til ejer/team", native
          share sheet opens (WhatsApp / Messenger / email) and the
          message goes wherever they already share their closing. */}
      {aggData && shareText && (
        <div className="mt-2 mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-semibold text-gray-800 dark:text-white">
              📨 {t("sendToTeam") || "Send til ejer / team"}
            </div>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {t("sendToTeamHint") || "WhatsApp · Messenger · email — your choice"}
            </span>
          </div>

          {/* Preview the exact text that will be shared. Owners trust
              what they see — no surprises in Messenger. */}
          <pre className="px-4 py-3 text-[12px] sm:text-[13px] font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
            {shareText}
          </pre>

          {shareState.message && (
            <div
              className={`mx-4 mb-3 px-3 py-2 rounded-lg text-xs ${
                shareState.status === "error"
                  ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300"
                  : "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              }`}
            >
              {shareState.message}
            </div>
          )}

          {/* Configured recipients — quick-tap buttons. The native share
              sheet doesn't let us preselect a contact across all
              channels, so we use channel-specific deep links where
              possible (mailto:, sms:, whatsapp://) and fall back to
              the share sheet otherwise. */}
          {recipients.length > 0 && (
            <div className="px-4 pt-3 pb-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                {t("yourRecipients") || "Your recipients"}
              </div>
              <div className="flex flex-wrap gap-2">
                {recipients.map((r) => (
                  <RecipientButton
                    key={r.id}
                    recipient={r}
                    title={shareTitle}
                    text={shareText}
                    t={t}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center gap-2 flex-wrap">
            <button
              onClick={doShare}
              disabled={shareState.status === "sharing"}
              className="flex-1 sm:flex-none px-5 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
            >
              {shareState.status === "sharing"
                ? (t("opening") || "Opening…")
                : `📨 ${recipients.length > 0 ? (t("openShareSheet") || "Open share sheet") : (t("sendNow") || "Send now")}`}
            </button>
            <button
              onClick={() => doPdf("share")}
              disabled={pdfState.status === "loading"}
              className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg disabled:opacity-50 transition"
              title={t("pdfShareHint") || "Share as PDF attachment via WhatsApp / email"}
            >
              {pdfState.status === "loading"
                ? `📄 ${t("generating") || "Generating…"}`
                : `📄 ${t("sharePdf") || "Share PDF"}`}
            </button>
            <button
              onClick={() => doPdf("download")}
              disabled={pdfState.status === "loading"}
              className="px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg disabled:opacity-50 transition"
            >
              ⬇ {t("downloadPdf") || "Download PDF"}
            </button>
            <button
              onClick={() => doXlsx("share")}
              disabled={xlsxState.status === "loading"}
              className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg disabled:opacity-50 transition"
              title={t("excelShareHint") || "Share as Excel attachment — paste into your weekly workbook"}
            >
              {xlsxState.status === "loading"
                ? `📊 ${t("generating") || "Generating…"}`
                : `📊 ${t("shareExcel") || "Share Excel"}`}
            </button>
            <button
              onClick={() => doXlsx("download")}
              disabled={xlsxState.status === "loading"}
              className="px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg disabled:opacity-50 transition"
            >
              ⬇ {t("downloadExcel") || "Download Excel"}
            </button>
            <CopyButton text={`${shareTitle}\n\n${shareText}`} t={t} />
          </div>

          {pdfState.message && (
            <div
              className={`mx-4 mb-3 px-3 py-2 rounded-lg text-xs ${
                pdfState.status === "error"
                  ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300"
                  : "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              }`}
            >
              {pdfState.message}
            </div>
          )}
          {xlsxState.message && (
            <div
              className={`mx-4 mb-3 px-3 py-2 rounded-lg text-xs ${
                xlsxState.status === "error"
                  ? "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300"
                  : "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              }`}
            >
              {xlsxState.message}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 justify-center flex-wrap">
        <a
          href="/daily-close"
          className="px-5 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg transition"
        >
          {t("openHistory") || "Open daily-close history"}
        </a>
        <button
          onClick={onReset}
          className="px-5 py-2 min-h-[44px] sm:min-h-0 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold rounded-lg transition"
        >
          {t("newClose") || "Start another close"}
        </button>
      </div>
    </div>
  );
}


/**
 * RecipientButton — channel-specific quick-tap that uses deep links
 * where available so the closer doesn't have to scroll the native
 * share sheet to find Lars's WhatsApp.
 *
 * Handled directly without the share sheet:
 *   email             → mailto: with subject + body
 *   sms               → sms: with body
 *   whatsapp          → wa.me/<phone>?text=  (opens the right chat)
 *   csv_to_accountant → mailto: with subject pinned to "Daily close CSV"
 *
 * Falls back to navigator.share() (with the recipient label appended
 * to the title so the closer knows which channel they were aiming for):
 *   messenger / slack / pdf_only — these don't have reliable deep
 *   links across iOS/Android, so we open the share sheet.
 */
function RecipientButton({ recipient, title, text, t }) {
  const channelMeta = {
    email:             { icon: "📧" },
    whatsapp:          { icon: "📱" },
    messenger:         { icon: "💬" },
    sms:               { icon: "💌" },
    slack:             { icon: "💻" },
    csv_to_accountant: { icon: "📊" },
    pdf_only:          { icon: "📄" },
  };
  const meta = channelMeta[recipient.channel_type] || { icon: "📨" };

  function handleClick() {
    const target = (recipient.target || "").trim();
    const encodedSubject = encodeURIComponent(title);
    const encodedBody = encodeURIComponent(text);

    switch (recipient.channel_type) {
      case "email":
      case "csv_to_accountant": {
        if (!target) return;
        const subjectLabel = recipient.channel_type === "csv_to_accountant"
          ? `Daily close · ${title}`
          : title;
        window.location.href = `mailto:${encodeURIComponent(target)}?subject=${encodeURIComponent(subjectLabel)}&body=${encodedBody}`;
        return;
      }
      case "sms": {
        if (!target) return;
        // sms: takes phone as path; iOS uses ?body= with body=
        const phone = target.replace(/[^0-9+]/g, "");
        window.location.href = `sms:${phone}?body=${encodedBody}`;
        return;
      }
      case "whatsapp": {
        if (!target) return;
        const phone = target.replace(/[^0-9]/g, "");
        // wa.me handles the protocol cleanly across iOS/Android
        window.open(`https://wa.me/${phone}?text=${encodedBody}`, "_blank");
        return;
      }
      default: {
        // Open the share sheet, the closer picks the channel manually
        if (typeof navigator !== "undefined" && navigator.share) {
          navigator.share({ title: `${title} → ${recipient.label}`, text }).catch(() => {});
        } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(`${title}\n\n${text}`).catch(() => {});
        }
        return;
      }
    }
  }

  return (
    <button
      onClick={handleClick}
      className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-gray-300 dark:hover:border-gray-500 rounded-lg transition flex items-center gap-1.5 min-h-[44px] sm:min-h-0"
      title={recipient.target || ""}
    >
      <span>{meta.icon}</span>
      <span>{recipient.label}</span>
    </button>
  );
}


function CopyButton({ text, t }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silent fail — not worth surfacing if the share button is right there
    }
  }
  return (
    <button
      onClick={copy}
      className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition"
    >
      {copied ? `✓ ${t("copied") || "Copied"}` : (t("copyText") || "Copy text")}
    </button>
  );
}


/* ─── helpers ────────────────────────────────────────────────────────── */

function fmtKr(n, currency, prefix = "") {
  if (n == null || isNaN(n)) return "—";
  const formatted = Math.round(n).toLocaleString();
  return `${prefix}${formatted} ${currency}`;
}
