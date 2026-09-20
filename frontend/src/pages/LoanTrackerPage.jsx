import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { displayCurrency, formatOwnerMoney, moneyLocale, parseMoneyInput } from "../utils/currency";
import MoneyField from "../components/ui/MoneyField";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { formatDate, formatDateShort, localIso } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";
import { errText } from "../utils/errText";

export default function LoanTrackerPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  // A loan amount is money the owner types — text field, strict parser, the
  // ACCOUNT's notation. type="number" silently rewrote a Dane's "1.500,50"
  // to "1.50050" on an English-locale browser.
  const mLocale = moneyLocale(user?.currency);
  const { t } = useLanguage();
  const confirm = useConfirm();

  const [persons, setPersons] = useState([]);
  const [summary, setSummary] = useState({ total_borrowed: 0, total_lent: 0, net_balance: 0, persons: [] });
  const [selected, setSelected] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [personForm, setPersonForm] = useState({ name: "", phone: "", notes: "" });
  const [editPerson, setEditPerson] = useState(null);
  const [txnForm, setTxnForm] = useState({ date: localIso(), type: "lent", amount: "", is_repayment: false, notes: "" });
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
      setError(errText(err, t("failedToSave")));
    }
  };

  // The badge word the row prints for a line. Shared with the delete dialog so
  // the confirm can only ever quote the row back in the owner's own words.
  const txnTypeLabel = (txn) =>
    txn.is_repayment ? t("repaid") : txn.type === "lent" ? t("lent") : t("borrowed");

  const handleDeletePerson = async (p) => {
    // "Delete this person?" was true of every name in the list, and the two
    // Delete buttons sit four pixels apart. One mis-tap took a counterparty
    // and their whole lending history out of the overview, with no undo
    // anywhere in the app. The dialog now says who — with the phone the row
    // shows, because two Mettes are not unusual — and what they stand at.
    // "you cannot bring them back FROM HERE": DELETE /loans/persons/{id}
    // soft-deletes and the LoanTransaction rows survive, so claiming BonBox
    // cannot recover them would be false in the other direction.
    const who = p.phone ? `${p.name} (${p.phone})` : p.name;
    const ok = await confirm({
      title: t("loanDeletePersonTitleNamed", "Delete {name} from your loan list?", { name: who }),
      message: t(
        "loanDeletePersonBodyBalance",
        // Nothing ends a clause straight after the balance: the Danish money
        // token already ends in a period ("1.500,00 kr."), so a full stop
        // there renders "kr..".
        "The net balance with {name} is {balance} — the person and every loan line you have registered leave your overview, and you cannot bring them back from here.",
        {
          name: p.name,
          balance: formatOwnerMoney(p.net_balance ?? 0, currency, { decimals: 2, sign: true }),
        },
      ),
      confirmLabel: t("delete", "Delete"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (!ok) return;
    await api.delete(`/loans/persons/${p.id}`);
    if (selected?.id === p.id) { setSelected(null); setTransactions([]); }
    fetchPersons();
  };

  // Parsed once, so the gate below and the payload cannot disagree. The old
  // `parseFloat(txnForm.amount) || 0` posted a 0-kroner loan line for anything
  // it could not read — a row in the ledger that never happened.
  const txnAmountNum = parseMoneyInput(txnForm.amount, mLocale);

  const handleAddTxn = async (e) => {
    e.preventDefault();
    if (!(txnAmountNum > 0)) return;
    setError("");
    try {
      const payload = {
        person_id: selected.id,
        date: txnForm.date,
        type: txnForm.type,
        amount: txnAmountNum,
        is_repayment: txnForm.is_repayment,
        notes: txnForm.notes || null,
      };
      if (editTxn) {
        await api.put(`/loans/transactions/${editTxn.id}`, payload);
      } else {
        await api.post("/loans/transactions", payload);
      }
      setTxnForm({ date: localIso(), type: "lent", amount: "", is_repayment: false, notes: "" });
      setEditTxn(null);
      fetchTxns(selected.id);
      fetchPersons();
    } catch (err) {
      setError(errText(err, t("failedToSave")));
    }
  };

  const handleDeleteTxn = async (txn) => {
    // "Delete?" — that was the whole dialog, on a ledger where every row has
    // the same button and rows repeat (two 500-kroner repayments on the same
    // day is an ordinary week). The line is gone for good on the server and
    // every running balance under it moves. The confirm now reads the row
    // back: its day, its badge word, its amount and the note that is often
    // the only thing telling two identical lines apart.
    const noteFrag = txn.notes
      ? t("loanDeleteTxnNoteFrag", ", noted “{note}”", { note: txn.notes })
      : "";
    const ok = await confirm({
      title: t("loanDeleteTxnTitleDated", "Delete the {date} line with {name}?", {
        date: formatDate(txn.date),
        name: selected.name,
      }),
      message: t(
        "loanDeleteTxnBodyAmount",
        // The amount never ends the clause — "1.500,00 kr." already carries a
        // period, and a full stop after it renders "kr..".
        "The row reads {type} {amount}{note} — the line is deleted for good, and the running balance on every other line is recalculated.",
        {
          type: txnTypeLabel(txn),
          amount: formatOwnerMoney(txn.amount ?? 0, currency, { decimals: 2 }),
          note: noteFrag,
        },
      ),
      confirmLabel: t("delete", "Delete"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (!ok) return;
    await api.delete(`/loans/transactions/${txn.id}`);
    fetchTxns(selected.id);
    fetchPersons();
  };

  const filtered = persons.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.phone?.includes(search));
  // Was `Number(n).toLocaleString("en", …)` + a bare currency code, so a
  // Danish owner's ledger read "1,500.5 DKK" — and in Danish the comma is the
  // DECIMAL separator, so that is one-and-a-half kroner. Every amount on this
  // page now goes through the owner-money formatter, which is also what the
  // delete dialogs quote; the two could otherwise describe the same line
  // differently. Two decimals because a loan ledger is exact money.
  const fmt = (n) => formatOwnerMoney(n, currency, { decimals: 2 });
  // The signed variant for balances, so "+" comes from the formatter rather
  // than from a hand-written ternary at each call site.
  const fmtSigned = (n) => formatOwnerMoney(n, currency, { decimals: 2, sign: true });

  // Running balance for selected person
  const sortedAsc = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.created_at || "").localeCompare(b.created_at || ""));
  let runBorrowed = 0, runLent = 0;
  const txnsWithBalance = sortedAsc.map((txn) => {
    const amt = parseFloat(txn.amount);
    if (txn.type === "borrowed") {
      if (txn.is_repayment) runBorrowed -= amt; else runBorrowed += amt;
    } else {
      if (txn.is_repayment) runLent -= amt; else runLent += amt;
    }
    return { ...txn, runBorrowed, runLent, runNet: runLent - runBorrowed };
  });
  const displayTxns = [...txnsWithBalance].reverse();

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <FadeIn><h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("loanTrackerTitle")}</h1></FadeIn>
      <p className="text-sm text-gray-500 dark:text-gray-400">{t("loanTrackerSubtitle")}</p>

      {error && <p className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">{error}</p>}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t("iOweBorrowed")}</p>
          <p className="text-2xl font-bold text-orange-600">{fmt(summary.total_borrowed)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t("owedToMeLent")}</p>
          <p className="text-2xl font-bold text-blue-600">{fmt(summary.total_lent)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t("netBalance")}</p>
          <p className={`text-2xl font-bold ${summary.net_balance >= 0 ? "text-emerald-600" : "text-red-600"}`}>
            {fmtSigned(summary.net_balance)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-5 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t("people")}</p>
          <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">{summary.person_count || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* People List */}
        <div className="lg:col-span-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="p-4 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-white">{t("people")}</h2>
              <button onClick={() => { setShowAdd(true); setEditPerson(null); setPersonForm({ name: "", phone: "", notes: "" }); }}
                className="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-purple-700 transition">{`+ ${t("add")}`}</button>
            </div>
            <input type="text" placeholder={t("search")} value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white" />
          </div>

          {showAdd && (
            <form onSubmit={handleAddPerson} className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-2 bg-purple-50 dark:bg-purple-900/20">
              <input type="text" placeholder={`${t("name")} *`} value={personForm.name} onChange={(e) => setPersonForm({ ...personForm, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" required />
              <input type="text" placeholder={t("phone")} value={personForm.phone} onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              <input type="text" placeholder={t("notes")} value={personForm.notes} onChange={(e) => setPersonForm({ ...personForm, notes: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              <div className="flex gap-2">
                <button type="submit" className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700">{editPerson ? t("update") : t("save")}</button>
                <button type="button" onClick={() => { setShowAdd(false); setEditPerson(null); }} className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">{t("cancel")}</button>
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
                      <p className="text-xs text-orange-600">{t("iOwe")}: {fmt(p.borrowed_balance)}</p>
                    )}
                    {p.lent_balance > 0 && (
                      <p className="text-xs text-blue-600">{t("owesMe")}: {fmt(p.lent_balance)}</p>
                    )}
                    <p className={`font-bold text-sm ${p.net_balance > 0 ? "text-emerald-600" : p.net_balance < 0 ? "text-red-600" : "text-gray-400"}`}>
                      {p.net_balance === 0 ? t("settled") : fmtSigned(p.net_balance)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={(e) => { e.stopPropagation(); setEditPerson(p); setPersonForm({ name: p.name, phone: p.phone || "", notes: p.notes || "" }); setShowAdd(true); }}
                    className="text-xs text-purple-600 hover:underline">{t("edit")}</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeletePerson(p); }}
                    className="text-xs text-red-500 hover:underline">{t("delete")}</button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <p className="p-4 text-center text-gray-400 text-sm">{t("noPeopleYet")}</p>}
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
                      <p className="text-xs text-orange-600">{t("iOwe")}: {fmt(selected.borrowed_balance)}</p>
                    )}
                    {selected.lent_balance > 0 && (
                      <p className="text-xs text-blue-600">{t("owesMe")}: {fmt(selected.lent_balance)}</p>
                    )}
                    <p className={`text-xl font-bold ${selected.net_balance >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {t("netBalance")}: {fmtSigned(selected.net_balance)}
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
                    <option value="lent">{t("iLent")}</option>
                    <option value="borrowed">{t("iBorrowed")}</option>
                  </select>
                  <MoneyField locale={mLocale} placeholder={t("amount")} value={txnForm.amount} onChange={(e) => setTxnForm({ ...txnForm, amount: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <input type="checkbox" checked={txnForm.is_repayment} onChange={(e) => {
                      const checked = e.target.checked;
                      const updates = { is_repayment: checked };
                      // Auto-set type to match outstanding balance direction
                      if (checked && selected) {
                        if (selected.borrowed_balance > 0 && selected.lent_balance <= 0) updates.type = "borrowed";
                        else if (selected.lent_balance > 0 && selected.borrowed_balance <= 0) updates.type = "lent";
                      }
                      setTxnForm({ ...txnForm, ...updates });
                    }}
                      className="rounded border-gray-300" />
                    {t("repayment")}
                  </label>
                  <input type="text" placeholder={t("notes")} value={txnForm.notes} onChange={(e) => setTxnForm({ ...txnForm, notes: e.target.value })}
                    className="px-3 py-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <div className="flex gap-2">
                    <button type="submit" disabled={!(txnAmountNum > 0)}
                      className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700 transition whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed">
                      {editTxn ? t("update") : t("add")}
                    </button>
                    {editTxn && (
                      <button type="button" onClick={() => { setEditTxn(null); setTxnForm({ date: localIso(), type: "lent", amount: "", is_repayment: false, notes: "" }); }}
                        className="text-sm text-gray-500 hover:text-gray-700">{t("cancel")}</button>
                    )}
                  </div>
                </div>
              </form>

              {/* Transactions Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-750 text-gray-500 dark:text-gray-400 text-xs uppercase">
                      <th className="px-4 py-3 text-left">{t("date")}</th>
                      <th className="px-4 py-3 text-left">{t("type")}</th>
                      <th className="px-4 py-3 text-right">{t("amount")}</th>
                      <th className="px-4 py-3 text-right">{t("netBalance")}</th>
                      <th className="px-4 py-3 text-left">{t("notes")}</th>
                      <th className="px-4 py-3 text-right">{t("actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {displayTxns.map((txn) => (
                      <tr key={txn.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{formatDate(txn.date)}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            txn.is_repayment
                              ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                              : txn.type === "lent"
                                ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                                : "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400"
                          }`}>
                            {txnTypeLabel(txn)}
                          </span>
                        </td>
                        <td className={`px-4 py-3 text-right font-medium ${
                          txn.is_repayment ? "text-emerald-600" : txn.type === "lent" ? "text-blue-600" : "text-orange-600"
                        }`}>
                          {txn.is_repayment ? "-" : "+"}{fmt(txn.amount)}
                        </td>
                        <td className={`px-4 py-3 text-right font-bold ${txn.runNet >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {fmtSigned(txn.runNet)}
                        </td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{txn.notes || "-"}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <button onClick={() => { setEditTxn(txn); setTxnForm({ date: txn.date, type: txn.type, amount: txn.amount, is_repayment: txn.is_repayment, notes: txn.notes || "" }); }}
                            className="text-purple-600 hover:underline text-xs">{t("edit")}</button>
                          <button onClick={() => handleDeleteTxn(txn)}
                            className="text-red-500 hover:underline text-xs">{t("delete")}</button>
                        </td>
                      </tr>
                    ))}
                    {displayTxns.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">{t("noTransactionsYet")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-gray-400">
              <p className="text-4xl mb-3">💰</p>
              <p className="text-lg font-medium">{t("selectPerson")}</p>
              <p className="text-sm">{t("selectPersonDesc")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
