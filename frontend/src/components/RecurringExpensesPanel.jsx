/**
 * RecurringExpensesPanel — the "Recurring" tab content inside the
 * ExpensesPage (Task #47).
 *
 * Owner-configured monthly expense templates that the backend cron
 * materializes into real Expense rows on schedule. Free users see an
 * UpgradeNudge instead of the form/list — backend additionally
 * enforces every mutation (defense in depth).
 *
 * UX choices (warm-stone palette, no new colors):
 *   • Card list of active rules with name + amount + next-run date +
 *     row actions (Run-now / Pause-Resume / Delete).
 *   • "+ Add recurring expense" opens a modal form.
 *   • Form inputs: name, amount, day-of-month (1–28), category,
 *     payment method, notes.
 *   • Paused rules are visually de-emphasised, not hidden — owners
 *     forget what they paused otherwise.
 *
 * No date math on the frontend that could leak UTC bugs — we always
 * render whatever next_run_date the backend returns, in the user's
 * locale via formatDateClearFull. Setting next_run is computed
 * server-side from day_of_month so the user never types a date.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { Button, Card, Empty, UpgradeNudge, Icon } from "./ui";
import { formatDateClearFull } from "../utils/dateFormat";

const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1);

// Mirrors backend whitelist in app/schemas/recurring_expense.py. Keep in
// sync — adding a method on either side without the other will 422.
const PAYMENT_METHODS = [
  { value: "card", labelKey: "card" },
  { value: "cash", labelKey: "cash" },
  { value: "mobilepay", labelKey: "mobilePay" },
  { value: "bank_transfer", labelKey: "bankTransfer" },
];

function PaymentMethodSelect({ value, onChange, t }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm text-stone-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-gray-900"
    >
      {PAYMENT_METHODS.map((m) => (
        <option key={m.value} value={m.value}>
          {t(m.labelKey, m.labelKey)}
        </option>
      ))}
    </select>
  );
}

function RuleForm({ initial, categories, currency, onSubmit, onCancel, t }) {
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [amount, setAmount] = useState(
    initial?.amount != null ? String(initial.amount) : "",
  );
  const [dayOfMonth, setDayOfMonth] = useState(initial?.day_of_month || 1);
  const [categoryId, setCategoryId] = useState(initial?.category_id || "");
  const [paymentMethod, setPaymentMethod] = useState(
    initial?.payment_method || "card",
  );
  const [notes, setNotes] = useState(initial?.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!name.trim() || name.trim().length < 2) {
      setError(t("recurringNameLabel", "Name") + " ≥ 2");
      return;
    }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      setError(t("invalidAmount", "Amount must be > 0"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || null,
        amount: amt,
        day_of_month: parseInt(dayOfMonth, 10) || 1,
        category_id: categoryId || null,
        payment_method: paymentMethod,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
        err?.response?.data?.detail ||
        t("somethingWentWrong", "Something went wrong"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="text-sm bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 px-3 py-2 rounded-lg">
          {String(error)}
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
          {t("recurringNameLabel", "Name")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder={t("recurringNamePlaceholder", "e.g. Rent — Nørrebrogade")}
          className="w-full h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            {t("amount", "Amount")} ({currency})
          </label>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="18000"
            className="w-full h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            {t("dayOfMonth", "Day of month")}
          </label>
          <select
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">
            {t("dayOfMonthHint", "1–28 (caps at 28 so February always works)")}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            {t("category", "Category")}
          </label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            {t("paymentMethod", "Payment method")}
          </label>
          <PaymentMethodSelect
            value={paymentMethod}
            onChange={setPaymentMethod}
            t={t}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
          {t("recurringDescLabel", "Description (shows on the expense)")}
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
          placeholder={t("recurringDescPlaceholder", "e.g. Monthly rent")}
          className="w-full h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
          {t("notesOptional", "Notes (optional)")}
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel} type="button">
          {t("cancel", "Cancel")}
        </Button>
        <Button variant="accent" busy={busy} type="submit">
          {t("save", "Save")}
        </Button>
      </div>
    </form>
  );
}

function RuleRow({ rule, currency, onRunNow, onPauseResume, onEdit, onDelete, t }) {
  const isPaused = !rule.is_active;
  return (
    <Card variant={isPaused ? "subtle" : "default"} className="p-4 sm:p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-base font-semibold text-stone-900 dark:text-stone-100 truncate">
              {rule.name}
            </h4>
            {isPaused && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 text-[10px] font-medium uppercase tracking-wide">
                <Icon name="Pause" size={10} />
                {t("paused", "Paused")}
              </span>
            )}
          </div>
          <p className="text-sm text-stone-600 dark:text-stone-400 mt-0.5">
            {Number(rule.amount).toLocaleString()} {currency} · {t("monthly", "Monthly")} · {t("dayOfMonth", "Day of month")} {rule.day_of_month}
          </p>
          <p className="text-xs text-stone-500 dark:text-stone-400 mt-1">
            {isPaused
              ? t("recurringPaused", "Paused — won't post until you resume")
              : `${t("nextRun", "Next")}: ${formatDateClearFull(rule.next_run_date)}`}
            {rule.last_run_date && (
              <>
                {" · "}
                {t("lastRun", "Last posted")}: {formatDateClearFull(rule.last_run_date)}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isPaused && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRunNow(rule)}
              title={t("runNow", "Post now")}
              iconLeft={<Icon name="RotateCw" size={14} />}
            >
              {t("runNow", "Post now")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onPauseResume(rule)}
            title={isPaused ? t("resume", "Resume") : t("pause", "Pause")}
            iconLeft={<Icon name={isPaused ? "Play" : "Pause"} size={14} />}
          >
            {isPaused ? t("resume", "Resume") : t("pause", "Pause")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEdit(rule)}
            title={t("edit", "Edit")}
          >
            {t("edit", "Edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(rule)}
            title={t("archive", "Archive")}
            className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            {t("archive", "Archive")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function RecurringExpensesPanel({ categories, currency }) {
  const { t } = useLanguage();
  const { hasFeature, loading: entLoading } = useEntitlements();
  const isUnlocked = hasFeature("recurring_expenses");

  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const res = await api.get("/recurring-expenses");
      setRules(res.data || []);
    } catch (err) {
      // 402 on the LIST endpoint shouldn't happen — read is open — but
      // any other error just clears the panel so the page still renders.
      setRules([]);
      if (err?.response?.status !== 402) {
        setError(err?.response?.data?.detail || t("somethingWentWrong", "Something went wrong"));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Don't even hit the endpoint for Free users — the UI already shows
    // an UpgradeNudge so there's nothing to display.
    if (isUnlocked) fetchRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked]);

  const showSuccess = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 2500);
  };

  const handleCreate = async (payload) => {
    await api.post("/recurring-expenses", payload);
    setShowForm(false);
    setEditing(null);
    showSuccess(t("recurringSaved", "Recurring expense saved"));
    fetchRules();
  };

  const handleUpdate = async (payload) => {
    await api.put(`/recurring-expenses/${editing.id}`, payload);
    setShowForm(false);
    setEditing(null);
    showSuccess(t("recurringSaved", "Recurring expense saved"));
    fetchRules();
  };

  const handleRunNow = async (rule) => {
    try {
      await api.post(`/recurring-expenses/${rule.id}/run-now`);
      showSuccess(t("recurringPosted", "Posted today's expense"));
      fetchRules();
      // Also bump the broader "data changed" channel so the One-time
      // tab picks up the new Expense row without a manual refresh.
      window.dispatchEvent(new CustomEvent("bonbox-data-changed"));
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
        err?.response?.data?.detail ||
        t("somethingWentWrong", "Something went wrong"),
      );
      setTimeout(() => setError(""), 4000);
    }
  };

  const handlePauseResume = async (rule) => {
    try {
      const endpoint = rule.is_active ? "pause" : "resume";
      await api.post(`/recurring-expenses/${rule.id}/${endpoint}`);
      fetchRules();
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
        err?.response?.data?.detail ||
        t("somethingWentWrong", "Something went wrong"),
      );
    }
  };

  const handleDelete = async (rule) => {
    if (!confirm(`${t("archive", "Archive")} ${rule.name}?`)) return;
    try {
      await api.delete(`/recurring-expenses/${rule.id}`);
      showSuccess(t("recurringDeleted", "Recurring expense archived"));
      fetchRules();
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
        err?.response?.data?.detail ||
        t("somethingWentWrong", "Something went wrong"),
      );
    }
  };

  // Locked-tier render — Free users see the value prop + a CTA.
  if (!entLoading && !isUnlocked) {
    return (
      <Card>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {t("recurringExpensesHeading", "Recurring expenses")}
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
            {t(
              "recurringExpensesIntro",
              "Set up rent, internet, subscriptions once. BonBox posts them automatically each month.",
            )}
          </p>
        </div>
        <UpgradeNudge
          intent="card"
          tier="starter"
          benefit={t(
            "recurringUpgradeBenefit",
            "Set rent and subscriptions once — BonBox posts them every month",
          )}
          ctaLabel={t("seePlans", "See plans")}
          icon={<Icon name="CalendarClock" size={28} />}
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {t("recurringExpensesHeading", "Recurring expenses")}
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1 max-w-md">
            {t(
              "recurringExpensesIntro",
              "Set up rent, internet, subscriptions once. BonBox posts them automatically each month.",
            )}
          </p>
        </div>
        <Button
          variant="accent"
          size="md"
          onClick={() => { setEditing(null); setShowForm(true); }}
          iconLeft={<Icon name="Plus" size={14} />}
        >
          {t("addRecurringShort", "Add recurring")}
        </Button>
      </div>

      {success && (
        <div className="mb-3 text-sm bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-300 px-3 py-2 rounded-lg">
          {success}
        </div>
      )}
      {error && (
        <div className="mb-3 text-sm bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 px-3 py-2 rounded-lg">
          {String(error)}
        </div>
      )}

      {loading && rules.length === 0 ? (
        <p className="text-sm text-stone-500 py-6 text-center">
          {t("loading", "Loading...")}
        </p>
      ) : rules.length === 0 ? (
        <Empty
          icon="🔁"
          title={t("noRecurringYet", "No recurring expenses yet")}
          body={t(
            "recurringEmptyHint",
            "Rent, internet, Microsoft 365, Spotify — set them up once and stop typing them every month.",
          )}
          cta={
            <Button
              variant="accent"
              onClick={() => { setEditing(null); setShowForm(true); }}
              iconLeft={<Icon name="Plus" size={14} />}
            >
              {t("addRecurring", "Add recurring expense")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              currency={currency}
              onRunNow={handleRunNow}
              onPauseResume={handlePauseResume}
              onEdit={(r) => { setEditing(r); setShowForm(true); }}
              onDelete={handleDelete}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Modal form — same backdrop pattern UpgradeNudge dialog uses */}
      {showForm && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => { setShowForm(false); setEditing(null); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl shadow-xl max-w-md w-full p-5 sm:p-6"
          >
            <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100 mb-4">
              {editing
                ? t("editRecurring", "Edit recurring expense")
                : t("addRecurring", "Add recurring expense")}
            </h3>
            <RuleForm
              initial={editing}
              categories={categories}
              currency={currency}
              onCancel={() => { setShowForm(false); setEditing(null); }}
              onSubmit={editing ? handleUpdate : handleCreate}
              t={t}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
