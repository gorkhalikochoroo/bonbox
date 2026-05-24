// EventsPage — cultural-event entity management (migration 013 + 015).
//
// Built for the Sudip-style customer: cultural-event organizers, mobile
// vendors, pop-up shops who run 10-15 standalone events per year and
// need a way to slice the Sales ledger by which event a row belongs to.
//
// Two views in one page:
//   1. List — every event the owner has registered, newest first.
//   2. Detail — when an event is selected, show its summary (sales,
//      MOMS, guests, expense ties) + the "Cash up event" CTA + the
//      LiveKpisToday card scoped to that event's day.
//
// Migration 015 additions:
//   • Create/edit form includes a "Ticket tiers" section (collapsible,
//     defaults closed for backwards-compat). Up to 6 tiers, each
//     {label, price_dkk}. Plus a "MOMS-fri" toggle for §13-exempt
//     events (legit cases: live theatre, museum — note cinema is NOT
//     exempt).
//   • Event detail has a "Cash up event" button that opens
//     EventCashupModal — disabled with a tooltip when the event has
//     no tiers defined.
//
// DK-first labels: we lean on "Event" in both EN and DK copy — Manoj's
// interviews confirmed Danish event organisers say "event" out loud,
// not "begivenhed". The DK terminology lock (kasserapport / revisor /
// MOMS / faktura) still applies to surfacing accountant artefacts.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, Plus, Trash2 } from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { formatMoney } from "../utils/currency";
import EventCashupModal from "../components/EventCashupModal";

// ── Default tier suggestions ──────────────────────────────────────────
// Common DK ticket types — used to seed the create-tier form so an
// owner without a clear preference gets a sensible starting point.
// Labels stay Danish per the DK terminology lock.
const DEFAULT_TIER_SUGGESTIONS = [
  { label: "Voksen", price_dkk: 150 },
  { label: "Studerende", price_dkk: 100 },
  { label: "Barn", price_dkk: 50 },
];

const EMPTY_TIER = { label: "", price_dkk: "" };

