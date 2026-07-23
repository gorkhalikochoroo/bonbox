import { useState, useRef } from "react";
import { Camera, ImageIcon, Search, Info, Check, ChevronDown } from "lucide-react";
import Modal from "./Modal";
import ReceiptViewer from "./ReceiptViewer";
import Chip from "./ui/Chip";
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
  // Expense mode starts UNSET — the receipt tells us how it was paid, and
  // when it doesn't, the owner does. It used to default to "card", which
  // silently booked every cash purchase as a card one.
  const [method, setMethod] = useState(isExpense ? "" : "mixed");
  // Payment picker stays collapsed on the OCR confirm — after the scan the
  // amount + confirm are what matter; method is almost always card. One tap
  // expands the chips. (design critique: don't make the owner scan 6 equal
  // options before the one thing that matters.)
  const [methodOpen, setMethodOpen] = useState(false);
  // True only when the METHOD CAME OFF THE RECEIPT, so the confirm screen
  // can say "read from the receipt" rather than implying we verified a
  // default we actually guessed.
  const [methodRead, setMethodRead] = useState(false);
  // Per-vendor memory for the payment method, when the receipt itself
  // didn't say: {value, evidence_n, band, vendor_label}. Rendered as a
  // countable sentence ("kort — som de sidste 6 gange hos Netto") rather
  // than a confidence score, so the owner can check the claim.
  const [learnedMethod, setLearnedMethod] = useState(null);
  // Save failed — shown inline above the confirm button. Before this,
  // a rejected POST /expenses left the modal sitting there looking fine
  // with nothing saved.
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
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
    // Provenance belongs to ONE receipt. Reset before the next upload so
    // a failure mid-scan can't leave the previous vendor's memory line
    // attached to a different receipt.
    setLearnedMethod(null);
    setMethodRead(false);
    setSaveError("");
    const file = await resizeImageIfLarge(rawFile);

    const formData = new FormData();
    formData.append("file", file);

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
        // Only PREFILL-band memory preselects the category. A
        // cold-start keyword guess (band "suggest", evidence_n 0) is
        // shown highlighted but unselected, so the owner's tap is what
        // becomes the agreement — otherwise a frozen constant would
        // bootstrap itself into "learned" history, and category carries
        // the §42 fradrag class, so that moves real købsmoms.
        if (res.data.suggested_category?.category_id
            && res.data.suggested_category.band === "prefill") {
          setParsedCategoryId(res.data.suggested_category.category_id);
        }
        // Payment method READ OFF the receipt ("Kontant" / "Dankort" /
        // "MobilePay"). Null when the paper doesn't say — then we leave
        // the picker unset and open, so the owner tells us instead of us
        // booking a cash purchase as card and quietly breaking their
        // cash position.
        if (res.data.suggested_payment_method) {
          setMethod(res.data.suggested_payment_method);
          setMethodRead(true);
        } else if (res.data.learned_payment_method?.band === "prefill") {
          // PAPER BEATS MEMORY — we only get here because the receipt
          // didn't say. This is replayed from the owner's own confirmed
          // history at this supplier, so it's labelled as memory, never
          // as "read from the receipt".
          setMethod(res.data.learned_payment_method.value);
          setMethodRead(false);
          setLearnedMethod(res.data.learned_payment_method);
        } else if (res.data.learned_payment_method?.band === "suggest") {
          // Two sightings is a hint, not a habit: highlight the chip but
          // do NOT preselect, so Save stays disabled exactly as today.
          // The owner's tap IS the third agreement.
          setMethod("");
          setMethodOpen(true);
          setLearnedMethod(res.data.learned_payment_method);
        } else {
          setMethod("");
          setMethodOpen(true);
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
      description: desc || t("receiptScanDefaultDesc"),
      date: expenseDate,
      payment_method: method,
      // Pass the OCR-saved photo path so the saved Expense row carries
      // it. Schema-level cap (500 chars) is enforced server-side. This
      // is what enables the post-save "View receipt" affordance from
      // the Expenses list.
      receipt_photo: result?.filepath || null,
    };
    // Only sent when the vendor→category guess actually hit. When it
    // misses we omit it and the server files the expense under "Andet"
    // — the scan must never be lost because a guess didn't land.
    if (parsedCategoryId) {
      payload.category_id = parsedCategoryId;
    }
    // The OCR's raw vendor line, kept separate from `description` because
    // description is owner-editable — keying memory on it is what made
    // the old learn/suggest loop write and read different names.
    if (result?.suggested_vendor) {
      payload.vendor_hint = result.suggested_vendor;
    }
    // What we PROPOSED before the owner touched anything. The server
    // compares this to what actually got saved: a different value is a
    // CORRECTION, and recording an override as agreement is how a wrong
    // habit cements itself.
    const proposed = {};
    if (learnedMethod?.band === "prefill") proposed.payment_method = learnedMethod.value;
    // Only when it was actually preselected — that is exactly when a
    // different saved value means the owner overrode us.
    if (result?.suggested_category?.band === "prefill"
        && parsedCategoryId === result.suggested_category.category_id) {
      proposed.category_name = result.suggested_category.category_name;
    }
    if (Object.keys(proposed).length) payload.autofill = proposed;

    setSaving(true);
    setSaveError("");
    try {
      await api.post("/expenses", payload);
    } catch (err) {
      // Previously unhandled: the promise rejected, the modal kept
      // showing the scanned receipt, and nothing was saved.
      const detail = err?.response?.data?.detail;
      setSaveError(
        (typeof detail === "string" && detail) || t("expenseSaveFailed"),
      );
      trackEvent("receipt_expense_save_error", mode, err.message);
      setSaving(false);
      return;
    }
    setSaving(false);
    setSuccess(t("expenseAddedFromReceipt"));
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
    setMethod(isExpense ? "" : "mixed");
    setMethodRead(false);
    setLearnedMethod(null);
    setMethodOpen(false);
    setSaveError("");
    setSaving(false);
    onClose?.();
  };

  const modalTitle = isExpense ? t("scanExpenseReceipt") : t("uploadReceipt");

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
            {/* Tier-cap reached — show upgrade prompt instead of file
                picker. Cleared when user closes modal so they can retry
                next month or upgrade and reopen immediately. */}
            {capError && (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 p-4 text-sm text-amber-800 dark:text-amber-200 space-y-2">
                <div className="font-semibold flex items-center gap-2">
                  <Camera size={16} />
                  {t("receiptScansThisMonth")}: {capError.used} / {capError.cap}
                </div>
                <p className="text-xs leading-relaxed">
                  {/* App Store compliance (Apple 3.1.1): on native, show a
                      neutral cap line — never the server's "Upgrade to Starter"
                      pitch. Web keeps the upgrade copy. */}
                  {isNativeApp()
                    ? t("receiptScanLimitReached")
                    : (capError.message || t("receiptScanUpgradeCopy"))}
                </p>
                {canPurchaseInApp() && (
                  <a
                    href="/subscription"
                    className="inline-block px-3 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition"
                  >
                    {t("seePlans")} →
                  </a>
                )}
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
                    className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-6 text-center hover:border-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition group"
                  >
                    <div className="flex justify-center mb-1 group-hover:scale-110 transition text-gray-700 dark:text-gray-300">
                      <Camera size={28} strokeWidth={1.5} />
                    </div>
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {t("takePhoto")}
                    </p>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                      {t("opensCamera")}
                    </p>
                  </button>
                  <button
                    onClick={() => {
                      if (fileRef.current) {
                        fileRef.current.removeAttribute("capture");
                        fileRef.current.click();
                      }
                    }}
                    className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-6 text-center hover:border-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition group"
                  >
                    <div className="flex justify-center mb-1 group-hover:scale-110 transition text-gray-700 dark:text-gray-300">
                      <ImageIcon size={28} strokeWidth={1.5} />
                    </div>
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {t("choosePhoto")}
                    </p>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                      {t("fromLibraryOrFiles")}
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
                      alt={t("rcReceiptImageAlt", "Receipt")}
                      className="max-h-48 w-auto object-contain"
                    />
                  </div>
                  <button
                    onClick={() => {
                      setPreview(null); setResult(null); setAmount("");
                      // Drop this receipt's provenance with it — otherwise
                      // the next scan inherits the previous vendor's memory.
                      setLearnedMethod(null); setMethodRead(false);
                      setParsedCategoryId(""); setParsedDate("");
                      setMethod(isExpense ? "" : "mixed");
                    }}
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
                    className="mt-2 text-xs text-gray-600 dark:text-gray-300 hover:underline inline-flex items-center gap-1"
                  >
                    <Search size={12} aria-hidden="true" /> {t("receiptViewerReviewLink")}
                  </button>
                )}
              </div>
            )}

            {uploading && (
              <div className="text-center py-4">
                <div className="inline-block w-8 h-8 border-3 border-gray-900 dark:border-gray-100 border-t-transparent rounded-full animate-spin mb-2"></div>
                <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">{t("scanningReceipt")}</p>
                <p className="text-xs text-gray-400 mt-1">{t("ocrMayTake")}</p>
              </div>
            )}

            {result && !uploading && (
              <div>
                {result.suggested_amount ? (
                  <div className="bg-gray-50 border border-gray-100 p-3 rounded-lg mb-3">
                    <p className="text-gray-700 text-sm font-medium">
                      {t("detectedAmount")}: {result.suggested_amount.toLocaleString()} DKK
                    </p>
                    {/* Honest VAT disclosure — only when the OCR endpoint
                        actually returned a computed MOMS figure. Uses the
                        endpoint's own vat_rate (never a hardcoded 25%, which
                        would be wrong for B2B / zero-rated owners). */}
                    {typeof result.vat_amount === "number" && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {t("herafMoms")} ({Math.round((result.vat_rate || 0.25) * 100)}%): {result.vat_amount.toLocaleString()} DKK
                      </p>
                    )}
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
                      <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-2 italic inline-flex items-start gap-1">
                        <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {result.claude_notes}
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
                      {t("verifyAmountConfidence")} {Math.round((conf || 0) * 100)}%.
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
                          {t("verifyVendorConfidence")} {Math.round(conf * 100)}%.
                        </p>
                      )}
                      <input
                        type="text"
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        placeholder={
                          result?.suggested_vendor
                            ? `${t("vendorFoundPrefix")} ${result.suggested_vendor}`
                            : t("descriptionVendorOptional")
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
                          {t("verifyDateConfidence")} {Math.round(conf * 100)}%.
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                          {t("date")}
                        </span>
                        <input
                          type="date"
                          value={parsedDate || ""}
                          onChange={(e) => setParsedDate(e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                        />
                        {result?.suggested_date && !isLow && (
                          <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0 inline-flex items-center gap-0.5">
                            <Check size={12} aria-hidden="true" /> {t("fromReceipt")}
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
                      {t("categoryGuess")}
                    </span>
                    <button
                      type="button"
                      onClick={() => setParsedCategoryId(result.suggested_category.category_id)}
                      className={`px-2 py-0.5 rounded-md text-xs font-medium transition inline-flex items-center gap-1 ${
                        parsedCategoryId === result.suggested_category.category_id
                          ? "bg-gray-900 text-white"
                          : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {parsedCategoryId === result.suggested_category.category_id && (
                        <Check size={12} aria-hidden="true" />
                      )}
                      {result.suggested_category.category_name}
                    </button>
                    {parsedCategoryId === result.suggested_category.category_id && (
                      <button
                        type="button"
                        onClick={() => setParsedCategoryId("")}
                        className="ml-auto text-xs text-gray-500 hover:text-gray-700"
                        aria-label={t("clearCategory")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}

                <div className="mb-4">
                  {/* Collapse to the one-line summary only when we HAVE a
                      method. Unset (OCR couldn't read it, or the upload
                      failed) always shows the chips — there is nothing
                      honest to collapse into. */}
                  {!methodOpen && method ? (
                    <button
                      type="button"
                      onClick={() => setMethodOpen(true)}
                      className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
                    >
                      {t("paidWith", "Paid with")}:{" "}
                      <span className="font-medium text-gray-700 dark:text-gray-200">{t(method)}</span>
                      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  ) : (
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("paymentMethod", "Payment method")}>
                      {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                        <Chip
                          key={m}
                          size="sm"
                          selected={method === m}
                          onClick={() => {
                            setMethod(m); setMethodOpen(false); setMethodRead(false);
                            // The owner has taken this field over — drop the
                            // memory provenance rather than let it describe a
                            // value they just replaced.
                            if (learnedMethod && m !== learnedMethod.value) setLearnedMethod(null);
                          }}
                        >
                          {t(m)}
                        </Chip>
                      ))}
                    </div>
                  )}
                  {/* Provenance. Exactly ONE of these may render for the
                      field, and which one is the honesty guarantee:
                        detected → "Read from the receipt"
                        learned  → "Card — same as the last 6 times at Netto"
                        assumed  → nothing is assumed; we ask instead.
                      A learned value must never wear the detected label —
                      that would claim the paper said something it didn't. */}
                  {isExpense && methodRead && (
                    <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                      {t("paymentMethodFromReceipt", "Read from the receipt")}
                    </p>
                  )}
                  {isExpense && !methodRead && method && learnedMethod?.band === "prefill" && (
                    <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                      {t("paymentMethodLearned", "{method} — same as the last {n} times at {vendor}")
                        .replace("{method}", t(learnedMethod.value))
                        .replace("{n}", String(learnedMethod.evidence_n))
                        .replace("{vendor}", learnedMethod.vendor_label || "")}
                    </p>
                  )}
                  {isExpense && !method && learnedMethod?.band === "suggest" && (
                    <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                      {t("paymentMethodUsually", "You usually pay {method} here — tap to confirm")
                        .replace("{method}", t(learnedMethod.value))}
                    </p>
                  )}
                  {isExpense && !method && !learnedMethod && (
                    <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                      {t("paymentMethodAsk", "The receipt doesn't say how it was paid — pick one")}
                    </p>
                  )}
                </div>

                {/* Pinned action footer. Modal is max-h-[90vh] with a
                    scrolling body, so on a phone the confirm button used
                    to sit below the fold under the preview + fields +
                    payment chips — the primary action, invisible, with
                    nothing hinting you had to scroll for it. Sticky keeps
                    it on screen while the rest scrolls under it.
                    No transform here on purpose (transform on a sticky
                    child inside a touch scroller causes the iOS wobble). */}
                <div className="sticky bottom-0 -mx-1 px-1 pt-2 pb-1 bg-white dark:bg-gray-800 border-t border-gray-100 dark:border-gray-700">
                  {saveError && (
                    <div
                      role="alert"
                      className="mb-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 px-3 py-2 text-sm text-red-700 dark:text-red-300"
                    >
                      {saveError}
                    </div>
                  )}

                  <button
                    onClick={isExpense ? confirmExpense : confirmSale}
                    disabled={!amount || saving || (isExpense && !method)}
                    className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 py-3.5 rounded-xl hover:bg-gray-700 dark:hover:bg-white transition font-semibold disabled:opacity-40"
                  >
                    {isExpense ? t("addExpense") : t("confirmLog")}
                  </button>
                </div>
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
