// Task #118 polish (Agent C): migrated H1 → PageHeader and the
// balance/in/out stat row → StatCard grid (red/green semantic accents
// preserved for cash-in vs cash-out where they're data-true).
// Behavior + i18n + a11y unchanged.
import { useEffect, useRef, useState } from "react";
import { Pencil, SearchX, Trash2, Wallet } from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useAsyncData } from "../hooks/useAsyncData";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency, formatOwnerMoney, moneyLocale, parseMoneyInput } from "../utils/currency";
import MoneyField from "../components/ui/MoneyField";
import { formatDate, localIso } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";
import { PageHeader, StatCard, Amount, LoadFailed, Empty, Button } from "../components/ui";
import DataTable from "../components/ui/DataTable";
import { errText } from "../utils/errText";
import { useUndoToast } from "../hooks/useUndoToast";

const IN_CATEGORIES = ["Sales", "Tips", "Loan", "Other"];
const OUT_CATEGORIES = ["Purchase", "Wages", "Supplies", "Rent", "Other"];
const QUICK_AMOUNTS = [100, 500, 1000, 2500, 5000];
const CATEGORY_KEYS = { Sales: "catSales", Tips: "catTips", Loan: "catLoan", Other: "catOther", Purchase: "catPurchase", Wages: "catWages", Supplies: "catSupplies", Rent: "catRent" };

