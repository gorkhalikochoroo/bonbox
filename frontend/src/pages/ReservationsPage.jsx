// ReservationsPage — the owner-facing reservation book at /reservations.
//
// Pro/Starter-tier feature (gated on `reservations`). Three sections via
// TabPills:
//   1. Book      — today's service: list of reservations by time, status
//                  chips, allergy flags, and one-tap state transitions
//                  (Confirm / Seat / No-show / Cancel). Plus the day
//                  summary (total / covers / by-status).
//   2. Floor     — bookable resources (tables): add / edit / delete,
//                  cap-aware (402 → upgrade message).
//   3. Settings  — on/off toggle, the public link + QR + copy, slug
//                  customisation, and the core availability numbers.
//
// Backend contract (app/routers/reservations.py, mounted /api/reservations):
//   GET    /reservations/book?day=YYYY-MM-DD
//   PATCH  /reservations/reservations/{id}/status   {status, cancel_reason?}
//   GET    /reservations/resources
//   POST   /reservations/resources                  {kind, label, capacity_seats, zone, combinable}
//   PATCH  /reservations/resources/{id}
//   DELETE /reservations/resources/{id}
//   GET    /reservations/settings
//   PUT    /reservations/settings                   {reservations_enabled?, settings?}
//   POST   /reservations/slug                       {slug}  (409 slug_taken)
//
// Design doctrine: gray-* palette, emerald only for the confirm "money
// moment" and the live-toggle ON state. rounded-xl cards, 1px gray-200
// borders, Lucide outline icons, light-mode default, mobile-first. Same
// `api` client + auth/CSRF path as EventsPage (no bespoke fetch wrapper).
//
// DK terminology lock: revisor / MOMS etc. stay Danish across locales.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  Plus,
  Minus,
  Trash2,
  Copy,
  Check,
  Users,
  Armchair,
  AlertTriangle,
  Link2,
  RefreshCw,
  MonitorSmartphone,
  Download,
  MessageSquare,
  Lock,
  X,
  Ban,
  CheckCircle2,
  Globe,
  Footprints,
  PartyPopper,
  Clock,
} from "lucide-react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import Button from "../components/ui/Button";
import TabPills from "../components/ui/TabPills";
import UpgradeNudge from "../components/ui/UpgradeNudge";
import DataTable from "../components/ui/DataTable";
import StatCard from "../components/ui/StatCard";
import FilterBar from "../components/ui/FilterBar";
import Empty from "../components/ui/Empty";
import { QRCodeSVG } from "qrcode.react";

// Status → colored-dot token for the status pill. Severe = red, the
// terminal-good states emerald, requests amber, dead states gray.
const STATUS_DOT = {
  requested: "bg-amber-500",
  confirmed: "bg-emerald-500",
  seated: "bg-emerald-500",
  completed: "bg-gray-400",
  no_show: "bg-red-500",
  cancelled: "bg-red-500",
};

// Local YYYY-MM-DD for the book's day picker (defaults to today).
function isoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// dd/mm/yyyy for DK-style display where a date is shown.
function fmtDkDate(isoStr) {
  if (!isoStr) return "";
  const [y, m, d] = isoStr.split("-");
  return `${d}/${m}/${y}`;
}

// HH:MM from an ISO datetime (the book sorts/labels by time-of-day).
function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("da-DK", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Booking hours (per weekday) ↔ the "HH:MM-HH:MM" | "closed" dict the engine
// reads (reservation_service.restaurant_windows). Mon-first to match DK weeks.
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function defaultBookingHours() {
  const o = {};
  DAY_KEYS.forEach((k) => {
    o[k] = { closed: false, open: "11:00", close: "22:00" };
  });
  return o;
}
function parseBookingHours(bh) {
  const out = defaultBookingHours();
  if (bh && typeof bh === "object") {
    DAY_KEYS.forEach((k) => {
      const v = bh[k];
      if (v === "closed") out[k] = { closed: true, open: "11:00", close: "22:00" };
      else if (typeof v === "string" && v.includes("-")) {
        const [open, close] = v.split("-");
        out[k] = { closed: false, open: open || "11:00", close: close || "22:00" };
      }
    });
  }
  return out;
}
function serializeBookingHours(hours) {
  const out = {};
  DAY_KEYS.forEach((k) => {
    const d = hours[k];
    out[k] = d.closed ? "closed" : `${d.open}-${d.close}`;
  });
  return out;
}

export default function ReservationsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { hasFeature, isReady } = useEntitlements();

  const [tab, setTab] = useState("book"); // "book" | "floor" | "settings"

  // ── Tier flicker contract ──────────────────────────────────────────
  // Render NOTHING while entitlements are loading, then either the
  // upgrade nudge (locked) or the page (unlocked). Matches the doctrine
  // in useEntitlements.jsx.
  if (!isReady) return null;
  if (!hasFeature("reservations")) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
        <PageTitle t={t} />
        <UpgradeNudge
          intent="card"
          tier="starter"
          icon="📅"
          feature="reservations"
          benefit={t(
            "rsvpUpsell",
            "Take table bookings 24/7 with a free public page — no commission, no third-party app.",
          )}
          ctaLabel={t("rsvpUpsellCta", "See plans")}
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <PageTitle t={t} />
      <TabPills
        tabs={[
          { id: "book", label: t("rsvpTabBook", "Reservation book") },
          { id: "floor", label: t("rsvpTabFloor", "Floor") },
          { id: "settings", label: t("rsvpTabSettings", "Settings") },
        ]}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t("rsvpTabsAria", "Reservation sections")}
        size="lg"
      />

      {tab === "book" && <BookSection t={t} />}
      {tab === "floor" && <FloorSection t={t} />}
      {tab === "settings" && <SettingsSection t={t} user={user} />}
    </div>
  );
}

function PageTitle({ t }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
        <CalendarCheck className="w-6 h-6 text-gray-700 dark:text-gray-200" aria-hidden />
        {t("rsvpOwnerTitle", "Reservations")}
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        {t(
          "rsvpOwnerSubtitle",
          "Your booking book, floor plan, and the public page guests book through.",
        )}
      </p>
    </div>
  );
}

// ─── Reservation book ─────────────────────────────────────────────────
// Remembers the owner's last-used book view across sessions/devices.
const RSVP_VIEW_KEY = "bonbox.rsvp.view";

// Status → localized label. Shared by the Liste status column + (later) the
// floor/timeline. Mirrors the map ReservationRow used.
function statusLabels(t) {
  return {
    requested: t("rsvpStatusRequested", "Requested"),
    confirmed: t("rsvpStatusConfirmed", "Confirmed"),
    seated: t("rsvpStatusSeated", "Seated"),
    completed: t("rsvpStatusCompleted", "Completed"),
    no_show: t("rsvpStatusNoShow", "No-show"),
    cancelled: t("rsvpStatusCancelled", "Cancelled"),
  };
}

// Table(s) cell — a combined seating shows the "Bord 1 + Bord 2" chip, a
// single table its label, an unassigned booking a muted dash.
function TablesCell({ r, labelById, t }) {
  const combined =
    Array.isArray(r.combined_resource_labels) && r.combined_resource_labels.length > 1
      ? r.combined_resource_labels
      : null;
  if (combined) {
    return (
      <span
        title={combined.join(" + ")}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 max-w-[9.5rem] truncate"
      >
        <Link2 className="w-3.5 h-3.5 shrink-0" aria-hidden />
        {combined.join(" + ")}
      </span>
    );
  }
  if (r.resource_id) {
    return (
      <span className="text-sm text-gray-700 dark:text-gray-300">
        {labelById[String(r.resource_id)] || t("rsvpTableFallback", "Table")}
      </span>
    );
  }
  return <span className="text-sm text-gray-400 dark:text-gray-500">—</span>;
}