export default function EventsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = user?.currency || "DKK";

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Form state for + New event
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDate, setFormDate] = useState("");
  const [formVenue, setFormVenue] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formTiers, setFormTiers] = useState([]);   // {label, price_dkk}
  const [formTaxExempt, setFormTaxExempt] = useState(false);
  const [showTierSection, setShowTierSection] = useState(false);
  const [creating, setCreating] = useState(false);

  // Selected event (right-pane summary)
  const [selectedId, setSelectedId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Cash-up modal
  const [cashupOpen, setCashupOpen] = useState(false);

  // Search filter on the list
  const [q, setQ] = useState("");

  const fetchEvents = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/events", { params: { sort: "date_desc" } });
      setEvents(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setError(e?.response?.data?.detail || t("eventsLoadFailed", "Failed to load events"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    // fetchEvents is stable for this component; explicit dep array
    // keeps the mount-only semantics. eslint-disable for the rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSummary(null);
      return;
    }
    let alive = true;
    setSummaryLoading(true);
    api
      .get(`/events/${selectedId}/summary`)
      .then((r) => {
        if (alive) setSummary(r.data);
      })
      .catch(() => {
        if (alive) setSummary(null);
      })
      .finally(() => {
        if (alive) setSummaryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const filtered = useMemo(() => {
    if (!q.trim()) return events;
    const needle = q.trim().toLowerCase();
    return events.filter((e) =>
      [e.name, e.venue, e.notes].some((field) =>
        (field || "").toLowerCase().includes(needle)
      )
    );
  }, [events, q]);

  // ── Tier-row editing helpers ─────────────────────────────────────
  // Empty state = section collapsed + no tiers. First "Add tier" click
  // expands the section and seeds one empty row.
  function openTierSection() {
    setShowTierSection(true);
    if (formTiers.length === 0) {
      setFormTiers([{ ...EMPTY_TIER }]);
    }
  }
  function applyTierSuggestions() {
    // Replace, not append — owners who tap "suggestions" expect a clean
    // 3-tier slate. The labels are sentence-cased Danish ("Voksen" not
    // "VOKSEN") per the DK terminology convention.
    setFormTiers(
      DEFAULT_TIER_SUGGESTIONS.map((t) => ({ label: t.label, price_dkk: String(t.price_dkk) })),
    );
  }
  function addTier() {
    if (formTiers.length >= 6) return;
    setFormTiers((prev) => [...prev, { ...EMPTY_TIER }]);
  }
  function removeTier(idx) {
    setFormTiers((prev) => prev.filter((_, i) => i !== idx));
  }
  function setTierField(idx, field, value) {
    setFormTiers((prev) =>
      prev.map((tier, i) =>
        i === idx
          ? {
              ...tier,
              [field]:
                field === "price_dkk"
                  ? value.replace(/[^\d]/g, "").slice(0, 6)
                  : value.slice(0, 40),
            }
          : tier,
      ),
    );
  }

  // Build the ticket_tiers payload for the API. Filter rows that are
  // entirely empty (drift from a row the owner expanded but didn't
  // fill) — those would fail Pydantic min_length=1 on label. Throws
  // if any half-filled tier exists so the caller can surface a clear
  // error rather than silently dropping the row.
  function buildTiersPayload() {
    const real = formTiers.filter(
      (t) => t.label.trim() || String(t.price_dkk).trim(),
    );
    for (const tier of real) {
      if (!tier.label.trim()) {
        throw new Error(t("eventTicketTierLabelMissing", "Every tier needs a label."));
      }
      const price = parseInt(tier.price_dkk, 10);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          t("eventTicketTierPriceInvalid", "Tier price must be a whole number ≥ 0 kr."),
        );
      }
    }
    // Case-insensitive dupe check matches the backend validator so the
    // user sees a clear message before the round-trip.
    const seen = new Set();
    for (const tier of real) {
      const key = tier.label.trim().toLowerCase();
      if (seen.has(key)) {
        throw new Error(
          t("eventTicketTierDuplicate", "Tier labels must be unique."),
        );
      }
      seen.add(key);
    }
    return real.map((tier) => ({
      label: tier.label.trim(),
      price_dkk: parseInt(tier.price_dkk, 10),
    }));
  }

  const resetForm = () => {
    setShowForm(false);
    setFormName("");
    setFormDate("");
    setFormVenue("");
    setFormNotes("");
    setFormTiers([]);
    setFormTaxExempt(false);
    setShowTierSection(false);
  };

  const createEvent = async () => {
    if (!formName.trim() || !formDate) {
      setError(t("eventsNameDateRequired", "Name and date are required"));
      return;
    }
    let tiers;
    try {
      tiers = buildTiersPayload();
    } catch (e) {
      setError(e.message);
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await api.post("/events", {
        name: formName.trim(),
        event_date: formDate,
        venue: formVenue.trim() || null,
        notes: formNotes.trim() || null,
        ticket_tiers: tiers.length > 0 ? tiers : null,
        is_tax_exempt: !!formTaxExempt,
      });
      setEvents((prev) => [res.data, ...prev]);
      setSelectedId(res.data.id);
      resetForm();
    } catch (e) {
      setError(e?.response?.data?.detail || t("eventsCreateFailed", "Failed to create event"));
    } finally {
      setCreating(false);
    }
  };

  const deleteEvent = async (id) => {
    if (!confirm(t("eventsConfirmDelete", "Soft-delete this event? Past sales stay tagged."))) return;
    try {
      await api.delete(`/events/${id}`);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(e?.response?.data?.detail || t("eventsDeleteFailed", "Failed to delete event"));
    }
  };

  // ── Cash-up flow ─────────────────────────────────────────────────
  // The modal hands us the request payload; we POST and on success
  // refresh both the summary (from the response) and the events list
  // (so the list-card date / venue stays in sync if anything else
  // changed). Errors propagate back to the modal so it can surface
  // the backend's detail message verbatim.
  const handleCashedUp = async (payload) => {
    if (!selectedId) return;
    const res = await api.post(`/events/${selectedId}/cashup`, payload);
    setSummary(res.data.summary);
    setCashupOpen(false);
    // Cross-page refresh signal — Dashboard, Sales, Reports, Expenses
    // listen for "bonbox-data-changed" and auto-refetch when a sale
    // mutation lands anywhere in the app. Without this dispatch the
    // freshly-cashed-up event's Sale row stays invisible on other open
    // tabs until the user manually refreshes. Pattern documented in
    // QuickAdd.jsx + KhataPage.jsx where it was already established.
    window.dispatchEvent(new Event("bonbox-data-changed"));
    // Lightweight success surfacing — re-uses the error banner slot
    // with a green tint so the owner sees confirmation immediately.
    setError("");
    // Bilagsnummer is the proof point — show it so the owner trusts
    // the row landed in the SKAT-compliant sequence.
    const vno = res.data?.sale?.voucher_number;
    const grossNum = res.data?.sale?.amount;
    setSuccessMsg(
      vno
        ? t(
            "eventCashupSuccessWithVno",
            "Cash-up logged · Bilagsnummer #{vno} · {gross}",
            {
              vno,
              gross: formatMoney(grossNum || 0, currency, { decimals: 0 }),
            },
          )
        : t(
            "eventCashupSuccess",
            "Cash-up logged · {gross}",
            {
              gross: formatMoney(grossNum || 0, currency, { decimals: 0 }),
            },
          ),
    );
    // Clear success banner after 6 seconds — long enough to read but
    // not lingering once the owner moves on to the next action.
    setTimeout(() => setSuccessMsg(""), 6000);
  };

  const [successMsg, setSuccessMsg] = useState("");

  const moneyFmt = (n) => formatMoney(n || 0, currency, { decimals: 0 });

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedId) || null,
    [events, selectedId],
  );
  const cashupReady = !!(selectedEvent && selectedEvent.ticket_tiers && selectedEvent.ticket_tiers.length > 0);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <span aria-hidden>📅</span> {t("eventsTitle", "Events")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t(
              "eventsSubtitle",
              "Tag sales by the cultural event or pop-up they belong to. One click to see totals, guests, and MOMS per event.",
            )}
          </p>
        </div>
        <button
          onClick={() => (showForm ? resetForm() : setShowForm(true))}
          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition"
        >
          {showForm ? t("cancel", "Cancel") : `+ ${t("eventsNew", "New event")}`}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 px-4 py-3 rounded-xl text-sm">
          {successMsg}
        </div>
      )}

      {showForm && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("eventsNew", "New event")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("eventsNamePlaceholder", "Event name (e.g. Nepali Movie Night)")}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
            />
            <input
              type="date"
              value={formDate}
              onChange={(e) => setFormDate(e.target.value)}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
            />
            <input
              type="text"
              value={formVenue}
              onChange={(e) => setFormVenue(e.target.value)}
              placeholder={t("eventsVenuePlaceholder", "Venue (optional)")}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
            />
            <input
              type="text"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder={t("eventsNotesPlaceholder", "Notes (optional)")}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
            />
          </div>

          {/* ── Ticket tiers (collapsible, defaults closed) ─────────── */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-1">
            {!showTierSection ? (
              <button
                type="button"
                onClick={openTierSection}
                className="text-sm font-medium text-green-700 dark:text-green-400 hover:underline"
              >
                + {t("eventTicketTiersSection", "Add ticket tiers (enables Cash-up)")}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-green-600" aria-hidden />
                    {t("eventTicketTiersSection", "Ticket tiers")}
                  </h3>
                  <button
                    type="button"
                    onClick={applyTierSuggestions}
                    className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-200 underline"
                  >
                    {t("eventTicketTiersSuggest", "Use Voksen / Studerende / Barn")}
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    "eventTicketTiersHelp",
                    "Up to 6 tiers, whole DKK only. You'll enter quantities sold after the event.",
                  )}
                </p>
                {formTiers.map((tier, idx) => (
                  <div key={idx} className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={tier.label}
                      onChange={(e) => setTierField(idx, "label", e.target.value)}
                      placeholder={t("eventTicketTierLabel", "Label (e.g. Voksen)")}
                      maxLength={40}
                      className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
                    />
                    <div className="flex gap-2">
                      <div className="relative flex-1 sm:flex-none sm:w-32">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={tier.price_dkk}
                          onChange={(e) => setTierField(idx, "price_dkk", e.target.value)}
                          placeholder={t("eventTicketTierPrice", "Price kr")}
                          className="w-full pl-3 pr-10 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                          kr
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTier(idx)}
                        aria-label={t("eventTicketTierRemove", "Remove tier")}
                        className="w-10 h-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-600 hover:border-red-300"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                {formTiers.length < 6 && (
                  <button
                    type="button"
                    onClick={addTier}
                    className="inline-flex items-center gap-1 text-sm font-medium text-green-700 dark:text-green-400 hover:underline"
                  >
                    <Plus className="w-4 h-4" />
                    {t("eventTicketTierAdd", "Add another tier")}
                  </button>
                )}
                <label className="flex items-center gap-2 mt-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={formTaxExempt}
                    onChange={(e) => setFormTaxExempt(e.target.checked)}
                    className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                  />
                  <span>
                    {t("eventIsTaxExempt", "MOMS-fri event (e.g. §13 live theatre)")}
                  </span>
                </label>
                <p className="text-[11px] text-gray-400 dark:text-gray-500 -mt-1 ml-6">
                  {t(
                    "eventIsTaxExemptHint",
                    "Stamps each cash-up sale as MOMS-fri. Cinema isn't exempt — leave unchecked for movie nights.",
                  )}
                </p>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={createEvent}
              disabled={creating}
              className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition disabled:opacity-60"
            >
              {creating ? t("creating", "Creating…") : t("save", "Save")}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* List */}
        <div className="space-y-3">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search", "Search…")}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
          />

          {loading ? (
            <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
              {t(
                "eventsEmpty",
                "No events yet. Create one to start tagging sales by event.",
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.map((ev) => (
                <li
                  key={ev.id}
                  className={`rounded-xl border px-4 py-3 cursor-pointer transition ${
                    selectedId === ev.id
                      ? "border-green-500 bg-green-50 dark:bg-green-900/20"
                      : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-gray-300"
                  }`}
                  onClick={() => setSelectedId(ev.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 dark:text-gray-100 truncate flex items-center gap-2">
                        {ev.name}
                        {ev.ticket_tiers && ev.ticket_tiers.length > 0 && (
                          <span
                            title={t(
                              "eventTicketTierBadge",
                              "{n} ticket tier(s) defined",
                              { n: ev.ticket_tiers.length },
                            )}
                            className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                          >
                            {ev.ticket_tiers.length}× {t("eventTicketTierBadgeShort", "tier")}
                          </span>
                        )}
                        {ev.is_tax_exempt && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                            MOMS-fri
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {ev.event_date}
                        {ev.venue ? ` · ${ev.venue}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteEvent(ev.id);
                      }}
                      className="text-xs text-gray-400 hover:text-red-600"
                      aria-label={t("delete", "Delete")}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
          {!selectedId ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
              {t("eventsSelectHint", "Pick an event on the left to see its summary.")}
            </div>
          ) : summaryLoading ? (
            <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
          ) : !summary ? (
            <div className="text-sm text-red-600">
              {t("eventsSummaryFailed", "Couldn't load summary.")}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                  {summary.event.name}
                </h2>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {summary.event.event_date}
                  {summary.event.venue ? ` · ${summary.event.venue}` : ""}
                </div>
                {summary.event.notes && (
                  <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                    {summary.event.notes}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label={t("eventsTotalSales", "Total sales")}
                  value={moneyFmt(summary.total_sales_amount)}
                  helper={`${summary.sale_count} ${t("eventsSalesUnit", "sales")}`}
                />
                <Stat
                  label={"MOMS"}
                  value={moneyFmt(summary.total_moms)}
                  helper={t("eventsMomsHint", "owner view, see PDF for accountant total")}
                />
                <Stat
                  label={t("eventsExempt", "MOMS-exempt")}
                  value={moneyFmt(summary.total_exempt_amount)}
                />
                <Stat
                  label={t("eventsGuests", "Guests")}
                  value={String(summary.total_guests)}
                />
              </div>

              {(summary.expense_count > 0 || summary.total_expense_amount > 0) && (
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
                  <div className="text-xs uppercase tracking-wide text-gray-500">
                    {t("eventsExpenses", "Expenses tied to event")}
                  </div>
                  <div className="text-base font-semibold mt-1">
                    {moneyFmt(summary.total_expense_amount)} · {summary.expense_count}
                  </div>
                </div>
              )}

              {/* ── Cash-up CTA ────────────────────────────────────── */}
              {/* Disabled w/ tooltip when no tiers — guides the user to
                  edit the event and add tiers without breaking the
                  flow with a hidden button. */}
              <button
                type="button"
                onClick={() => setCashupOpen(true)}
                disabled={!cashupReady}
                title={
                  cashupReady
                    ? t("eventCashupButton", "Cash up event")
                    : t(
                        "eventCashupButtonDisabledHint",
                        "Add ticket tiers to this event first (Edit → Ticket tiers).",
                      )
                }
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Wallet className="w-4 h-4" aria-hidden />
                {t("eventCashupButton", "Cash up event")}
              </button>

              <div className="flex gap-2">
                <Link
                  to={`/sales?event_id=${summary.event.id}`}
                  className="inline-flex items-center justify-center px-3 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl text-sm font-medium hover:opacity-90 transition"
                >
                  {t("eventsViewSales", "View tagged sales →")}
                </Link>
                <button
                  onClick={() => setSelectedId(null)}
                  className="inline-flex items-center justify-center px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-xl text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                >
                  {t("close", "Close")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Cash-up modal ──────────────────────────────────────────── */}
      <EventCashupModal
        open={cashupOpen && !!selectedEvent}
        onClose={() => setCashupOpen(false)}
        event={selectedEvent}
        onCashedUp={handleCashedUp}
        currency={currency}
      />
    </div>
  );
}


function Stat({ label, value, helper }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-800 dark:text-gray-100 mt-1">{value}</div>
      {helper && <div className="text-xs text-gray-400 mt-0.5">{helper}</div>}
    </div>
  );
}
