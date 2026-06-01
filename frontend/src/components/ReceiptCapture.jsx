import { useState, useRef } from "react";
import { Camera, ImageIcon } from "lucide-react";
import Modal from "./Modal";
import ReceiptViewer from "./ReceiptViewer";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { resizeImageIfLarge } from "../utils/resizeImage";
import { localIso } from "../utils/dateFormat";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";

/**
 * ReceiptCapture — supports both sale and expense mode.
 *
 * Props:
 *  - mode: "sale" (default) | "expense"
 *  - onSaleCreated: callback after sale is logged (sale mode)
 *  - onClose: callback to close externally (expense mode)
 *  - onSaved: callback after expense/sale is saved (expense mode)
 */
export default function ReceiptCapture({ onSaleCreated, mode = "sale", onClose, onSaved }) {
  const { t } = useLanguage();
  const isExpense = mode === "expense";
  const [open, setOpen] = useState(isExpense); // auto-open in expense mode
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState(isExpense ? "card" : "mixed");
  const [preview, setPreview] = useState(null);
  const [success, setSuccess] = useState("");
  const [desc, setDesc] = useState("");
  // Pre-filled by OCR vendor + date in expense mode. Owner can override
  // before saving — we never silently book OCR guesses.
  const [parsedDate, setParsedDate] = useState("");
  const [parsedCategoryId, setParsedCategoryId] = useState("");
  // Tier-cap error surfaced from /upload-receipt 402 response. When set,
  // we hide the file picker and show an UpgradeNudge-style block.
  const [capError, setCapError] = useState(null);
  // "with-moms" (gross — typical Danish receipt) | "without-moms" (net).
  // Default to gross because most printed receipts include MOMS in the
  // total. The flag is passed through to the OCR endpoint so server-
  // side amount detection picks the right line ('Total' vs 'Net').
  const [momsMode, setMomsMode] = useState("with-moms");
  // Pre-save full-size review modal — opens when user taps the
  // "Review receipt" link below the cropped preview thumbnail.
  // Lets the owner see a tall receipt without cropping + the OCR text
  // with detected amounts highlighted before they confirm.
  const [reviewOpen, setReviewOpen] = useState(false);
  const fileRef = useRef();

  const uploadEndpoint = isExpense ? "/expenses/upload-receipt" : "/sales/upload-receipt";

  const handleFile = async (e) => {
    const rawFile = e.target.files[0];
    if (!rawFile) return;
    // Auto-resize iPhone-sized photos before upload. iPhone 15 Pro
    // captures at 48 MP — JPEG conversion can produce 15-25 MB which
    // exceeds our 12 MB backend cap. Resizing client-side to 2000px
    // long edge keeps OCR text crisp + uploads stay under cap.
    setPreview(URL.createObjectURL(rawFile));
    setUploading(true);
    setResult(null);
    const file = await resizeImageIfLarge(rawFile);

    const formData = new FormData();
    formData.append("file", file);
    // Pass the with/without-MOMS choice to the upload endpoint. Backend
    // currently ignores it for /sales/upload-receipt and /expenses/upload-
    // receipt (MOMS is computed at the daily-close level), but sending it
    // future-proofs the API for per-receipt VAT-mode awareness.
    formData.append("prices_include_moms", momsMode === "with-moms" ? "true" : "false");

    try {
      const res = await api.post(uploadEndpoint, formData, { timeout: 60000 });
      setResult(res.data);
      if (res.data.suggested_amount) {
        setAmount(String(res.data.suggested_amount));
        trackEvent("receipt_scanned", mode, `detected ${res.data.suggested_amount}`);
      } else {
        trackEvent("receipt_scan_failed", mode, res.data.ocr_available ? "no amount found" : "ocr unavailable");
      }
      // Expense-mode richer fields (May 2026): vendor → description,
      // date → parsed date, suggested_category → category id pre-fill.
      if (isExpense) {
        if (res.data.suggested_vendor && !desc) {
          setDesc(res.data.suggested_vendor);
        }
        if (res.data.suggested_date) {
          setParsedDate(res.data.suggested_date);
        }
        if (res.data.suggested_category?.category_id) {
          setParsedCategoryId(res.data.suggested_category.category_id);
        }
      }
    } catch (err) {
      // Tier-cap 402 returns structured detail — surface it to the user
      // as an UpgradeNudge instead of a generic "OCR failed" toast.
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 402 && detail?.code === "plan_required") {
        setCapError({
          used: detail.used_this_month,
          cap: detail.monthly_cap,
          plan: detail.required_plan,
          message: detail.message,
        });
        setPreview(null);
        trackEvent("receipt_scan_cap_hit", mode, `${detail.used_this_month}/${detail.monthly_cap}`);
      } else {
        setResult({ suggested_amount: null, all_amounts_found: [], ocr_available: false });
        trackEvent("receipt_scan_error", mode, err.message);
      }
    }
    setUploading(false);
  };

  const confirmSale = async () => {
    if (!amount || !result) return;
    await api.post("/sales/from-receipt", null, {
      params: {
        amount: parseFloat(amount),
        receipt_path: result.filepath,
        payment_method: method,
      },
    });
    setSuccess(t("saleLoggedReceipt"));
    onSaleCreated?.();
    setTimeout(() => { setSuccess(""); closeModal(); }, 2000);
  };

  const confirmExpense = async () => {
    if (!amount) return;
    // Use OCR-parsed date when available, else today. Owner sees the
    // date field rendered below before confirming so they can override.
    const expenseDate = parsedDate || localIso();
    const payload = {
      amount: parseFloat(amount),
      description: desc || "Receipt scan",
      date: expenseDate,
      payment_method: method,
      // Pass the OCR-saved photo path so the saved Expense row carries
      // it. Schema-level cap (500 chars) is enforced server-side. This
      // is what enables the post-save "View receipt" affordance from
      // the Expenses list.
      receipt_photo: result?.filepath || null,
    };
    if (parsedCategoryId) {
      payload.category_id = parsedCategoryId;
    }
    await api.post("/expenses", payload);
    setSuccess("Expense added from receipt");
    onSaved?.();
    setTimeout(() => { setSuccess(""); closeModal(); }, 2000);
  };

  const closeModal = () => {
    setOpen(false);
    setResult(null);
    setPreview(null);
    setAmount("");
    setDesc("");
    setParsedDate("");
    setParsedCategoryId("");
    setCapError(null);
    onClose?.();
  };

  const modalTitle = isExpense ? "Scan Expense Receipt" : t("uploadReceipt");

  return (
    <>
      {/* Only show the trigger button in sale mode */}
      {!isExpense && (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800/50 transition shadow-sm"
        >
          <Camera size={16} />
          {t("snapReceipt")}
        </button>
      )}

      <Modal open={open} onClose={closeModal} title={modalTitle}>
        {success ? (
          <div className="bg-gray-50 text-gray-700 px-4 py-6 rounded-xl text-center font-medium">
            {success}
          </div>
        ) : (
          <div className="space-y-4">
            {/* MOMS toggle — show before file picker so the owner picks
                whether the receipt amounts are gross (with VAT) or net.
                Default 'with-moms' covers most printed Danish receipts.
                Currently informational at the per-sale level — MOMS is
                computed at daily-close — but sent to backend for future
                per-receipt VAT awareness. */}
            {/* Tier-cap reached — show upgrade prompt instead of file
                picker. Cleared when user closes modal so they can retry
                next month or upgrade and reopen immediately. */}
            {capError && (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 p-4 text-sm text-amber-800 dark:text-amber-200 space-y-2">
                <div className="font-semibold flex items-center gap-2">
                  <Camera size={16} />
                  Receipt scans this month: {capError.used} / {capError.cap}
                </div>
                <p className="text-xs leading-relaxed">
                  {/* App Store compliance (Apple 3.1.1): on native, show a
                      neutral cap line — never the server's "Upgrade to Starter"
                      pitch. Web keeps the upgrade copy. */}
                  {isNativeApp()
                    ? "You've reached this month's receipt scan limit on your plan."
                    : (capError.message || "Upgrade to Starter for 200 receipt scans / month.")}
                </p>
                {canPurchaseInApp() && (
                  <a
                    href="/subscription"
                    className="inline-block px-3 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition"
                  >
                    See plans →
                  </a>
                )}
              </div>
            )}

            {!preview && !capError && (
              <div className="flex items-center justify-center gap-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Receipt amounts are:
                </span>
                <button
                  onClick={() => setMomsMode("with-moms")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                    momsMode === "with-moms"
                      ? "bg-blue-600 text-white shadow"
                      : "bg-white dark:bg-gray-600 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-500 hover:bg-gray-100 dark:hover:bg-gray-500"
                  }`}>
                  with MOMS
                </button>
                <button
                  onClick={() => setMomsMode("without-moms")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                    momsMode === "without-moms"
                      ? "bg-blue-600 text-white shadow"
                      : "bg-white dark:bg-gray-600 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-500 hover:bg-gray-100 dark:hover:bg-gray-500"
                  }`}>
                  without MOMS
                </button>
              </div>
            )}

            {!preview && !capError && (
              <>
                {/* Two buttons on iOS: 'Take Photo' opens the rear
                    camera directly (capture="environment"); 'Choose
                    Photo' opens the photo library / files picker.
                    Same split as daily close + smart import for
                    consistency. Big iPhone photos auto-resize via
                    handleFile → resizeImageIfLarge before upload. */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => {
                      if (fileRef.current) {
                        fileRef.current.setAttribute("capture", "environment");
                        fileRef.current.click();
                      }
                    }}
                    className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-6 text-center hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition group"
                  >
                    <div className="flex justify-center mb-1 group-hover:scale-110 transition text-gray-700 dark:text-gray-300">
                      <Camera size={28} strokeWidth={1.5} />
                    </div>
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {t("takePhoto") || "Take Photo"}
                    </p>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                      Opens camera
                    </p>
                  </button>
                  <button
                    onClick={() => {
                      if (fileRef.current) {
                        fileRef.current.removeAttribute("capture");
                        fileRef.current.click();
                      }
                    }}
                    className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-6 text-center hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition group"
                  >
                    <div className="flex justify-center mb-1 group-hover:scale-110 transition text-gray-700 dark:text-gray-300">
                      <ImageIcon size={28} strokeWidth={1.5} />
                    </div>
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      Choose Photo
                    </p>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                      From library or files
                    </p>
                  </button>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFile}
                  className="hidden"
                />
              </>
            )}

            {preview && (
              <div>
                <div className="relative">
                  {/* Cropped thumbnail — keeps the modal compact while
                      OCR runs. object-contain on a fixed-height row
                      means tall receipts show top + scale-to-fit, not
                      a cover-crop that hides the totals row at the
                      bottom (which was the original bug). */}
                  <div className="bg-gray-50 dark:bg-gray-700/40 rounded-xl h-48 flex items-center justify-center overflow-hidden">
                    <img
                      src={preview}
                      alt="Receipt"
                      className="max-h-48 w-auto object-contain"
                    />
                  </div>
                  <button
                    onClick={() => { setPreview(null); setResult(null); setAmount(""); }}
                    className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white w-7 h-7 rounded-full text-sm transition"
                    aria-label={t("clear") || "Clear"}
                  >
                    &times;
                  </button>
                </div>
                {/* Review-receipt link — opens the full-size viewer with
                    OCR text + detected-amount highlights. Surfaces only
                    after OCR finishes (so we can pass detectedAmounts /
                    suggested into the viewer). */}
                {result && !uploading && (
                  <button
                    type="button"
                    onClick={() => setReviewOpen(true)}
                    className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    🔍 {t("receiptViewerReviewLink") || "Review receipt full-size"}
                  </button>
                )}
              </div>
            )}

            {uploading && (
              <div className="text-center py-4">
                <div className="inline-block w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mb-2"></div>
                <p className="text-sm text-blue-600 font-medium">{t("scanningReceipt")}</p>
                <p className="text-xs text-gray-400 mt-1">This may take 10-20 seconds...</p>
              </div>
            )}

            {result && !uploading && (
              <div>
                {result.suggested_amount ? (
                  <div className="bg-gray-50 border border-gray-100 p-3 rounded-lg mb-3">
                    <p className="text-gray-700 text-sm font-medium">
                      {t("detectedAmount")}: {result.suggested_amount.toLocaleString()} DKK
                    </p>
                    {result.all_amounts_found.length > 1 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {result.all_amounts_found.map((a, i) => (
                          <button
                            key={i}
                            onClick={() => setAmount(String(a))}
                            className={`px-2 py-1 rounded text-xs border transition ${
                              amount === String(a)
                                ? "bg-gray-100 border-gray-200 text-gray-700"
                                : "border-gray-200 text-gray-600 hover:bg-gray-50"
                            }`}
                          >
                            {a.toLocaleString()}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Claude Vision's free-text notes — surfaces any
                        ambiguity the model self-reported ("Milk line
                        amount could be 30 or 36 — partial occlusion").
                        Honesty-first: if the model flagged uncertainty,
                        the owner sees it BEFORE saving. */}
                    {result.claude_notes && (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-2 italic">
                        ℹ {result.claude_notes}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="bg-yellow-50 border border-yellow-200 p-3 rounded-lg mb-3">
                    <p className="text-yellow-700 text-sm">
                      {result.ocr_available ? t("couldntRead") : t("ocrNotAvailable")}
                    </p>
                  </div>
                )}

                {result.raw_text && (
                  <details className="mb-3">
                    <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                      {t("receiptText") || "Receipt text recognized"}
                    </summary>
                    <pre className="mt-2 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-600">
                      {result.raw_text}
                    </pre>
                  </details>
                )}

                {/* Per-field "verify this" hint — derived from
                    Claude Vision's self-reported confidence. Threshold
                    0.85: anything below means the model was uncertain
                    enough that the owner should double-check before
                    saving. Honesty-first: confidence is the model's
                    real uncertainty, not a heuristic. */}
                {(() => {
                  const conf = result?.confidence_per_field?.total;
                  const isLow = typeof conf === "number" && conf < 0.85;
                  return isLow && result?.confidence_per_field ? (
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                      Verify the amount — confidence {Math.round((conf || 0) * 100)}%.
                    </p>
                  ) : null;
                })()}

                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={t("enterTotal")}
                  className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-gray-900 mb-3"
                  autoFocus
                />

                {/* Description (pre-filled with OCR vendor) — expense mode */}
                {isExpense && (() => {
                  const conf = result?.confidence_per_field?.vendor;
                  const isLow = typeof conf === "number" && conf < 0.85;
                  return (
                    <div className="mb-3">
                      {isLow && (
                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                          Verify the vendor — confidence {Math.round(conf * 100)}%.
                        </p>
                      )}
                      <input
                        type="text"
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        placeholder={
                          result?.suggested_vendor
                            ? `Vendor (we found: ${result.suggested_vendor})`
                            : "Description / vendor (optional)"
                        }
                        className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                      />
                    </div>
                  );
                })()}

                {/* Date row — pre-filled by OCR-parsed receipt date,
                    fallback to today. Owner sees what we read so they
                    catch back-dated mistakes before saving. */}
                {isExpense && (() => {
                  const conf = result?.confidence_per_field?.date;
                  const isLow = typeof conf === "number" && conf < 0.85;
                  return (
                    <div className="mb-3">
                      {isLow && (
                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                          Verify the date — confidence {Math.round(conf * 100)}%.
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                          Date
                        </span>
                        <input
                          type="date"
                          value={parsedDate || ""}
                          onChange={(e) => setParsedDate(e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                        />
                        {result?.suggested_date && !isLow && (
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0">
                            ✓ from receipt
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Suggested-category chip — shown only when OCR
                    matched a vendor and the user already has that
                    category. Tap to confirm (sets the id), tap × to
                    skip and pick manually after save. */}
                {isExpense && result?.suggested_category && (
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 rounded-lg">
                    <span className="text-xs text-gray-700 dark:text-gray-300">
                      Category guess:
                    </span>
                    <button
                      type="button"
                      onClick={() => setParsedCategoryId(result.suggested_category.category_id)}
                      className={`px-2 py-0.5 rounded-md text-xs font-medium transition ${
                        parsedCategoryId === result.suggested_category.category_id
                          ? "bg-gray-900 text-white"
                          : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {parsedCategoryId === result.suggested_category.category_id ? "✓ " : ""}
                      {result.suggested_category.category_name}
                    </button>
                    {parsedCategoryId === result.suggested_category.category_id && (
                      <button
                        type="button"
                        onClick={() => setParsedCategoryId("")}
                        className="ml-auto text-xs text-gray-500 hover:text-gray-700"
                        aria-label="Clear category"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5 mb-4">
                  {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                    <button
                      key={m}
                      onClick={() => setMethod(m)}
                      className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                        method === m
                          ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                          : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                      }`}
                    >
                      {t(m)}
                    </button>
                  ))}
                </div>

                <button
                  onClick={isExpense ? confirmExpense : confirmSale}
                  disabled={!amount}
                  className="w-full bg-blue-600 text-white py-3.5 rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-40"
                >
                  {isExpense ? "Add Expense" : t("confirmLog")}
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Pre-save review modal — full image + OCR text with amounts
          highlighted. The same component is reused on Sales / Expenses
          list rows for post-save review (then with no OCR text since
          we don't persist it). */}
      <ReceiptViewer
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        imageUrl={preview}
        amount={amount ? parseFloat(amount) : result?.suggested_amount}
        currency="DKK"
        date={localIso()}
        paymentMethod={method}
        description={desc}
        ocrText={result?.raw_text}
        detectedAmounts={result?.all_amounts_found}
        suggestedAmount={result?.suggested_amount}
        kind={isExpense ? "expense" : "sale"}
      />
    </>
  );
}
