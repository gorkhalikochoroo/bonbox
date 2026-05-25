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
import {
  Wallet,
  Plus,
  Trash2,
  Check,
  Eye,
  RotateCcw,
  Link2,
  Upload,
  X,
} from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { formatMoney } from "../utils/currency";
import EventCashupModal from "../components/EventCashupModal";
import DataTable from "../components/ui/DataTable";
import TabPills from "../components/ui/TabPills";
import Empty from "../components/ui/Empty";
import Button from "../components/ui/Button";

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
const EMPTY_ADDON = { label: "", price_dkk: "" };

// ── Refund policy options (locked spec values) ────────────────────────
// Backend stores these as enum strings on events.refund_policy. Default
// "organizer" matches Sudip's mental model — he wants to approve each
// refund manually rather than auto-issue.
const REFUND_POLICY_VALUES = ["organizer", "7day", "no_refund"];

// ── Booking-side helpers ──────────────────────────────────────────────
// Cover image client-side cap. Server also enforces this — defense in
// depth. 5 MB matches the spec (§2 — Pro tier; Free is also capped at
// 1 image so this client check is enough).
const COVER_MAX_BYTES = 5 * 1024 * 1024;

// Public booking link. Hard-coded www host per spec §3 ("Sudip pastes
// it into Facebook"). Reads cleanly in DK Messenger preview.
const PUBLIC_EVENT_LINK_BASE = "https://www.bonbox.dk/e";

