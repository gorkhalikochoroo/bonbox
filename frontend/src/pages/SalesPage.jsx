import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import ReceiptCapture from "../components/ReceiptCapture";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency } from "../utils/currency";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000, 7500, 10000, 15000];

export default function SalesPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [sales, setSales] = useState([]);
  const [amount, setAmount] = useState("");
  const [saleDate, setSaleDate] = useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = useState("mixed");
  const [notes, setNotes] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [listening, setListening] = useState(false);
  const [showItemSale, setShowItemSale] = useState(false);
  const [inventoryItems, setInventoryItems] = useState([]);

  const filtered = sales.filter(s => !search || s.notes?.toLowerCase().includes(search.toLowerCase()) || s.payment_method?.toLowerCase().includes(search.toLowerCase())).sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    if (d !== 0) return d;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });

  const startVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError("Voice input not supported in this browser"); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript.toLowerCase();
      // Extract number from speech
      const numMatch = text.match(/[\d,]+\.?\d*/);
      if (numMatch) {
        const val = parseFloat(numMatch[0].replace(/,/g, ""));
        if (val > 0) {
          setAmount(String(val));
          // Detect payment method
          if (text.includes("cash")) setMethod("cash");
          else if (text.includes("card")) setMethod("card");
          else if (text.includes("mobile")) setMethod("mobilepay");
          // Extract notes (everything after the number and method)
          const remaining = text.replace(numMatch[0], "").replace(/cash|card|mobilepay|mixed|dankort/g, "").trim();
          if (remaining.length > 2) setNotes(remaining);
          setSuccess(`Voice: "${text}" → ${val.toLocaleString()} ${currency}`);
          setTimeout(() => setSuccess(""), 3000);
        }
      } else {
        setError(`Couldn't parse amount from: "${text}"`);
        setTimeout(() => setError(""), 3000);
      }
    };
    recognition.onerror = () => { setListening(false); setError("Voice recognition failed"); setTimeout(() => setError(""), 3000); };
    recognition.start();
  };

  const fetchSales = async (from, to) => {
    try {
      setFetchError("");
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await api.get("/sales", { params });
      setSales(res.data);
    } catch (err) {
      setFetchError(err.response?.data?.detail || "Failed to load sales");
    }
  };
  const fetchInventory = () => {
    api.get("/inventory").then((res) => setInventoryItems(res.data)).catch(() => {});
  };

  useEffect(() => {
    fetchSales();
    fetchInventory();
    const onDataChanged = () => { fetchSales(); fetchInventory(); };
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  const submit = async (amt) => {
    const value = amt || parseFloat(amount);
    if (!value) return;
    const duplicate = sales.find(s => s.date === saleDate && parseFloat(s.amount) === value);
    if (duplicate && !confirm(`A sale of ${value.toLocaleString()} ${currency} on ${saleDate} already exists. Add another?`)) {
      return;
    }
    setError("");
    try {
      await api.post("/sales", {
        date: saleDate,
        amount: value,
        payment_method: method,
        notes: notes || null,
      });
      const isBackdated = saleDate !== new Date().toISOString().split("T")[0];
      setAmount("");
      setNotes("");
      setSaleDate(new Date().toISOString().split("T")[0]);
      trackEvent("sale_logged", "sales", `${value} ${currency} via ${method}`);
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${saleDate})` : ""}!`);
      fetchSales(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add sale");
    }
  };

  const startEdit = (sale) => {
    setEditId(sale.id);
    setEditData({
      date: sale.date,
      amount: parseFloat(sale.amount),
      payment_method: sale.payment_method,
      notes: sale.notes || "",
    });
  };

  const saveEdit = async () => {
    try {
      await api.put(`/sales/${editId}`, editData);
      setEditId(null);
      setEditData({});
      fetchSales(filterFrom, filterTo);
      setSuccess("Sale updated!");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update sale");
    }
  };

  const bulkDelete = async () => {
    if (!confirm(`Move ${selected.size} items to trash?`)) return;
    try {
      await Promise.all([...selected].map(id => api.delete(`/sales/${id}`)));
      setSelected(new Set());
      fetchSales(filterFrom, filterTo);
      setSuccess(`${selected.size} items moved to trash`);
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError("Failed to delete some items");
    }
  };

  const deleteSale = async (id) => {
    try {
      await api.delete(`/sales/${id}`);
      setDeleteConfirm(null);
      fetchSales(filterFrom, filterTo);
      setSuccess("Moved to recently deleted");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to delete sale");
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("salesTracker")}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowItemSale(true)}
            className="px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition"
          >
            + Item Sale
          </button>
          <ReceiptCapture onSaleCreated={fetchSales} />
        </div>
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {fetchError && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{fetchError}</div>}

      {/* Quick Entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">{t("logSale")}</h2>
        <p className="text-sm text-gray-400 dark:text-gray-400 mb-4">{t("tapAmount")}</p>

        {/* One-tap amounts */}
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-500 hover:text-blue-700 dark:hover:text-blue-300 transition"
            >
              {amt.toLocaleString()} {currency}
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="flex items-center gap-2">
          <button
            onClick={startVoice}
            className={`p-2.5 rounded-lg border transition flex-shrink-0 ${
              listening
                ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 animate-pulse"
                : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600"
            }`}
            title="Voice input"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </button>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            className="flex-1 px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold text-sm disabled:opacity-40"
          >
            {t("log")}
          </button>
        </div>

        {/* Payment method */}
        <div className="flex flex-wrap gap-2 mt-3">
          {["cash", "card", "mobilepay", "mixed", "dankort"].map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`flex-1 min-w-[4.5rem] py-2.5 rounded-lg text-xs font-medium capitalize border transition ${
                method === m
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-500 text-blue-700 dark:text-blue-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={saleDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={(e) => setSaleDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {saleDate !== new Date().toISOString().split("T")[0] && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated entry</span>
          )}
        </div>

        {/* Notes */}
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add a note (optional)"
          className="mt-3 w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
        />
      </div>

      {/* Item Sale Modal */}
      {showItemSale && (
        <ItemSaleModal
          items={inventoryItems}
          currency={currency}
          onClose={() => setShowItemSale(false)}
          onSale={async (saleData) => {
            try {
              await api.post("/sales", saleData);
              setShowItemSale(false);
              fetchSales(filterFrom, filterTo);
              fetchInventory();
              setSuccess(`Item sale: ${saleData.item_name || "item"} × ${saleData.quantity_sold} = ${(saleData.quantity_sold * saleData.unit_price).toLocaleString()} ${currency}`);
              setTimeout(() => setSuccess(""), 3000);
            } catch (err) {
              setError(err.response?.data?.detail || "Failed to create item sale");
              setTimeout(() => setError(""), 4000);
            }
          }}
        />
      )}

      {/* CSV Import */}
      <CsvUpload onDone={fetchSales} />

      {/* Sales History */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentSales")}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); fetchSales(e.target.value, filterTo); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); fetchSales(filterFrom, e.target.value); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchSales(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => exportToCsv("sales.csv", sales, [
                { key: "date", label: "Date" },
                { key: "amount", label: "Amount" },
                { key: "payment_method", label: "Payment Method" },
                { key: "notes", label: "Notes" },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              Export CSV
            </button>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="px-6 py-3 bg-blue-50 dark:bg-blue-900/20 flex items-center justify-between">
            <span className="text-sm text-blue-700 dark:text-blue-400">{selected.size} selected</span>
            <button onClick={bulkDelete} className="text-sm text-red-600 dark:text-red-400 font-medium hover:underline">
              Move to trash
            </button>
          </div>
        )}
        <div className="overflow-x-auto">
        <table className="w-full text-left min-w-[500px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-4 sm:px-6 py-3 w-8">
                <input type="checkbox" onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(filtered.map(i => i.id)));
                  else setSelected(new Set());
                }} checked={selected.size === filtered.length && filtered.length > 0} />
              </th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("payment")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Notes</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("date")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {filtered.slice(0, 50).map((sale) => (
              <tr key={sale.id}>
                <td className="px-4 sm:px-6 py-4">
                  <input type="checkbox" checked={selected.has(sale.id)} onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(sale.id);
                    else next.delete(sale.id);
                    setSelected(next);
                  }} />
                </td>
                {editId === sale.id ? (
                  <>
                    <td className="px-6 py-3">
                      <input
                        type="number"
                        value={editData.amount}
                        onChange={(e) => setEditData({ ...editData, amount: parseFloat(e.target.value) || 0 })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28"
                      />
                    </td>
                    <td className="px-6 py-3">
                      <select
                        value={editData.payment_method}
                        onChange={(e) => setEditData({ ...editData, payment_method: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                      >
                        {["cash", "card", "mobilepay", "mixed", "dankort"].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="text"
                        value={editData.notes || ""}
                        onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                        placeholder="Notes"
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-32"
                      />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <input
                        type="date"
                        value={editData.date}
                        onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-36"
                      />
                    </td>
                    <td className="px-6 py-3 text-right space-x-2">
                      <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">Save</button>
                      <button onClick={() => setEditId(null)} className="text-gray-400 dark:text-gray-500 text-sm hover:underline">Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">
                      {parseFloat(sale.amount).toLocaleString()} {currency}
                      {sale.item_name && (
                        <div className="text-xs font-normal text-gray-400 mt-0.5">
                          {sale.item_name} × {sale.quantity_sold} @ {parseFloat(sale.unit_price).toLocaleString()}/{currency}
                          {sale.cost_at_sale != null && (
                            <span className="ml-1.5 text-green-600 dark:text-green-400">
                              +{Math.round((sale.unit_price - sale.cost_at_sale) * sale.quantity_sold).toLocaleString()} profit
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400 capitalize">{sale.payment_method}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{sale.notes || "—"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 text-right">{sale.date}</td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button onClick={() => startEdit(sale)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">Edit</button>
                      {deleteConfirm === sale.id ? (
                        <>
                          <button onClick={() => deleteSale(sale.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">Yes, move</button>
                          <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">No</button>
                        </>
                      ) : (
                        <button onClick={() => setDeleteConfirm(sale.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">Move to trash</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noSalesYet")}</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function ItemSaleModal({ items, currency, onClose, onSale }) {
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState(null);
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [method, setMethod] = useState("cash");

  const filtered = useMemo(() => {
    if (!search) return items.filter((i) => parseFloat(i.quantity) > 0).slice(0, 20);
    return items
      .filter((i) => i.name.toLowerCase().includes(search.toLowerCase()) && parseFloat(i.quantity) > 0)
      .slice(0, 20);
  }, [items, search]);

  const cost = selectedItem ? parseFloat(selectedItem.cost_per_unit) : 0;
  const qtyNum = parseFloat(qty) || 0;
  const priceNum = parseFloat(price) || 0;
  const total = qtyNum * priceNum;
  const profit = qtyNum * (priceNum - cost);
  const available = selectedItem ? parseFloat(selectedItem.quantity) : 0;

  const handleSubmit = () => {
    if (!selectedItem || !qtyNum || !priceNum) return;
    onSale({
      date: new Date().toISOString().split("T")[0],
      inventory_item_id: selectedItem.id,
      quantity_sold: qtyNum,
      unit_price: priceNum,
      payment_method: method,
      item_name: selectedItem.name,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">Item Sale</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Pick item from inventory, set qty & price</p>

        {!selectedItem ? (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search inventory..."
              className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white mb-3"
              autoFocus
            />
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setSelectedItem(item);
                    if (item.sell_price) setPrice(String(parseFloat(item.sell_price)));
                  }}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 transition flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{item.name}</p>
                    <p className="text-xs text-gray-400">{item.category} · Cost: {parseFloat(item.cost_per_unit)} {currency}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">{parseFloat(item.quantity)} {item.unit}</p>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-center text-gray-400 py-4 text-sm">No items with stock found</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg mb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-800 dark:text-white">{selectedItem.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Cost: {cost} {currency}/{selectedItem.unit} · Stock: {available} {selectedItem.unit}
                  </p>
                </div>
                <button onClick={() => { setSelectedItem(null); setQty(""); setPrice(""); }} className="text-xs text-blue-600 hover:underline">Change</button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Quantity ({selectedItem.unit})</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="0"
                  max={available}
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                  autoFocus
                />
                {qtyNum > available && (
                  <p className="text-xs text-red-500 mt-1">Only {available} {selectedItem.unit} available</p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Sell Price ({currency}/{selectedItem.unit})</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                />
              </div>
            </div>

            {/* Payment method */}
            <div className="flex gap-2 mb-4">
              {["cash", "card", "mobilepay", "mixed"].map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize border transition ${
                    method === m
                      ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-500 text-blue-700 dark:text-blue-300"
                      : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Summary */}
            {qtyNum > 0 && priceNum > 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg mb-4 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Total</span>
                  <span className="font-bold text-gray-800 dark:text-white">{total.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Cost</span>
                  <span className="text-gray-600 dark:text-gray-300">{(qtyNum * cost).toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Profit</span>
                  <span className={`font-bold ${profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                    {profit >= 0 ? "+" : ""}{profit.toLocaleString()} {currency}
                  </span>
                </div>
                {cost > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Margin</span>
                    <span className="text-green-600 dark:text-green-400">{Math.round(((priceNum - cost) / cost) * 100)}%</span>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!qtyNum || !priceNum || qtyNum > available}
                className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition disabled:opacity-40"
              >
                Sell {total > 0 ? `(${total.toLocaleString()} ${currency})` : ""}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CsvUpload({ onDone }) {
  const { t } = useLanguage();
  const [result, setResult] = useState(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await api.post("/sales/import-csv", formData);
      setResult(res.data);
      onDone();
    } catch (err) {
      setResult({ imported: 0, errors: [err.response?.data?.detail || "Upload failed"] });
    }
    setUploading(false);
    e.target.value = "";
  };

  return (
    <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("importCsv")}</h2>
          <p className="text-xs text-gray-400 dark:text-gray-400 mt-0.5">{t("csvColumns")}</p>
        </div>
        <label className={`px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition ${
          uploading ? "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500" : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
        }`}>
          {uploading ? t("uploading") : t("chooseFile")}
          <input type="file" accept=".csv" onChange={handleFile} className="hidden" disabled={uploading} />
        </label>
      </div>
      {result && (
        <div className="mt-3 text-sm">
          <p className="text-green-600 dark:text-green-400 font-medium">{result.imported} {t("salesImported")}</p>
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="text-yellow-600 dark:text-yellow-400 cursor-pointer">{result.errors.length} {t("rowsSkipped")}</summary>
              <ul className="mt-1 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                {result.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
