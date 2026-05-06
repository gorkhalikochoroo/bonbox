import { useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

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
  const currency = displayCurrency(user?.currency);

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

  async function send() {
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

  if (loading) {
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
    return (
      <div className="px-4 sm:px-6 py-12 max-w-2xl mx-auto text-center">
        <div className="text-5xl mb-4">💳</div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
          {t("multiCloseNoTerminalsTitle") || "Set up your terminals first"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-md mx-auto">
          {t("multiCloseNoTerminalsBody") ||
            "The multi-terminal close needs at least one POS station configured. Pop over to Terminals and add yours."}
        </p>
        <a
          href="/terminals"
          className="inline-block px-5 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
        >
          {t("goToTerminals") || "Open Terminals settings"}
        </a>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

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
                  className={`rounded-2xl border p-4 sm:p-5 transition ${
                    isDone
                      ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700/50"
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
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-green-600 text-white">
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
                            className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
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
                            className="px-4 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
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
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
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

      {/* ─── STEP 4: done ──────────────────────────────────────── */}
      {step === "done" && doneSummary && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-green-200 dark:border-green-800 p-6 sm:p-8 text-center">
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
            <div className="flex gap-2 justify-center flex-wrap">
              <a
                href="/daily-close"
                className="px-5 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg transition"
              >
                {t("openHistory") || "Open daily-close history"}
              </a>
              <button
                onClick={() => {
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
                className="px-5 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
              >
                {t("newClose") || "Start another close"}
              </button>
            </div>
          </div>
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
            i < idx ? "bg-green-600 text-white"
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
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6">
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


/* ─── helpers ────────────────────────────────────────────────────────── */

function fmtKr(n, currency, prefix = "") {
  if (n == null || isNaN(n)) return "—";
  const formatted = Math.round(n).toLocaleString();
  return `${prefix}${formatted} ${currency}`;
}
