import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import HowItWorksCard from "../components/HowItWorksCard";
import { UpgradeNudge } from "../components/ui";
import { localIso } from "../utils/dateFormat";

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
  // Date range filter — defaults to "all time" (both empty). Preset
  // chips set both ends in one click. Persisted in URL not done yet —
  // could be a later UX nicety.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // Pending-count for the "📥 N to review" badge. Polled lazily on
  // mount + when the invoice list refreshes (after any mutation that
  // could clear a suggestion via accept/reject).
  const [pendingCount, setPendingCount] = useState(0);

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
  }, [hasAccess, statusFilter, fromDate, toDate]);

  // Faktura monthly usage — drives the "12 of 30 this month" chip
  // and the "approaching cap" UpgradeNudge banner near the limit.
  // null = not loaded yet (Pro shows nothing); on Starter shows the
  // chip + a soft "Upgrade to Pro for unlimited" hint at 80%+.
  const [usage, setUsage] = useState(null);
  // Modal-style nudge — fires when /invoices POST returns 402 because
  // the user hit their Starter monthly cap. Provides a clear pitch
  // instead of a generic error.
  const [upgradeNudge, setUpgradeNudge] = useState(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status_filter = statusFilter;
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      // Fire all 4 in parallel — payment-suggestions + usage are both
      // single-COUNT queries server-side so the parallelism is free.
      const [inv, cust, pending, usageRes] = await Promise.all([
        api.get("/invoices", { params }),
        api.get("/customers"),
        api.get("/payment-suggestions/pending-count").catch(() => ({ data: { pending_count: 0 } })),
        api.get("/invoices/usage").catch(() => ({ data: null })),
      ]);
      setInvoices(inv.data);
      setCustomers(cust.data);
      setPendingCount(pending.data?.pending_count || 0);
      setUsage(usageRes.data);
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
        <div className="flex items-center gap-2 flex-wrap">
          {pendingCount > 0 && (
            <Link
              to="/faktura/review"
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-200 rounded-xl text-sm font-semibold transition"
              title={t("reviewBadgeHint") || "Bank deposits that need your confirmation"}
            >
              📥 {pendingCount} {t("toReview") || "to review"}
            </Link>
          )}
        <button
          onClick={() => setShowForm(true)}
          disabled={customers.length === 0}
          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          title={customers.length === 0 ? (t("addCustomerFirst") || "Add a customer first") : ""}
        >
          + {t("newInvoice") || "New invoice"}
        </button>
        </div>
      </div>

      {/* Monthly usage chip — only shown for tiers with a real cap
          (Starter). Pro / Trial = unlimited → no chip. Free can't
          reach this page because hasAccess gates everything. */}
      {usage && !usage.unlimited && typeof usage.monthly_cap === "number" && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-800 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-stone-500 dark:text-stone-400">
              {t("fakturaMonthlyUsage", "This month")}
            </span>
            <span className="font-semibold text-stone-800 dark:text-stone-100">
              {usage.used_this_month} / {usage.monthly_cap}
            </span>
            {/* Progress bar */}
            <div className="hidden sm:block flex-1 max-w-[160px] h-1.5 bg-stone-200 dark:bg-stone-700 rounded-full overflow-hidden ml-2">
              <div
                className={
                  "h-full transition-all " +
                  (usage.used_this_month / usage.monthly_cap >= 0.9
                    ? "bg-amber-500"
                    : "bg-emerald-500")
                }
                style={{
                  width: `${Math.min(100, (usage.used_this_month / usage.monthly_cap) * 100)}%`,
                }}
              />
            </div>
          </div>
          {/* Soft nudge once Starter is at 80% — gentle "Pro is
              unlimited" reminder. Not blocking; just informational. */}
          {usage.used_this_month / usage.monthly_cap >= 0.8 && (
            <UpgradeNudge
              intent="inline"
              tier="pro"
              benefit={t("nudgeUnlimitedFakt", "Unlimited fakturaer")}
            />
          )}
        </div>
      )}

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
            // Updated 2026-05-19 — direct Resend send is now the
            // primary path; mailto only as fallback if the server
            // can't deliver (Resend down / customer.email missing).
            title: t("fakturaStep3TitleNew", "3. Send — one tap, direct email"),
            body:
              t("fakturaStep3BodyNew",
                "Click Send: the invoice locks, the PDF goes straight to the customer's inbox via BonBox, and you're CC'd on every send. Reply-to is your email so the customer replies to you, not to noreply."),
          },
          {
            title: t("fakturaStep4Title") || "4. Get paid — two ways",
            body:
              t("fakturaStep4Body") ||
              "Auto: export your bank's CSV (2 clicks in netbank), upload it under Bank Import — BonBox matches payments to open invoices within ±2 kr tolerance and flips status to Paid. Manual: when the money lands and you spot it yourself, tap Mark paid on the invoice row. Either way, status updates everywhere and the customer never sees a 'still open' invoice.",
          },
        ]}
        footer={
          t("fakturaHowFooter") ||
          "Fakturanummer er løbende og uden huller per branch per år, jf. Bogføringsloven §7. Sendte fakturaer kan ikke slettes — annullér med kreditnota i stedet (vi laver den automatisk)."
        }
      />


      {/* Date range filter — preset chips set both from + to in one
          click. Manual date inputs available for precise range work.
          Defaults to all-time (both empty) so the page shows everything
          on first load — preset chips narrow when needed. */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-gray-500 dark:text-gray-400 font-medium">
              {t("dateRange") || "Date range"}:
            </span>
            {[
              { label: t("allTime") || "All time", from: "", to: "" },
              {
                label: t("thisMonth") || "This month",
                from: (() => { const d = new Date(); return localIso(new Date(d.getFullYear(), d.getMonth(), 1)); })(),
                to: localIso(),
              },
              {
                label: t("lastMonth") || "Last month",
                from: (() => { const d = new Date(); return localIso(new Date(d.getFullYear(), d.getMonth() - 1, 1)); })(),
                to: (() => { const d = new Date(); return localIso(new Date(d.getFullYear(), d.getMonth(), 0)); })(),
              },
              {
                label: t("thisQuarter") || "This quarter",
                from: (() => { const d = new Date(); const q = Math.floor(d.getMonth() / 3); return localIso(new Date(d.getFullYear(), q * 3, 1)); })(),
                to: localIso(),
              },
              {
                label: t("yearToDate") || "Year to date",
                from: `${new Date().getFullYear()}-01-01`,
                to: localIso(),
              },
            ].map((p) => {
              const active = fromDate === p.from && toDate === p.to;
              return (
                <button
                  key={p.label}
                  onClick={() => { setFromDate(p.from); setToDate(p.to); }}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                    active
                      ? "bg-green-600 text-white"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-xs"
            />
            <span className="text-gray-400">→</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-xs"
            />
          </div>
        </div>
      </div>

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
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-10 sm:p-12 text-center border border-gray-100 dark:border-gray-700">
          <p className="text-4xl mb-3">🧾</p>
          <p className="text-stone-800 dark:text-stone-100 font-semibold text-base mb-1.5">
            {t("noInvoicesYet") || "No invoices yet"}
          </p>
          <p className="text-stone-500 dark:text-stone-400 text-sm max-w-md mx-auto leading-relaxed mb-5">
            {t("noInvoicesYetHint") ||
              "Tap + New invoice above to create your first. Customers can be auto-filled from CVR — no manual typing of address or company name."}
          </p>
          <Link
            to="/connections"
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition"
          >
            {t("noInvoicesConnHint") || "Or finish your setup first"} <span aria-hidden="true">→</span>
          </Link>
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
          onPlanCap={(detail) => {
            // Starter hit the 30/month cap. Close the form and surface
            // the Pro upgrade dialog with the used/cap counts.
            setShowForm(false);
            setUpgradeNudge({
              tier: detail.required_plan || "pro",
              benefit: t(
                "nudgeInvoiceCap",
                `You've issued ${detail.used_this_month} of ${detail.monthly_cap} fakturaer this month. Pro is unlimited.`
              ),
              icon: "🧾",
            });
          }}
          t={t}
        />
      )}

      {/* Upgrade nudge dialog — Starter user hit the monthly cap */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          icon={upgradeNudge.icon}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}
    </div>
  );
}

// ─── Single row + status actions ──────────────────────────────────

function InvoiceRow({ invoice, customer, onChanged, t }) {
  // Kreditnota dialog state — Bogføringsloven §7: a sent invoice can't
  // be deleted, only credited. The dialog explains this gravity so the
  // owner understands the action before they confirm.
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidSubmitting, setVoidSubmitting] = useState(false);
  const [voidError, setVoidError] = useState("");
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
      // 1. Flip status to 'sent' + lock + record sent_at (only if still draft)
      if (invoice.status === "draft") {
        await api.post(`/invoices/${invoice.id}/send`);
      }

      // 2. PRIMARY: server-side direct email via Resend. The customer
      //    gets the PDF straight in their inbox — no mailto dance, no
      //    manual re-attach on iPhone Safari. Reply-to is the owner's
      //    email so the customer can reply directly.
      try {
        const r = await api.post(`/invoices/${invoice.id}/send-email`, {
          cc_self: true,
        });
        if (r.data?.ok) {
          alert(
            (t("invoiceSentDirect") || "✓ Faktura emailed to") +
            ` ${r.data.sent_to}` +
            (r.data.cc_self ? ` (${t("ccdYou") || "you cc'd"})` : "")
          );
          onChanged();
          return;
        }
      } catch (sendErr) {
        // 5xx or transient — fall through to the mailto fallback so the
        // user always has a working path. 4xx (no_recipient, plan-cap)
        // we surface directly.
        const status = sendErr.response?.status;
        if (status && status >= 400 && status < 500 && status !== 402) {
          const detail = sendErr.response?.data?.detail;
          alert(
            typeof detail === "string"
              ? detail
              : (detail?.message || (t("sendFailed") || "Send failed"))
          );
          return;
        }
        // 5xx → fall through to manual mailto fallback below
      }

      // 3. FALLBACK: download PDF + open mailto so the user can attach
      //    manually. Same UX as before — runs only if Resend is down or
      //    not configured.
      const res = await api.get(`/invoices/${invoice.id}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `faktura-${invoice.fakturanummer_formatted}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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

  const openVoidDialog = () => {
    setVoidReason("");
    setVoidError("");
    setVoidOpen(true);
  };

  const submitVoid = async () => {
    const trimmed = voidReason.trim();
    if (trimmed.length < 5) {
      setVoidError(t("kreditnotaReasonTooShort") || "Reason must be at least 5 characters — your accountant will see this.");
      return;
    }
    if (trimmed.length > 200) {
      setVoidError(t("kreditnotaReasonTooLong") || "Reason is too long (max 200 characters).");
      return;
    }
    setVoidSubmitting(true);
    setVoidError("");
    try {
      await api.post(`/invoices/${invoice.id}/void`, { reason: trimmed });
      setVoidOpen(false);
      onChanged();
    } catch (e) {
      setVoidError(e?.response?.data?.detail || (t("voidFailed") || "Couldn't create kreditnota — please try again."));
    } finally {
      setVoidSubmitting(false);
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
    <>
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
            <button onClick={openVoidDialog} className="text-red-600 hover:underline text-xs font-medium px-2">
              {t("voidInvoice") || "Void"}
            </button>
          )}
          <button onClick={handleDownloadPdf} className="text-gray-600 dark:text-gray-300 hover:underline text-xs">
            {t("downloadPdf") || "PDF"}
          </button>
        </div>
      </td>
    </tr>
    {voidOpen && (
      <tr>
        <td colSpan={7} className="p-0">
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-stone-900 rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
              <div className="px-5 pt-5 pb-3 border-b border-stone-100 dark:border-stone-800">
                <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100 flex items-center gap-2">
                  ↩ {t("kreditnotaTitle") || "Create kreditnota"}
                </h3>
                <p className="text-xs text-stone-500 dark:text-stone-400 mt-1.5 leading-relaxed">
                  {(t("kreditnotaBody") ||
                    "Sent fakturaer can't be deleted (Bogføringsloven §7). Voiding creates a kreditnota with the next number — the original keeps its number and stays in the ledger. Both records are locked and auditable.")}
                </p>
              </div>
              <div className="px-5 py-4 space-y-3">
                <div className="text-xs text-stone-500 dark:text-stone-400">
                  <span className="text-stone-700 dark:text-stone-300 font-medium">
                    {invoice.fakturanummer_formatted}
                  </span>
                  {" · "}
                  {new Intl.NumberFormat("da-DK", { style: "currency", currency: invoice.currency }).format(invoice.total_gross)}
                  {customer?.name ? ` · ${customer.name}` : ""}
                </div>
                <label className="block">
                  <span className="block text-xs font-medium text-stone-700 dark:text-stone-300 mb-1.5">
                    {t("kreditnotaReasonLabel") || "Reason (visible to your accountant)"}
                  </span>
                  <textarea
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    rows={3}
                    maxLength={200}
                    placeholder={t("kreditnotaReasonPlaceholder") ||
                      "e.g. Customer canceled order — refunded via MobilePay 18/05"}
                    className="w-full px-3 py-2 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    autoFocus
                  />
                  <span className="block text-[10.5px] text-stone-400 mt-1">
                    {voidReason.length}/200
                  </span>
                </label>
                {voidError && (
                  <p className="text-xs text-red-600 dark:text-red-400">{voidError}</p>
                )}
              </div>
              <div className="px-5 py-4 bg-stone-50 dark:bg-stone-800/40 flex items-center justify-end gap-2 border-t border-stone-100 dark:border-stone-800">
                <button
                  onClick={() => setVoidOpen(false)}
                  disabled={voidSubmitting}
                  className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-50 transition"
                >
                  {t("cancel") || "Cancel"}
                </button>
                <button
                  onClick={submitVoid}
                  disabled={voidSubmitting || voidReason.trim().length < 5}
                  className="px-4 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition"
                >
                  {voidSubmitting
                    ? (t("kreditnotaSubmitting") || "Creating…")
                    : (t("kreditnotaConfirm") || "Create kreditnota")}
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

// ─── Create modal ──────────────────────────────────────────────────

function CreateInvoiceModal({ customers, onClose, onCreated, onPlanCap, t }) {
  const [customerId, setCustomerId] = useState(customers[0]?.id || "");
  // localIso() respects the user's timezone — fixes the off-by-one where
  // a Danish owner at 01:14 CEST saw Issued=yesterday because toISOString
  // returns UTC. See utils/dateFormat.js for full rationale.
  const [issueDate, setIssueDate] = useState(localIso());
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
      const detail = err?.response?.data?.detail;
      // 402 plan_required with the faktura cap detail → call the
      // parent's onPlanCap so the page can surface the UpgradeNudge.
      if (err?.response?.status === 402 &&
          detail?.code === "plan_required" &&
          typeof detail?.used_this_month === "number" &&
          onPlanCap) {
        onPlanCap(detail);
        return;
      }
      setError(
        detail?.message ||
        (typeof detail === "string" ? detail : "Create failed")
      );
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
