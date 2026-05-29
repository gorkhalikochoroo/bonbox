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
//   POST   /reservations/resources                  {kind, label, capacity_seats, zone}
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
import { useCallback, useEffect, useState } from "react";
import {
  CalendarCheck,
  Plus,
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
} from "lucide-react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import Button from "../components/ui/Button";
import TabPills from "../components/ui/TabPills";
import UpgradeNudge from "../components/ui/UpgradeNudge";

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

// QR for the public link — reuses the same client-side generator as
// WineListPage (api.qrserver.com), so no new dependency is pulled in.
function qrUrlFor(url, size = 200) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}`;
}

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
function BookSection({ t }) {
  const [day, setDay] = useState(() => isoDay(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actioningId, setActioningId] = useState(null);

  const fetchBook = useCallback(
    async (forDay) => {
      setLoading(true);
      setError("");
      try {
        const res = await api.get("/reservations/book", {
          params: { day: forDay },
        });
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

  useEffect(() => {
    fetchBook(day);
  }, [day, fetchBook]);

  const setStatus = async (r, status) => {
    // Cancel asks for a reason via confirm — the backend stores it on
    // the row (cancel_reason) for the audit trail.
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
      // Refetch so the summary (covers / by_status) reconciles.
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

  const summary = data?.summary || { total: 0, covers: 0, by_status: {} };
  const reservations = Array.isArray(data?.reservations) ? data.reservations : [];

  return (
    <div className="space-y-4">
      {/* Day picker + summary. Host-stand sizing: every control here is a
          ≥44px tap target so a host behind a podium can hit them fast on a
          Windows touch PC / tablet (where the global pointer:coarse floor
          does not apply). */}
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
        <div className="flex items-center gap-2 text-sm">
          <SummaryPill label={t("rsvpTotal", "Bookings")} value={summary.total} />
          <SummaryPill label={t("rsvpCovers", "Covers")} value={summary.covers} />
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
      ) : reservations.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 py-10 text-center">
          <CalendarCheck className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("rsvpBookEmpty", "No reservations for {date} yet.", {
              date: fmtDkDate(day),
            })}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {reservations.map((r) => (
            <ReservationRow
              key={r.id}
              r={r}
              t={t}
              busy={actioningId === r.id}
              onStatus={setStatus}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryPill({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-medium">
      <span className="tabular-nums font-semibold text-base">{value}</span>
      <span className="text-gray-500 dark:text-gray-400 text-xs">{label}</span>
    </span>
  );
}

function ReservationRow({ r, t, busy, onStatus }) {
  // Allergy flag — severe ones go red, everything else gray-with-warn.
  const hasAllergy =
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity;
  const isSevere = r.allergy_severity === "severe";

  const statusLabel = {
    requested: t("rsvpStatusRequested", "Requested"),
    confirmed: t("rsvpStatusConfirmed", "Confirmed"),
    seated: t("rsvpStatusSeated", "Seated"),
    completed: t("rsvpStatusCompleted", "Completed"),
    no_show: t("rsvpStatusNoShow", "No-show"),
    cancelled: t("rsvpStatusCancelled", "Cancelled"),
  };

  // Which actions make sense for each status. Terminal states (completed
  // / cancelled / no_show) get no actions.
  const actions = [];
  if (r.status === "requested") {
    actions.push({ id: "confirmed", label: t("rsvpConfirmAction", "Confirm") });
    actions.push({ id: "cancelled", label: t("rsvpDeclineAction", "Decline"), variant: "danger" });
  } else if (r.status === "confirmed") {
    actions.push({ id: "seated", label: t("rsvpSeatAction", "Seat") });
    actions.push({ id: "no_show", label: t("rsvpNoShowAction", "No-show"), variant: "danger" });
    actions.push({ id: "cancelled", label: t("rsvpCancelAction", "Cancel"), variant: "danger" });
  } else if (r.status === "seated") {
    actions.push({ id: "completed", label: t("rsvpCompleteAction", "Complete") });
  }

  return (
    <li className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3.5">
      {/* Readable at arm's length across a host stand: the time, guest name
          and party size are bumped up + given more breathing room so the
          host can glance the book from a step back. Actions stack below on
          tablet portrait and sit to the right on wider screens. */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
            <span className="text-lg sm:text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100 leading-none">
              {fmtTime(r.starts_at)}
            </span>
            <span className="text-base sm:text-lg font-medium text-gray-800 dark:text-gray-200 truncate">
              {r.guest_name || "—"}
            </span>
            <span className="inline-flex items-center gap-1 text-sm font-medium text-gray-600 dark:text-gray-300">
              <Users className="w-4 h-4" aria-hidden />
              {r.party_size}
            </span>
            {hasAllergy && (
              <span
                title={[r.allergen_tags?.join(", "), r.allergy_note].filter(Boolean).join(" · ")}
                className={
                  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide " +
                  (isSevere
                    ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                    : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300")
                }
              >
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                {isSevere
                  ? t("rsvpAllergySevere", "Severe allergy")
                  : t("rsvpAllergyFlag", "Allergy")}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-1.5 flex items-center gap-2 flex-wrap">
            <StatusPill status={r.status} label={statusLabel[r.status] || r.status} />
            {r.occasion && <span>· {r.occasion}</span>}
            {r.source === "public" && <span>· {t("rsvpSourceOnline", "online")}</span>}
            {(r.source === "walk_in") && <span>· {t("rsvpSourceWalkIn", "walk-in")}</span>}
          </div>
          {(r.guest_notes || hasAllergy) && (
            <div className="mt-1.5 space-y-0.5">
              {hasAllergy && (
                <p
                  className={
                    "text-sm " +
                    (isSevere
                      ? "text-red-600 dark:text-red-400 font-medium"
                      : "text-gray-600 dark:text-gray-300")
                  }
                >
                  {[
                    (r.allergen_tags || [])
                      .map((k) => t(`allergen_${k}`, k))
                      .join(", "),
                    r.allergy_note,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {r.guest_notes && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {r.guest_notes}
                </p>
              )}
            </div>
          )}
        </div>
        {actions.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {actions.map((a) => (
              <Button
                key={a.id}
                size="lg"
                variant={a.variant === "danger" ? "ghost" : "primary"}
                onClick={() => onStatus(r, a.id)}
                disabled={busy}
                className={a.variant === "danger" ? "text-red-600 hover:text-red-700" : ""}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
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
  const [saving, setSaving] = useState(false);

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
      });
      setResources((prev) => [...prev, res.data]);
      setLabel("");
      setSeats("2");
      setZone("");
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
  });
  // SMS reminders (Pro) — kept in its own state so the toggle/sender input
  // are independent of the availability-number form's save lifecycle.
  const [sms, setSms] = useState({ enabled: false, sender: "" });
  const [savingSms, setSavingSms] = useState(false);
  const [smsSaved, setSmsSaved] = useState(false);
  const [savingForm, setSavingForm] = useState(false);
  const [formSaved, setFormSaved] = useState(false);

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
    });
    setSms({
      enabled: !!s.sms_reminders,
      sender: s.sms_sender ?? "",
    });
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

  const smsUnlocked = hasFeature("sms_reminders");

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
              <img
                src={qrUrlFor(publicUrl, 220)}
                alt={t("rsvpQrAlt", "QR code for your booking page")}
                width={140}
                height={140}
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
