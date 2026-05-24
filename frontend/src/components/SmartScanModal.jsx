/**
 * SmartScanModal — the "snap anything" entry point for BonBox.
 *
 * The owner takes ONE photo of any document — kvittering / kasserapport /
 * faktura — and the backend classifier figures out what it is, where it
 * should land, and pre-extracts the data we know how to read. The modal
 * then auto-navigates the owner to the right destination page with that
 * data already in the form fields.
 *
 * 10-layer multi-barrier defense built into this flow:
 *   L1 — Camera permission denied → seamless fall back to the file picker
 *        (capture="environment" hint still tells iOS to prefer the rear
 *         camera).
 *   L4 — Graceful API failure → on any network / 5xx, we surface a soft
 *        toast ("Smart skan ikke tilgængelig — åbner manuelt") and open
 *        the manual picker.
 *   L6 — Fail-closed → if the classifier returns `route_to ===
 *        "manual_picker"` (or confidence is too low), we DO NOT auto-
 *        proceed. The owner picks manually.
 *   L7 — Observable corrections → every Override tap POSTs to
 *        /api/smart-scan/override with the original classifier guess +
 *        the chosen doc type so we can measure classifier drift.
 *   L10 — Honest copy → no "100% accurate" claims anywhere. The auto-
 *        proceed countdown reads "Åbner om {n} sek" so the owner knows
 *        WHEN we'll act, with a one-tap Override that interrupts.
 *
 * Tier respect: if the backend returns `upgrade_hint`, we render the
 * existing UpgradeNudge with the tier from the hint instead of routing.
 *
 * Mounting: this modal is opened by SmartScanFAB (mobile FAB) AND by
 * QuickAdd's "Smart skan" entry. Both surfaces reach the same UX.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScanLine, Camera, Receipt, FileText, Moon } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { resizeImageIfLarge } from "../utils/resizeImage";
import UpgradeNudge from "./ui/UpgradeNudge";

// Auto-proceed window. 2 seconds is long enough to read the result and
// cancel, short enough that the owner doesn't feel held up. Confirmed
// against the user prompt ("åbner Udgifter om 2 sek").
const AUTO_PROCEED_SECONDS = 2;

// Map backend doc_type → an icon component for the result card. Always
// monochrome Lucide so the result reads as a calm classification, not a
// celebratory toast (honesty-first — we're not 100% sure).
const TYPE_ICON = {
  receipt: Receipt,
  z_report: Moon,
  invoice: FileText,
};

// Map backend route_to → a translation key for the "where we're going"
// label. Falls back to the backend-provided route_label so a new
// destination doesn't require a frontend deploy.
const DETECTED_KEY = {
  receipt: "smartScan.detected.receipt",
  z_report: "smartScan.detected.z_report",
  invoice: "smartScan.detected.invoice",
};

export default function SmartScanModal({ open, onClose }) {
  const navigate = useNavigate();
  const { t } = useLanguage();

  // ─── State machine ────────────────────────────────────────────────
  // "idle"      — picker UI (Take photo / Choose photo)
  // "scanning"  — file uploaded, waiting for classifier response
  // "result"    — classified successfully; auto-proceed timer running
  // "manual"    — 3-button picker (override OR fail-closed path)
  // "upgrade"   — backend returned upgrade_hint; show UpgradeNudge
  const [stage, setStage] = useState("idle");
  const [result, setResult] = useState(null);
  const [preview, setPreview] = useState(null);
  const [countdown, setCountdown] = useState(AUTO_PROCEED_SECONDS);
  const [error, setError] = useState("");

  const fileRef = useRef(null);
  const timerRef = useRef(null);

  // Reset state every time the modal closes so the next open is fresh.
  // Also revoke any preview blob URL so the captured image isn't pinned
  // in memory after close — GDPR-friendly + saves RAM on multi-scan
  // sessions.
  useEffect(() => {
    if (!open) {
      setStage("idle");
      setResult(null);
      setPreview((prev) => {
        if (prev) {
          try { URL.revokeObjectURL(prev); } catch { /* already revoked */ }
        }
        return null;
      });
      setCountdown(AUTO_PROCEED_SECONDS);
      setError("");
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [open]);

  // Lock body scroll while modal is open (matches Modal.jsx behavior).
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  // ─── File handling ────────────────────────────────────────────────
  // Web fallback only. Native (Capacitor) camera support can be wired
  // later — for v1 the <input type="file" capture="environment"> path
  // is plenty: iOS Safari opens the camera directly, Android Chrome
  // does the same, and desktop falls through to the file picker.
  const handleFile = async (e) => {
    const rawFile = e.target.files?.[0];
    // Clear input.value so picking the same file twice still fires
    // change — important for "Retake" after manual override.
    if (e.target) e.target.value = "";
    if (!rawFile) return;
    await classifyFile(rawFile);
  };

  const classifyFile = async (rawFile) => {
    setStage("scanning");
    setError("");
    setPreview(URL.createObjectURL(rawFile));
    try {
      // Same client-side resize the receipt + close-day scans use so we
      // stay under the backend's 12 MB cap.
      const file = await resizeImageIfLarge(rawFile);
      const formData = new FormData();
      formData.append("file", file);
      const res = await api.post("/smart-scan/classify", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60000,
      });
      const data = res.data;
      // L4 — gated content from a paid tier. Surface the upgrade nudge
      // instead of pushing the owner into a half-broken flow.
      if (data?.upgrade_hint) {
        setResult(data);
        setStage("upgrade");
        trackEvent("smart_scan_upgrade_hint", "smart_scan", data.upgrade_hint.feature);
        return;
      }
      setResult(data);
      // L6 — fail-closed when the classifier itself couldn't tell.
      if (data.route_to === "manual_picker" || data.doc_type === "unknown") {
        setStage("manual");
        trackEvent("smart_scan_unknown", "smart_scan", data?.reason || "manual_picker");
        return;
      }
      setStage("result");
      setCountdown(AUTO_PROCEED_SECONDS);
      trackEvent(
        "smart_scan_classified",
        "smart_scan",
        `${data.doc_type} conf=${(data.confidence || 0).toFixed(2)}`,
      );
    } catch (err) {
      // L4 — never blank the modal. Toast the soft error so the owner
      // sees a global hint, then drop them into manual picker so they
      // can still complete the task.
      trackEvent("smart_scan_error", "smart_scan", err.message || "unknown");
      try {
        window.dispatchEvent(
          new CustomEvent("bonbox:soft-error", {
            detail: {
              message: t("smartScan.apiDown", "Smart skan ikke tilgængelig — åbner manuelt"),
              recoverable: true,
              url: "/smart-scan/classify",
            },
          }),
        );
      } catch { /* SSR — fine */ }
      setError(t("smartScan.apiDown", "Smart skan ikke tilgængelig — åbner manuelt"));
      setStage("manual");
    }
  };

  // ─── Auto-proceed countdown ───────────────────────────────────────
  // Only ticks while we're in the "result" stage. The Override button
  // clears the timer by switching stage → "manual" via the handler
  // below, so we don't need an explicit "cancel" path here.
  useEffect(() => {
    if (stage !== "result") return;
    setCountdown(AUTO_PROCEED_SECONDS);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          // Defer the navigation so the "0 sek" frame paints first.
          setTimeout(() => proceed(), 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // proceed depends on result, but we read it from closure when the
    // timer fires; intentional empty deps so we don't reset on every
    // render. result is set once before we transition to "result".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // ─── Navigation helpers ───────────────────────────────────────────
  const proceed = (overrideRoute = null, overridePrefill = null, source = "smart_scan") => {
    if (!result) {
      onClose?.();
      return;
    }
    const route = overrideRoute || result.route_to;
    const prefill = overridePrefill !== null ? overridePrefill : (result.extracted_data || null);
    const verifyHints = result.verify_hints || [];
    // React Router v6 state — never appears in the URL, exactly matches
    // the brief's "no URL leak" requirement. Page components read this
    // via useLocation().state on mount.
    navigate(route, {
      state: {
        prefill,
        verify_hints: verifyHints,
        source,
        doc_type: result.doc_type,
      },
    });
    onClose?.();
  };

  // Tap "Vælg manuelt" (override) — clear the timer and reveal the
  // 3-button picker. We DON'T POST anything to /override yet — that
  // happens once the owner actually picks a type, since otherwise we'd
  // log every accidental cancel as a "correction".
  const beginOverride = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setStage("manual");
    trackEvent("smart_scan_override_opened", "smart_scan", result?.doc_type || "unknown");
  };

  // Owner picked a doc type from the manual picker. POST the
  // correction (L7 observability) then navigate with EMPTY prefill —
  // we don't trust the extracted data when the classifier was wrong.
  const pickManual = async (chosenDocType, routeTo) => {
    if (result) {
      try {
        await api.post("/smart-scan/override", {
          original_doc_type: result.doc_type,
          chosen_doc_type: chosenDocType,
          file_size_kb: result.file_size_kb,
        });
      } catch (e) {
        // L7 — observability is best-effort. A failed override POST
        // must not block the owner from completing the task.
        console.warn("smart-scan override POST failed", e);
      }
    }
    trackEvent("smart_scan_manual_pick", "smart_scan", chosenDocType);
    // Empty prefill — we explicitly don't pass extracted_data here
    // because the classifier got it wrong. Owner enters fresh data.
    navigate(routeTo, {
      state: {
        prefill: null,
        verify_hints: [],
        source: "smart_scan_manual",
        doc_type: chosenDocType,
      },
    });
    onClose?.();
  };

  if (!open) return null;

  // ─── Render ───────────────────────────────────────────────────────
  const detectedKey = result?.doc_type ? DETECTED_KEY[result.doc_type] : null;
  const TypeIcon = result?.doc_type ? TYPE_ICON[result.doc_type] : ScanLine;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" role="dialog" aria-modal="true" aria-label={t("smartScan.title", "Smart skan")}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between mb-5 shrink-0">
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-200 flex items-center gap-2">
            <ScanLine size={20} strokeWidth={1.75} aria-hidden="true" />
            {t("smartScan.title", "Smart skan")}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-2xl leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-md w-8 h-8 flex items-center justify-center"
            aria-label={t("close", "Close")}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 -mx-1 px-1">
          {/* ── Stage: idle ──────────────────────────────────────────
              Camera + file picker. Two buttons mirror the
              ReceiptCapture component so the camera/library affordances
              feel familiar across the app. */}
          {stage === "idle" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t(
                  "smartScan.intro",
                  "Tag ét billede — vi finder ud af hvad det er (kvittering, kasserapport eller faktura) og åbner den rigtige side.",
                )}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    if (!fileRef.current) return;
                    fileRef.current.setAttribute("capture", "environment");
                    fileRef.current.click();
                  }}
                  className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-6 text-center hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <Camera size={28} strokeWidth={1.75} className="mx-auto mb-1 text-gray-700 dark:text-gray-200 group-hover:scale-110 transition" aria-hidden="true" />
                  <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                    {t("takePhoto", "Take Photo")}
                  </p>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                    {t("smartScan.opensCamera", "Åbner kameraet")}
                  </p>
                </button>
                <button
                  onClick={() => {
                    if (!fileRef.current) return;
                    fileRef.current.removeAttribute("capture");
                    fileRef.current.click();
                  }}
                  className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-6 text-center hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <FileText size={28} strokeWidth={1.75} className="mx-auto mb-1 text-gray-700 dark:text-gray-200 group-hover:scale-110 transition" aria-hidden="true" />
                  <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                    {t("smartScan.choosePhoto", "Vælg fra album")}
                  </p>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                    {t("smartScan.imageOrPdf", "Billede eller PDF")}
                  </p>
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,application/pdf"
                onChange={handleFile}
                className="hidden"
              />
              {/* Honest copy footer — sets expectations before scan. */}
              <p className="text-[11px] text-gray-400 dark:text-gray-500 italic">
                {t(
                  "smartScan.honestyFooter",
                  "Du bekræfter alle felter inden vi gemmer noget. AI'en kan tage fejl — derfor stopper vi altid op.",
                )}
              </p>
            </div>
          )}

          {/* ── Stage: scanning ───────────────────────────────────── */}
          {stage === "scanning" && (
            <div className="text-center py-8 space-y-3">
              {preview && (
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded-xl h-32 flex items-center justify-center overflow-hidden mb-2">
                  <img src={preview} alt="" className="max-h-32 w-auto object-contain opacity-70" />
                </div>
              )}
              <div className="inline-block w-8 h-8 border-[3px] border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium">
                {t("smartScan.detecting", "Kigger på billedet…")}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {t("smartScan.detectingHint", "Typisk 3–6 sekunder")}
              </p>
            </div>
          )}

          {/* ── Stage: result ─────────────────────────────────────── */}
          {stage === "result" && result && (
            <div className="space-y-4">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded-xl p-4">
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
                    <TypeIcon size={20} strokeWidth={1.75} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                      {detectedKey ? t(detectedKey, result.route_label) : result.route_label}
                    </p>
                    <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">
                      {t("smartScan.openingIn", "Åbner om {seconds} sek").replace(
                        "{seconds}",
                        String(countdown),
                      )}
                    </p>
                  </div>
                </div>
                {typeof result.confidence === "number" && result.confidence < 0.85 && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-2">
                    {t("smartScan.lowConfidence", "Lidt usikker — tjek felterne på næste side")}
                    {" "}
                    ({Math.round(result.confidence * 100)}%)
                  </p>
                )}
                {result.fallback_used === "heuristic" && (
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 italic">
                    {t("smartScan.heuristicNote", "Klassificeret uden AI denne gang — bekræft venligst")}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => proceed()}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl font-semibold text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                >
                  {t("smartScan.openNow", "Åbn nu")}
                </button>
                <button
                  onClick={beginOverride}
                  className="px-4 py-2.5 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-xl font-medium text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  {t("smartScan.override", "Vælg manuelt")}
                </button>
              </div>
            </div>
          )}

          {/* ── Stage: manual picker ──────────────────────────────── */}
          {stage === "manual" && (
            <div className="space-y-4">
              {error && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-200 px-3 py-2 rounded-lg text-xs">
                  {error}
                </div>
              )}
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {result?.doc_type === "unknown" || !result
                  ? t("smartScan.unknown", "Vi kunne ikke afgøre hvad det er — vælg manuelt")
                  : t("smartScan.pickCorrect", "Vælg den rigtige type")}
              </p>
              <div className="space-y-2">
                <button
                  onClick={() => pickManual("receipt", "/expenses")}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 hover:border-emerald-300 transition text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <Receipt size={20} strokeWidth={1.75} className="text-gray-700 dark:text-gray-200 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm text-gray-800 dark:text-gray-100">
                      {t("smartScan.pick.receipt", "Kvittering")}
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {t("smartScan.pick.receiptHint", "Til Udgifter")}
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => pickManual("z_report", "/daily-close")}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 hover:border-emerald-300 transition text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <Moon size={20} strokeWidth={1.75} className="text-gray-700 dark:text-gray-200 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm text-gray-800 dark:text-gray-100">
                      {t("smartScan.pick.kasserapport", "Kasserapport")}
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {t("smartScan.pick.kasserapportHint", "Til I dag")}
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => pickManual("invoice", "/inventory")}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 hover:border-emerald-300 transition text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <FileText size={20} strokeWidth={1.75} className="text-gray-700 dark:text-gray-200 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm text-gray-800 dark:text-gray-100">
                      {t("smartScan.pick.faktura", "Faktura")}
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {t("smartScan.pick.fakturaHint", "Til Lager")}
                    </p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* ── Stage: upgrade nudge ──────────────────────────────── */}
          {stage === "upgrade" && result?.upgrade_hint && (
            <div className="space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {t(
                  "smartScan.upgradeIntro",
                  "Denne type kræver et højere abonnement — ellers kan du vælge manuelt nedenfor.",
                )}
              </p>
              <UpgradeNudge
                intent="card"
                tier={result.upgrade_hint.min_plan === "pro" ? "pro" : "starter"}
                benefit={t(
                  `smartScan.upgrade.${result.upgrade_hint.feature}`,
                  t(
                    "smartScan.upgrade.default",
                    "Smart skan for PDF + multi-side dokumenter",
                  ),
                )}
                ctaLabel={t("seePlans", "See plans")}
              />
              <button
                onClick={() => setStage("manual")}
                className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-xl font-medium text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {t("smartScan.continueManual", "Fortsæt manuelt")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
