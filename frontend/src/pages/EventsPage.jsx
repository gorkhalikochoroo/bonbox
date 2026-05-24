// EventsPage — cultural-event entity management (migration 013, kulturarrangør sprint).
//
// Built for the Sudip-style customer: cultural-event organizers, mobile
// vendors, pop-up shops who run 10-15 standalone events per year and
// need a way to slice the Sales ledger by which event a row belongs to.
//
// Two views in one page:
//   1. List — every event the owner has registered, newest first.
//   2. Detail — when an event is selected, show its summary (sales,
//      MOMS, guests, expense ties) + the LiveKpisToday card scoped to
//      that event's day.
//
// DK-first labels: we lean on "Event" in both EN and DK copy — Manoj's
// interviews confirmed Danish event organisers say "event" out loud,
// not "begivenhed". The DK terminology lock (kasserapport / revisor /
// MOMS / faktura) still applies to surfacing accountant artefacts.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { formatMoney } from "../utils/currency";

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
  const [creating, setCreating] = useState(false);

  // Selected event (right-pane summary)
  const [selectedId, setSelectedId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Search filter on the list
  const [q, setQ] = useState("");

  const fetchEvents = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/events", { params: { sort: "date_desc" } });
      setEvents(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setError(e?.response?.data?.detail || (t("eventsLoadFailed") || "Failed to load events"));
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

  const createEvent = async () => {
    if (!formName.trim() || !formDate) {
      setError(t("eventsNameDateRequired") || "Name and date are required");
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
      });
      setEvents((prev) => [res.data, ...prev]);
      setSelectedId(res.data.id);
      setShowForm(false);
      setFormName("");
      setFormDate("");
      setFormVenue("");
      setFormNotes("");
    } catch (e) {
      setError(e?.response?.data?.detail || (t("eventsCreateFailed") || "Failed to create event"));
    } finally {
      setCreating(false);
    }
  };

  const deleteEvent = async (id) => {
    if (!confirm(t("eventsConfirmDelete") || "Soft-delete this event? Past sales stay tagged.")) return;
    try {
      await api.delete(`/events/${id}`);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(e?.response?.data?.detail || (t("eventsDeleteFailed") || "Failed to delete event"));
    }
  };

  const moneyFmt = (n) => formatMoney(n || 0, currency, { decimals: 0 });

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <span aria-hidden>📅</span> {t("eventsTitle") || "Events"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("eventsSubtitle") ||
              "Tag sales by the cultural event or pop-up they belong to. One click to see totals, guests, and MOMS per event."}
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition"
        >
          {showForm ? (t("cancel") || "Cancel") : `+ ${t("eventsNew") || "New event"}`}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {showForm && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("eventsNew") || "New event"}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("eventsNamePlaceholder") || "Event name (e.g. Nepali Movie Night)"}
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
              placeholder={t("eventsVenuePlaceholder") || "Venue (optional)"}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
            />
            <input
              type="text"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder={t("eventsNotesPlaceholder") || "Notes (optional)"}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={createEvent}
              disabled={creating}
              className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition disabled:opacity-60"
            >
              {creating ? (t("creating") || "Creating…") : (t("save") || "Save")}
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
            placeholder={t("search") || "Search…"}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
          />

          {loading ? (
            <div className="text-sm text-gray-500">{t("loading") || "Loading…"}</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
              {t("eventsEmpty") ||
                "No events yet. Create one to start tagging sales by event."}
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
                      <div className="font-medium text-gray-800 dark:text-gray-100 truncate">
                        {ev.name}
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
                      aria-label={t("delete") || "Delete"}
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
              {t("eventsSelectHint") || "Pick an event on the left to see its summary."}
            </div>
          ) : summaryLoading ? (
            <div className="text-sm text-gray-500">{t("loading") || "Loading…"}</div>
          ) : !summary ? (
            <div className="text-sm text-red-600">
              {t("eventsSummaryFailed") || "Couldn't load summary."}
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
                  label={t("eventsTotalSales") || "Total sales"}
                  value={moneyFmt(summary.total_sales_amount)}
                  helper={`${summary.sale_count} ${t("eventsSalesUnit") || "sales"}`}
                />
                <Stat
                  label={"MOMS"}
                  value={moneyFmt(summary.total_moms)}
                  helper={t("eventsMomsHint") || "owner view, see PDF for accountant total"}
                />
                <Stat
                  label={t("eventsExempt") || "MOMS-exempt"}
                  value={moneyFmt(summary.total_exempt_amount)}
                />
                <Stat
                  label={t("eventsGuests") || "Guests"}
                  value={String(summary.total_guests)}
                />
              </div>

              {(summary.expense_count > 0 || summary.total_expense_amount > 0) && (
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
                  <div className="text-xs uppercase tracking-wide text-gray-500">
                    {t("eventsExpenses") || "Expenses tied to event"}
                  </div>
                  <div className="text-base font-semibold mt-1">
                    {moneyFmt(summary.total_expense_amount)} · {summary.expense_count}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Link
                  to={`/sales?event_id=${summary.event.id}`}
                  className="inline-flex items-center justify-center px-3 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl text-sm font-medium hover:opacity-90 transition"
                >
                  {t("eventsViewSales") || "View tagged sales →"}
                </Link>
                <button
                  onClick={() => setSelectedId(null)}
                  className="inline-flex items-center justify-center px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-xl text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                >
                  {t("close") || "Close"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
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
