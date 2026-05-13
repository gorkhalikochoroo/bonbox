import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import HowItWorksCard from "../components/HowItWorksCard";

/**
 * FakturaPage — list + create + send.
 *
 * Send flow:
 *  1. Owner clicks "Send" on a draft.
 *  2. Backend flips status to 'sent' and locks the invoice.
 *  3. Frontend downloads the PDF blob.
 *  4. Frontend opens mailto: with the customer's email + subject + body.
 *     The owner manually attaches the downloaded PDF in their mail app.
 *
 * Why mailto: instead of server-sent SMTP:
 *   - No SMTP infrastructure required for v1
 *   - Owner sees the email before sending — fewer "wait did that go out" panics
 *   - Mail goes from owner's domain, not a "no-reply@bonbox.dk" — looks professional
 *   - V2: add a "Send from BonBox" toggle that uses Postmark/SendGrid
 */
export default function FakturaPage() {
  const { user } = useAuth();
  const { t } = useLanguage();

  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  const plan = (user?.plan || "free").toLowerCase();
  // Trial users get Pro-tier access during the 14-day window — include them
  // so the trial actually demos every paid feature.
  const hasAccess = ["starter", "pro", "business", "trial"].includes(plan);

  useEffect(() => {
    if (!hasAccess) {
      setLoading(false);
      return;
    }
    fetchAll();
  }, [hasAccess, statusFilter]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const params = statusFilter ? { status_filter: statusFilter } : {};
      const [inv, cust] = await Promise.all([
        api.get("/invoices", { params }),
        api.get("/customers"),
      ]);
      setInvoices(inv.data);
      setCustomers(cust.data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  if (!hasAccess) {
    return (
      <div className="p-4 md:p-8 max-w-2xl mx-auto">
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-6 text-center">
          <div className="text-4xl mb-3">🔒</div>
          <h1 className="text-xl font-bold mb-2 text-amber-900 dark:text-amber-200">
            {t("fakturaStarterRequired") || "Faktura — Starter plan required"}
          </h1>
          <p className="text-sm text-amber-800 dark:text-amber-300 mb-4">
            {t("fakturaStarterDesc") ||
              "Send invoices, track payments, and replace your accountant's monthly data entry."}
          </p>
          <a href="/subscription" className="inline-block px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 transition">
            {t("upgrade") || "Upgrade"}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <span>🧾</span> {t("faktura") || "Faktura"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("fakturaDesc") || "Send invoices · gap-less numbering · auto-paid via bank match"}
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          disabled={customers.length === 0}
          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          title={customers.length === 0 ? (t("addCustomerFirst") || "Add a customer first") : ""}
        >
          + {t("newInvoice") || "New invoice"}
        </button>
      </div>

      {customers.length === 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-2xl p-4 text-sm text-blue-800 dark:text-blue-300">
          {t("fakturaNoCustomersHint") ||
            "You need at least one customer before you can send an invoice. "}
          <a href="/customers" className="font-semibold underline">
            {t("addCustomerNow") || "Add one now →"}
          </a>
        </div>
      )}

      <HowItWorksCard
        storageKey="faktura"
        icon="🧾"
        tone="blue"
        title={t("fakturaHowTitle") || "How Faktura works"}
        steps={[
          {
            title: t("fakturaStep1Title") || "1. Add a customer first",
            body:
              t("fakturaStep1Body") ||
              "Type a CVR and we auto-fill name + address from CVR/DAWA. For private clients, toggle Privatperson — no CVR needed.",
          },
          {
            title: t("fakturaStep2Title") || "2. Create the invoice",
            body:
              t("fakturaStep2Body") ||
              "Add line items (description, qty, unit price). Moms (25 % default) and totals calculate live. Save as draft to edit later.",
          },
          {
            title: t("fakturaStep3Title") || "3. Send — PDF + mailto",
            body:
              t("fakturaStep3Body") ||
              "Click Send: the invoice locks, the PDF downloads, and your mail app opens pre-filled with the customer's email + subject + body. Attach the PDF and hit Send.",
          },
          {
            title: t("fakturaStep4Title") || "4. Get paid — auto-matched",
            body:
              t("fakturaStep4Body") ||
              "Export your bank's CSV (2 clicks in netbank), upload it under Bank Import. BonBox auto-matches the payment to the open invoice within ±2 kr tolerance and flips status to Paid — no manual reconciliation.",
          },
        ]}
        footer={
          t("fakturaHowFooter") ||
          "Fakturanummer er løbende og uden huller per branch per år, jf. Bogføringsloven §7. Sendte fakturaer kan ikke slettes — annullér med kreditnota i stedet (vi laver den automatisk)."
        }
      />


      <div className="flex gap-2 flex-wrap">
        {[
          { value: "", label: t("all") || "All" },
          { value: "draft", label: t("draft") || "Draft" },
          { value: "sent", label: t("sent") || "Sent" },
          { value: "paid", label: t("paid") || "Paid" },
          { value: "overdue", label: t("overdue") || "Overdue" },
          { value: "credited", label: t("credited") || "Credited" },
        ].map((s) => (
          <button
            key={s.value}
            onClick={() => setStatusFilter(s.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
              statusFilter === s.value
                ? "bg-green-600 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">{t("loading") || "Loading…"}</div>
      ) : invoices.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-12 text-center border border-gray-100 dark:border-gray-700">
          <p className="text-4xl mb-3">🧾</p>
          <p className="text-gray-600 dark:text-gray-300 font-medium">
            {t("noInvoicesYet") || "No invoices yet"}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400 uppercase text-xs">
              <tr>
                <th className="text-left px-5 py-3">{t("invoiceNumber") || "Faktura nr."}</th>
                <th className="text-left px-5 py-3">{t("customer") || "Customer"}</th>
                <th className="text-left px-5 py-3">{t("issueDate") || "Issued"}</th>
                <th className="text-left px-5 py-3">{t("dueDate") || "Due"}</th>
                <th className="text-right px-5 py-3">{t("amount") || "Amount"}</th>
                <th className="text-center px-5 py-3">{t("status") || "Status"}</th>
                <th className="text-right px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {invoices.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  customer={customers.find((c) => c.id === inv.customer_id)}
                  onChanged={fetchAll}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <CreateInvoiceModal
          customers={customers}
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            fetchAll();
          }}
          t={t}
        />
      )}
    </div>
  );
}

// ─── Single row + status actions ──────────────────────────────────

function InvoiceRow({ invoice, customer, onChanged, t }) {
  const statusBadge = {
    draft: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
    sent: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    paid: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    overdue: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    credited: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  }[invoice.status] || "bg-gray-100 text-gray-700";

  const handleDownloadPdf = async () => {
    try {
      const res = await api.get(`/invoices/${invoice.id}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = invoice.is_credit_note
        ? `kreditnota-${invoice.fakturanummer_formatted}.pdf`
        : `faktura-${invoice.fakturanummer_formatted}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(t("pdfFailed") || "PDF generation failed");
    }
  };

  const handleSend = async () => {
    if (!customer?.email) {
      alert(t("customerHasNoEmail") || "Customer has no email — add one first");
      return;
    }
    try {
      // 1. Flip status to 'sent' + lock + record sent_at
      await api.post(`/invoices/${invoice.id}/send`);
      // 2. Download the PDF for attachment
      const res = await api.get(`/invoices/${invoice.id}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `faktura-${invoice.fakturanummer_formatted}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 3. Open mail app with subject + body — owner manually attaches PDF
      const subject = encodeURIComponent(
        `Faktura ${invoice.fakturanummer_formatted}`
      );
      const total = new Intl.NumberFormat("da-DK", {
        style: "currency",
        currency: invoice.currency || "DKK",
      }).format(invoice.total_gross);
      const body = encodeURIComponent(
        invoice.customer_lang === "en"
          ? `Hi ${customer.name},\n\nPlease find faktura ${invoice.fakturanummer_formatted} attached.\n\nAmount: ${total}\nDue: ${invoice.due_date}\n\nThank you,\n`
          : `Hej ${customer.name},\n\nVedhæftet finder du faktura ${invoice.fakturanummer_formatted}.\n\nBeløb: ${total}\nForfald: ${invoice.due_date}\n\nVenlig hilsen,\n`
      );
      window.location.href = `mailto:${customer.email}?subject=${subject}&body=${body}`;
      onChanged();
    } catch (e) {
      alert(e?.response?.data?.detail || (t("sendFailed") || "Send failed"));
    }
  };

  const handleMarkPaid = async () => {
    if (!confirm(`Mark ${invoice.fakturanummer_formatted} as paid?`)) return;
    try {
      await api.post(`/invoices/${invoice.id}/mark-paid`, {
        amount: invoice.total_gross,
        source: "manual",
      });
      onChanged();
    } catch (e) {
      alert(e?.response?.data?.detail || "Mark paid failed");
    }
  };

  // Reverse a paid status. Service-layer enforces eligibility:
  // auto-matches only within 7 days, manual marks always reversible.
  // Backend returns 409 if outside window — we surface the message.
  const handleUnmarkPaid = async () => {
    if (!confirm(t("confirmUnmarkPaid") || `Unmark ${invoice.fakturanummer_formatted} as paid?`)) return;
    try {
      await api.post(`/invoices/${invoice.id}/unmark-paid`);
      onChanged();
    } catch (e) {
      alert(e?.response?.data?.detail || "Unmark failed");
    }
  };

  const handleVoid = async () => {
    const reason = prompt(t("voidReasonPrompt") || "Reason for voiding this invoice?");
    if (!reason) return;
    try {
      await api.post(`/invoices/${invoice.id}/void`, { reason });
      onChanged();
    } catch (e) {
      alert(e?.response?.data?.detail || "Void failed");
    }
  };

  // Is unmark reasonable to surface right now?
  // - paid status required
  // - manual marks: always show
  // - auto-matches: only if auto_match_reversible is still true (server
  //   resets it when the 7-day window passes via unmark attempt)
  const unmarkAvailable =
    invoice.status === "paid" &&
    (invoice.paid_via !== "auto_match" || invoice.auto_match_reversible === true);

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
      <td className="px-5 py-3 font-mono text-sm text-gray-800 dark:text-white">
        {invoice.fakturanummer_formatted}
        {invoice.is_credit_note && <span className="ml-1 text-xs text-purple-600 dark:text-purple-300">↩</span>}
      </td>
      <td className="px-5 py-3 text-gray-700 dark:text-gray-200">
        {customer?.name || "—"}
      </td>
      <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{invoice.issue_date}</td>
      <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{invoice.due_date}</td>
      <td className="px-5 py-3 text-right font-semibold text-gray-800 dark:text-white">
        {new Intl.NumberFormat("da-DK", { style: "currency", currency: invoice.currency }).format(invoice.total_gross)}
      </td>
      <td className="px-5 py-3 text-center">
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusBadge}`}>
          {invoice.status}
        </span>
      </td>
      <td className="px-5 py-3 text-right whitespace-nowrap">
        <div className="inline-flex items-center gap-2 justify-end">
          {invoice.status === "draft" && (
            <button onClick={handleSend} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition">
              {t("send") || "Send"}
            </button>
          )}
          {(invoice.status === "sent" || invoice.status === "overdue") && (
            <button
              onClick={handleMarkPaid}
              className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-lg transition"
              title={t("markPaidHint") || "Click when customer's payment lands in your bank"}
            >
              ✓ {t("markPaid") || "Mark paid"}
            </button>
          )}
          {unmarkAvailable && (
            <button
              onClick={handleUnmarkPaid}
              className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 text-xs rounded-lg transition"
              title={
                invoice.paid_via === "auto_match"
                  ? (t("undoAutoMatchHint") || "Auto-matched — reversible within 7 days")
                  : (t("undoManualHint") || "Reverse this paid status")
              }
            >
              ↩ {t("undo") || "Undo"}
            </button>
          )}
          {(invoice.status === "sent" || invoice.status === "overdue" || invoice.status === "paid") && !invoice.is_credit_note && (
            <button onClick={handleVoid} className="text-red-600 hover:underline text-xs font-medium px-2">
              {t("voidInvoice") || "Void"}
            </button>
          )}
          <button onClick={handleDownloadPdf} className="text-gray-600 dark:text-gray-300 hover:underline text-xs">
            {t("downloadPdf") || "PDF"}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Create modal ──────────────────────────────────────────────────

function CreateInvoiceModal({ customers, onClose, onCreated, t }) {
  const [customerId, setCustomerId] = useState(customers[0]?.id || "");
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  // Optional leveringsdato — only rendered on the PDF when it differs
  // from issueDate (Momsbekendtgørelsen §57 stk. 1 nr. 6). Default to
  // empty so same-day work doesn't pollute the PDF with redundant info.
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([
    { description: "", quantity: "1", unit: "", unit_price_net: "", moms_rate: "0.250" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setLine = (i, k, v) => {
    setLines((arr) => arr.map((ln, idx) => (idx === i ? { ...ln, [k]: v } : ln)));
  };

  const addLine = () => setLines((arr) => [
    ...arr,
    { description: "", quantity: "1", unit: "", unit_price_net: "", moms_rate: "0.250" },
  ]);

  const removeLine = (i) => setLines((arr) => arr.filter((_, idx) => idx !== i));

  // Live totals
  const totals = lines.reduce(
    (acc, l) => {
      const qty = parseFloat(l.quantity) || 0;
      const price = parseFloat(l.unit_price_net) || 0;
      const rate = parseFloat(l.moms_rate) || 0;
      const net = qty * price;
      const moms = net * rate;
      acc.net += net;
      acc.moms += moms;
      return acc;
    },
    { net: 0, moms: 0 }
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        customer_id: customerId,
        issue_date: issueDate,
        delivery_date: deliveryDate || undefined,
        notes: notes || undefined,
        lines: lines
          .filter((l) => l.description && l.unit_price_net)
          .map((l) => ({
            description: l.description,
            quantity: parseFloat(l.quantity),
            unit: l.unit || undefined,
            unit_price_net: parseFloat(l.unit_price_net),
            moms_rate: parseFloat(l.moms_rate),
          })),
      };
      if (payload.lines.length === 0) {
        setError(t("atLeastOneLine") || "At least one line item required");
        setSaving(false);
        return;
      }
      await api.post("/invoices", payload);
      onCreated();
    } catch (err) {
      setError(err?.response?.data?.detail || "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800 dark:text-white">
            {t("newInvoice") || "New invoice"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("customer") || "Customer"} *
              </label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.cvr ? ` · CVR ${c.cvr}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("issueDate") || "Issue date"}
              </label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>
          </div>

          {/* Leveringsdato — collapsible, only fill when work was
              delivered on a different day than the invoice date. Required
              on the PDF in that case per Momsbekendtgørelsen §57. */}
          <details>
            <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t("deliveryDateToggle") || "Set delivery date (only if different from issue date)"}
            </summary>
            <div className="mt-2">
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="w-full md:w-64 px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                {t("deliveryDateHint") ||
                  "When the goods/service was actually delivered. Leave empty for same-day work."}
              </p>
            </div>
          </details>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 block">
              {t("lineItems") || "Line items"}
            </label>
            <div className="space-y-2">
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-start">
                  <input
                    type="text"
                    placeholder={t("description") || "Description"}
                    value={line.description}
                    onChange={(e) => setLine(i, "description", e.target.value)}
                    className="col-span-5 px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
                  />
                  <input
                    type="number"
                    placeholder={t("qty") || "Qty"}
                    value={line.quantity}
                    step="0.01"
                    onChange={(e) => setLine(i, "quantity", e.target.value)}
                    className="col-span-1 px-2 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
                  />
                  <input
                    type="number"
                    placeholder={t("unitPrice") || "Unit price"}
                    value={line.unit_price_net}
                    step="0.01"
                    onChange={(e) => setLine(i, "unit_price_net", e.target.value)}
                    className="col-span-3 px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
                  />
                  <select
                    value={line.moms_rate}
                    onChange={(e) => setLine(i, "moms_rate", e.target.value)}
                    className="col-span-2 px-2 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
                  >
                    <option value="0.250">Moms 25%</option>
                    <option value="0">Moms 0%</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    disabled={lines.length === 1}
                    className="col-span-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addLine}
              className="mt-2 text-sm text-blue-600 hover:underline"
            >
              + {t("addLine") || "Add line"}
            </button>
          </div>

          <div className="bg-gray-50 dark:bg-gray-900/40 rounded-xl p-4 space-y-1 text-sm">
            <div className="flex justify-between text-gray-600 dark:text-gray-300">
              <span>{t("subtotal") || "Subtotal (excl. moms)"}</span>
              <span>{new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK" }).format(totals.net)}</span>
            </div>
            <div className="flex justify-between text-gray-600 dark:text-gray-300">
              <span>{t("momsTotal") || "Moms total"}</span>
              <span>{new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK" }).format(totals.moms)}</span>
            </div>
            <div className="flex justify-between font-bold text-gray-900 dark:text-white pt-2 border-t border-gray-200 dark:border-gray-700">
              <span>{t("totalGross") || "Total to pay"}</span>
              <span>{new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK" }).format(totals.net + totals.moms)}</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("notes") || "Notes (optional)"}
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder") || "Tak for samarbejdet 🙏"}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm resize-none"
            />
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl text-sm"
            >
              {t("cancel") || "Cancel"}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition disabled:opacity-50"
            >
              {saving ? (t("creating") || "Creating…") : (t("createDraft") || "Create draft")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
