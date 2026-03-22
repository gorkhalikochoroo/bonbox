import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { displayCurrency } from "../utils/currency";

export default function KhataPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);

  const [customers, setCustomers] = useState([]);
  const [summary, setSummary] = useState({ total_receivable: 0, customer_count: 0, top_debtors: [] });
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [search, setSearch] = useState("");
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [custForm, setCustForm] = useState({ name: "", phone: "", address: "" });
  const [editCust, setEditCust] = useState(null);
  const [txnForm, setTxnForm] = useState({ date: new Date().toISOString().slice(0, 10), purchase_amount: "", paid_amount: "", notes: "" });
  const [editTxn, setEditTxn] = useState(null);
  const [error, setError] = useState("");

  const fetchCustomers = () => {
    api.get("/khata/customers").then((r) => {
      setCustomers(r.data);
      if (selectedCustomer) {
        const updated = r.data.find((c) => c.id === selectedCustomer.id);
        if (updated) setSelectedCustomer(updated);
      }
    }).catch(() => {});
    api.get("/khata/summary").then((r) => setSummary(r.data)).catch(() => {});
  };

  const fetchTransactions = (custId) => {
    api.get(`/khata/customers/${custId}/transactions`).then((r) => setTransactions(r.data)).catch(() => {});
  };

  useEffect(() => { fetchCustomers(); }, []);
  useEffect(() => { if (selectedCustomer) fetchTransactions(selectedCustomer.id); }, [selectedCustomer]);

  const handleAddCustomer = async (e) => {
    e.preventDefault();
    setError("");
    try {
      if (editCust) {
        await api.put(`/khata/customers/${editCust.id}`, custForm);
      } else {
        await api.post("/khata/customers", custForm);
      }
      setCustForm({ name: "", phone: "", address: "" });
      setShowAddCustomer(false);
      setEditCust(null);
      fetchCustomers();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed");
    }
  };

  const handleDeleteCustomer = async (id) => {
    if (!confirm("Delete this customer?")) return;
    await api.delete(`/khata/customers/${id}`);
    if (selectedCustomer?.id === id) { setSelectedCustomer(null); setTransactions([]); }
    fetchCustomers();
  };

  const handleAddTxn = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const payload = {
        customer_id: selectedCustomer.id,
        date: txnForm.date,
        purchase_amount: parseFloat(txnForm.purchase_amount) || 0,
        paid_amount: parseFloat(txnForm.paid_amount) || 0,
        notes: txnForm.notes || null,
      };
      if (editTxn) {
        await api.put(`/khata/transactions/${editTxn.id}`, payload);
      } else {
        await api.post("/khata/transactions", payload);
      }
      setTxnForm({ date: new Date().toISOString().slice(0, 10), purchase_amount: "", paid_amount: "", notes: "" });
      setEditTxn(null);
      fetchTransactions(selectedCustomer.id);
      fetchCustomers();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed");
    }
  };

  const handleDeleteTxn = async (id) => {
    if (!confirm("Delete this transaction?")) return;
    await api.delete(`/khata/transactions/${id}`);
    fetchTransactions(selectedCustomer.id);
    fetchCustomers();
  };

  const filtered = customers.filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.phone?.includes(search));

  const fmt = (n) => Number(n).toLocaleString("en", { minimumFractionDigits: 0 });

  // Calculate running balance for transaction list (oldest first, accumulate)
  const sortedTxnsAsc = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.created_at || "").localeCompare(b.created_at || ""));
  let runBal = 0;
  const txnsWithBalance = sortedTxnsAsc.map((t) => {
    runBal += parseFloat(t.purchase_amount) - parseFloat(t.paid_amount);
    return { ...t, runningBalance: runBal };
  });
  const displayTxns = [...txnsWithBalance].reverse();

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Khata — Customer Ledger</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">Track credit purchases and payments for your wholesale customers</p>

      {error && <p className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">{error}</p>}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Total Receivable</p>
          <p className="text-2xl font-bold text-red-600">{fmt(summary.total_receivable)} {currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Customers</p>
          <p className="text-2xl font-bold text-blue-600">{summary.customer_count}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Top Debtors</p>
          <div className="space-y-1 mt-1">
            {summary.top_debtors?.slice(0, 3).map((d, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-gray-700 dark:text-gray-300 truncate">{d.name}</span>
                <span className="text-red-600 font-medium">{fmt(d.balance)}</span>
              </div>
            ))}
            {(!summary.top_debtors || summary.top_debtors.length === 0) && (
              <p className="text-sm text-gray-400">No pending balances</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Customer List */}
        <div className="lg:col-span-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="p-4 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white">Customers</h2>
              <button
                onClick={() => { setShowAddCustomer(true); setEditCust(null); setCustForm({ name: "", phone: "", address: "" }); }}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700 transition"
              >+ Add</button>
            </div>
            <input
              type="text" placeholder="Search customers..." value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white"
            />
          </div>

          {showAddCustomer && (
            <form onSubmit={handleAddCustomer} className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-2 bg-blue-50 dark:bg-blue-900/20">
              <input type="text" placeholder="Name *" value={custForm.name} onChange={(e) => setCustForm({ ...custForm, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" required />
              <input type="text" placeholder="Phone" value={custForm.phone} onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              <input type="text" placeholder="Address" value={custForm.address} onChange={(e) => setCustForm({ ...custForm, address: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              <div className="flex gap-2">
                <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700">{editCust ? "Update" : "Save"}</button>
                <button type="button" onClick={() => { setShowAddCustomer(false); setEditCust(null); }} className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
              </div>
            </form>
          )}

          <div className="divide-y divide-gray-100 dark:divide-gray-700 max-h-[500px] overflow-y-auto">
            {filtered.map((c) => (
              <div
                key={c.id}
                onClick={() => setSelectedCustomer(c)}
                className={`p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition ${
                  selectedCustomer?.id === c.id ? "bg-blue-50 dark:bg-blue-900/30 border-l-4 border-blue-600" : ""
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium text-gray-800 dark:text-white">{c.name}</p>
                    {c.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{c.phone}</p>}
                  </div>
                  <div className="text-right">
                    <p className={`font-bold text-sm ${c.balance > 0 ? "text-red-600" : "text-green-600"}`}>
                      {c.balance > 0 ? `${fmt(c.balance)} owed` : c.balance < 0 ? `${fmt(Math.abs(c.balance))} overpaid` : "Settled"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={(e) => { e.stopPropagation(); setEditCust(c); setCustForm({ name: c.name, phone: c.phone || "", address: c.address || "" }); setShowAddCustomer(true); }}
                    className="text-xs text-blue-600 hover:underline">Edit</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteCustomer(c.id); }}
                    className="text-xs text-red-500 hover:underline">Delete</button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="p-4 text-center text-gray-400 text-sm">No customers yet</p>
            )}
          </div>
        </div>

        {/* Transaction Detail */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          {selectedCustomer ? (
            <>
              <div className="p-4 border-b border-gray-100 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-800 dark:text-white">{selectedCustomer.name}</h2>
                    {selectedCustomer.phone && <p className="text-sm text-gray-500">{selectedCustomer.phone}</p>}
                    {selectedCustomer.address && <p className="text-sm text-gray-500">{selectedCustomer.address}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500 uppercase">Balance</p>
                    <p className={`text-2xl font-bold ${selectedCustomer.balance > 0 ? "text-red-600" : "text-green-600"}`}>
                      {fmt(selectedCustomer.balance)} {currency}
                    </p>
                  </div>
                </div>
              </div>

              {/* Add Transaction Form */}
              <form onSubmit={handleAddTxn} className="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <input type="date" value={txnForm.date} onChange={(e) => setTxnForm({ ...txnForm, date: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <div>
                    <input type="number" placeholder="Purchased" value={txnForm.purchase_amount} onChange={(e) => setTxnForm({ ...txnForm, purchase_amount: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" min="0" step="0.01" />
                  </div>
                  <div>
                    <input type="number" placeholder="Paid" value={txnForm.paid_amount} onChange={(e) => setTxnForm({ ...txnForm, paid_amount: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" min="0" step="0.01" />
                  </div>
                  <input type="text" placeholder="Notes" value={txnForm.notes} onChange={(e) => setTxnForm({ ...txnForm, notes: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <div className="flex gap-2">
                    <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition whitespace-nowrap">
                      {editTxn ? "Update" : "Add"}
                    </button>
                    {editTxn && (
                      <button type="button" onClick={() => { setEditTxn(null); setTxnForm({ date: new Date().toISOString().slice(0, 10), purchase_amount: "", paid_amount: "", notes: "" }); }}
                        className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
                    )}
                  </div>
                </div>
              </form>

              {/* Transactions Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-750 text-gray-500 dark:text-gray-400 text-xs uppercase">
                      <th className="px-4 py-3 text-left">Date</th>
                      <th className="px-4 py-3 text-right">Purchased</th>
                      <th className="px-4 py-3 text-right">Paid</th>
                      <th className="px-4 py-3 text-right">Balance</th>
                      <th className="px-4 py-3 text-left">Notes</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {displayTxns.map((t) => (
                      <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{t.date}</td>
                        <td className="px-4 py-3 text-right text-red-600 font-medium">
                          {parseFloat(t.purchase_amount) > 0 ? `+${fmt(t.purchase_amount)}` : "-"}
                        </td>
                        <td className="px-4 py-3 text-right text-green-600 font-medium">
                          {parseFloat(t.paid_amount) > 0 ? `-${fmt(t.paid_amount)}` : "-"}
                        </td>
                        <td className={`px-4 py-3 text-right font-bold ${t.runningBalance > 0 ? "text-red-600" : "text-green-600"}`}>
                          {fmt(t.runningBalance)} {currency}
                        </td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{t.notes || "-"}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <button onClick={() => { setEditTxn(t); setTxnForm({ date: t.date, purchase_amount: t.purchase_amount, paid_amount: t.paid_amount, notes: t.notes || "" }); }}
                            className="text-blue-600 hover:underline text-xs">Edit</button>
                          <button onClick={() => handleDeleteTxn(t.id)}
                            className="text-red-500 hover:underline text-xs">Delete</button>
                        </td>
                      </tr>
                    ))}
                    {displayTxns.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No transactions yet — add the first one above</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-gray-400">
              <p className="text-4xl mb-3">📋</p>
              <p className="text-lg font-medium">Select a customer</p>
              <p className="text-sm">Choose a customer from the list to view their ledger</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
