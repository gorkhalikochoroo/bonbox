import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { displayCurrency } from "../utils/currency";

export default function LoanTrackerPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);

  const [persons, setPersons] = useState([]);
  const [summary, setSummary] = useState({ total_borrowed: 0, total_lent: 0, net_balance: 0, persons: [] });
  const [selected, setSelected] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [personForm, setPersonForm] = useState({ name: "", phone: "", notes: "" });
  const [editPerson, setEditPerson] = useState(null);
  const [txnForm, setTxnForm] = useState({ date: new Date().toISOString().slice(0, 10), type: "lent", amount: "", is_repayment: false, notes: "" });
  const [editTxn, setEditTxn] = useState(null);
  const [error, setError] = useState("");

  const fetchPersons = () => {
    api.get("/loans/persons").then((r) => {
      setPersons(r.data);
      if (selected) {
        const updated = r.data.find((p) => p.id === selected.id);
        if (updated) setSelected(updated);
      }
    }).catch(() => {});
    api.get("/loans/summary").then((r) => setSummary(r.data)).catch(() => {});
  };

  const fetchTxns = (personId) => {
    api.get(`/loans/persons/${personId}/transactions`).then((r) => setTransactions(r.data)).catch(() => {});
  };

  useEffect(() => { fetchPersons(); }, []);
  useEffect(() => { if (selected) fetchTxns(selected.id); }, [selected]);

  const handleAddPerson = async (e) => {
    e.preventDefault();
    setError("");
    try {
      if (editPerson) {
        await api.put(`/loans/persons/${editPerson.id}`, personForm);
      } else {
        await api.post("/loans/persons", personForm);
      }
      setPersonForm({ name: "", phone: "", notes: "" });
      setShowAdd(false);
      setEditPerson(null);
      fetchPersons();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed");
    }
  };

  const handleDeletePerson = async (id) => {
    if (!confirm("Delete this person?")) return;
    await api.delete(`/loans/persons/${id}`);
    if (selected?.id === id) { setSelected(null); setTransactions([]); }
    fetchPersons();
  };

  const handleAddTxn = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const payload = {
        person_id: selected.id,
        date: txnForm.date,
        type: txnForm.type,
        amount: parseFloat(txnForm.amount) || 0,
        is_repayment: txnForm.is_repayment,
        notes: txnForm.notes || null,
      };
      if (editTxn) {
        await api.put(`/loans/transactions/${editTxn.id}`, payload);
      } else {
        await api.post("/loans/transactions", payload);
      }
      setTxnForm({ date: new Date().toISOString().slice(0, 10), type: "lent", amount: "", is_repayment: false, notes: "" });
      setEditTxn(null);
      fetchTxns(selected.id);
      fetchPersons();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed");
    }
  };

  const handleDeleteTxn = async (id) => {
    if (!confirm("Delete?")) return;
    await api.delete(`/loans/transactions/${id}`);
    fetchTxns(selected.id);
    fetchPersons();
  };

  const filtered = persons.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.phone?.includes(search));
  const fmt = (n) => Number(n).toLocaleString("en", { minimumFractionDigits: 0 });

  // Running balance for selected person
  const sortedAsc = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.created_at || "").localeCompare(b.created_at || ""));
  let runBorrowed = 0, runLent = 0;
  const txnsWithBalance = sortedAsc.map((t) => {
    const amt = parseFloat(t.amount);
    if (t.type === "borrowed") {
      if (t.is_repayment) runBorrowed -= amt; else runBorrowed += amt;
    } else {
      if (t.is_repayment) runLent -= amt; else runLent += amt;
    }
    return { ...t, runBorrowed, runLent, runNet: runLent - runBorrowed };
  });
  const displayTxns = [...txnsWithBalance].reverse();

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Loan Tracker</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">Track money borrowed and lent with partial payments</p>

      {error && <p className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">{error}</p>}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">I Owe (Borrowed)</p>
          <p className="text-2xl font-bold text-orange-600">{fmt(summary.total_borrowed)} {currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Owed to Me (Lent)</p>
          <p className="text-2xl font-bold text-blue-600">{fmt(summary.total_lent)} {currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Net Balance</p>
          <p className={`text-2xl font-bold ${summary.net_balance >= 0 ? "text-green-600" : "text-red-600"}`}>
            {summary.net_balance >= 0 ? "+" : ""}{fmt(summary.net_balance)} {currency}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">People</p>
          <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">{summary.person_count || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* People List */}
        <div className="lg:col-span-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="p-4 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white">People</h2>
              <button onClick={() => { setShowAdd(true); setEditPerson(null); setPersonForm({ name: "", phone: "", notes: "" }); }}
                className="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-purple-700 transition">+ Add</button>
            </div>
            <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white" />
          </div>

          {showAdd && (
            <form onSubmit={handleAddPerson} className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-2 bg-purple-50 dark:bg-purple-900/20">
              <input type="text" placeholder="Name *" value={personForm.name} onChange={(e) => setPersonForm({ ...personForm, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" required />
              <input type="text" placeholder="Phone" value={personForm.phone} onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              <input type="text" placeholder="Notes" value={personForm.notes} onChange={(e) => setPersonForm({ ...personForm, notes: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              <div className="flex gap-2">
                <button type="submit" className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700">{editPerson ? "Update" : "Save"}</button>
                <button type="button" onClick={() => { setShowAdd(false); setEditPerson(null); }} className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
              </div>
            </form>
          )}

          <div className="divide-y divide-gray-100 dark:divide-gray-700 max-h-[500px] overflow-y-auto">
            {filtered.map((p) => (
              <div key={p.id} onClick={() => setSelected(p)}
                className={`p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition ${
                  selected?.id === p.id ? "bg-purple-50 dark:bg-purple-900/30 border-l-4 border-purple-600" : ""
                }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium text-gray-800 dark:text-white">{p.name}</p>
                    {p.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{p.phone}</p>}
                  </div>
                  <div className="text-right">
                    {p.borrowed_balance > 0 && (
                      <p className="text-xs text-orange-600">I owe: {fmt(p.borrowed_balance)}</p>
                    )}
                    {p.lent_balance > 0 && (
                      <p className="text-xs text-blue-600">Owes me: {fmt(p.lent_balance)}</p>
                    )}
                    <p className={`font-bold text-sm ${p.net_balance > 0 ? "text-green-600" : p.net_balance < 0 ? "text-red-600" : "text-gray-400"}`}>
                      {p.net_balance > 0 ? `+${fmt(p.net_balance)}` : p.net_balance < 0 ? fmt(p.net_balance) : "Settled"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={(e) => { e.stopPropagation(); setEditPerson(p); setPersonForm({ name: p.name, phone: p.phone || "", notes: p.notes || "" }); setShowAdd(true); }}
                    className="text-xs text-purple-600 hover:underline">Edit</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeletePerson(p.id); }}
                    className="text-xs text-red-500 hover:underline">Delete</button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <p className="p-4 text-center text-gray-400 text-sm">No people yet</p>}
          </div>
        </div>

        {/* Transaction Detail */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          {selected ? (
            <>
              <div className="p-4 border-b border-gray-100 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-800 dark:text-white">{selected.name}</h2>
                    {selected.phone && <p className="text-sm text-gray-500">{selected.phone}</p>}
                  </div>
                  <div className="text-right space-y-0.5">
                    {selected.borrowed_balance > 0 && (
                      <p className="text-xs text-orange-600">I owe: {fmt(selected.borrowed_balance)} {currency}</p>
                    )}
                    {selected.lent_balance > 0 && (
                      <p className="text-xs text-blue-600">Owes me: {fmt(selected.lent_balance)} {currency}</p>
                    )}
                    <p className={`text-xl font-bold ${selected.net_balance >= 0 ? "text-green-600" : "text-red-600"}`}>
                      Net: {selected.net_balance >= 0 ? "+" : ""}{fmt(selected.net_balance)} {currency}
                    </p>
                  </div>
                </div>
              </div>

              {/* Add Transaction */}
              <form onSubmit={handleAddTxn} className="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 items-end">
                  <input type="date" value={txnForm.date} onChange={(e) => setTxnForm({ ...txnForm, date: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <select value={txnForm.type} onChange={(e) => setTxnForm({ ...txnForm, type: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    <option value="lent">I Lent</option>
                    <option value="borrowed">I Borrowed</option>
                  </select>
                  <input type="number" placeholder="Amount" value={txnForm.amount} onChange={(e) => setTxnForm({ ...txnForm, amount: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" min="0" step="0.01" />
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <input type="checkbox" checked={txnForm.is_repayment} onChange={(e) => setTxnForm({ ...txnForm, is_repayment: e.target.checked })}
                      className="rounded border-gray-300" />
                    Repayment
                  </label>
                  <input type="text" placeholder="Notes" value={txnForm.notes} onChange={(e) => setTxnForm({ ...txnForm, notes: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <div className="flex gap-2">
                    <button type="submit" className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700 transition whitespace-nowrap">
                      {editTxn ? "Update" : "Add"}
                    </button>
                    {editTxn && (
                      <button type="button" onClick={() => { setEditTxn(null); setTxnForm({ date: new Date().toISOString().slice(0, 10), type: "lent", amount: "", is_repayment: false, notes: "" }); }}
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
                      <th className="px-4 py-3 text-left">Type</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3 text-right">Net Balance</th>
                      <th className="px-4 py-3 text-left">Notes</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {displayTxns.map((t) => (
                      <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{t.date}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            t.is_repayment
                              ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                              : t.type === "lent"
                                ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                                : "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400"
                          }`}>
                            {t.is_repayment ? "Repaid" : t.type === "lent" ? "Lent" : "Borrowed"}
                          </span>
                        </td>
                        <td className={`px-4 py-3 text-right font-medium ${
                          t.is_repayment ? "text-green-600" : t.type === "lent" ? "text-blue-600" : "text-orange-600"
                        }`}>
                          {t.is_repayment ? "-" : "+"}{fmt(t.amount)} {currency}
                        </td>
                        <td className={`px-4 py-3 text-right font-bold ${t.runNet >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {t.runNet >= 0 ? "+" : ""}{fmt(t.runNet)} {currency}
                        </td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{t.notes || "-"}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <button onClick={() => { setEditTxn(t); setTxnForm({ date: t.date, type: t.type, amount: t.amount, is_repayment: t.is_repayment, notes: t.notes || "" }); }}
                            className="text-purple-600 hover:underline text-xs">Edit</button>
                          <button onClick={() => handleDeleteTxn(t.id)}
                            className="text-red-500 hover:underline text-xs">Delete</button>
                        </td>
                      </tr>
                    ))}
                    {displayTxns.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No transactions yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-gray-400">
              <p className="text-4xl mb-3">💰</p>
              <p className="text-lg font-medium">Select a person</p>
              <p className="text-sm">Choose someone from the list to view loan details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