export default function CashBookPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  // Cash in / cash out is money the owner types, so the boxes are text and
  // read through the strict parser in the ACCOUNT's notation — a number input
  // on an English-locale browser turns "1.500,50" into "1.50050" with no
  // error at all. See components/ui/MoneyField.jsx.
  const mLocale = moneyLocale(user?.currency);
  const { t } = useLanguage();
  const { show: showUndo, ToastUI: undoToastUI } = useUndoToast();
  const [tab, setTab] = useState("cash_in");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("");
  const [txnDate, setTxnDate] = useState(localIso());
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");

  // THE THIRD STATE. Both of these loads used to discard the error and leave
  // the page at its initial value — an empty list and a 0 balance. The table
  // then rendered "no cash transactions yet" and the tiles rendered a
  // confident 0 kr., so a drawer we could not reach looked exactly like a
  // drawer that was empty. Those are different facts and only the second one
  // is comforting, which is why it cost trust every time it was wrong.
  // useAsyncData splits them: loading / failed / data, with the last good data
  // kept through a failed reload so a refresh that drops leaves the owner
  // looking at the numbers that were true a minute ago, labelled stale —
  // never at a blank screen, and never at an invented zero.
  //
  // The entry form above deliberately does NOT depend on any of this: the
  // owner can still book cash in or out while the history is unreachable.
  const rangeParams = () => {
    const params = {};
    if (filterFrom) params.from = filterFrom;
    if (filterTo) params.to = filterTo;
    return params;
  };
  const txns = useAsyncData(() => api.get("/cashbook", { params: rangeParams() }), [filterFrom, filterTo], { initial: [] });
  const bal = useAsyncData(() => api.get("/cashbook/balance", { params: rangeParams() }), [filterFrom, filterTo]);

  const transactions = Array.isArray(txns.data) ? txns.data : [];
  // Re-runs BOTH after a write. The fetchers close over the filter range that
  // is on screen right now, so this is the old fetchData(filterFrom, filterTo).
  const refresh = () => { txns.reload(); bal.reload(); };

  // A figure we could not fetch is not a figure. num() returns null for
  // anything that is not a real number, so Amount renders its honest "—" and
  // the tile drops its accent instead of painting an em-dash green.
  const num = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const balBalance = num(bal.data?.balance);
  const balIn = num(bal.data?.total_in);
  const balOut = num(bal.data?.total_out);

  const submit = async (quickAmt) => {
    const value = quickAmt || parseMoneyInput(amount, mLocale);
    if (!(value > 0) || !desc) return;
    setError("");
    try {
      await api.post("/cashbook", {
        date: txnDate,
        type: tab,
        amount: value,
        description: desc,
        category: category || null,
      });
      setAmount("");
      setDesc("");
      setCategory("");
      setTxnDate(localIso());
      trackEvent("cash_transaction", "cashbook", `${tab} ${value} ${currency}`);
      setSuccess(`${tab === "cash_in" ? "+" : "-"}${formatOwnerMoney(value, user?.currency, { decimals: 2 })}`);
      refresh();
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToAddTransaction")));
    }
  };

  // The correction form is a card BELOW the table now (the row itself no
  // longer turns into six input boxes). On a 50-row list, opening it from a
  // row near the top would put it off-screen and "Edit" would look dead, so
  // it is scrolled into view — the same fix /sales and /expenses carry.
  const editPanelRef = useRef(null);
  useEffect(() => {
    if (editId && editPanelRef.current) {
      editPanelRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [editId]);

  const startEdit = (txn) => {
    setEditId(txn.id);
    // An armed "move to trash" on another row must not survive into an edit.
    setDeleteConfirm(null);
    setEditData({
      date: txn.date,
      amount: parseFloat(txn.amount),
      description: txn.description,
      type: txn.type,
      category: txn.category || "",
    });
  };

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      // The row's amount box is text now, so this is the owner's own notation
      // and has to be READ. The old line turned a blank box into a 0 entry in
      // the cash book — a fabricated count, not a correction.
      const n = parseMoneyInput(payload.amount, mLocale);
      if (!(n > 0)) return;
      payload.amount = n;
      await api.put(`/cashbook/${editId}`, payload);
      setEditId(null);
      refresh();
      setSuccess(t("updated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToUpdate")));
    }
  };

  const deleteTxn = async (id) => {
    try {
      await api.delete(`/cashbook/${id}`);
      setDeleteConfirm(null);
      refresh();
      // NOTE: this page dispatches no bonbox-data-changed on delete (unlike
      // Sales/Expenses), so undo stays symmetric and doesn't either. If the
      // cash position ever feeds a cached figure, BOTH need the dispatch.
      showUndo({
        message: t("movedToDeleted"),
        onUndo: async () => {
          await api.put(`/cashbook/${id}/restore`);
          refresh();
        },
      });
    } catch (err) {
      setError(errText(err, t("failedToDelete")));
    }
  };

  // Calculate running balance
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.created_at || "").localeCompare(b.created_at || ""));
  let runningBal = 0;
  const withBalance = sorted.map((txn) => {
    runningBal += txn.type === "cash_in" ? parseFloat(txn.amount) : -parseFloat(txn.amount);
    return { ...txn, runningBalance: runningBal };
  });
  const displayTxns = [...withBalance].reverse().filter(txn => !search || txn.description?.toLowerCase().includes(search.toLowerCase()) || txn.category?.toLowerCase().includes(search.toLowerCase()));

  const categories = tab === "cash_in" ? IN_CATEGORIES : OUT_CATEGORIES;

  // ── History table ──────────────────────────────────────────────────────
  // BEFORE: a hand-rolled 7-column <table> inside `overflow-x-auto`. On a
  // 402pt phone the owner saw Date and Description and had to drag sideways
  // to reach the amount they came to check; Edit and Move-to-trash were plain
  // text links parked past the right edge. <DataTable mobileBreakpoint="md">
  // is the app's one table: a real table from md up, stacked cards below it,
  // and row actions as real buttons instead of links.
  //
  // An auto-synced row (reference_id) mirrors a sale or an expense, so it
  // recedes — same muted grey the rest of that row already used.
  const mutedIf = (r) => (r.reference_id ? "text-gray-400 dark:text-gray-500" : "");

  const tableColumns = [
    {
      id: "date",
      label: t("date"),
      width: "w-28",
      render: (r) => <span className={mutedIf(r)}>{formatDate(r.date)}</span>,
    },
    {
      id: "description",
      label: t("description"),
      render: (r) => (
        <span className={"inline-flex items-center gap-1.5 " + mutedIf(r)}>
          <span className="truncate">{r.description}</span>
          {/* One badge, spelled out. The row used to carry "(auto)" here AND
              "Auto-synced" in the actions column — the same fact twice, and
              the actions column is now where the buttons live. */}
          {r.reference_id && (
            <span className="shrink-0 text-[11px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded-lg">
              {t("autoSynced")}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "category",
      label: t("category"),
      render: (r) => (
        <span className={mutedIf(r) || "text-gray-500 dark:text-gray-400"}>
          {r.category || "—"}
        </span>
      ),
    },
    {
      id: "cash_in",
      label: t("cashIn"),
      align: "right",
      // Empty, not "0" and not "—": a cash-out line has no cash-in figure,
      // and neither a fabricated zero nor an "unknown" dash is true of it.
      render: (r) =>
        r.type === "cash_in" ? (
          <span
            className={
              "font-semibold " +
              (r.reference_id ? "text-gray-400 dark:text-gray-500" : "text-emerald-600 dark:text-emerald-400")
            }
          >
            <Amount value={parseFloat(r.amount)} currency={currency} decimals={2} sign />
          </span>
        ) : null,
    },
    {
      id: "cash_out",
      label: t("cashOut"),
      align: "right",
      render: (r) =>
        r.type === "cash_out" ? (
          <span
            className={
              "font-semibold " +
              (r.reference_id ? "text-gray-400 dark:text-gray-500" : "text-red-600 dark:text-red-400")
            }
          >
            <Amount value={-parseFloat(r.amount)} currency={currency} decimals={2} />
          </span>
        ) : null,
    },
    {
      id: "balance",
      label: t("balance"),
      align: "right",
      render: (r) => (
        <span
          className={
            "font-semibold " +
            (r.runningBalance >= 0 ? "text-gray-900 dark:text-gray-100" : "text-red-600 dark:text-red-400")
          }
        >
          <Amount value={r.runningBalance} currency={currency} decimals={2} />
        </span>
      ),
    },
  ];

  const rowActions = (txn) => {
    // An auto-synced line is the shadow of a sale or an expense. Correcting it
    // here would put the two records out of step, so it carries no actions —
    // the badge in the description column is what says why.
    if (txn.reference_id) return [];
    const armed = deleteConfirm === txn.id;
    return [
      {
        id: "edit",
        label: t("edit"),
        icon: <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />,
        onClick: () => startEdit(txn),
      },
      {
        id: "delete",
        // Armed shows the WORD. A trash icon that silently changes meaning on
        // the first tap is a trap on a touch screen: nothing moves, so the
        // owner either reads it as broken or taps twice and loses the row.
        label: armed ? t("cbConfirmDelete", "Confirm?") : t("moveToTrash"),
        ariaLabel: armed
          ? t("cbConfirmDeleteAria", "Confirm: move this entry to the trash")
          : t("moveToTrash"),
        text: armed,
        icon: <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />,
        variant: "danger",
        onClick: () => {
          if (armed) { deleteTxn(txn.id); return; }
          setDeleteConfirm(txn.id);
          // A stray tap must not leave the next one armed.
          setTimeout(() => setDeleteConfirm((cur) => (cur === txn.id ? null : cur)), 5000);
        },
      },
    ];
  };

  // "Nothing here" is a CLAIM, and there are three different true ones. The
  // range/search case is the one the old table had no answer for at all: it
  // rendered an empty tbody and left the owner staring at column headers.
  const rowsOnScreen = displayTxns.slice(0, 50);
  const hasFilter = !!(search || filterFrom || filterTo);
  const clearFilters = () => { setSearch(""); setFilterFrom(""); setFilterTo(""); };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <FadeIn>
        <PageHeader eyebrow="MONEY" title={t("cashBook")} />
      </FadeIn>

      {success && <div className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {/* The cash position could not be checked. Said out loud, above the
          tiles, because the tiles themselves have no empty state to replace —
          they always show three numbers, and three em-dashes on their own do
          not explain themselves or offer a way back. If a previous load
          succeeded, useAsyncData still holds those figures: they stay on
          screen, labelled as the last ones we could confirm. */}
      {bal.failed && (
        <LoadFailed
          onRetry={bal.reload}
          body={bal.data ? t("cbBalanceStale") : t("cbBalanceUnavailable")}
        />
      )}

      {/* Balance Summary — value accent only when it's data-true
          (balance going negative = critical; cash-in vs cash-out
          colors are inherently semantic and preserved). An unknown
          figure is not data-true, so it renders "—" and stays neutral:
          a green 0 kr. on a drawer we could not reach is the same lie
          the empty state below used to tell. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label={t("cashBalance")}
          value={<Amount value={balBalance} currency={currency} decimals={2} />}
          accent={balBalance == null ? "neutral" : balBalance >= 0 ? "success" : "critical"}
          helper={bal.loading && bal.data == null ? t("cbCheckingBalance") : null}
        />
        <StatCard
          label={t("totalCashIn")}
          value={<Amount value={balIn} currency={currency} decimals={2} sign />}
          accent={balIn == null ? "neutral" : "success"}
        />
        <StatCard
          label={t("totalCashOut")}
          value={<Amount value={balOut == null ? null : -balOut} currency={currency} decimals={2} />}
          accent={balOut == null ? "neutral" : "critical"}
        />
      </div>

      {/* Quick Entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        {/* Tabs */}
        <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 mb-5 w-fit">
          <button
            onClick={() => { setTab("cash_in"); setCategory(""); }}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              tab === "cash_in" ? "bg-gray-900 text-white" : "text-gray-600 dark:text-gray-300"
            }`}
          >
            {t("cashIn")}
          </button>
          <button
            onClick={() => { setTab("cash_out"); setCategory(""); }}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              tab === "cash_out" ? "bg-red-600 text-white" : "text-gray-600 dark:text-gray-300"
            }`}
          >
            {t("cashOut")}
          </button>
        </div>

        {/* Category */}
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">{t("category")}</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {categories.map((c) => (
            // BEFORE: on the CASH IN tab — the tab the page opens on — the
            // selected chip was gray-50 on a gray-200 border with gray-700
            // text, and the UNSELECTED chip took that same gray-50 on hover,
            // one step of grey away. The owner tapped a category and could not
            // see which one they had picked. This is the doctrine's selected
            // chip (ui/Chip.jsx): gray-900 fill, white text — the same weight
            // as the primary button it is about to feed. The cash-out tab
            // keeps its red because money leaving is data-true red, which is
            // this file's own rule (see the header comment).
            // py-3 (was py-2) takes the chip to a 44px tap target: these are
            // tapped standing at a till, often one-handed.
            <button
              key={c}
              onClick={() => { setCategory(c); setDesc(c); }}
              aria-pressed={category === c}
              className={`px-4 py-3 rounded-xl text-sm font-medium border transition ${
                category === c
                  ? tab === "cash_in"
                    ? "bg-gray-900 dark:bg-gray-50 border-gray-900 dark:border-gray-50 text-white dark:text-gray-900"
                    : "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-700 dark:text-red-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {t(CATEGORY_KEYS[c]) || c}
            </button>
          ))}
        </div>

        {/* Description */}
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("whatWasItFor")}
          className="max-w-sm px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white"
        />

        {/* Quick amounts */}
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              disabled={!desc}
              className={`px-5 py-3 rounded-xl border text-sm font-semibold transition disabled:opacity-30 ${
                tab === "cash_in"
                  ? "border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  : "border-red-200 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
              }`}
            >
              <Amount value={amt} currency={currency} />
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="flex gap-3">
          <MoneyField
            locale={mLocale}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            wrapperClassName="flex-1 max-w-sm"
            className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount || !desc}
            className={`px-6 py-3 text-white rounded-xl font-semibold transition disabled:opacity-40 ${
              tab === "cash_in" ? "bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white" : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {tab === "cash_in" ? t("addIn") : t("addOut")}
          </button>
        </div>

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={txnDate}
            max={localIso()}
            onChange={(e) => setTxnDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {txnDate !== localIso() && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdatedEntry")}</span>
          )}
        </div>
      </div>

      {/* Transaction History.
          The block is a plain <section> now, not a card: DataTable draws its
          own card (and, on a phone, one card per entry). Keeping the old
          wrapper would have stacked a second border around the first. Same
          shape /sales and /expenses use. */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("transactionHistory")}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("search")}
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            {/* Was date-range only: a search word that hid every row left the
                owner with no one-tap way back, and the new "nothing matched"
                card points at this same control. One lever, all three. */}
            {hasFilter && (
              <button
                onClick={clearFilters}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                {t("clear")}
              </button>
            )}
            {/* A CSV built from a list that did not load is a file the owner
                would file. Disabled while we know the rows are incomplete —
                an export is a claim about what happened, not a screenshot. */}
            <button
              onClick={() => exportToCsv("cashbook.csv", transactions, [
                { key: "date", label: t("date") },
                { key: "type", label: t("type") },
                { key: "description", label: t("description") },
                { key: "category", label: t("category") },
                { key: "amount", label: t("amount") },
              ])}
              disabled={txns.failed}
              title={txns.failed ? t("cbExportNeedsFullList") : undefined}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
            >
              {t("exportCsv")}
            </button>
          </div>
        </div>
        {/* Stale rows, said so. When the reload drops but we still hold the
            last good list, the rows stay — they were true — and this banner
            is the only thing that changes. The no-rows case is handled in the
            table body instead, where it replaces the empty state outright. */}
        {txns.failed && transactions.length > 0 && (
          <LoadFailed onRetry={txns.reload} body={t("cbListStale")} />
        )}
        <DataTable
          columns={tableColumns}
          rows={rowsOnScreen}
          rowKey="id"
          rowActions={rowActions}
          mobileBreakpoint="md"
          // The order that matters: asking → could not ask → nothing to
          // show. The empty state is last and now only renders when the
          // drawer genuinely came back empty, so "no cash transactions
          // yet" is a fact about the drawer again instead of a guess
          // about the network. Words, not a bare spinner — a spinner
          // says something is happening, not what.
          //
          // That is why `loading` is deliberately NOT handed to DataTable:
          // its skeleton bars are the same wordless shrug. All four answers
          // are carried here, in the one slot, in sentences.
          //
          // The filtered branch is new. A date range or a search word that
          // matched nothing used to render an empty tbody under six column
          // headers — no sentence at all — and the owner had no way to tell
          // "nothing in this period" from "the page is broken".
          empty={
            txns.loading && transactions.length === 0 ? (
              <p className="text-center text-sm text-gray-400 dark:text-gray-500 animate-pulse">
                {t("cbLoadingTransactions")}
              </p>
            ) : txns.failed && transactions.length === 0 ? (
              <LoadFailed onRetry={txns.reload} body={t("cbListUnavailable")} />
            ) : hasFilter ? (
              <Empty
                icon={SearchX}
                title={t("cbNoMatches", "No entries match these filters")}
                body={t("cbNoMatchesBody", "Try a wider date range, or a different word in the search box.")}
                cta={
                  <Button variant="ghost" size="lg" onClick={clearFilters}>
                    {t("clear")}
                  </Button>
                }
              />
            ) : (
              <Empty
                icon={Wallet}
                title={t("noCashTransactionsYet")}
                body={t("cbEmptyBody", "Book the first one with the form above — cash in or cash out.")}
              />
            )
          }
        />
      </section>

      {/* Correcting a booked entry. BEFORE: the row turned into six input
          boxes inside the same 7-column scroller, so on a phone the owner
          edited a date they could see and an amount they could not. It is a
          card of its own now — the /sales and /expenses shape — which works
          at any width and keeps DataTable concerned only with display. */}
      {editId && (
        <div
          ref={editPanelRef}
          className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] p-4 sm:p-5 space-y-3 scroll-mt-24"
        >
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t("cbEditEntry", "Edit entry")}
            {editData.description ? ` · ${editData.description}` : ""}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="date"
              value={editData.date || ""}
              max={localIso()}
              onChange={(e) => setEditData({ ...editData, date: e.target.value })}
              aria-label={t("date")}
              className="w-full px-3 py-3 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-[rgb(var(--surface-card))] dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <input
              type="text"
              value={editData.description || ""}
              onChange={(e) => setEditData({ ...editData, description: e.target.value })}
              placeholder={t("description")}
              aria-label={t("description")}
              className="w-full px-3 py-3 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-[rgb(var(--surface-card))] dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <input
              type="text"
              value={editData.category || ""}
              onChange={(e) => setEditData({ ...editData, category: e.target.value })}
              placeholder={t("category")}
              aria-label={t("category")}
              className="w-full px-3 py-3 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-[rgb(var(--surface-card))] dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <select
              value={editData.type || "cash_in"}
              onChange={(e) => setEditData({ ...editData, type: e.target.value })}
              aria-label={t("type")}
              className="w-full px-3 py-3 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-[rgb(var(--surface-card))] dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
            >
              <option value="cash_in">{t("cashIn")}</option>
              <option value="cash_out">{t("cashOut")}</option>
            </select>
            {/* Still the strict parser in the ACCOUNT's notation — see the
                note on saveEdit. A blank box must not book a 0. */}
            <MoneyField
              locale={mLocale}
              value={editData.amount ?? ""}
              onChange={(e) => setEditData({ ...editData, amount: e.target.value })}
              placeholder={t("amount")}
              aria-label={t("amount")}
              className="w-full px-3 py-3 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-[rgb(var(--surface-card))] dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="lg" onClick={() => { setEditId(null); setEditData({}); }}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={saveEdit}
              disabled={!(parseMoneyInput(editData.amount, mLocale) > 0)}
            >
              {t("save")}
            </Button>
          </div>
        </div>
      )}
      {undoToastUI}
    </div>
  );
}
