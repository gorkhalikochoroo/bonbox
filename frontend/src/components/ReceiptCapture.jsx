import { useState, useRef } from "react";
import Modal from "./Modal";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

export default function ReceiptCapture({ onSaleCreated }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("mixed");
  const [preview, setPreview] = useState(null);
  const [success, setSuccess] = useState("");
  const fileRef = useRef();

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await api.post("/sales/upload-receipt", formData);
      setResult(res.data);
      if (res.data.suggested_amount) {
        setAmount(String(res.data.suggested_amount));
      }
    } catch {
      setResult({ suggested_amount: null, all_amounts_found: [], ocr_available: false });
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
    setTimeout(() => {
      setSuccess("");
      setOpen(false);
      setResult(null);
      setPreview(null);
      setAmount("");
    }, 2000);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2.5 bg-orange-50 text-orange-700 border border-orange-200 rounded-lg text-sm font-medium hover:bg-orange-100 transition"
      >
        {t("snapReceipt")}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={t("uploadReceipt")}>
        {success ? (
          <div className="bg-green-50 text-green-700 px-4 py-6 rounded-xl text-center font-medium">
            {success}
          </div>
        ) : (
          <div className="space-y-4">
            {!preview && (
              <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center">
                <p className="text-gray-500 mb-3">{t("photoOrGallery")}</p>
                <div className="flex gap-2 justify-center">
                  <label className="px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium cursor-pointer hover:bg-blue-700 transition">
                    {t("takePhoto")}
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handleFile}
                      className="hidden"
                    />
                  </label>
                  <label className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium cursor-pointer hover:bg-gray-200 transition">
                    {t("chooseFile")}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFile}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
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
              <p className="text-center text-sm text-blue-600">{t("scanningReceipt")}</p>
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

                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={t("enterTotal")}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
                  autoFocus
                />

                <div className="flex gap-2 mb-4">
                  {["cash", "card", "mobilepay", "mixed", "dankort", "kontant"].map((m) => (
                    <button
                      key={m}
                      onClick={() => setMethod(m)}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize border transition ${
                        method === m
                          ? "bg-blue-50 border-blue-300 text-blue-700"
                          : "border-gray-200 text-gray-500 hover:bg-gray-50"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>

                <button
                  onClick={confirmSale}
                  disabled={!amount}
                  className="w-full bg-blue-600 text-white py-3.5 rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-40"
                >
                  {t("confirmLog")}
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
