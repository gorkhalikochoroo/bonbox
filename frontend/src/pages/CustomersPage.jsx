import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import HowItWorksCard from "../components/HowItWorksCard";

/**
 * CustomersPage — debitor management.
 *
 * Used by Faktura: every invoice needs a Customer. Owners can also
 * pre-populate customers separately. Soft-delete only (referential
 * integrity with past invoices).
 */
export default function CustomersPage() {
  const { user } = useAuth();
  const { t } = useLanguage();

  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [q, setQ] = useState("");

  // Plan gate (defense-in-depth — backend also enforces).
  // Trial users get Pro-tier access during the 14-day window — include them
  // so the trial actually demos every paid feature.
  const plan = (user?.plan || "free").toLowerCase();
  const hasAccess = ["starter", "pro", "business", "trial"].includes(plan);

  useEffect(() => {
    if (!hasAccess) {
      setLoading(false);
      return;
    }
    fetchCustomers();
  }, [hasAccess]);

  const fetchCustomers = async () => {
    setLoading(true);
    try {
      const res = await api.get("/customers");
      setCustomers(res.data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load customers");
    } finally {
      setLoading(false);
    }
  };

  const filtered = customers.filter((c) => {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      c.name?.toLowerCase().includes(needle) ||
      c.cvr?.toLowerCase().includes(needle) ||
      c.email?.toLowerCase().includes(needle)
    );
  });

  if (!hasAccess) {
    return (
      <div className="p-4 md:p-8 max-w-2xl mx-auto">
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-6 text-center">
          <div className="text-4xl mb-3">🔒</div>
          <h1 className="text-xl font-bold mb-2 text-amber-900 dark:text-amber-200">
            {t("invoicingStarterRequired") || "Customers & Invoicing — Starter plan required"}
          </h1>
          <p className="text-sm text-amber-800 dark:text-amber-300 mb-4">
            {t("invoicingStarterDesc") ||
              "Send fakturas, track customers, and log mileage. Upgrade to Starter to unlock."}
          </p>
          <a
            href="/subscription"
            className="inline-block px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 transition"
          >
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
            <span>👥</span> {t("customers") || "Customers"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("customersDesc") || "Debitors you invoice. CVR-verified for B2B."}
          </p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setShowForm(true);
          }}
          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition"
        >
          + {t("addCustomer") || "Add customer"}
        </button>
      </div>

      <HowItWorksCard
        storageKey="customers"
        icon="👥"
        tone="blue"
        title={t("customersHowTitle") || "How Customers works"}
        steps={[
          {
            title: t("customersStep1Title") || "1. B2B clients — search by CVR",
            body:
              t("customersStep1Body") ||
              "Type a Danish CVR number (8 digits). We auto-fill the company name, address, and postal code from the public CVR + DAWA registers — saves you from typos that nullify a faktura.",
          },
          {
            title: t("customersStep2Title") || "2. Private clients — no CVR",
            body:
              t("customersStep2Body") ||
              "Toggle off the B2B switch for privatpersoner. We still need a name and at least one of email or phone so the faktura has somewhere to land.",
          },
          {
            title: t("customersStep3Title") || "3. Set sensible defaults",
            body:
              t("customersStep3Body") ||
              "Pick the customer's invoice language (DA / EN) so the PDF arrives in the right one. Set payment terms — Danish default is 8 dage netto. These pre-fill on every new faktura for this customer.",
          },
          {
            title: t("customersStep4Title") || "4. Deletes are soft",
            body:
              t("customersStep4Body") ||
              "Customers tied to past invoices can't be hard-deleted (Bogføringsloven §10 needs the audit trail intact). We hide them from your list but keep them linked to historical fakturaer.",
          },
        ]}
        footer={
          t("customersHowFooter") ||
          "CVR-numre valideres mod CVR-registeret (Erhvervsstyrelsen). Adresser hentes fra DAWA — Danmarks officielle adresseregister."
        }
      />

      <input
        type="text"
        placeholder={t("searchCustomers") || "Search by name, CVR, or email"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm"
      />

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">{t("loading") || "Loading…"}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-12 text-center border border-gray-100 dark:border-gray-700">
          <p className="text-4xl mb-3">👥</p>
          <p className="text-gray-600 dark:text-gray-300 font-medium">
            {q
              ? (t("noCustomersMatch") || "No customers match your search.")
              : (t("noCustomersYet") || "No customers yet. Add your first one to start invoicing.")}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400 uppercase text-xs">
              <tr>
                <th className="text-left px-5 py-3">{t("name") || "Name"}</th>
                <th className="text-left px-5 py-3">CVR</th>
                <th className="text-left px-5 py-3">{t("email") || "Email"}</th>
                <th className="text-left px-5 py-3">{t("paymentTermsDays") || "Terms"}</th>
                <th className="text-right px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
                  <td className="px-5 py-3 font-medium text-gray-800 dark:text-white">
                    {c.name}
                    {c.is_company && <span className="ml-2 text-xs text-blue-600 dark:text-blue-300">B2B</span>}
                  </td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{c.cvr || "—"}</td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-300 truncate max-w-[200px]">{c.email || "—"}</td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{c.payment_terms_days} {t("days") || "days"}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => {
                        setEditingId(c.id);
                        setShowForm(true);
                      }}
                      className="text-xs text-blue-600 hover:underline mr-3"
                    >
                      {t("edit") || "Edit"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <CustomerFormModal
          customerId={editingId}
          customers={customers}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            fetchCustomers();
          }}
          t={t}
        />
      )}
    </div>
  );
}

