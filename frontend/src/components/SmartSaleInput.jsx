import { useEffect, useRef, useState } from "react";
import api from "../services/api";
import Modal from "./Modal";

/**
 * Smart Sale Entry — type natural language, AI parses to structured items,
 * user reviews + confirms, frontend posts each line as a Sale.
 *
 * Renders ONLY pure text — names and prices come from a backend-validated
 * response. The backend already cross-checks names against the user's
 * inventory and overrides AI-supplied prices with the DB sell_price for
 * any matched item, so the values shown here are trustworthy.
 *
 * Flow:
 *   1. User types in textarea, clicks Parse
 *   2. We POST /api/ai/parse-sale, render the preview
 *   3. User can edit qty / price / payment method, remove lines, etc.
 *   4. On Confirm, we POST each line to /api/sales (existing endpoint).
 *      Each line is a separate Sale row — same as the manual Quick Add
 *      sale flow does today.
 */
export default function SmartSaleInput({ open, onClose, onSaved }) {
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const taRef = useRef(null);

  useEffect(() => {
    if (open) {
      // Reset on each open so a previous parse doesn't leak through
      setText("");
      setParsed(null);
      setParseError("");
      setPaymentMethod("");
      setSavedCount(0);
      // Autofocus textarea after the modal animates in
      setTimeout(() => taRef.current?.focus(), 80);
    }
  }, [open]);

  if (!open) return null;

  const onParse = async () => {
    if (text.trim().length < 5 || parsing) return;
    setParsing(true);
    setParseError("");
    setParsed(null);
    try {
      const res = await api.post("/ai/parse-sale", { text: text.trim() });
      const data = res.data || {};
      if (data.error) {
        setParseError(data.error);
      }
      // Always try to render whatever items came back, even if there's a soft error
      if (Array.isArray(data.items) && data.items.length > 0) {
        // Local copy so the user can edit quantities/prices in-place
        const lines = data.items.map((it) => ({
          name: it.name || "",
          qty: it.qty || 1,
          unit_price: it.unit_price ?? null,
          inventory_item_id: it.inventory_item_id || null,
          matched: !!it.matched,
        }));
        setParsed({ ...data, lines });
        if (data.payment_method) setPaymentMethod(data.payment_method);
      }
    } catch (err) {
      setParseError(err?.response?.data?.detail || "Could not parse — please try again.");
    } finally {
      setParsing(false);
    }
  };

  const updateLine = (i, patch) => {
    setParsed((prev) => {
      if (!prev) return prev;
      const lines = prev.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
      return { ...prev, lines };
    });
  };

  const removeLine = (i) => {
    setParsed((prev) => {
      if (!prev) return prev;
      return { ...prev, lines: prev.lines.filter((_, idx) => idx !== i) };
    });
  };

  const linesTotal = (parsed?.lines || []).reduce((acc, l) => {
    const q = parseFloat(l.qty);
    const p = parseFloat(l.unit_price);
    if (!isFinite(q) || !isFinite(p)) return acc;
    return acc + q * p;
  }, 0);

  const onConfirm = async () => {
    if (!parsed || !parsed.lines || parsed.lines.length === 0 || saving) return;
    // Validate every line client-side too — never trust the parse output blindly
    const today = new Date().toISOString().split("T")[0];
    const validLines = parsed.lines.filter((l) => {
      const q = parseFloat(l.qty);
      const p = parseFloat(l.unit_price);
      return isFinite(q) && q > 0 && isFinite(p) && p > 0 && (l.name || "").trim().length > 0;
    });
    if (validLines.length === 0) {
      setParseError("Please fill in name, quantity, and price for at least one line.");
      return;
    }
    setSaving(true);
    setParseError("");
    let saved = 0;
    let failed = 0;
    for (const l of validLines) {
      try {
        const body = {
          date: today,
          payment_method: paymentMethod || "mixed",
          quantity_sold: parseFloat(l.qty),
          unit_price: parseFloat(l.unit_price),
          amount: parseFloat(l.qty) * parseFloat(l.unit_price),
        };
        if (l.inventory_item_id) body.inventory_item_id = l.inventory_item_id;
        else body.notes = l.name;  // unmatched: store the name in notes since
                                   // there's no inventory_item_id to attach
        await api.post("/sales", body);
        saved++;
      } catch (e) {
        failed++;
      }
    }
    setSavedCount(saved);
    setSaving(false);
    if (saved > 0) {
      window.dispatchEvent(new Event("bonbox-data-changed"));
      if (onSaved) onSaved(saved);
      // Close after a short success peek
      setTimeout(() => onClose?.(), 900);
    } else {
      setParseError(`Could not save (${failed} failed). Please try the manual form.`);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Smart Sale Entry">
      <div className="space-y-4">
        <div>
          <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            What did you sell?
          </label>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. 3 espressos and 1 croissant for 95 DKK on cash"
            rows={3}
            maxLength={500}
            className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-[14.5px] text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#22c55e] focus:border-[#22c55e] resize-none"
          />
          <p className="text-[11px] text-gray-400 mt-1">{text.length}/500 characters</p>
        </div>

        {!parsed && (
          <button
            type="button"
            onClick={onParse}
            disabled={text.trim().length < 5 || parsing}
            className="w-full bg-[#22c55e] text-white py-2.5 rounded-lg text-[14px] font-medium hover:bg-[#16a34a] disabled:opacity-60 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
          >
            {parsing ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Parsing…
              </>
            ) : (
              "Parse with AI"
            )}
          </button>
        )}

        {parseError && (
          <div role="alert" className="text-[13px] text-amber-700 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-300 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800/60">
            {parseError}
          </div>
        )}

        {parsed && parsed.lines && parsed.lines.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-[12px] text-gray-500 dark:text-gray-400">
              <span>
                {parsed.unrecognized_count > 0
                  ? `${parsed.lines.length - parsed.unrecognized_count} matched · ${parsed.unrecognized_count} new`
                  : `${parsed.lines.length} item${parsed.lines.length > 1 ? "s" : ""} matched`}
              </span>
              <span>Confidence: {Math.round((parsed.confidence || 0) * 100)}%</span>
            </div>

            <div className="space-y-2">
              {parsed.lines.map((l, i) => (
                <div key={i} className={`flex items-center gap-2 p-2.5 rounded-lg border ${l.matched ? "border-gray-200 dark:border-gray-700/60 bg-gray-50/50 dark:bg-gray-800/40" : "border-amber-200 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-900/10"}`}>
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={l.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      className="w-full bg-transparent text-[14px] font-medium text-gray-900 dark:text-white outline-none"
                    />
                    {!l.matched && (
                      <p className="text-[10.5px] text-amber-700 dark:text-amber-400 mt-0.5">
                        Not in inventory — saved as note
                      </p>
                    )}
                  </div>
                  <input
                    type="number"
                    value={l.qty}
                    onChange={(e) => updateLine(i, { qty: e.target.value })}
                    min="0"
                    step="any"
                    aria-label="Quantity"
                    className="w-16 px-2 py-1.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded text-[13px] text-right text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#22c55e]/40"
                  />
                  <span className="text-[12px] text-gray-400">×</span>
                  <input
                    type="number"
                    value={l.unit_price ?? ""}
                    onChange={(e) => updateLine(i, { unit_price: e.target.value })}
                    placeholder="Price"
                    min="0"
                    step="any"
                    aria-label="Unit price"
                    className="w-20 px-2 py-1.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded text-[13px] text-right text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-[#22c55e]/40"
                  />
                  <span className="text-[10.5px] uppercase tracking-wider text-gray-400">{parsed.currency}</span>
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    aria-label="Remove line"
                    title="Remove line"
                    className="w-7 h-7 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition flex items-center justify-center"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                aria-label="Payment method"
                className="flex-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-[13.5px] text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-[#22c55e]/40"
              >
                <option value="">Payment method…</option>
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="mobilepay">MobilePay</option>
                <option value="dankort">Dankort</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="mixed">Mixed</option>
              </select>
              <div className="text-[14px] font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                {Math.round(linesTotal).toLocaleString()} {parsed.currency}
              </div>
            </div>

            {savedCount > 0 ? (
              <div className="text-[13px] text-green-700 bg-green-50 dark:bg-green-900/20 dark:text-green-300 px-3 py-2 rounded-lg border border-green-200 dark:border-green-800/60">
                ✓ {savedCount} sale{savedCount > 1 ? "s" : ""} logged
              </div>
            ) : (
              <button
                type="button"
                onClick={onConfirm}
                disabled={saving}
                className="w-full bg-[#22c55e] text-white py-2.5 rounded-lg text-[14px] font-medium hover:bg-[#16a34a] disabled:opacity-60 disabled:cursor-not-allowed transition"
              >
                {saving ? "Saving…" : `Confirm & log ${parsed.lines.length} line${parsed.lines.length > 1 ? "s" : ""}`}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