// Map booking.status → status-pill colour token. Stays at the file scope
// (not inside the component) so the pill renderer stays cheap to inline
// inside DataTable column render functions.
const BOOKING_STATUS_DOT = {
  reserved: "bg-gray-500",
  paid: "bg-emerald-500",
  attended: "bg-emerald-500",
  refunded: "bg-red-500",
  cancelled: "bg-red-500",
  expired: "bg-gray-400",
  pending: "bg-amber-500",
  "pending-pay": "bg-amber-500",
};

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
  // ── Booking-form extensions (P1) ───────────────────────────────────
  // starts_at / ends_at replace the single date field for publishable
  // events. We keep formDate populated too (the existing back-end still
  // requires `event_date` per migration 013); when starts_at is set,
  // formDate is derived from it on submit.
  const [formStartsAt, setFormStartsAt] = useState("");   // datetime-local
  const [formEndsAt, setFormEndsAt] = useState("");       // datetime-local
  // Cover image goes through POST /api/uploads/event-cover before we
  // stamp the URL onto the event create payload. Storing the URL (not
  // the File) means a failed event-create doesn't orphan an unused
  // upload — the backend will sweep dangling Supabase Storage rows.
  const [formCoverUrl, setFormCoverUrl] = useState("");
  const [coverUploading, setCoverUploading] = useState(false);
  // Add-ons: separate from ticket_tiers because the spec (§5.2) ships
  // them as a distinct JSONB column with different semantics — tiers
  // gate the cash-up totals, add-ons are upsells that don't.
  const [formAddons, setFormAddons] = useState([]);       // {label, price_dkk}
  const [formRefundPolicy, setFormRefundPolicy] = useState("organizer");
  const [formMakePublic, setFormMakePublic] = useState(false);

  // Selected event (right-pane summary)
  const [selectedId, setSelectedId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Cash-up modal
  const [cashupOpen, setCashupOpen] = useState(false);

  // ── Bookings tab state (P1) ────────────────────────────────────────
  // When the selected event is published, the detail-pane shows the
  // bookings list by default. Walk-ins (cash-up) becomes a secondary
  // tab. For unpublished events the tab control is hidden and we keep
  // the existing cash-up CTA front-and-centre.
  const [detailTab, setDetailTab] = useState("bookings"); // "bookings" | "walkins"
  const [bookings, setBookings] = useState([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsErr, setBookingsErr] = useState("");
  const [bookingActioningId, setBookingActioningId] = useState(null);
  // View-tickets modal — simple controlled state instead of pulling
  // the global <Modal> primitive because the content is just a list,
  // and the primitive's corner radius is the locked one (the doctrine
  // carve-out only applies to the primitive itself, not pages that
  // compose it).
  const [ticketsModalBooking, setTicketsModalBooking] = useState(null);

  // Success-toast slot — referenced from handleCashedUp + copyEventLink
  // below. Hoisted here so the closures have a stable binding at
  // declaration time (no temporal-dead-zone risk).
  const [successMsg, setSuccessMsg] = useState("");

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

  // Auto-pick the right default tab for the selected event: if it's
  // a published bookable event, default to Bookings; otherwise show
  // the existing Walk-ins / cash-up flow first. Re-runs every time
  // the user switches selectedId so each event picks its own default.
  useEffect(() => {
    if (!selectedId) return;
    const ev = events.find((e) => e.id === selectedId);
    if (ev?.published) {
      setDetailTab("bookings");
    } else {
      setDetailTab("walkins");
    }
    // We intentionally do not include `events` in deps — we only want
    // to set the default on selection change, not whenever the events
    // array re-fetches (which would clobber a manual tab switch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Fetch bookings when the bookings tab activates. Re-fetches when
  // the user switches between published events.
  useEffect(() => {
    if (!selectedId) return;
    if (detailTab !== "bookings") return;
    fetchBookings(selectedId);
    // fetchBookings is closure-stable; explicit dep list keeps this
    // tied to "tab activated for this event".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detailTab]);

  const pendingBookingIds = useMemo(
    () =>
      bookings
        .filter((b) => b.status === "reserved" || b.status === "pending-pay")
        .map((b) => b.id),
    [bookings],
  );

  const filtered = useMemo(() => {
    if (!q.trim()) return events;
    const needle = q.trim().toLowerCase();
    return events.filter((e) =>
      [e.name, e.venue, e.notes].some((field) =>
        (field || "").toLowerCase().includes(needle)
      )
    );
  }, [events, q]);

  // ── Cover image upload (Supabase Storage via backend proxy) ──────
  // Backend wraps the multipart upload, runs MIME-sniff, and returns
  // the public URL. We never touch the Supabase client directly here
  // — the auth+ACL story stays server-owned. 5 MB client check is a
  // UX cap, not security; backend re-validates.
  async function handleCoverUpload(file) {
    if (!file) return;
    if (file.size > COVER_MAX_BYTES) {
      setError(t("eventCoverTooLarge", "File too large (max 5 MB)"));
      return;
    }
    setError("");
    setCoverUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post("/uploads/event-cover", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setFormCoverUrl(res.data?.url || "");
    } catch (e) {
      setError(
        e?.response?.data?.detail ||
          t("eventCoverUploadFailed", "Couldn't upload cover image"),
      );
    } finally {
      setCoverUploading(false);
    }
  }

  // ── Add-on row helpers (mirror tier helpers — kept inline because
  // adding a shared util for an N≤6 repeater is more abstraction than
  // the carry-cost is worth.)
  function addAddon() {
    if (formAddons.length >= 6) return;
    setFormAddons((prev) => [...prev, { ...EMPTY_ADDON }]);
  }
  function removeAddon(idx) {
    setFormAddons((prev) => prev.filter((_, i) => i !== idx));
  }
  function setAddonField(idx, field, value) {
    setFormAddons((prev) =>
      prev.map((row, i) =>
        i === idx
          ? {
              ...row,
              [field]:
                field === "price_dkk"
                  ? value.replace(/[^\d]/g, "").slice(0, 6)
                  : value.slice(0, 40),
            }
          : row,
      ),
    );
  }

  function buildAddonsPayload() {
    const real = formAddons.filter(
      (a) => a.label.trim() || String(a.price_dkk).trim(),
    );
    for (const a of real) {
      if (!a.label.trim()) {
        throw new Error(
          t("eventAddonLabelMissing", "Every add-on needs a label."),
        );
      }
      const price = parseInt(a.price_dkk, 10);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          t(
            "eventAddonPriceInvalid",
            "Add-on price must be a whole number ≥ 0 kr.",
          ),
        );
      }
    }
    return real.map((a) => ({
      label: a.label.trim(),
      price_dkk: parseInt(a.price_dkk, 10),
    }));
  }

  // ── starts_at / ends_at defaults ──────────────────────────────────
  // When the user picks a start date+time we auto-fill ends_at to
  // start + 3h (matches the spec §3 default). They can override.
  function handleStartsAtChange(v) {
    setFormStartsAt(v);
    if (v && !formEndsAt) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(d.getHours() + 3);
        // datetime-local expects YYYY-MM-DDTHH:mm, no timezone
        const pad = (n) => String(n).padStart(2, "0");
        const iso =
          d.getFullYear() +
          "-" +
          pad(d.getMonth() + 1) +
          "-" +
          pad(d.getDate()) +
          "T" +
          pad(d.getHours()) +
          ":" +
          pad(d.getMinutes());
        setFormEndsAt(iso);
      }
    }
    // Keep formDate (the legacy single-date field, still required by
    // POST /events) in sync from the date-portion of starts_at so the
    // user never has to fill both.
    if (v) setFormDate(v.slice(0, 10));
  }

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
    setFormStartsAt("");
    setFormEndsAt("");
    setFormCoverUrl("");
    setFormAddons([]);
    setFormRefundPolicy("organizer");
    setFormMakePublic(false);
  };

  const createEvent = async () => {
    if (!formName.trim() || !formDate) {
      setError(t("eventsNameDateRequired", "Name and date are required"));
      return;
    }
    let tiers;
    let addons;
    try {
      tiers = buildTiersPayload();
      addons = buildAddonsPayload();
    } catch (e) {
      setError(e.message);
      return;
    }
    setCreating(true);
    setError("");
    try {
      // POST /events — extended with the P1 publishable-event fields.
      // The backend (parallel agent) is adding cover_image_url, addons,
      // refund_policy, starts_at, ends_at columns via migration 016.
      // We send nullable; older deploys ignore unknown fields.
      const res = await api.post("/events", {
        name: formName.trim(),
        event_date: formDate,
        venue: formVenue.trim() || null,
        notes: formNotes.trim() || null,
        ticket_tiers: tiers.length > 0 ? tiers : null,
        is_tax_exempt: !!formTaxExempt,
        starts_at: (() => {
          if (!formStartsAt) return null;
          const d = new Date(formStartsAt);
          return Number.isNaN(d.getTime()) ? null : d.toISOString();
        })(),
        ends_at: (() => {
          if (!formEndsAt) return null;
          const d = new Date(formEndsAt);
          return Number.isNaN(d.getTime()) ? null : d.toISOString();
        })(),
        cover_image_url: formCoverUrl || null,
        addons: addons.length > 0 ? addons : null,
        refund_policy: REFUND_POLICY_VALUES.includes(formRefundPolicy)
          ? formRefundPolicy
          : "organizer",
      });
      const createdEvent = res.data;
      // ── Two-step publish flow ──────────────────────────────────────
      // Publish is a SEPARATE endpoint (POST /events/{id}/publish) so
      // the L7 cap-check can run as a discrete failure mode. If the
      // user is on Free tier and already published 1 event this month
      // we get a 402 and surface the upgrade message — but keep the
      // (unpublished) event row, so they don't lose their work.
      let finalEvent = createdEvent;
      if (formMakePublic && createdEvent?.id) {
        try {
          const pubRes = await api.post(
            `/events/${createdEvent.id}/publish`,
            {},
          );
          finalEvent = {
            ...createdEvent,
            published: true,
            slug: pubRes.data?.slug || createdEvent.slug,
            public_url: pubRes.data?.public_url,
          };
        } catch (pubErr) {
          const status = pubErr?.response?.status;
          if (status === 402) {
            setError(
              t(
                "eventPublishFreeTierError",
                "Free accounts can only publish 1 event per month",
              ),
            );
          } else {
            setError(
              pubErr?.response?.data?.detail ||
                t("eventPublishFailed", "Couldn't publish event"),
            );
          }
          // We still keep the event row — `finalEvent` stays unpublished.
        }
      }
      setEvents((prev) => [finalEvent, ...prev]);
      setSelectedId(finalEvent.id);
      // If we hit the publish error path we surfaced it via setError —
      // keep the form open so the user can see the message + pick
      // "upgrade" or "keep as draft". Otherwise reset.
      if (!formMakePublic || finalEvent.published) {
        resetForm();
      } else {
        setCreating(false);
        return;
      }
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

  // ── Publish / unpublish ──────────────────────────────────────────
  // POST /api/events/{id}/publish — L7 cap-checks
  // `published_events_per_month`. 402 = Free tier hit cap; we honour
  // the spec's exact DA-fallback string. Everything else surfaces the
  // backend's detail or a fallback.
  const publishEvent = async (event) => {
    try {
      const res = await api.post(`/events/${event.id}/publish`, {});
      setEvents((prev) =>
        prev.map((e) =>
          e.id === event.id
            ? {
                ...e,
                published: true,
                slug: res.data?.slug || e.slug,
                public_url: res.data?.public_url,
              }
            : e,
        ),
      );
    } catch (e) {
      if (e?.response?.status === 402) {
        setError(
          t(
            "eventPublishFreeTierError",
            "Free accounts can only publish 1 event per month",
          ),
        );
      } else {
        setError(
          e?.response?.data?.detail ||
            t("eventPublishFailed", "Couldn't publish event"),
        );
      }
    }
  };

  const unpublishEvent = async (event) => {
    try {
      await api.post(`/events/${event.id}/unpublish`, {});
      setEvents((prev) =>
        prev.map((e) =>
          e.id === event.id ? { ...e, published: false } : e,
        ),
      );
    } catch (e) {
      setError(
        e?.response?.data?.detail ||
          t("eventUnpublishFailed", "Couldn't unpublish event"),
      );
    }
  };

  // ── Copy public link ─────────────────────────────────────────────
  // Uses navigator.clipboard.writeText (modern path) with a no-op
  // fallback when the API is blocked (rare — non-secure-context, but
  // bonbox.dk is HTTPS everywhere). We surface the toast via the
  // existing successMsg slot so we don't introduce a new toast
  // primitive just for this.
  const copyEventLink = async (event) => {
    if (!event?.slug) return;
    const url = `${PUBLIC_EVENT_LINK_BASE}/${event.slug}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      }
      setSuccessMsg(t("eventLinkCopied", "Link copied"));
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch {
      // Fall back to a less-pretty prompt if clipboard is unavailable.
      // Not localized — this only fires when the browser blocks
      // clipboard access (e.g. embedded webviews).
      try {
        window.prompt("Copy this link", url);
      } catch {
        /* truly headless — give up silently */
      }
    }
  };

  // ── Bookings tab data ────────────────────────────────────────────
  // Refetch helper extracted so row-actions can refresh after a
  // mark-paid / refund / bulk operation. The endpoint accepts
  // ?status=&limit=&offset= but for v1 we list everything and let
  // the user scroll — pagination is a v2 polish.
  const fetchBookings = async (eventId) => {
    if (!eventId) return;
    setBookingsLoading(true);
    setBookingsErr("");
    try {
      const res = await api.get(`/events/${eventId}/bookings`, {
        params: { limit: 200, offset: 0 },
      });
      // Endpoint returns either a bare array or {items: [...]} — be
      // tolerant of both shapes so the parallel backend agent has wiggle
      // room without breaking this page.
      const list = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.items)
          ? res.data.items
          : [];
      setBookings(list);
    } catch (e) {
      setBookingsErr(
        e?.response?.data?.detail ||
          t("bookingsLoadFailed", "Couldn't load bookings."),
      );
      setBookings([]);
    } finally {
      setBookingsLoading(false);
    }
  };

  // Mark a single booking paid → write_sale_from_booking server-side.
  // Optimistic local update keeps the UI snappy; we refetch after to
  // ensure status + sale_id reconcile.
  const markBookingPaid = async (booking) => {
    setBookingActioningId(booking.id);
    setBookingsErr("");
    // Optimistic UI: flip status locally so the action button hides
    // immediately, then reconcile from the response.
    setBookings((prev) =>
      prev.map((b) =>
        b.id === booking.id ? { ...b, status: "paid" } : b,
      ),
    );
    try {
      await api.post(`/bookings/${booking.id}/mark-paid`, {});
      // Cross-page refresh so Dashboard / Sales pick up the new sale.
      window.dispatchEvent(new Event("bonbox-data-changed"));
      await fetchBookings(selectedId);
    } catch (e) {
      setBookingsErr(
        e?.response?.data?.detail ||
          t("bookingActionFailed", "Action failed. Please try again."),
      );
      // Roll back the optimistic flip.
      setBookings((prev) =>
        prev.map((b) =>
          b.id === booking.id ? { ...b, status: booking.status } : b,
        ),
      );
    } finally {
      setBookingActioningId(null);
    }
  };

  const refundBooking = async (booking) => {
    if (
      !confirm(
        t(
          "bookingRefundConfirm",
          "Mark booking as refunded? BonBox writes the kreditnota — you handle the actual refund via MobilePay/Dankort.",
        ),
      )
    ) {
      return;
    }
    setBookingActioningId(booking.id);
    setBookingsErr("");
    try {
      await api.post(`/bookings/${booking.id}/mark-refunded`, {});
      window.dispatchEvent(new Event("bonbox-data-changed"));
      await fetchBookings(selectedId);
    } catch (e) {
      setBookingsErr(
        e?.response?.data?.detail ||
          t("bookingActionFailed", "Action failed. Please try again."),
      );
    } finally {
      setBookingActioningId(null);
    }
  };

  // Bulk mark-paid: the "Mark all paid" bar only renders when there
  // are ≥3 pending bookings (spec §0 — "small events Sudip just taps
  // each row; once you've got 3+ awaiting payment, the bulk button is
  // the right affordance").
  const bulkMarkAllPaid = async (pendingIds) => {
    if (pendingIds.length === 0) return;
    if (
      !confirm(
        t(
          "bookingMarkAllPaidConfirm",
          "Mark all {n} pending bookings as paid?",
          { n: pendingIds.length },
        ),
      )
    ) {
      return;
    }
    setBookingsErr("");
    // Optimistic: flip everything locally first.
    setBookings((prev) =>
      prev.map((b) =>
        pendingIds.includes(b.id) ? { ...b, status: "paid" } : b,
      ),
    );
    try {
      await api.post(`/bookings/bulk-mark-paid`, {
        booking_ids: pendingIds,
      });
      window.dispatchEvent(new Event("bonbox-data-changed"));
      await fetchBookings(selectedId);
    } catch (e) {
      setBookingsErr(
        e?.response?.data?.detail ||
          t("bookingActionFailed", "Action failed. Please try again."),
      );
      // Refetch to recover from any partial state.
      await fetchBookings(selectedId);
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
          className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-700 transition"
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
        <div className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-4 py-3 rounded-xl text-sm">
          {successMsg}
        </div>
      )}

      {showForm && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
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
            {/* The legacy single-date input stays mounted for back-compat
                (existing API still requires `event_date`), but the new
                starts_at / ends_at controls below are the primary affordance
                for publishable events. We keep this one visible so cash-up-
                only owners (no public booking) don't lose their flow. */}
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

          {/* ── starts_at / ends_at (P1) ──────────────────────────────
              Two datetime-local inputs replace the single date for any
              event that will be publicly bookable. When the user sets
              `starts_at`, `ends_at` auto-fills to start+3h on first edit
              (per spec §3 default). The legacy date field above stays
              live for the back-end's required `event_date` column. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 flex flex-col gap-1">
              <span>{t("eventStartsAt", "Starts")}</span>
              <input
                type="datetime-local"
                value={formStartsAt}
                onChange={(e) => handleStartsAtChange(e.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-normal"
              />
            </label>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 flex flex-col gap-1">
              <span>{t("eventEndsAt", "Ends")}</span>
              <input
                type="datetime-local"
                value={formEndsAt}
                onChange={(e) => setFormEndsAt(e.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-normal"
              />
            </label>
          </div>

          {/* ── Cover image upload (P1) ───────────────────────────────
              16:9 preview when present, drop-zone affordance when not.
              Server enforces MIME type + max 5 MB; the client check is
              a UX cap. Image lives in Supabase Storage `event-covers/`
              with public-read ACL (per spec §5.1). */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {t("eventCoverImage", "Cover image")}
              </h3>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                {t("eventCoverHint", "16:9, max 5 MB")}
              </span>
            </div>
            {formCoverUrl ? (
              <div className="relative rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 aspect-video bg-gray-50 dark:bg-gray-800">
                <img
                  src={formCoverUrl}
                  alt={t("eventCoverImage", "Cover image")}
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => setFormCoverUrl("")}
                  aria-label={t("eventCoverRemove", "Remove cover")}
                  className="absolute top-2 right-2 inline-flex items-center justify-center h-8 w-8 rounded-full bg-white/90 dark:bg-gray-900/90 text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-gray-900"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <label
                className={
                  "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed " +
                  "border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 " +
                  "px-4 py-8 cursor-pointer hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
                }
              >
                <Upload
                  className="w-5 h-5 text-gray-400 dark:text-gray-500"
                  aria-hidden
                />
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {coverUploading
                    ? t("eventCoverUploading", "Uploading…")
                    : t("eventCoverImage", "Cover image")}
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={coverUploading}
                  onChange={(e) => handleCoverUpload(e.target.files?.[0])}
                  className="sr-only"
                />
              </label>
            )}
          </div>

          {/* ── Add-ons repeater (P1) ─────────────────────────────────
              Max 6 rows, chip-style. Identical UX shape to ticket-tier
              repeater but ships as a separate JSONB column server-side. */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-1 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {t("eventAddons", "Add-ons (optional)")}
              </h3>
            </div>
            {formAddons.map((row, idx) => (
              <div key={idx} className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={row.label}
                  onChange={(e) => setAddonField(idx, "label", e.target.value)}
                  placeholder={t("eventAddonLabel", "Label (e.g. Momo plate)")}
                  maxLength={40}
                  className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
                />
                <div className="flex gap-2">
                  <div className="relative flex-1 sm:flex-none sm:w-32">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={row.price_dkk}
                      onChange={(e) =>
                        setAddonField(idx, "price_dkk", e.target.value)
                      }
                      placeholder={t("eventAddonPrice", "Price kr")}
                      className="w-full pl-3 pr-10 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                      kr
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAddon(idx)}
                    aria-label={t("eventAddonRemove", "Remove add-on")}
                    className="w-10 h-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-600 hover:border-red-300"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {formAddons.length < 6 && (
              <button
                type="button"
                onClick={addAddon}
                className="inline-flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:underline"
              >
                <Plus className="w-4 h-4" />
                {t("eventAddonAdd", "Add add-on")}
              </button>
            )}
          </div>

          {/* ── Refund policy + Make publicly bookable toggle ─────────
              Chip-style toggle for the publish flag; native select for
              the policy enum because the 3 options fit nowhere else.
              Both inherit the doctrine pill / input styling. */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-1 grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 flex flex-col gap-1">
              <span>{t("eventRefundPolicy", "Refund policy")}</span>
              <select
                value={formRefundPolicy}
                onChange={(e) => setFormRefundPolicy(e.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-normal"
              >
                <option value="organizer">
                  {t("eventRefundOrganizer", "Organizer-handled")}
                </option>
                <option value="7day">
                  {t("eventRefund7day", "Refund within 7 days")}
                </option>
                <option value="no_refund">
                  {t("eventRefundNone", "No refunds")}
                </option>
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => setFormMakePublic((v) => !v)}
                aria-pressed={formMakePublic}
                className={
                  "w-full inline-flex items-center justify-center gap-2 h-[42px] px-3 rounded-lg border text-sm font-medium transition-colors " +
                  (formMakePublic
                    ? "bg-gray-900 dark:bg-gray-50 border-gray-900 dark:border-gray-50 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-white"
                    : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600")
                }
              >
                <Link2 className="w-4 h-4" aria-hidden />
                {t("eventPublishToggle", "Make publicly bookable")}
              </button>
            </div>
          </div>

          {/* ── Ticket tiers (collapsible, defaults closed) ─────────── */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-1">
            {!showTierSection ? (
              <button
                type="button"
                onClick={openTierSection}
                className="text-sm font-medium text-gray-700 dark:text-gray-300 hover:underline"
              >
                + {t("eventTicketTiersSection", "Add ticket tiers (enables Cash-up)")}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-emerald-600" aria-hidden />
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
                    className="inline-flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:underline"
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
                    className="rounded border-gray-300 text-emerald-600 focus:ring-gray-400"
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
              className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-700 transition disabled:opacity-60"
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
                      ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50"
                      : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-gray-300"
                  }`}
                  onClick={() => setSelectedId(ev.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 dark:text-gray-100 truncate flex items-center gap-2 flex-wrap">
                        {ev.name}
                        {/* ── Publish status pill (doctrine pattern) ────
                            gray-100 background + 6px colored dot. Three
                            states: Live (emerald) when published; Lukket
                            (red) when published but bookings_close_at is
                            past; Draft (gray) otherwise. We compute the
                            "lukket" branch here rather than relying on a
                            server field so the pill reflects current time
                            without a re-fetch. */}
                        {(() => {
                          const closesAt = ev.bookings_close_at
                            ? new Date(ev.bookings_close_at)
                            : null;
                          const isClosed =
                            ev.published &&
                            closesAt &&
                            !Number.isNaN(closesAt.getTime()) &&
                            closesAt < new Date();
                          const dotClass = isClosed
                            ? "bg-red-500"
                            : ev.published
                              ? "bg-emerald-500"
                              : "bg-gray-400";
                          const label = isClosed
                            ? t("eventStatusClosed", "Lukket")
                            : ev.published
                              ? t("eventStatusLive", "Live")
                              : t("eventStatusDraft", "Draft");
                          return (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-[11px] font-medium">
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${dotClass}`}
                                aria-hidden="true"
                              />
                              {label}
                            </span>
                          );
                        })()}
                        {ev.ticket_tiers && ev.ticket_tiers.length > 0 && (
                          <span
                            title={t(
                              "eventTicketTierBadge",
                              "{n} ticket tier(s) defined",
                              { n: ev.ticket_tiers.length },
                            )}
                            className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300"
                          >
                            {ev.ticket_tiers.length}× {t("eventTicketTierBadgeShort", "tier")}
                          </span>
                        )}
                        {ev.is_tax_exempt && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                            MOMS-fri
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {ev.event_date}
                        {ev.venue ? ` · ${ev.venue}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {/* ── Copy Link (only when published) ──────────
                          Sits flush with the existing delete affordance
                          so the action surface reads as one cluster. */}
                      {ev.published && ev.slug && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyEventLink(ev);
                          }}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
                          aria-label={t("eventShareLink", "Copy link")}
                          title={t("eventShareLink", "Copy link")}
                        >
                          <Link2 className="w-4 h-4" />
                        </button>
                      )}
                      {/* ── Publish / Unpublish menu action ──────────
                          Reuses the same single-button affordance as the
                          existing delete X; no dropdown menu primitive
                          exists on this page yet so we add a discrete
                          icon button per pattern. */}
                      {ev.published ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            unpublishEvent(ev);
                          }}
                          className="text-[11px] px-2 h-8 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
                          aria-label={t(
                            "eventPublishUnpublish",
                            "Unpublish",
                          )}
                          title={t("eventPublishUnpublish", "Unpublish")}
                        >
                          {t("eventPublishUnpublish", "Unpublish")}
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            publishEvent(ev);
                          }}
                          className="text-[11px] px-2 h-8 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
                          aria-label={t("eventPublishAction", "Publish")}
                          title={t("eventPublishAction", "Publish")}
                        >
                          {t("eventPublishAction", "Publish")}
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteEvent(ev.id);
                        }}
                        className="text-xs text-gray-400 hover:text-red-600 w-8 h-8 inline-flex items-center justify-center"
                        aria-label={t("delete", "Delete")}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
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

              {/* ── Tabs (Bookings + Walk-ins) ────────────────────────
                  Only rendered when the event is published — unpublished
                  events have no booking surface so the cash-up CTA stays
                  the only thing the owner needs. */}
              {selectedEvent?.published && (
                <TabPills
                  tabs={[
                    {
                      id: "bookings",
                      label: t("bookingsTab", "Bookings"),
                      count: bookings.length || undefined,
                    },
                    { id: "walkins", label: t("walkInsTab", "Walk-ins") },
                  ]}
                  activeId={detailTab}
                  onChange={setDetailTab}
                />
              )}

              {/* ── Bookings tab content ───────────────────────────── */}
              {selectedEvent?.published && detailTab === "bookings" ? (
                <div className="space-y-3">
                  {bookingsErr && (
                    <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-3 py-2 rounded-xl text-xs">
                      {bookingsErr}
                    </div>
                  )}
                  {/* Bulk-action bar — appears once there are ≥3 pending
                      bookings. Below that threshold a per-row tap is the
                      right affordance (spec §0). */}
                  {pendingBookingIds.length >= 3 && (
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-xs text-gray-700 dark:text-gray-300">
                      <span>
                        {pendingBookingIds.length}{" "}
                        {t(
                          "bookingStatusPendingPay",
                          "Awaiting payment",
                        ).toLowerCase()}
                      </span>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => bulkMarkAllPaid(pendingBookingIds)}
                      >
                        {t("bookingMarkAllPaid", "Mark all paid")}
                      </Button>
                    </div>
                  )}
                  <DataTable
                    columns={[
                      {
                        id: "customer_name",
                        label: t("bookingColCustomer", "Customer"),
                        render: (r) => (
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {r.customer_name || "—"}
                          </span>
                        ),
                      },
                      {
                        id: "customer_email",
                        label: t("bookingColEmail", "Email"),
                        render: (r) => (
                          <span
                            className="text-gray-600 dark:text-gray-400 truncate inline-block max-w-[180px] align-middle"
                            title={r.customer_email}
                          >
                            {r.customer_email || "—"}
                          </span>
                        ),
                      },
                      {
                        id: "tickets",
                        label: t("bookingColTickets", "Tickets"),
                        render: (r) => {
                          const lines = Array.isArray(r.ticket_lines)
                            ? r.ticket_lines
                            : [];
                          return (
                            <span className="text-gray-700 dark:text-gray-300">
                              {lines.length === 0
                                ? "—"
                                : lines
                                    .map((l) => `${l.qty} ${l.label}`)
                                    .join(", ")}
                            </span>
                          );
                        },
                      },
                      {
                        id: "total_amount_dkk",
                        label: t("bookingColTotal", "Total"),
                        align: "right",
                        render: (r) => (
                          <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">
                            {moneyFmt(r.total_amount_dkk || 0)}
                          </span>
                        ),
                      },
                      {
                        id: "status",
                        label: t("bookingColStatus", "Status"),
                        render: (r) => {
                          const dotClass =
                            BOOKING_STATUS_DOT[r.status] || "bg-gray-400";
                          const labelMap = {
                            reserved: t(
                              "bookingStatusReserved",
                              "Reserved",
                            ),
                            paid: t("bookingStatusPaid", "Paid"),
                            attended: t(
                              "bookingStatusAttended",
                              "Attended",
                            ),
                            refunded: t(
                              "bookingStatusRefunded",
                              "Refunded",
                            ),
                            cancelled: t(
                              "bookingStatusCancelled",
                              "Cancelled",
                            ),
                            expired: t(
                              "bookingStatusExpired",
                              "Expired",
                            ),
                            "pending-pay": t(
                              "bookingStatusPendingPay",
                              "Awaiting payment",
                            ),
                            pending: t(
                              "bookingStatusPendingPay",
                              "Awaiting payment",
                            ),
                          };
                          return (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs font-medium">
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${dotClass}`}
                                aria-hidden="true"
                              />
                              {labelMap[r.status] || r.status || "—"}
                            </span>
                          );
                        },
                      },
                      {
                        id: "created_at",
                        label: t("bookingColCreated", "Created"),
                        render: (r) =>
                          r.created_at
                            ? new Date(r.created_at).toLocaleDateString()
                            : "—",
                      },
                    ]}
                    rows={bookings}
                    rowKey="id"
                    loading={bookingsLoading}
                    rowActions={(row) => {
                      const actions = [];
                      // Mark paid — reserved bookings only. Disabled
                      // while an action is in flight for that specific
                      // row so a double-tap can't fire twice.
                      if (
                        row.status === "reserved" ||
                        row.status === "pending-pay" ||
                        row.status === "pending"
                      ) {
                        actions.push({
                          id: "mark-paid",
                          label: t("bookingMarkPaid", "Mark paid"),
                          icon: <Check size={14} />,
                          onClick: () => markBookingPaid(row),
                          disabled: bookingActioningId === row.id,
                        });
                      }
                      actions.push({
                        id: "view-tickets",
                        label: t("bookingViewTickets", "View tickets"),
                        icon: <Eye size={14} />,
                        onClick: () => setTicketsModalBooking(row),
                      });
                      if (row.status === "paid") {
                        actions.push({
                          id: "refund",
                          label: t("bookingMarkRefunded", "Mark refunded"),
                          icon: <RotateCcw size={14} />,
                          onClick: () => refundBooking(row),
                          variant: "danger",
                          disabled: bookingActioningId === row.id,
                        });
                      }
                      return actions;
                    }}
                    empty={
                      <div className="text-center py-2">
                        <Empty
                          icon="📅"
                          title={t(
                            "bookingsEmptyTitle",
                            "No reservations yet",
                          )}
                          body={t(
                            "bookingsEmptyBody",
                            "Share your event link to get the first booking",
                          )}
                          cta={
                            selectedEvent?.slug ? (
                              <Button
                                variant="primary"
                                size="sm"
                                iconLeft={<Link2 className="w-4 h-4" />}
                                onClick={() => copyEventLink(selectedEvent)}
                              >
                                {t("eventShareLink", "Copy link")}
                              </Button>
                            ) : null
                          }
                        />
                      </div>
                    }
                  />
                </div>
              ) : (
                <>
                  {/* ── Cash-up CTA (walk-ins / unpublished default) ─ */}
                  {/* Disabled w/ tooltip when no tiers — guides the user
                      to edit the event and add tiers without breaking
                      the flow with a hidden button. */}
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
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Wallet className="w-4 h-4" aria-hidden />
                    {t("eventCashupButton", "Cash up event")}
                  </button>
                </>
              )}

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

      {/* ── View-tickets modal ─────────────────────────────────────── */}
      {/* Simple controlled-state modal — kept inline rather than
          pulling the global <Modal> primitive because that primitive
          uses the locked corner radius (the carve-out only applies to
          itself, not its callers). The visitor's separate /t/{id}
          ticket page owns the full QR experience; this modal is the
          organizer's quick peek. */}
      {ticketsModalBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setTicketsModalBooking(null)}
          />
          <div className="relative bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 w-full max-w-md p-6 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
                {t("bookingViewTicketsTitle", "Tickets in booking")}
              </h2>
              <button
                onClick={() => setTicketsModalBooking(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                aria-label={t("close", "Close")}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2 text-sm">
              <div className="text-gray-600 dark:text-gray-400 text-xs">
                {ticketsModalBooking.customer_name} ·{" "}
                {ticketsModalBooking.customer_email}
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg">
                {(ticketsModalBooking.ticket_lines || []).map((line, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between px-3 py-2"
                  >
                    <span className="text-gray-800 dark:text-gray-200">
                      {line.qty}× {line.label}
                    </span>
                    <span className="tabular-nums text-gray-600 dark:text-gray-400">
                      {moneyFmt(
                        (line.unit_price_dkk || 0) * (line.qty || 0),
                      )}
                    </span>
                  </li>
                ))}
                {(ticketsModalBooking.addon_lines || []).map((line, i) => (
                  <li
                    key={"a-" + i}
                    className="flex items-center justify-between px-3 py-2"
                  >
                    <span className="text-gray-500 dark:text-gray-400 text-xs">
                      +{line.qty}× {line.label}
                    </span>
                    <span className="tabular-nums text-gray-500 dark:text-gray-400 text-xs">
                      {moneyFmt(
                        (line.unit_price_dkk || 0) * (line.qty || 0),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between pt-2 text-sm font-semibold">
                <span className="text-gray-700 dark:text-gray-300">
                  {t("bookingColTotal", "Total")}
                </span>
                <span className="tabular-nums text-gray-900 dark:text-gray-100">
                  {moneyFmt(ticketsModalBooking.total_amount_dkk || 0)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
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
