import { useState, useRef } from "react";
import Modal from "./Modal";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";

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
  const fileRef = useRef();

  const uploadEndpoint = isExpense ? "/expenses/upload-receipt" : "/sales/upload-receipt";

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    setResult(null);

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
    } catch (err) {
      setResult({ suggested_amount: null, all_amounts_found: [], ocr_available: false });
      trackEvent("receipt_scan_error", mode, err.message);
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
    const today = new Date().toISOString().split("T")[0];
    await api.post("/expenses", {
      amount: parseFloat(amount),
      description: desc || "Receipt scan",
      date: today,
      payment_method: method,
    });
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
    onClose?.();
  };

  const modalTitle = isExpense ? "Scan Expense Receipt" : t("uploadReceipt");

  return (
    <>
      {/* Only show the trigger button in sale mode */}
      {!isExpense && (
        <button
          onClick={() => setOpen(true)}
          className="px-4 py-2.5 bg-orange-50 text-orange-700 border border-orange-200 rounded-lg text-sm font-medium hover:bg-orange-100 transition"
        >
          {t("snapReceipt")}
        </button>
      )}

      <Modal open={open} onClose={closeModal} title={modalTitle}>
        {success ? (
          <div className="bg-green-50 text-green-700 px-4 py-6 rounded-xl text-center font-medium">
            {success}
          </div>
        ) : (
          <div className="space-y-4">
            {!preview && (
              <label className="block border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition group">
                <svg className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-500 group-hover:text-blue-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <circle cx="12" cy="13" r="3" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} />
                </svg>
                <p className="text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">{t("takePhoto")}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{t("photoOrGallery")}</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFile}
                  className="hidden"
                />
              </label>
            )}

            {preview && (
              <div className="relative">
                <img src={preview} alt="Receipt" className="w-full h-48 object-cover rounded-xl" />
                <button
                  onClick={() => { setPreview(null); setResult(null); setAmount(""); }}
                  className="absolute top-2 right-2 bg-black/50 text-white w-7 h-7 rounded-full text-sm"
                >
                  &times;
                </button>
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
                  <div className="bg-green-50 border border-green-200 p-3 rounded-lg mb-3">
                    <p className="text-green-700 text-sm font-medium">
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
                                ? "bg-green-100 border-green-300 text-green-700"
                                : "border-gray-200 text-gray-600 hover:bg-gray-50"
                            }`}
                          >
                            {a.toLocaleString()}
                          </button>
                        ))}
                      </div>
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

                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={t("enterTotal")}
                  className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
                  autoFocus
                />

                {/* Description field for expense mode */}
                {isExpense && (
                  <input
                    type="text"
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
                  />
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
    </>
  );
}