function CustomerFormModal({ customerId, customers, onClose, onSaved, t }) {
  const isEdit = !!customerId;
  const existing = customers.find((c) => c.id === customerId);
  const [form, setForm] = useState({
    name: existing?.name || "",
    cvr: existing?.cvr || "",
    is_company: existing?.is_company || false,
    email: existing?.email || "",
    phone: existing?.phone || "",
    address: existing?.address || "",
    zipcode: existing?.zipcode || "",
    city: existing?.city || "",
    country: existing?.country || "DK",
    payment_terms_days: existing?.payment_terms_days || 14,
    default_lang: existing?.default_lang || "da",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // CVR auto-lookup state. Tracks the *last CVR we attempted* so a user
  // editing the CVR (e.g. typo correction) doesn't re-fire the lookup
  // every keystroke once 8 digits are reached.
  const [cvrLookup, setCvrLookup] = useState({ status: "idle", forCvr: "" });

  // Trigger CVR autofill once the user has typed a valid 8-digit CVR.
  // Uses the same /business/lookup endpoint as the Profile flow — handles
  // CVR + DAWA address verification server-side.
  useEffect(() => {
    if (!form.is_company) return;
    const cvr = (form.cvr || "").trim();
    if (cvr.length !== 8 || !/^\d{8}$/.test(cvr)) return;
    if (cvrLookup.forCvr === cvr) return; // already tried this exact value

    let cancelled = false;
    setCvrLookup({ status: "loading", forCvr: cvr });
    api
      .get("/business/lookup", { params: { q: cvr, country: "DK" } })
      .then((res) => {
        if (cancelled) return;
        const hit = Array.isArray(res.data) ? res.data[0] : null;
        if (!hit?.name) {
          setCvrLookup({ status: "no-match", forCvr: cvr });
          return;
        }
        // Only auto-fill fields the user hasn't typed into — never clobber
        // existing input.
        setForm((f) => ({
          ...f,
          name: f.name || hit.name || "",
          // hit.address is "Vesterbrogade 1, 1620 København" — but we
          // store address + zipcode + city separately. cvrapi.dk also
          // gives us them separately via the raw fields, but the
          // service layer only surfaces the concatenated `address`
          // plus separate zipcode/city, so we use those.
          address: f.address || (hit.address || "").split(",")[0].trim() || "",
          zipcode: f.zipcode || hit.zipcode || "",
          city: f.city || hit.city || "",
          email: f.email || hit.email || "",
          phone: f.phone || hit.phone || "",
        }));
        setCvrLookup({ status: "ok", forCvr: cvr, hit });
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e?.response?.data?.detail || "Lookup failed";
        setCvrLookup({ status: "error", forCvr: cvr, msg });
      });

    return () => { cancelled = true; };
  }, [form.cvr, form.is_company]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form };
      // Drop empty strings (Pydantic prefers null/missing for optional)
      Object.keys(payload).forEach((k) => {
        if (payload[k] === "") delete payload[k];
      });
      if (isEdit) {
        await api.patch(`/customers/${customerId}`, payload);
      } else {
        await api.post("/customers", payload);
      }
      onSaved();
    } catch (err) {
      setError(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const update = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800 dark:text-white">
            {isEdit ? (t("editCustomer") || "Edit customer") : (t("addCustomer") || "Add customer")}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("name") || "Name"} *
              </label>
              <input
                type="text"
                value={form.name}
                onChange={update("name")}
                required
                placeholder={t("customerNamePlaceholder") || "Acme ApS"}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <label className="md:col-span-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.is_company} onChange={update("is_company")} />
              {t("isB2BCustomer") || "B2B customer (company)"}
            </label>

            {form.is_company && (
              <div className="md:col-span-2">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                  CVR
                </label>
                <input
                  type="text"
                  value={form.cvr}
                  onChange={update("cvr")}
                  placeholder="12345678"
                  maxLength={8}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm font-mono"
                />
                {cvrLookup.status === "loading" && (
                  <p className="mt-1 text-[11px] text-blue-600 dark:text-blue-400">
                    {t("cvrLookingUp") || "Looking up CVR…"}
                  </p>
                )}
                {cvrLookup.status === "ok" && (
                  <p className="mt-1 text-[11px] text-green-600 dark:text-green-400">
                    {t("cvrAutofilled") || "Auto-filled from CVR register"} ({cvrLookup.hit?.source || "cvrapi.dk"})
                  </p>
                )}
                {cvrLookup.status === "no-match" && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    {t("cvrNoMatch") || "No match found — enter details manually"}
                  </p>
                )}
                {cvrLookup.status === "error" && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    {t("cvrLookupError") || "CVR lookup unavailable — enter details manually"}
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("email") || "Email"}
              </label>
              <input
                type="email"
                value={form.email}
                onChange={update("email")}
                placeholder="finance@acme.dk"
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("phone") || "Phone"}
              </label>
              <input
                type="tel"
                value={form.phone}
                onChange={update("phone")}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("address") || "Address"}
              </label>
              <input
                type="text"
                value={form.address}
                onChange={update("address")}
                placeholder="Vesterbrogade 1"
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("zipcode") || "Zipcode"}
              </label>
              <input
                type="text"
                value={form.zipcode}
                onChange={update("zipcode")}
                placeholder="1620"
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("city") || "City"}
              </label>
              <input
                type="text"
                value={form.city}
                onChange={update("city")}
                placeholder="København"
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("paymentTermsDays") || "Payment terms (days)"}
              </label>
              <input
                type="number"
                value={form.payment_terms_days}
                onChange={update("payment_terms_days")}
                min={0}
                max={180}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                {t("invoiceLanguage") || "Invoice language"}
              </label>
              <select
                value={form.default_lang}
                onChange={update("default_lang")}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
              >
                <option value="da">Dansk</option>
                <option value="en">English</option>
              </select>
            </div>
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
              {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