// Flags cell — allergy / occasion / source as compact icon badges (icon-only
// with title + aria-label; the column is narrow). Allergy is the one signal
// that earns color: red when severe, amber otherwise.
function FlagsCell({ r, t }) {
  const hasAllergy =
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity;
  const severe = r.allergy_severity === "severe";
  const allergyTitle = [
    (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
    r.allergy_note,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-1.5 text-gray-400 dark:text-gray-500">
      {hasAllergy && (
        <AlertTriangle
          className={"w-4 h-4 " + (severe ? "text-red-600 dark:text-red-400" : "text-amber-500 dark:text-amber-400")}
          aria-label={severe ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
          title={allergyTitle || (severe ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy"))}
        />
      )}
      {r.occasion && (
        <PartyPopper className="w-4 h-4" aria-label={r.occasion} title={r.occasion} />
      )}
      {r.source === "public" && (
        <Globe className="w-4 h-4" aria-label={t("rsvpSourceOnline", "online")} title={t("rsvpSourceOnline", "online")} />
      )}
      {r.source === "walk_in" && (
        <Footprints className="w-4 h-4" aria-label={t("rsvpSourceWalkIn", "walk-in")} title={t("rsvpSourceWalkIn", "walk-in")} />
      )}
    </div>
  );
}

// Phase-3 lens lands here. Honest placeholder until then.
function ComingSoonView({ icon, title, body }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 py-12 text-center">
      <div className="text-gray-300 dark:text-gray-600 mb-2 flex justify-center">{icon}</div>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  );
}

// ─── Plan (visual floor) ──────────────────────────────────────────────
// Map the day's holding bookings onto each table and classify it. Status-
// driven (seated > upcoming > free) so it's correct on any day; the "in N
// min" eta is only computed when it's meaningful (a future start). Tables
// only — providers carry their own availability model.
function deriveFloorState(reservations, resources, nowMs) {
  const holding = reservations.filter((r) =>
    ["requested", "confirmed", "seated"].includes(r.status),
  );
  return resources
    .filter((r) => r.kind !== "provider")
    .map((res) => {
      const id = String(res.id);
      if (res.is_active === false) {
        return { res, status: "inactive", booking: null, combined: false };
      }
      const mine = holding.filter((r) => {
        if (String(r.resource_id) === id) return true;
        return (r.combined_resource_ids || []).map(String).includes(id);
      });
      if (mine.length === 0) {
        return { res, status: "free", booking: null, combined: false };
      }
      const seated = mine.find((r) => r.status === "seated");
      const current =
        seated ||
        mine.slice().sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1))[0];
      const combined =
        Array.isArray(current.combined_resource_ids) &&
        current.combined_resource_ids.length > 1;
      let eta = null;
      if (!seated && current.starts_at) {
        const ms = new Date(current.starts_at).getTime() - nowMs;
        if (ms > 0 && ms < 1000 * 60 * 120) eta = Math.round(ms / 60000);
      }
      return {
        res,
        status: seated ? "seated" : "upcoming",
        combined,
        booking: {
          id: current.id,
          name: current.guest_name,
          time: fmtTime(current.starts_at),
          eta,
          reservation: current,
        },
      };
    });
}

const TILE_DOT = {
  free: "bg-gray-300 dark:bg-gray-600",
  upcoming: "bg-amber-500",
  seated: "bg-emerald-500",
  inactive: "bg-gray-200 dark:bg-gray-700",
};

function FloorTile({ cell, t, onSelect, onSeatNow }) {
  const { res, status, booking, combined } = cell;
  const inactive = status === "inactive";
  const free = status === "free";
  const clickable = !inactive; // free → seat walk-in; occupied → open detail
  const handle = () => {
    if (inactive) return;
    if (free) onSeatNow && onSeatNow(res);
    else if (booking?.reservation) onSelect(booking.reservation);
  };
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={handle}
      className={
        "text-left rounded-xl border p-3 min-h-[92px] flex flex-col transition-colors " +
        (inactive
          ? "bg-gray-50 dark:bg-gray-900/40 border-dashed border-gray-200 dark:border-gray-700 opacity-60 cursor-default"
          : free
          ? "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700"
          : status === "seated"
          ? "bg-gray-50 dark:bg-gray-800/60 border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
          {res.label}
        </span>
        <span className={"w-2.5 h-2.5 rounded-full shrink-0 " + (TILE_DOT[status] || TILE_DOT.free)} aria-hidden />
      </div>
      <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
        <Users className="w-3 h-3" aria-hidden />
        {res.capacity_seats}
        {combined && (
          <Link2 className="w-3 h-3 ml-0.5" aria-hidden title={t("rsvpCombinable", "Can be combined")} />
        )}
      </div>
      <div className="mt-auto pt-1.5 min-h-[1.4rem]">
        {inactive ? (
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            {t("rsvpTileInactive", "Out of service")}
          </span>
        ) : free ? (
          <span className="text-[11px] text-gray-400 dark:text-gray-500 inline-flex items-center gap-1">
            <Plus className="w-3 h-3" aria-hidden />
            {t("rsvpTileSeat", "Seat")}
          </span>
        ) : (
          <div className="leading-tight">
            <div className="text-[12px] font-medium text-gray-800 dark:text-gray-200 truncate">
              {booking.time} · {booking.name || t("rsvpGuest", "Guest")}
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              {status === "seated"
                ? t("rsvpTileSeated", "Seated")
                : booking.eta != null
                ? t("rsvpTileInMin", "in {n} min", { n: booking.eta })
                : t("rsvpStatusConfirmed", "Confirmed")}
            </div>
          </div>
        )}
      </div>
    </button>
  );
}

function LegendDot({ cls, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={"w-2 h-2 rounded-full " + cls} aria-hidden />
      {label}
    </span>
  );
}

function FloorView({ reservations, resources, t, onSelect, onSeatNow }) {
  const cells = useMemo(
    () => deriveFloorState(reservations, resources, Date.now()),
    [reservations, resources],
  );
  const byZone = useMemo(() => {
    const g = {};
    cells.forEach((c) => {
      const z = c.res.zone || t("rsvpZoneOther", "Other");
      (g[z] = g[z] || []).push(c);
    });
    return g;
  }, [cells, t]);

  if (cells.length === 0) {
    return (
      <ComingSoonView
        icon={<Armchair className="w-8 h-8" />}
        title={t("rsvpFloorEmptyTitle", "No tables yet")}
        body={t("rsvpFloorEmptyBody", "Add tables on the Floor tab to see your room here.")}
      />
    );
  }
  return (
    <div className="space-y-5">
      {Object.entries(byZone).map(([zone, list]) => (
        <div key={zone}>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
            {zone}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {list.map((c) => (
              <FloorTile key={c.res.id} cell={c} t={t} onSelect={onSelect} onSeatNow={onSeatNow} />
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-gray-500 dark:text-gray-400 pt-1">
        <LegendDot cls="bg-gray-300 dark:bg-gray-600" label={t("rsvpTileFree", "Free")} />
        <LegendDot cls="bg-amber-500" label={t("rsvpLegUpcoming", "Upcoming")} />
        <LegendDot cls="bg-emerald-500" label={t("rsvpTileSeated", "Seated")} />
      </div>
    </div>
  );
}

// ─── Shared detail drawer (Liste row + Plan tile both open this) ──────
function DetailRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 text-right">{value}</span>
    </div>
  );
}

function ReservationDrawer({ reservation, t, busy, onStatus, onClose }) {
  if (!reservation) return null;
  const r = reservation;
  const labels = statusLabels(t);
  const hasAllergy =
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity;
  const severe = r.allergy_severity === "severe";
  const allergyText = [
    (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
    r.allergy_note,
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = [];
  if (r.status === "requested") {
    actions.push({ id: "confirmed", label: t("rsvpConfirmAction", "Confirm"), to: "confirmed" });
    actions.push({ id: "decline", label: t("rsvpDeclineAction", "Decline"), to: "cancelled", danger: true });
  } else if (r.status === "confirmed") {
    actions.push({ id: "seated", label: t("rsvpSeatAction", "Seat"), to: "seated" });
    actions.push({ id: "no_show", label: t("rsvpNoShowAction", "No-show"), to: "no_show", danger: true });
    actions.push({ id: "cancel", label: t("rsvpCancelAction", "Cancel"), to: "cancelled", danger: true });
  } else if (r.status === "seated") {
    actions.push({ id: "completed", label: t("rsvpCompleteAction", "Complete"), to: "completed" });
  }

  const combinedLabels =
    Array.isArray(r.combined_resource_labels) && r.combined_resource_labels.length > 1
      ? r.combined_resource_labels.join(" + ")
      : null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-md h-full bg-white dark:bg-gray-900 shadow-sm border-l border-gray-200 dark:border-gray-800 overflow-auto p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {fmtTime(r.starts_at)}–{fmtTime(r.ends_at)}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300 truncate">
              {(r.guest_name || "—") + " · " + r.party_size + " " + t("rsvpCoversHelper", "guests")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <StatusPill status={r.status} label={labels[r.status] || r.status} />

        {hasAllergy && (
          <div
            className={
              "rounded-lg px-3 py-2 text-sm " +
              (severe
                ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                : "bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300")
            }
          >
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" aria-hidden />
              {severe ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
            </div>
            {allergyText && <div className="mt-0.5">{allergyText}</div>}
          </div>
        )}

        <div className="space-y-1.5">
          {r.guest_phone && <DetailRow label={t("rsvpPhone", "Phone")} value={r.guest_phone} />}
          {combinedLabels && <DetailRow label={t("rsvpColTable", "Table")} value={combinedLabels} />}
          {r.occasion && <DetailRow label={t("rsvpOccasion", "Occasion")} value={r.occasion} />}
        </div>
        {r.guest_notes && (
          <p className="text-sm text-gray-600 dark:text-gray-300">{r.guest_notes}</p>
        )}

        {actions.length > 0 && (
          <div className="pt-2 space-y-2">
            {actions.map((a) => (
              <Button
                key={a.id}
                variant={a.danger ? "ghost" : "primary"}
                size="lg"
                disabled={busy}
                onClick={() => onStatus(r, a.to)}
                className={"w-full justify-center " + (a.danger ? "text-red-600 hover:text-red-700" : "")}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Seat-now (mark a free table occupied with a walk-in) ─────────────
function SeatNowSheet({ table, t, busy, onSeat, onClose }) {
  const [party, setParty] = useState(String(table?.capacity_seats || 2));
  const [name, setName] = useState("");
  if (!table) return null;
  const sizes = [1, 2, 3, 4, 5, 6, 8];
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full sm:max-w-sm bg-white dark:bg-gray-900 rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("rsvpSeatNowTitle", "Seat guests")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {table.label + " · " + table.capacity_seats + " " + t("rsvpCoversHelper", "guests")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpColParty", "Party")}
          </label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {sizes.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setParty(String(n))}
                className={
                  "h-11 min-w-[44px] px-3 rounded-lg border text-sm font-medium tabular-nums " +
                  (String(n) === party
                    ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                    : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600")
                }
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpGuestNameOpt", "Name (optional)")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            placeholder={t("rsvpWalkIn", "Walk-in")}
            className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
          />
        </div>
        <Button
          variant="primary"
          size="lg"
          busy={busy}
          className="w-full justify-center"
          onClick={() =>
            onSeat({
              resource_id: table.id,
              party_size: Math.max(1, Math.min(100, parseInt(party, 10) || 2)),
              guest_name: name.trim() || t("rsvpWalkIn", "Walk-in"),
            })
          }
        >
          {t("rsvpSeatNowBtn", "Seat now")}
        </Button>
      </div>
    </div>
  );
}

// ─── Tidslinje (service timeline grid) ────────────────────────────────
// Minutes since midnight for an ISO datetime (the timeline's X axis).
function minOfDay(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function TimelineView({ reservations, resources, day, t, onSelect }) {
  const tables = useMemo(
    () =>
      resources
        .filter((r) => r.kind !== "provider")
        .slice()
        .sort((a, b) =>
          (a.zone || "") === (b.zone || "")
            ? (a.sort_order || 0) - (b.sort_order || 0)
            : (a.zone || "").localeCompare(b.zone || ""),
        ),
    [resources],
  );
  const holding = useMemo(
    () => reservations.filter((r) => ["requested", "confirmed", "seated"].includes(r.status)),
    [reservations],
  );

  // Service window derived from the day's bookings (min start → max end),
  // hour-aligned and clamped to at least 4h. Empty day falls back to 16–23.
  const { startMin, endMin } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    holding.forEach((r) => {
      if (!r.starts_at || !r.ends_at) return;
      let s = minOfDay(r.starts_at);
      let e = minOfDay(r.ends_at);
      if (e <= s) e += 1440;
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    });
    if (!isFinite(lo)) {
      lo = 16 * 60;
      hi = 23 * 60;
    }
    lo = Math.floor(lo / 60) * 60;
    hi = Math.ceil(hi / 60) * 60;
    if (hi - lo < 240) hi = lo + 240;
    return { startMin: lo, endMin: hi };
  }, [holding]);

  const PX = 1.2; // px per minute
  const ROW_H = 52;
  const RAIL_W = 116;
  const bodyW = (endMin - startMin) * PX;
  const hours = [];
  for (let m = startMin; m <= endMin; m += 60) hours.push(m);
  const labels = statusLabels(t);

  const todayIso = isoDay(new Date());
  const nowD = new Date();
  const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
  const nowX =
    day === todayIso && nowMin >= startMin && nowMin <= endMin ? (nowMin - startMin) * PX : null;

  if (tables.length === 0) {
    return (
      <ComingSoonView
        icon={<CalendarCheck className="w-8 h-8" />}
        title={t("rsvpFloorEmptyTitle", "No tables yet")}
        body={t("rsvpFloorEmptyBody", "Add tables on the Floor tab to see your room here.")}
      />
    );
  }

  // Status carried by fill weight (not hue): seated = inverted gray-900,
  // requested = dashed/provisional, confirmed = solid bordered.
  const blockClass = (status) =>
    status === "seated"
      ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
      : status === "requested"
      ? "bg-white dark:bg-gray-900 border-dashed border-gray-400 dark:border-gray-500 text-gray-700 dark:text-gray-200"
      : "bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100";

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-x-auto">
      <div style={{ minWidth: RAIL_W + bodyW }}>
        {/* Time axis */}
        <div className="flex h-8 border-b border-gray-200 dark:border-gray-800 sticky top-0 bg-gray-50 dark:bg-gray-900/80 z-20">
          <div
            style={{ width: RAIL_W }}
            className="shrink-0 sticky left-0 z-20 bg-gray-50 dark:bg-gray-900/80 border-r border-gray-200 dark:border-gray-800"
          />
          <div style={{ width: bodyW }} className="relative">
            {hours.map((m) => (
              <span
                key={m}
                style={{ left: (m - startMin) * PX }}
                className="absolute top-1.5 -translate-x-1/2 text-[11px] tabular-nums text-gray-500 dark:text-gray-400"
              >
                {String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:00
              </span>
            ))}
          </div>
        </div>

        {/* Table rows */}
        {tables.map((tbl) => {
          const id = String(tbl.id);
          const blocks = holding.filter(
            (r) =>
              String(r.resource_id) === id ||
              (r.combined_resource_ids || []).map(String).includes(id),
          );
          return (
            <div
              key={tbl.id}
              className="flex border-b border-gray-100 dark:border-gray-800 last:border-0"
              style={{ height: ROW_H }}
            >
              <div
                style={{ width: RAIL_W }}
                className="shrink-0 sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 px-2 flex flex-col justify-center"
              >
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate leading-tight">
                  {tbl.label}
                </span>
                <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                  {[tbl.zone, tbl.capacity_seats + "p"].filter(Boolean).join(" · ")}
                </span>
              </div>
              <div style={{ width: bodyW }} className="relative">
                {hours.map((m) => (
                  <span
                    key={m}
                    style={{ left: (m - startMin) * PX }}
                    className="absolute top-0 bottom-0 border-l border-gray-100 dark:border-gray-800"
                    aria-hidden
                  />
                ))}
                {nowX != null && (
                  <span
                    style={{ left: nowX }}
                    className="absolute top-0 bottom-0 border-l-2 border-gray-900 dark:border-gray-100 z-[2]"
                    aria-hidden
                  />
                )}
                {blocks.map((r) => {
                  let s = minOfDay(r.starts_at);
                  let e = minOfDay(r.ends_at);
                  if (e <= s) e += 1440;
                  const left = Math.max(0, (s - startMin) * PX);
                  const width = Math.max(30, (Math.min(e, endMin) - Math.max(s, startMin)) * PX - 2);
                  const combined = (r.combined_resource_ids || []).length > 1;
                  return (
                    <button
                      key={r.id + id}
                      type="button"
                      onClick={() => onSelect(r)}
                      title={`${fmtTime(r.starts_at)} ${r.guest_name || ""} (${r.party_size}) · ${labels[r.status] || r.status}`}
                      style={{ left, width, top: 5, height: ROW_H - 12 }}
                      className={"absolute rounded-md border px-1.5 overflow-hidden text-left flex flex-col justify-center " + blockClass(r.status)}
                    >
                      <span className="text-[11px] font-semibold leading-none truncate flex items-center gap-0.5">
                        {fmtTime(r.starts_at)} · {r.party_size}
                        {combined && <Link2 className="w-3 h-3 shrink-0" aria-hidden />}
                      </span>
                      <span className="text-[10px] leading-tight truncate opacity-90 flex items-center gap-0.5 mt-0.5">
                        {r.allergy_severity === "severe" && (
                          <AlertTriangle className="w-3 h-3 shrink-0 text-red-500" aria-hidden />
                        )}
                        {r.guest_name || t("rsvpGuest", "Guest")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BookSection({ t }) {
  const [day, setDay] = useState(() => isoDay(new Date()));
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(RSVP_VIEW_KEY) || "liste";
    } catch {
      return "liste";
    }
  });
  const [data, setData] = useState(null);
  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actioningId, setActioningId] = useState(null);
  // Filters (Liste view).
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [zoneFilter, setZoneFilter] = useState("all");
  // The reservation open in the detail drawer (from a Plan tile or a
  // timeline block). null = drawer closed.
  const [selected, setSelected] = useState(null);
  // Seat-now: the free table the host is seating a walk-in onto.
  const [seatTarget, setSeatTarget] = useState(null);
  const [seating, setSeating] = useState(false);

  const pickView = (v) => {
    setView(v);
    try {
      localStorage.setItem(RSVP_VIEW_KEY, v);
    } catch {
      /* private mode — non-fatal */
    }
  };

  const fetchBook = useCallback(
    async (forDay) => {
      setLoading(true);
      setError("");
      try {
        const res = await api.get("/reservations/book", { params: { day: forDay } });
        setData(res.data || null);
      } catch (e) {
        setError(
          e?.response?.data?.detail?.error ||
            t("rsvpBookError", "Couldn't load the reservation book."),
        );
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // Resources power the zone filter + table-label resolution (and, next
  // phases, the floor + timeline rails). Soft-fail: the book still works.
  const fetchResources = useCallback(async () => {
    try {
      const res = await api.get("/reservations/resources");
      setResources(Array.isArray(res.data?.resources) ? res.data.resources : []);
    } catch {
      setResources([]);
    }
  }, []);

  useEffect(() => {
    fetchBook(day);
  }, [day, fetchBook]);
  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  const setStatus = async (r, status) => {
    if (status === "cancelled") {
      if (
        !confirm(
          t("rsvpConfirmCancel", "Cancel this reservation? The guest is notified if possible."),
        )
      ) {
        return;
      }
    }
    setActioningId(r.id);
    // Optimistic flip so the chip updates instantly.
    setData((prev) =>
      prev
        ? {
            ...prev,
            reservations: prev.reservations.map((row) =>
              row.id === r.id ? { ...row, status } : row,
            ),
          }
        : prev,
    );
    try {
      await api.patch(`/reservations/reservations/${r.id}/status`, {
        status,
        cancel_reason: status === "cancelled" ? "owner_cancelled" : null,
      });
      await fetchBook(day);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpActionError", "Action failed. Please try again."),
      );
      await fetchBook(day);
    } finally {
      setActioningId(null);
    }
  };

  // Seat a walk-in NOW on a free table → the table goes occupied (seated).
  const seatWalkIn = async ({ resource_id, party_size, guest_name }) => {
    setSeating(true);
    setError("");
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const startsAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
      await api.post("/reservations/book", {
        guest_name,
        party_size,
        starts_at: startsAt,
        resource_id,
        source: "walk_in",
        status: "seated",
      });
      setSeatTarget(null);
      // The walk-in is seated NOW (today) — jump to today if viewing another
      // day so it's visible; otherwise refetch in place.
      const todayIso = isoDay(new Date());
      if (day !== todayIso) setDay(todayIso);
      else await fetchBook(day);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error || t("rsvpSeatError", "Couldn't seat the guests."),
      );
    } finally {
      setSeating(false);
    }
  };

  const summary = data?.summary || { total: 0, covers: 0, by_status: {} };
  const reservations = Array.isArray(data?.reservations) ? data.reservations : [];
  const labels = statusLabels(t);

  const zones = useMemo(
    () => [...new Set(resources.map((r) => r.zone).filter(Boolean))],
    [resources],
  );
  const labelById = useMemo(() => {
    const m = {};
    resources.forEach((r) => {
      m[String(r.id)] = r.label;
    });
    return m;
  }, [resources]);

  const seatedCount = summary.by_status?.seated || 0;
  const requestedCount = summary.by_status?.requested || 0;

  const filtered = useMemo(() => {
    let out = reservations;
    if (statusFilter !== "all") out = out.filter((r) => r.status === statusFilter);
    if (zoneFilter !== "all") {
      const ids = new Set(
        resources.filter((r) => r.zone === zoneFilter).map((r) => String(r.id)),
      );
      out = out.filter((r) => r.resource_id && ids.has(String(r.resource_id)));
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter(
        (r) =>
          (r.guest_name || "").toLowerCase().includes(needle) ||
          (r.guest_phone || "").includes(q.trim()),
      );
    }
    return out;
  }, [reservations, statusFilter, zoneFilter, q, resources]);

  const filtersOn = q.trim() !== "" || statusFilter !== "all" || zoneFilter !== "all";
  const resetFilters = () => {
    setQ("");
    setStatusFilter("all");
    setZoneFilter("all");
  };

  const columns = [
    {
      id: "time",
      label: t("rsvpColTime", "Time"),
      width: "w-24",
      render: (r) => (
        <div className="leading-tight">
          <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {fmtTime(r.starts_at)}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
            {fmtTime(r.ends_at)}
          </div>
        </div>
      ),
    },
    {
      id: "guest",
      label: t("rsvpColGuest", "Guest"),
      render: (r) => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {r.guest_name || "—"}
          </div>
          {r.guest_phone && (
            <div className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
              {r.guest_phone}
            </div>
          )}
          {r.allergy_severity === "severe" && (
            <div className="text-[11px] text-red-600 dark:text-red-400 font-medium truncate">
              {[
                (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
                r.allergy_note,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "party",
      label: t("rsvpColParty", "Party"),
      align: "right",
      width: "w-16",
      render: (r) => (
        <span className="inline-flex items-center gap-1 tabular-nums text-gray-700 dark:text-gray-300">
          <Users className="w-3.5 h-3.5 text-gray-400" aria-hidden />
          {r.party_size}
        </span>
      ),
    },
    {
      id: "tables",
      label: t("rsvpColTable", "Table"),
      width: "w-36",
      render: (r) => <TablesCell r={r} labelById={labelById} t={t} />,
    },
    {
      id: "status",
      label: t("rsvpColStatus", "Status"),
      width: "w-32",
      render: (r) => <StatusPill status={r.status} label={labels[r.status] || r.status} />,
    },
    {
      id: "flags",
      label: t("rsvpColFlags", "Flags"),
      width: "w-20",
      render: (r) => <FlagsCell r={r} t={t} />,
    },
  ];

  // Status-aware inline actions, mirroring ReservationRow's transition logic.
  const rowActions = (r) => {
    const busy = actioningId === r.id;
    const out = [];
    if (r.status === "requested") {
      out.push({ id: "confirmed", label: t("rsvpConfirmAction", "Confirm"), icon: <Check className="w-4 h-4" />, onClick: () => setStatus(r, "confirmed"), disabled: busy });
      out.push({ id: "decline", label: t("rsvpDeclineAction", "Decline"), icon: <X className="w-4 h-4" />, onClick: () => setStatus(r, "cancelled"), variant: "danger", disabled: busy });
    } else if (r.status === "confirmed") {
      out.push({ id: "seated", label: t("rsvpSeatAction", "Seat"), icon: <Armchair className="w-4 h-4" />, onClick: () => setStatus(r, "seated"), disabled: busy });
      out.push({ id: "no_show", label: t("rsvpNoShowAction", "No-show"), icon: <Ban className="w-4 h-4" />, onClick: () => setStatus(r, "no_show"), variant: "danger", disabled: busy });
      out.push({ id: "cancel", label: t("rsvpCancelAction", "Cancel"), icon: <X className="w-4 h-4" />, onClick: () => setStatus(r, "cancelled"), variant: "danger", disabled: busy });
    } else if (r.status === "seated") {
      out.push({ id: "completed", label: t("rsvpCompleteAction", "Complete"), icon: <CheckCircle2 className="w-4 h-4" />, onClick: () => setStatus(r, "completed"), disabled: busy });
    }
    return out;
  };

  return (
    <div className="space-y-4">
      {/* Toolbar: day controls (left) + view toggle (right). Every control is
          a ≥44px tap target for the Windows host-stand / tablet. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-base sm:text-sm text-gray-900 dark:text-gray-100"
            aria-label={t("rsvpBookDay", "Reservation date")}
          />
          <button
            type="button"
            onClick={() => setDay(isoDay(new Date()))}
            className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {t("rsvpToday", "Today")}
          </button>
          <button
            type="button"
            onClick={() => fetchBook(day)}
            aria-label={t("rsvpRefresh", "Refresh")}
            className="inline-flex items-center justify-center h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
        <TabPills
          tabs={[
            { id: "liste", label: t("rsvpViewListe", "List") },
            { id: "plan", label: t("rsvpViewPlan", "Floor") },
            { id: "tidslinje", label: t("rsvpViewTimeline", "Timeline") },
          ]}
          activeId={view}
          onChange={pickView}
          ariaLabel={t("rsvpViewAria", "Reservation views")}
        />
      </div>

      {/* Covers strip — the day's vitals. Awaiting goes amber when requests
          pile up; otherwise the strip is calm gray. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label={t("rsvpTotal", "Bookings")} value={summary.total} helper={fmtDkDate(day)} />
        <StatCard label={t("rsvpCovers", "Covers")} value={summary.covers} helper={t("rsvpCoversHelper", "guests")} />
        <StatCard label={t("rsvpSeatedNow", "Seated now")} value={seatedCount} />
        <StatCard
          label={t("rsvpAwaiting", "Awaiting")}
          value={requestedCount}
          accent={requestedCount > 0 ? "warn" : "neutral"}
          helper={t("rsvpAwaitingHelper", "to confirm")}
        />
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* ── Liste (the polished data-table) ── */}
      {view === "liste" && (
        <>
          <FilterBar>
            <FilterBar.Search
              value={q}
              onChange={setQ}
              placeholder={t("rsvpSearchPh", "Search guest or phone")}
            />
            <FilterBar.Select
              label={t("rsvpFilterStatus", "Status")}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: t("rsvpFilterAll", "All") },
                ...["requested", "confirmed", "seated", "completed", "no_show", "cancelled"].map(
                  (s) => ({ value: s, label: labels[s] }),
                ),
              ]}
            />
            {zones.length > 0 && (
              <FilterBar.Select
                label={t("rsvpFilterZone", "Zone")}
                value={zoneFilter}
                onChange={setZoneFilter}
                options={[
                  { value: "all", label: t("rsvpFilterAll", "All") },
                  ...zones.map((z) => ({ value: z, label: z })),
                ]}
              />
            )}
            {filtersOn && <FilterBar.Reset onClick={resetFilters} label={t("reset", "Reset")} />}
          </FilterBar>

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey="id"
            loading={loading}
            rowActions={rowActions}
            mobileBreakpoint="md"
            empty={
              <Empty
                icon={<CalendarCheck className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600" />}
                title={t("rsvpBookEmpty", "No reservations for {date} yet.", { date: fmtDkDate(day) })}
                body={
                  filtersOn
                    ? t("rsvpNoMatch", "No bookings match your filters.")
                    : t("rsvpBookEmptyBody", "Bookings will appear here as they come in.")
                }
              />
            }
          />
        </>
      )}

      {/* ── Plan (visual floor) ── */}
      {view === "plan" &&
        (loading ? (
          <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
        ) : (
          <FloorView
            reservations={reservations}
            resources={resources}
            t={t}
            onSelect={setSelected}
            onSeatNow={setSeatTarget}
          />
        ))}

      {/* ── Tidslinje (service timeline grid) ── */}
      {view === "tidslinje" &&
        (loading ? (
          <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
        ) : (
          <TimelineView
            reservations={reservations}
            resources={resources}
            day={day}
            t={t}
            onSelect={setSelected}
          />
        ))}

      {/* Shared detail drawer — opened from a Plan tile (and, next phase, a
          timeline block). Status actions reuse the same optimistic handler. */}
      {selected && (
        <ReservationDrawer
          reservation={selected}
          t={t}
          busy={actioningId === selected.id}
          onStatus={(r, to) => {
            setStatus(r, to);
            setSelected(null);
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Seat-now sheet — opened by tapping a FREE tile on the Plan view. */}
      {seatTarget && (
        <SeatNowSheet
          table={seatTarget}
          t={t}
          busy={seating}
          onSeat={seatWalkIn}
          onClose={() => setSeatTarget(null)}
        />
      )}
    </div>
  );
}

function StatusPill({ status, label }) {
  const dot = STATUS_DOT[status] || "bg-gray-400";
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs font-medium">
      <span className={`w-2 h-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// ─── Floor / resources ────────────────────────────────────────────────
function FloorSection({ t }) {
  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [capMsg, setCapMsg] = useState(null); // {cap, current, limit, plan, upgrade_to}

  // Add-form state.
  const [label, setLabel] = useState("");
  const [seats, setSeats] = useState("2");
  const [zone, setZone] = useState("");
  const [combinable, setCombinable] = useState(false);
  const [saving, setSaving] = useState(false);

  // Bulk "quick setup" — (seats, count) rows created in one call.
  const [bulkRows, setBulkRows] = useState([
    { seats: "2", count: "" },
    { seats: "4", count: "" },
    { seats: "6", count: "" },
  ]);
  const [bulkZone, setBulkZone] = useState("");
  const [bulkCombinable, setBulkCombinable] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkDone, setBulkDone] = useState(null); // {created, capped}

  const fetchResources = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/reservations/resources");
      setResources(Array.isArray(res.data?.resources) ? res.data.resources : []);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpFloorError", "Couldn't load your floor."),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  const addResource = async () => {
    if (!label.trim()) {
      setError(t("rsvpTableLabelRequired", "Give the table a name (e.g. Table 4)."));
      return;
    }
    setSaving(true);
    setError("");
    setCapMsg(null);
    try {
      const res = await api.post("/reservations/resources", {
        kind: "table",
        label: label.trim(),
        capacity_seats: Math.max(1, Math.min(100, parseInt(seats, 10) || 2)),
        zone: zone.trim() || null,
        combinable,
      });
      setResources((prev) => [...prev, res.data]);
      setLabel("");
      setSeats("2");
      setZone("");
      setCombinable(false);
    } catch (e) {
      // 402 cap_exceeded → show the cap message + upgrade nudge. FastAPI
      // wraps HTTPException(detail=…) so the structured payload
      // { error, cap, current, limit, plan, upgrade_to } lands under
      // `detail` (matches billing.enforce_cap). Fall back to the top-level
      // object too, in case a future handler returns it un-nested.
      if (e?.response?.status === 402) {
        const d = e?.response?.data?.detail || e?.response?.data || {};
        setCapMsg({
          cap: d.cap,
          current: d.current,
          limit: d.limit,
          plan: d.plan,
          upgrade_to: d.upgrade_to,
        });
      } else {
        setError(
          e?.response?.data?.detail?.error ||
            t("rsvpTableAddError", "Couldn't add the table."),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Bulk quick-setup ───────────────────────────────────────────────
  const bulkTotal = bulkRows.reduce((n, r) => n + (parseInt(r.count, 10) || 0), 0);
  const setBulkRow = (i, patch) =>
    setBulkRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const bumpCount = (i, delta) =>
    setBulkRow(i, {
      count: String(Math.max(0, (parseInt(bulkRows[i].count, 10) || 0) + delta)),
    });
  const addBulkRow = () => setBulkRows((prev) => [...prev, { seats: "", count: "" }]);
  const removeBulkRow = (i) => setBulkRows((prev) => prev.filter((_, idx) => idx !== i));

  const submitBulk = async () => {
    const specs = bulkRows
      .map((r) => ({
        capacity_seats: Math.max(1, Math.min(100, parseInt(r.seats, 10) || 0)),
        count: Math.max(0, parseInt(r.count, 10) || 0),
      }))
      .filter((s) => s.capacity_seats >= 1 && s.count >= 1);
    if (specs.length === 0) return;
    setBulkSaving(true);
    setError("");
    setCapMsg(null);
    setBulkDone(null);
    try {
      const res = await api.post("/reservations/resources/bulk", {
        specs,
        zone: bulkZone.trim() || null,
        combinable: bulkCombinable,
      });
      const created = Array.isArray(res.data?.created) ? res.data.created : [];
      setResources((prev) => [...prev, ...created]);
      setBulkDone({
        created: res.data?.created_count ?? created.length,
        capped: res.data?.capped ?? 0,
      });
      setBulkRows((prev) => prev.map((r) => ({ ...r, count: "" })));
      // Partial-cap → reuse the existing upgrade nudge (same payload shape).
      if (res.data?.cap_info) {
        const d = res.data.cap_info;
        setCapMsg({ cap: d.cap, current: d.current, limit: d.limit, plan: d.plan, upgrade_to: d.upgrade_to });
      }
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error || t("rsvpBulkError", "Couldn't add the tables."),
      );
    } finally {
      setBulkSaving(false);
    }
  };

  const saveSeats = async (r, nextSeats) => {
    const capacity_seats = Math.max(1, Math.min(100, parseInt(nextSeats, 10) || 1));
    // Optimistic.
    setResources((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, capacity_seats } : x)),
    );
    try {
      await api.patch(`/reservations/resources/${r.id}`, { capacity_seats });
    } catch {
      fetchResources();
    }
  };

  const toggleCombinable = async (r) => {
    const next = !r.combinable;
    // Optimistic.
    setResources((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, combinable: next } : x)),
    );
    try {
      await api.patch(`/reservations/resources/${r.id}`, { combinable: next });
    } catch {
      fetchResources();
    }
  };

  const removeResource = async (r) => {
    if (!confirm(t("rsvpTableDeleteConfirm", "Remove this table?"))) return;
    setResources((prev) => prev.filter((x) => x.id !== r.id));
    try {
      await api.delete(`/reservations/resources/${r.id}`);
    } catch {
      fetchResources();
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          "rsvpFloorIntro",
          "Add the tables guests can be seated at. Capacity drives which party sizes a slot can take.",
        )}
      </p>

      {/* Quick setup — bulk-add tables by size. The fast path for a fresh
          floor: "5 of 2, 4 of 4, 2 of 6" → one click, auto-numbered. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!bulkSaving) submitBulk();
        }}
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3"
      >
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpBulkTitle", "Quick setup")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("rsvpBulkHint", "How many tables of each size? They're created and numbered for you.")}
          </p>
        </div>

        <div className="space-y-2">
          {bulkRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="relative w-24 shrink-0">
                <input
                  type="text"
                  inputMode="numeric"
                  value={row.seats}
                  onChange={(e) => setBulkRow(i, { seats: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })}
                  placeholder={t("rsvpBulkSeatsPh", "Seats")}
                  aria-label={t("rsvpBulkSeatsAria", "Seats per table")}
                  className="w-full h-11 pl-3 pr-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
                  {t("rsvpSeatsShort", "pax")}
                </span>
              </div>
              <span className="text-gray-400 text-sm shrink-0">×</span>
              <div className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden shrink-0">
                <button
                  type="button"
                  onClick={() => bumpCount(i, -1)}
                  aria-label={t("rsvpBulkFewer", "Fewer")}
                  className="h-11 w-11 inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  value={row.count}
                  onChange={(e) => setBulkRow(i, { count: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })}
                  placeholder="0"
                  aria-label={t("rsvpBulkCountAria", "How many")}
                  className="h-11 w-14 text-center border-x border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => bumpCount(i, 1)}
                  aria-label={t("rsvpBulkMore", "More")}
                  className="h-11 w-11 inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              {bulkRows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeBulkRow(i)}
                  aria-label={t("delete", "Delete")}
                  className="ml-auto h-11 w-11 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addBulkRow}
          className="inline-flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
        >
          <Plus className="w-4 h-4" /> {t("rsvpBulkAddSize", "Add another size")}
        </button>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="text"
            value={bulkZone}
            onChange={(e) => setBulkZone(e.target.value)}
            maxLength={60}
            placeholder={t("rsvpTableZonePh", "Zone (optional)")}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
          />
          <label className="flex items-center gap-2.5 cursor-pointer select-none px-1">
            <input
              type="checkbox"
              checked={bulkCombinable}
              onChange={(e) => setBulkCombinable(e.target.checked)}
              className="w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {t("rsvpCombinable", "Can be combined")}
            </span>
          </label>
        </div>

        {bulkDone && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {t("rsvpBulkDone", "Added {n} tables.", { n: bulkDone.created })}
            {bulkDone.capped > 0 &&
              " " + t("rsvpBulkCapped", "{n} more need a plan upgrade.", { n: bulkDone.capped })}
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {bulkTotal > 0
              ? t("rsvpBulkTotal", "Adding {n} tables", { n: bulkTotal })
              : t("rsvpBulkPickCounts", "Set how many of each")}
          </span>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={bulkSaving}
            disabled={bulkTotal === 0}
            iconLeft={<Plus className="w-4 h-4" />}
          >
            {t("rsvpBulkSubmit", "Add tables")}
          </Button>
        </div>
      </form>

      {/* Add table — a real <form> so Enter submits from any field
          (keyboard-friendly on a host-stand desktop). Inputs + button are
          ≥44px touch targets. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving) addResource();
        }}
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3"
      >
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {t("rsvpAddTable", "Add a table")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("rsvpTableLabelPh", "Name (e.g. Table 4)")}
            maxLength={120}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
          />
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              value={seats}
              onChange={(e) => setSeats(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              placeholder={t("rsvpTableSeatsPh", "Seats")}
              className="w-full h-11 pl-3 pr-12 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              {t("rsvpSeats", "seats")}
            </span>
          </div>
          <input
            type="text"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder={t("rsvpTableZonePh", "Zone (optional)")}
            maxLength={60}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
          />
        </div>
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={combinable}
            onChange={(e) => setCombinable(e.target.checked)}
            className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 focus:ring-gray-400"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
            {t("rsvpCombinable", "Can be combined")}
            <span className="block text-xs text-gray-400 dark:text-gray-500">
              {t(
                "rsvpCombinableHint",
                "Push together with other combinable tables in the same zone to seat a bigger party.",
              )}
            </span>
          </span>
        </label>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="lg" busy={saving} iconLeft={<Plus className="w-4 h-4" />}>
            {t("rsvpAddTableBtn", "Add table")}
          </Button>
        </div>
      </form>

      {/* Cap-exceeded message + upgrade nudge */}
      {capMsg && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 p-4 space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t(
              "rsvpTableCapHit",
              "You've reached your plan's table limit ({limit}). Upgrade to add more.",
              { limit: capMsg.limit ?? capMsg.current ?? "" },
            )}
          </p>
          <UpgradeNudge
            intent="inline"
            tier={capMsg.upgrade_to === "pro" ? "pro" : "starter"}
            benefit={t("rsvpTableCapBenefit", "Unlimited tables")}
          />
        </div>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Resource list */}
      {loading ? (
        <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
      ) : resources.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 py-10 text-center">
          <Armchair className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("rsvpFloorEmpty", "No tables yet — add your first above.")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {resources.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate flex items-center gap-2">
                  <Armchair className="w-4 h-4 text-gray-400" aria-hidden />
                  {r.label}
                  {r.zone && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                      {r.zone}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleCombinable(r)}
                  aria-pressed={!!r.combinable}
                  title={t(
                    "rsvpCombinableToggleTitle",
                    "Combine with other combinable tables in the same zone to seat bigger parties",
                  )}
                  className={
                    "h-11 px-3 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-colors " +
                    (r.combinable
                      ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                      : "border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200")
                  }
                >
                  <Link2 className="w-4 h-4" aria-hidden />
                  <span className="hidden sm:inline">{t("rsvpCombineShort", "Combine")}</span>
                </button>
                <div className="relative w-24">
                  <input
                    type="text"
                    inputMode="numeric"
                    defaultValue={r.capacity_seats}
                    onBlur={(e) => {
                      const v = e.target.value.replace(/[^\d]/g, "");
                      if (v && parseInt(v, 10) !== r.capacity_seats) saveSeats(r, v);
                    }}
                    aria-label={t("rsvpTableSeatsAria", "Seats at {label}", { label: r.label })}
                    className="w-full h-11 pl-3 pr-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
                    {t("rsvpSeatsShort", "pax")}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeResource(r)}
                  aria-label={t("delete", "Delete")}
                  className="w-11 h-11 inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-600 hover:border-red-300"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Settings + share ─────────────────────────────────────────────────
function SettingsSection({ t }) {
  // SettingsSection only mounts after the parent's `if (!isReady) return null`
  // gate, so entitlements are already settled here — reading hasFeature is
  // flicker-safe (tier-flicker doctrine, useEntitlements.jsx).
  const { hasFeature } = useEntitlements();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingToggle, setSavingToggle] = useState(false);
  const [copied, setCopied] = useState(false);

  // Slug editor.
  const [slugDraft, setSlugDraft] = useState("");
  const [slugSaving, setSlugSaving] = useState(false);
  const [slugError, setSlugError] = useState("");

  // Availability numbers (subset of settings — kept simple).
  const [form, setForm] = useState({
    max_party_size: "",
    group_request_threshold: "",
    lead_time_min: "",
    max_advance_days: "",
    pacing_max_per_slot: "",
    default_duration_min: "",
    combine_enabled: true,
    max_combo_size: "",
  });
  // SMS reminders (Pro) — kept in its own state so the toggle/sender input
  // are independent of the availability-number form's save lifecycle.
  const [sms, setSms] = useState({ enabled: false, sender: "" });
  const [savingSms, setSavingSms] = useState(false);
  const [smsSaved, setSmsSaved] = useState(false);
  const [savingForm, setSavingForm] = useState(false);
  const [formSaved, setFormSaved] = useState(false);
  // Opening / booking hours, per weekday. Owner-settable so slots come from
  // when they actually open — not a hard-coded default.
  const [hours, setHours] = useState(() => defaultBookingHours());
  const [savingHours, setSavingHours] = useState(false);
  const [hoursSaved, setHoursSaved] = useState(false);

  const applyData = useCallback((d) => {
    setData(d);
    setSlugDraft(d?.reservation_slug || "");
    const s = d?.settings || {};
    setForm({
      max_party_size: s.max_party_size ?? "",
      group_request_threshold: s.group_request_threshold ?? "",
      lead_time_min: s.lead_time_min ?? "",
      max_advance_days: s.max_advance_days ?? "",
      pacing_max_per_slot: s.pacing_max_per_slot ?? "",
      default_duration_min: s.default_duration_min ?? "",
      // combine_enabled defaults on (matches the backend); only flips off if
      // the owner explicitly disabled combining.
      combine_enabled: s.combine_enabled !== false,
      max_combo_size: s.max_combo_size ?? "",
    });
    setSms({
      enabled: !!s.sms_reminders,
      sender: s.sms_sender ?? "",
    });
    setHours(parseBookingHours(s.booking_hours));
  }, []);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/reservations/settings");
      applyData(res.data || null);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpSettingsError", "Couldn't load settings."),
      );
    } finally {
      setLoading(false);
    }
  }, [applyData, t]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const toggleEnabled = async () => {
    if (!data) return;
    const next = !data.reservations_enabled;
    setSavingToggle(true);
    setError("");
    try {
      const res = await api.put("/reservations/settings", {
        reservations_enabled: next,
      });
      applyData(res.data || null);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpToggleError", "Couldn't update."),
      );
    } finally {
      setSavingToggle(false);
    }
  };

  const copyLink = async () => {
    if (!data?.public_url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(data.public_url);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      try {
        window.prompt(t("rsvpCopyLinkPrompt", "Copy this link"), data.public_url);
      } catch {
        /* headless */
      }
    }
  };

  const saveSlug = async () => {
    const desired = slugDraft.trim().toLowerCase();
    if (!desired || desired.length < 2) {
      setSlugError(t("rsvpSlugTooShort", "Pick at least 2 characters."));
      return;
    }
    setSlugSaving(true);
    setSlugError("");
    try {
      const res = await api.post("/reservations/slug", { slug: desired });
      setData((prev) =>
        prev
          ? {
              ...prev,
              reservation_slug: res.data?.reservation_slug || desired,
              public_url: res.data?.public_url || prev.public_url,
            }
          : prev,
      );
    } catch (e) {
      if (e?.response?.status === 409) {
        setSlugError(t("rsvpSlugTaken", "That link is taken — try another."));
      } else {
        setSlugError(
          e?.response?.data?.detail?.error ||
            t("rsvpSlugError", "Couldn't update the link."),
        );
      }
    } finally {
      setSlugSaving(false);
    }
  };

  const saveForm = async () => {
    setSavingForm(true);
    setFormSaved(false);
    setError("");
    // Only send numeric fields the owner actually filled. Empty string =
    // leave the backend default in place.
    const toInt = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const settings = {};
    if (toInt(form.max_party_size) !== undefined) settings.max_party_size = toInt(form.max_party_size);
    if (toInt(form.group_request_threshold) !== undefined) settings.group_request_threshold = toInt(form.group_request_threshold);
    if (toInt(form.lead_time_min) !== undefined) settings.lead_time_min = toInt(form.lead_time_min);
    if (toInt(form.max_advance_days) !== undefined) settings.max_advance_days = toInt(form.max_advance_days);
    // pacing: blank → null (no cap); a number → that cap.
    settings.pacing_max_per_slot =
      form.pacing_max_per_slot === "" ? null : toInt(form.pacing_max_per_slot) ?? null;
    // Booking length — how long a table is held per booking. Setting a flat
    // value clears the per-party-size turn-time tiers so the owner's number
    // applies to EVERY party (otherwise the tiers would override it). Clamped
    // 15–360 min. Blank leaves the existing rules untouched.
    if (toInt(form.default_duration_min) !== undefined) {
      settings.default_duration_min = Math.max(15, Math.min(360, toInt(form.default_duration_min)));
      settings.turn_time_tiers = [];
    }
    // Table combining: always send the on/off flag; cap is clamped to 2–6
    // (blank leaves the backend default of 3).
    settings.combine_enabled = !!form.combine_enabled;
    if (toInt(form.max_combo_size) !== undefined) {
      settings.max_combo_size = Math.max(2, Math.min(6, toInt(form.max_combo_size)));
    }
    try {
      const res = await api.put("/reservations/settings", { settings });
      applyData(res.data || null);
      setFormSaved(true);
      setTimeout(() => setFormSaved(false), 2500);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpSettingsSaveError", "Couldn't save settings."),
      );
    } finally {
      setSavingForm(false);
    }
  };

  // SMS reminders save — SAME PUT /reservations/settings path as the
  // availability numbers, just carrying sms_reminders + sms_sender in the
  // settings payload (no new endpoint). Sender is clamped to 11 chars to
  // match the alphanumeric-sender-ID limit. nextSms lets a toggle flip save
  // immediately without waiting on a state re-render.
  const saveSms = async (nextSms) => {
    const desired = nextSms || sms;
    setSavingSms(true);
    setSmsSaved(false);
    setError("");
    const settings = {
      sms_reminders: !!desired.enabled,
      sms_sender: (desired.sender || "").slice(0, 11),
    };
    try {
      const res = await api.put("/reservations/settings", { settings });
      applyData(res.data || null);
      setSmsSaved(true);
      setTimeout(() => setSmsSaved(false), 2500);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpSettingsSaveError", "Couldn't save settings."),
      );
      // Re-sync from server on failure so the toggle reflects truth.
      fetchSettings();
    } finally {
      setSavingSms(false);
    }
  };

  // Toggle flips state + persists in one go (optimistic, like the
  // accept-online switch). Disabled entirely when the tier lacks the feature.
  const toggleSms = () => {
    const next = { ...sms, enabled: !sms.enabled };
    setSms(next);
    saveSms(next);
  };

  // Patch one weekday's hours (open/close time or closed flag).
  const setHourDay = (key, patch) =>
    setHours((h) => ({ ...h, [key]: { ...h[key], ...patch } }));

  // Convenience: copy Monday's row to every day (the common "same every day"
  // case — set once, fan out).
  const applyMonToAll = () =>
    setHours((h) => {
      const mon = h.mon;
      const next = {};
      DAY_KEYS.forEach((k) => {
        next[k] = { ...mon };
      });
      return next;
    });

  // Persist booking hours through the SAME PUT /reservations/settings path —
  // serialized to the {mon:"HH:MM-HH:MM"|"closed", …} dict the availability
  // engine reads (reservation_service.restaurant_windows).
  const saveHours = async () => {
    setSavingHours(true);
    setHoursSaved(false);
    setError("");
    try {
      const res = await api.put("/reservations/settings", {
        settings: { booking_hours: serializeBookingHours(hours) },
      });
      applyData(res.data || null);
      setHoursSaved(true);
      setTimeout(() => setHoursSaved(false), 2500);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpHoursSaveError", "Couldn't save opening hours."),
      );
    } finally {
      setSavingHours(false);
    }
  };

  const smsUnlocked = hasFeature("sms_reminders");

  // Short weekday labels — static t() keys (not template-literal) so the i18n
  // discipline grep can verify each has an EN+DA entry. DK weeks start Monday.
  const dayLabel = {
    mon: t("rsvpDayMon", "Mon"),
    tue: t("rsvpDayTue", "Tue"),
    wed: t("rsvpDayWed", "Wed"),
    thu: t("rsvpDayThu", "Thu"),
    fri: t("rsvpDayFri", "Fri"),
    sat: t("rsvpDaySat", "Sat"),
    sun: t("rsvpDaySun", "Sun"),
  };

  if (loading) {
    return <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>;
  }

  const enabled = !!data?.reservations_enabled;
  const publicUrl = data?.public_url || "";

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* On/off toggle */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpAcceptToggle", "Accept online reservations")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {enabled
              ? t("rsvpAcceptOn", "Your public page is live and taking bookings.")
              : t("rsvpAcceptOff", "Turn on to publish your booking page.")}
          </p>
        </div>
        {/* 44px-tall tap target (host-stand touch), with the visual switch
            track centred inside it. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("rsvpAcceptToggle", "Accept online reservations")}
          disabled={savingToggle}
          onClick={toggleEnabled}
          className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 disabled:opacity-50"
        >
          <span
            className={
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors " +
              (enabled ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-600")
            }
          >
            <span
              className={
                "inline-block h-5 w-5 transform rounded-full bg-white transition-transform " +
                (enabled ? "translate-x-5" : "translate-x-0.5")
              }
            />
          </span>
        </button>
      </div>

      {/* Share — link + QR (only meaningful once enabled & a slug exists) */}
      {enabled && publicUrl && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-4">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpShareTitle", "Your booking page")}
          </h2>
          <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
            <div className="bg-white rounded-xl border border-gray-200 dark:border-gray-700 p-3 shrink-0 self-start">
              {/* Generated client-side (qrcode.react) — no dependency on an
                  external image service, so it always renders + works offline
                  for a printed table card. */}
              <QRCodeSVG
                value={publicUrl}
                size={140}
                level="M"
                marginSize={2}
                title={t("rsvpQrAlt", "QR code for your booking page")}
                className="w-[140px] h-[140px]"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t(
                  "rsvpShareHint",
                  "Put this link in your bio, on Google, or print the QR for the tables.",
                )}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 truncate">
                  {publicUrl}
                </div>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={copyLink}
                  iconLeft={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                >
                  {copied ? t("rsvpCopied", "Copied") : t("rsvpCopy", "Copy")}
                </Button>
              </div>
              <a
                href={publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
              >
                <Link2 className="w-3.5 h-3.5" />
                {t("rsvpOpenPage", "Open the page")}
              </a>
            </div>
          </div>

          {/* Slug editor — <form> so Enter saves from the field. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!slugSaving && slugDraft.trim() !== (data?.reservation_slug || "")) saveSlug();
            }}
            className="border-t border-gray-100 dark:border-gray-800 pt-3 space-y-2"
          >
            <label
              htmlFor="rsvp-slug"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              {t("rsvpCustomLink", "Customise your link")}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex items-center flex-1 min-w-0 h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
                <span className="px-3 text-sm text-gray-400 dark:text-gray-500 border-r border-gray-200 dark:border-gray-700 shrink-0 self-stretch flex items-center">
                  /r/
                </span>
                <input
                  id="rsvp-slug"
                  type="text"
                  value={slugDraft}
                  onChange={(e) => setSlugDraft(e.target.value)}
                  placeholder={t("rsvpSlugPh", "cafe-mocca")}
                  maxLength={60}
                  className="flex-1 min-w-0 px-3 h-full text-base sm:text-sm bg-transparent outline-none text-gray-900 dark:text-gray-100"
                />
              </div>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                busy={slugSaving}
                disabled={slugDraft.trim() === (data?.reservation_slug || "")}
              >
                {t("save", "Save")}
              </Button>
            </div>
            {slugError && (
              <p className="text-xs text-red-600 dark:text-red-400">{slugError}</p>
            )}
          </form>
        </div>
      )}

      {/* Opening / booking hours — the hours each weekday a guest can book.
          These feed the slot generator (reservation_service reads
          booking_hours first, before any fallback), so the times guests see
          come from when the owner actually opens, not a hard-coded default. */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" aria-hidden />
              {t("rsvpHoursTitle", "Opening hours (bookings)")}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t(
                "rsvpHoursHint",
                "Guests can only book while you're open. Set the hours for each day.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={applyMonToAll}
            className="shrink-0 text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 underline-offset-2 hover:underline"
          >
            {t("rsvpHoursCopyMon", "Apply Monday to all")}
          </button>
        </div>

        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {DAY_KEYS.map((k) => {
            const d = hours[k];
            const isOpen = !d.closed;
            return (
              <div key={k} className="flex items-center gap-3 py-2 flex-wrap">
                <span className="w-9 shrink-0 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {dayLabel[k]}
                </span>
                {/* Open / closed — 44px tap target for the host stand. */}
                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none shrink-0 min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={isOpen}
                    onChange={(e) => setHourDay(k, { closed: !e.target.checked })}
                    className="w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 focus:ring-gray-400"
                  />
                  <span className="text-xs text-gray-500 dark:text-gray-400 w-12">
                    {isOpen ? t("rsvpHoursOpen", "Open") : t("rsvpHoursClosed", "Closed")}
                  </span>
                </label>
                {isOpen ? (
                  <div className="inline-flex items-center gap-1.5">
                    <input
                      type="time"
                      value={d.open}
                      onChange={(e) => setHourDay(k, { open: e.target.value })}
                      aria-label={t("rsvpHoursOpenAt", "Opens")}
                      className="h-11 px-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100"
                    />
                    <span className="text-gray-400" aria-hidden>–</span>
                    <input
                      type="time"
                      value={d.close}
                      onChange={(e) => setHourDay(k, { close: e.target.value })}
                      aria-label={t("rsvpHoursCloseAt", "Closes")}
                      className="h-11 px-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100"
                    />
                  </div>
                ) : (
                  <span className="text-sm text-gray-400 dark:text-gray-500">
                    {t("rsvpHoursClosedDay", "Closed all day")}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          {hoursSaved && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> {t("rsvpSaved", "Saved")}
            </span>
          )}
          <Button
            type="button"
            variant="primary"
            size="lg"
            busy={savingHours}
            onClick={saveHours}
          >
            {t("save", "Save")}
          </Button>
        </div>
      </div>

      {/* Availability settings (kept simple — a few numbers). <form> so
          Enter saves from any field on a host-stand keyboard. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!savingForm) saveForm();
        }}
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3"
      >
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {t("rsvpAvailTitle", "Availability rules")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NumberField
            label={t("rsvpBookingLength", "Booking length (minutes)")}
            hint={t("rsvpBookingLengthHint", "How long a table is held per booking. Leave blank to keep your current rules.")}
            value={form.default_duration_min}
            onChange={(v) => setForm((f) => ({ ...f, default_duration_min: v }))}
          />
          <NumberField
            label={t("rsvpMaxParty", "Max party size (online)")}
            hint={t("rsvpMaxPartyHint", "Bigger groups see 'call us'.")}
            value={form.max_party_size}
            onChange={(v) => setForm((f) => ({ ...f, max_party_size: v }))}
          />
          <NumberField
            label={t("rsvpGroupThreshold", "Group-request from")
            }
            hint={t("rsvpGroupThresholdHint", "At/above this, bookings become a request you approve.")}
            value={form.group_request_threshold}
            onChange={(v) => setForm((f) => ({ ...f, group_request_threshold: v }))}
          />
          <NumberField
            label={t("rsvpLeadTime", "Lead time (minutes)")}
            hint={t("rsvpLeadTimeHint", "Earliest a guest can book from now.")}
            value={form.lead_time_min}
            onChange={(v) => setForm((f) => ({ ...f, lead_time_min: v }))}
          />
          <NumberField
            label={t("rsvpMaxAdvance", "Book up to (days ahead)")}
            value={form.max_advance_days}
            onChange={(v) => setForm((f) => ({ ...f, max_advance_days: v }))}
          />
          <NumberField
            label={t("rsvpPacing", "Max covers per slot")}
            hint={t("rsvpPacingHint", "Leave blank for no pacing cap.")}
            value={form.pacing_max_per_slot}
            onChange={(v) => setForm((f) => ({ ...f, pacing_max_per_slot: v }))}
          />
        </div>
        {/* Table combining — flag tables as combinable on the Floor tab; this
            switch governs whether the engine actually combines them. */}
        <div className="pt-3 border-t border-gray-100 dark:border-gray-800">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!form.combine_enabled}
              onChange={(e) => setForm((f) => ({ ...f, combine_enabled: e.target.checked }))}
              className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
              {t("rsvpCombineSetting", "Table combining")}
              <span className="block text-xs text-gray-400 dark:text-gray-500">
                {t(
                  "rsvpCombineSettingHint",
                  "Let big parties be seated across multiple combinable tables in the same zone.",
                )}
              </span>
            </span>
          </label>
          {form.combine_enabled && (
            <div className="mt-3 sm:max-w-[14rem]">
              <NumberField
                label={t("rsvpMaxComboSize", "Max tables per party")}
                value={form.max_combo_size}
                onChange={(v) => setForm((f) => ({ ...f, max_combo_size: v }))}
              />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3">
          {formSaved && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> {t("rsvpSaved", "Saved")}
            </span>
          )}
          <Button type="submit" variant="primary" size="lg" busy={savingForm}>
            {t("save", "Save")}
          </Button>
        </div>
      </form>

      {/* SMS reminders (Pro). Locked surface for non-Pro tiers (disabled
          switch + Pro badge/lock + upsell link to /subscription, the same
          path the rest of the app's Pro gates use). A Pro / Trial owner
          sees it fully enabled. Saves through the SAME PUT
          /reservations/settings as the availability numbers. */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-gray-400" aria-hidden />
              {t("rsvpSmsTitle", "SMS reminders")}
              {!smsUnlocked && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-[10px] font-semibold uppercase tracking-wide">
                  <Lock className="w-3 h-3" aria-hidden />
                  {t("rsvpSmsPro", "Pro")}
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
              {t(
                "rsvpSmsHint",
                "Send an SMS reminder the day before instead of email (Pro).",
              )}
            </p>
          </div>
          {/* 44px-tall tap target, switch track centred inside — identical
              to the "Accept online reservations" toggle above. Disabled +
              dimmed when the tier doesn't include SMS. */}
          <button
            type="button"
            role="switch"
            aria-checked={smsUnlocked && sms.enabled}
            aria-label={t("rsvpSmsToggle", "SMS reminders")}
            disabled={!smsUnlocked || savingSms}
            onClick={toggleSms}
            className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span
              className={
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors " +
                (smsUnlocked && sms.enabled
                  ? "bg-emerald-600"
                  : "bg-gray-300 dark:bg-gray-600")
              }
            >
              <span
                className={
                  "inline-block h-5 w-5 transform rounded-full bg-white transition-transform " +
                  (smsUnlocked && sms.enabled ? "translate-x-5" : "translate-x-0.5")
                }
              />
            </span>
          </button>
        </div>

        {/* Locked tiers: short upsell line → /subscription (same route as
            other Pro gates, e.g. the sidebar Lock entries + UpgradeNudge). */}
        {!smsUnlocked && (
          <Link
            to="/subscription"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 dark:hover:text-emerald-200"
          >
            <Lock className="w-3.5 h-3.5" aria-hidden />
            {t("rsvpSmsProUpsell", "Available on Pro")}
          </Link>
        )}

        {/* Sender input — only when unlocked AND the toggle is on. */}
        {smsUnlocked && sms.enabled && (
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 space-y-2">
            <label
              htmlFor="rsvp-sms-sender"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              {t("rsvpSmsSender", "Sender name")}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="rsvp-sms-sender"
                type="text"
                value={sms.sender}
                onChange={(e) =>
                  setSms((s) => ({ ...s, sender: e.target.value.slice(0, 11) }))
                }
                onBlur={() => saveSms()}
                placeholder="BonBox"
                maxLength={11}
                className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100"
              />
              <Button
                type="button"
                variant="primary"
                size="lg"
                busy={savingSms}
                onClick={() => saveSms()}
              >
                {t("save", "Save")}
              </Button>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {t("rsvpSmsSenderHint", "Sender name on the SMS (max 11 characters).")}
            </p>
          </div>
        )}

        {/* Honesty: SMS needs a provider token that may not be configured
            yet — until then the reminder is sent by email. */}
        {smsUnlocked && sms.enabled && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            {t(
              "rsvpSmsFallbackNote",
              "SMS sends once your account is set up. Until then we send the reminder by email.",
            )}
          </p>
        )}

        {smsSaved && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
            <Check className="w-3.5 h-3.5" /> {t("rsvpSaved", "Saved")}
          </span>
        )}
      </div>

      {/* Install-as-app hint — BonBox's host-stand edge: runs as an app on
          the Windows PC / touch tablet already at the podium, no locked-down
          terminal required. */}
      <InstallHostStandHint t={t} />
    </div>
  );
}

// ─── Install-as-app hint (host stand) ─────────────────────────────────
// Reuses the SAME mechanism as the rest of the app's PWA install flow
// (see components/InstallAppPrompt.jsx + StaffPortalPage's InstallNotify
// card): capture the browser's `beforeinstallprompt` event and replay it
// on tap. We do NOT pull in a dependency or a second install codepath.
//
// Three states (first match wins):
//   1. Already running as an installed app (display-mode: standalone) →
//      render nothing; there's nothing to install.
//   2. Browser fired beforeinstallprompt (Chrome / Edge on Windows /
//      Android) → show the "Installér" button that replays it.
//   3. No programmatic prompt (event already consumed, unsupported, or
//      iOS Safari) → show brief Edge/Chrome menu instructions instead.
function _isStandaloneDisplay() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.navigator?.standalone === true) return true;
  } catch {
    /* SSR / matchMedia unavailable — treat as not installed */
  }
  return false;
}

function InstallHostStandHint({ t }) {
  const [installEvent, setInstallEvent] = useState(null);
  const [installed, setInstalled] = useState(() => _isStandaloneDisplay());
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault(); // suppress the browser's own mini-infobar
      setInstallEvent(e); // stash so our button can replay it
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Nothing to do once it's already a home-screen / desktop app.
  if (installed) return null;

  const doInstall = async () => {
    if (!installEvent) return;
    setInstalling(true);
    try {
      installEvent.prompt();
      await installEvent.userChoice;
    } catch {
      /* stale event on some browsers — harmless */
    } finally {
      setInstallEvent(null);
      setInstalling(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 p-4 flex items-start gap-3">
      <div className="w-9 h-9 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center shrink-0 text-gray-600 dark:text-gray-300">
        <MonitorSmartphone className="w-4 h-4" aria-hidden />
      </div>
      <div className="min-w-0 space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpInstallTitle", "Open the book as an app")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
            {t(
              "rsvpInstallBody",
              "Install BonBox on your host PC / tablet so the reservation book opens as an app.",
            )}
          </p>
        </div>
        {installEvent ? (
          <Button
            variant="secondary"
            size="lg"
            onClick={doInstall}
            busy={installing}
            iconLeft={<Download className="w-4 h-4" />}
          >
            {t("rsvpInstallCta", "Install BonBox")}
          </Button>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            {t(
              "rsvpInstallManual",
              "In Edge or Chrome: open the ⋯ menu → Apps → Install this site as an app.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function NumberField({ label, hint, value, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, "").slice(0, 4))}
        className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
      />
      {hint && <span className="text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>}
    </label>
  );
}
