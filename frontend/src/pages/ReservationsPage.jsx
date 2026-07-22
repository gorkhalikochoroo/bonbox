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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Phone,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  BarChart3,
  Scissors,
  SlidersHorizontal,
  ExternalLink,
  HelpCircle,
  Pencil,
  Mail,
} from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import api from "../services/api";
import { haptic } from "../utils/haptics";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { useConfirm } from "../hooks/useConfirm";
import { useEntitlements } from "../hooks/useEntitlements";
import Button from "../components/ui/Button";
import Sheet from "../components/ui/Sheet";
import TabPills from "../components/ui/TabPills";
import UpgradeNudge from "../components/ui/UpgradeNudge";
import DataTable from "../components/ui/DataTable";
import StatCard from "../components/ui/StatCard";
import FilterBar from "../components/ui/FilterBar";
import Empty from "../components/ui/Empty";
import FloorPlan from "../components/FloorPlan";
import InsightsSection from "../components/reservations/InsightsSection";
import WaitlistSection from "../components/reservations/WaitlistSection";
import { QRCodeSVG } from "qrcode.react";
import { canPurchaseInApp } from "../utils/platform";
import { venueProfile, bookingModeFor, usesTableFloor } from "../config/venueProfiles";
import { formatKr } from "../utils/currency";

// Status → status-pill styling. Colour is BUDGETED, status-only (design
// doctrine): it appears where it MEANS something and recedes where it
// doesn't — the opposite of a list where every row shouts equally.
//   • requested  amber tint + a live pulsing dot — the one that needs a human
//   • confirmed  emerald tint — on the books, needs nothing now
//   • seated     SOLID DARK — occupied = present = the heaviest chip, tying
//                the Liste to the 2D floor's "dark tile = in use" language
//   • no_show    muted red — the ONLY status red (the cover that stung)
//   • completed  quiet gray — done, receding
//   • cancelled  quiet gray + strikethrough (NOT red — a cancellation is a
//                non-event; the strike keeps it distinct from completed)
// Soft tints, never candy fills. Every text/bg pairing clears WCAG AA in
// light AND dark mode (neutral pills use gray-600, not gray-400/500).
const STATUS_PILL = {
  requested: {
    pill: "font-medium bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/60",
    dot: "bg-amber-500 dark:bg-amber-400 motion-safe:animate-pulse",
  },
  confirmed: {
    pill: "font-medium bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/60",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  seated: {
    // The only solid fill — inverts in dark mode so it stays the highest-
    // contrast (heaviest) mark in the column. No ring; font-semibold.
    pill: "font-semibold bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
    dot: "bg-white/80 dark:bg-gray-900/70",
  },
  completed: {
    pill: "font-medium bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-500/15 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700",
    dot: "bg-gray-400 dark:bg-gray-500",
  },
  no_show: {
    pill: "font-medium bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-800/60",
    dot: "bg-red-500 dark:bg-red-400",
  },
  cancelled: {
    pill: "font-medium bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-500/15 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700",
    dot: "bg-gray-300 dark:bg-gray-600",
    strike: true,
  },
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

// Step a YYYY-MM-DD day by ±n calendar days (local, DST-safe).
function shiftDay(iso, delta) {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return isoDay(dt);
}

// Friendly label for the date stepper: "I dag" / "I morgen" / "I går" for the
// immediate neighbours, otherwise the capitalised weekday in the active locale.
function relativeDayLabel(iso, t, locale) {
  const today = isoDay(new Date());
  if (iso === today) return t("rsvpToday", "Today");
  if (iso === shiftDay(today, 1)) return t("rsvpDayTomorrow", "Tomorrow");
  if (iso === shiftDay(today, -1)) return t("rsvpDayYesterday", "Yesterday");
  try {
    const [y, m, d] = iso.split("-").map(Number);
    const wd = new Date(y, m - 1, d).toLocaleDateString(locale || "en", {
      weekday: "long",
    });
    return wd.charAt(0).toUpperCase() + wd.slice(1);
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
// Salon-flavored starting hours for the first-run card — the SAME shape
// defaultBookingHours() returns, but a typical salon week (Tue–Fri 09–17,
// Sat 09–14, Mon + Sun closed). A suggestion only; the owner confirms/edits
// before we persist it via /reservations/salon/quick-setup.
function defaultSalonHours() {
  const o = {};
  DAY_KEYS.forEach((k) => {
    o[k] = { closed: false, open: "09:00", close: "17:00" };
  });
  o.sat = { closed: false, open: "09:00", close: "14:00" };
  o.mon = { closed: true, open: "09:00", close: "17:00" };
  o.sun = { closed: true, open: "09:00", close: "17:00" };
  return o;
}

// Weekday opening-hours editor — the one weekday-rows grid shared by the
// Settings section and the salon first-run card. Presentational: the parent
// owns the `hours` state plus the setHourDay / applyMonToAll handlers (the
// SAME helpers that serialize to the {mon:"HH:MM-HH:MM"|"closed", …} dict the
// availability engine reads). Pass `onApplyMonToAll` to surface the "copy
// Monday to every day" shortcut above the rows.
function WeekHoursEditor({ t, hours, setHourDay, onApplyMonToAll }) {
  // Static t() keys (not template literals) so the i18n grep can verify each
  // has an EN+DA entry. DK weeks start Monday.
  const dayLabel = {
    mon: t("rsvpDayMon", "Mon"),
    tue: t("rsvpDayTue", "Tue"),
    wed: t("rsvpDayWed", "Wed"),
    thu: t("rsvpDayThu", "Thu"),
    fri: t("rsvpDayFri", "Fri"),
    sat: t("rsvpDaySat", "Sat"),
    sun: t("rsvpDaySun", "Sun"),
  };
  return (
    <div className="space-y-2">
      {onApplyMonToAll && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onApplyMonToAll}
            className="shrink-0 text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 underline-offset-2 hover:underline"
          >
            {t("rsvpHoursCopyMon", "Apply Monday to all")}
          </button>
        </div>
      )}
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
    </div>
  );
}

// Tab ids — kept as a const so the ?tab= deep-link (e.g. from the Insights
// "Turn on SMS reminders" action) can validate against the real set.
const RSVP_TABS = ["book", "floor", "behandlinger", "insights", "settings"];

export default function ReservationsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { hasFeature, isReady } = useEntitlements();
  const location = useLocation();
  const navigate = useNavigate();

  // Per-vertical adaptation (Phase A). `bookingMode` gates the Floor tab
  // (TABLE-only) on the venue TYPE; `isProvider` (salon) drives the
  // Aftaler/Tidsbestilling vocabulary swap. Pure config read — no refetch.
  const businessType = user?.business_type;
  // Resources fetched at page level (Insights zone filter + the floor
  // grandfather just below). Soft-fail: the page works without it. The state
  // lives up here so the grandfather flag is in scope before the tab logic.
  const [pageResources, setPageResources] = useState([]);
  // GRANDFATHER: a venue whose TYPE isn't table-booking but that has ALREADY
  // configured tables keeps its Floor — Phase A type-gating must never strip a
  // surface the owner already built (e.g. a legacy / personal-mode account with
  // a real table plan + live reservations). A table is any non-provider resource.
  const hasTableResources = useMemo(
    () => pageResources.some((r) => r.kind !== "provider"),
    [pageResources],
  );
  const isProvider = bookingModeFor(businessType) === "provider";
  // A real TABLE plan exists → the 2D table-plan view + table-style authoring.
  // (A salon with leftover tables from an earlier setup also counts, so the
  // grandfather/clear-tables path stays reachable.)
  const tablePlan = usesTableFloor(businessType) || hasTableResources;
  // The authoring tab is visible for table venues, venues with existing
  // tables, AND provider venues that need to author stylist (behandler)
  // stations — without it a fresh salon could never create a bookable
  // provider station, so the engine would never return slots.
  const showFloor = tablePlan || isProvider;

  // The book's date lives HERE, not inside BookSection, so the desktop day
  // rail and the book are driven by one value and can never disagree about
  // which day is open. BookSection stays uncontrolled everywhere else (host
  // stand, tests) — see its `day`/`onDayChange` props.
  const [bookDay, setBookDay] = useState(() => isoDay(new Date()));

  // The active tab is DERIVED from the URL (?tab=), so the query string is the
  // single source of truth — a deep-link (e.g. the Insights "Turn on SMS
  // reminders" action → ?tab=settings) and the browser back/forward button are
  // honoured for free, with no mirror state to keep in sync. Falls back to
  // "book" for a missing / unknown value.
  const tab = useMemo(() => {
    try {
      const q = new URLSearchParams(location.search).get("tab");
      const resolved = RSVP_TABS.includes(q) ? q : "book";
      // A provider/no-floor venue has no Floor tab — a deep-link to ?tab=floor
      // (or a stale bookmark) falls back to the book view, never a dead tab.
      if (resolved === "floor" && !showFloor) return "book";
      // Behandlinger is salon-only — a non-provider deep-link to it falls back.
      if (resolved === "behandlinger" && !isProvider) return "book";
      return resolved;
    } catch {
      return "book";
    }
  }, [location.search, showFloor, isProvider]);

  // Fetch the page-level resources (used by the Insights zone filter + the
  // floor grandfather above). Soft-fail — the page works without it.
  useEffect(() => {
    if (!isReady || !hasFeature("reservations")) return;
    let alive = true;
    api
      .get("/reservations/resources")
      .then((res) => {
        if (alive) setPageResources(Array.isArray(res.data?.resources) ? res.data.resources : []);
      })
      .catch(() => {
        if (alive) setPageResources([]);
      });
    return () => {
      alive = false;
    };
  }, [isReady, hasFeature]);

  const insightsZones = useMemo(
    () => [...new Set(pageResources.map((r) => r.zone).filter(Boolean))],
    [pageResources],
  );

  // Switch tab by writing the URL — `tab` re-derives from it on the next
  // render. Used by the TabPills. (The in-page SMS deep-link is a plain
  // <Link to="/reservations?tab=settings">, which lands on the same code path.)
  const changeTab = useCallback(
    (next) => {
      const params = new URLSearchParams(location.search);
      if (next === "book") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      navigate({ search: qs ? `?${qs}` : "" }, { replace: true });
    },
    [location.search, navigate],
  );

  // ── Tier flicker contract ──────────────────────────────────────────
  // Render NOTHING while entitlements are loading, then either the
  // upgrade nudge (locked) or the page (unlocked). Matches the doctrine
  // in useEntitlements.jsx.
  if (!isReady) return null;
  if (!hasFeature("reservations")) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
        <PageTitle t={t} isProvider={isProvider} />
        <UpgradeNudge
          intent="card"
          tier="starter"
          iconName="CalendarCheck"
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
    // max-w-5xl (1024px) was capping this page on every screen, so hiding the
    // sidebar freed pixels the page then refused to use — ~400 dead on a 1440
    // display. The cap only lifts at xl, exactly where the day rail appears;
    // below that the single column is still the right shape.
    <div className="p-4 md:p-8 max-w-5xl xl:max-w-[1400px] mx-auto space-y-6">
      <PageTitle t={t} isProvider={isProvider} />
      <TabPills
        tabs={[
          // Salon (provider) reads "Aftaler" (the appointment book) instead of
          // "Reservation book"; the booking primitive underneath is unchanged.
          { id: "book", label: isProvider ? t("rsvpTabBookProvider", "Aftaler") : t("rsvpTabBook", "Reservation book") },
          // Floor/station tab — table venues, venues with existing tables, AND
          // provider venues (where it authors stylist stations). Provider venues
          // read "Behandlere"; table venues keep "Floor".
          ...(showFloor
            ? [
                {
                  id: "floor",
                  label: isProvider
                    ? t("rsvpTabProviders", "Stylists")
                    : t("rsvpTabFloor", "Floor"),
                },
              ]
            : []),
          // Behandlinger (salon service catalog) — salon (provider) venues only.
          // "Behandlinger" stays Danish in every UI language (DK terminology lock).
          ...(isProvider
            ? [{ id: "behandlinger", label: t("rsvpTabBehandlinger", "Behandlinger") }]
            : []),
          { id: "insights", label: t("rsvpTabInsights", "Insights") },
          { id: "settings", label: t("rsvpTabSettings", "Settings") },
        ]}
        activeId={tab}
        onChange={changeTab}
        ariaLabel={t("rsvpTabsAria", "Reservation sections")}
        size="lg"
      />

      {/* Two columns from xl (1280px) up — the rail is additive, so below that
          breakpoint this collapses to exactly the single column shipped
          before. min-w-0 on the book so a wide timeline scrolls inside its
          own column instead of pushing the grid open. */}
      {tab === "book" && (
        <div className="xl:grid xl:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:items-start">
          <div className="hidden xl:block xl:sticky xl:top-6">
            <DayRail day={bookDay} onPick={setBookDay} t={t} />
          </div>
          <div className="min-w-0">
            <BookSection
              t={t}
              businessType={user?.business_type}
              tableFloor={tablePlan}
              day={bookDay}
              onDayChange={setBookDay}
            />
          </div>
        </div>
      )}
      {tab === "floor" && showFloor && <FloorSection t={t} businessType={user?.business_type} />}
      {tab === "behandlinger" && isProvider && <BehandlingerSection t={t} />}
      {/* Insights mounts lazily (only when its tab is open) so it never blocks
          the Book view's first paint; the fetch fires on mount. */}
      {tab === "insights" && <InsightsSection t={t} zones={insightsZones} />}
      {tab === "settings" && <SettingsSection t={t} user={user} />}
    </div>
  );
}

function PageTitle({ t, isProvider = false }) {
  // Salon (provider) reads "Tidsbestilling" with an Aftaler-flavoured subtitle.
  // The booking primitive underneath is unchanged — this is vocabulary + IA
  // only (Phase A is NOT appointment-grade; honesty gate #2).
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
        <CalendarCheck className="w-6 h-6 text-gray-700 dark:text-gray-200" aria-hidden />
        {isProvider ? t("rsvpOwnerTitleProvider", "Tidsbestilling") : t("rsvpOwnerTitle", "Reservations")}
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        {isProvider
          ? t(
              "rsvpOwnerSubtitleProvider",
              "Dine aftaler og den offentlige side, dine kunder bestiller tid på.",
            )
          : t(
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

// Sentinel seatTarget for a header-launched walk-in (no preset tile). It
// signals SeatNowSheet to render its table picker instead of a fixed table.
const SEAT_WALK_IN_PICK = "__pick__";

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
// Note-intent i18n keys — a rule-based operational bucket the owner can filter
// by. NOT a colored alarm: a quiet gray badge (a hint for prep). See
// backend/app/services/note_intent.py for the classifier.
const NOTE_INTENT_KEYS = {
  accessibility: ["rsvpIntentAccess", "Accessibility"],
  celebration_birthday: ["rsvpIntentBirthday", "Birthday"],
  celebration_anniversary: ["rsvpIntentAnniversary", "Anniversary"],
  business: ["rsvpIntentBusiness", "Business"],
  large_group: ["rsvpIntentLargeGroup", "Large group"],
};
function noteIntentLabel(intent, t) {
  const k = NOTE_INTENT_KEYS[intent];
  return k ? t(k[0], k[1]) : null;
}

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
  // Unconfirmed AI allergy suggestion — shown only when there's no CONFIRMED
  // allergy already flagged (that icon wins). A dashed-amber "maybe — confirm"
  // cue distinct from a confirmed allergy; the owner confirms in the drawer.
  const ai = r.ai_allergy;
  const aiMaybe = !hasAllergy && ai && ai.has_ai_suggested_allergy;
  const aiTags = (ai?.ai_tags || []).map((k) => t(`allergen_${k}`, k)).join(", ");
  const aiTitle =
    t("rsvpAiAllergyMaybe", "Possible allergy — confirm") + (aiTags ? `: ${aiTags}` : "");
  const intentLabel = noteIntentLabel(r.note_intent, t);
  return (
    <div className="flex items-center gap-1.5 text-gray-400 dark:text-gray-500">
      {hasAllergy && (
        <AlertTriangle
          className={"w-4 h-4 " + (severe ? "text-red-600 dark:text-red-400" : "text-amber-500 dark:text-amber-400")}
          aria-label={severe ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
          title={allergyTitle || (severe ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy"))}
        />
      )}
      {aiMaybe && (
        <HelpCircle
          className="w-4 h-4 text-amber-500 dark:text-amber-400"
          aria-label={aiTitle}
          title={aiTitle}
        />
      )}
      {intentLabel && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 whitespace-nowrap"
          title={intentLabel}
        >
          {intentLabel}
        </span>
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
          // When an OCCUPIED table frees — the number a host seating walk-ins
          // actually decides on. Only for seated tables (an upcoming table
          // isn't holding a seat yet); the floor tile + the "next free" readout
          // both read these. freesInMin goes negative once it runs over (the
          // visual status flips to "overdue" and shows "+Nm over" instead).
          freesAt: seated && current.ends_at ? fmtTime(current.ends_at) : null,
          freesInMin:
            seated && current.ends_at
              ? Math.round((new Date(current.ends_at).getTime() - nowMs) / 60000)
              : null,
          reservation: current,
        },
      };
    });
}

// FloorView — the Floor lens of the book. A thin adapter: it derives the
// per-table live state (deriveFloorState) and the "your next booking" accent
// id, then hands them to the premium 2D FloorPlan (the spatial room with
// draggable tables, chairs, zone bands, and edit/save). The tap + seat-now
// handlers are passed straight through so FloorPlan reuses the page's shared
// ReservationDrawer + SeatNowSheet.
function FloorView({ reservations, resources, t, businessType, onSelect, onSeatNow, onResourcesChanged }) {
  // Tick every 60s so the floor is LIVE, not a snapshot: a seated table that
  // crosses its end-time flips to "overdue" (red) on its own, and upcoming
  // ETAs ("om 25 min") count down — no manual refresh. This is the difference
  // between a pretty diagram and a tool a host trusts mid-service.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  const cells = useMemo(
    () => deriveFloorState(reservations, resources, nowMs),
    [reservations, resources, nowMs],
  );

  // "Your next booking" — the soonest still-upcoming (requested/confirmed)
  // reservation today, accented on the plan so the host's eye lands on it.
  const nextBookingId = useMemo(() => {
    const upcoming = reservations
      .filter(
        (r) =>
          ["requested", "confirmed"].includes(r.status) &&
          r.starts_at &&
          new Date(r.starts_at).getTime() >= nowMs,
      )
      .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    return upcoming.length ? upcoming[0].id : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations]);

  return (
    <FloorPlan
      cells={cells}
      nowMs={nowMs}
      t={t}
      businessType={businessType}
      onSelect={onSelect}
      onSeatNow={onSeatNow}
      nextBookingId={nextBookingId}
      onResourcesChanged={onResourcesChanged}
    />
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

// Resolve a booking's table(s) to a display label using the resource map —
// handles a single table (resource_id) and a combined seating
// (combined_resource_ids → "Bord 4 + Bord 2"). Returns null if unknown.
function resolveTableLabel(r, labelById) {
  if (!r || !labelById) return null;
  const ids =
    Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
      ? r.combined_resource_ids
      : r.resource_id
        ? [r.resource_id]
        : [];
  const labels = ids.map((id) => labelById[String(id)]).filter(Boolean);
  return labels.length ? labels.join(" + ") : null;
}

function ReservationDrawer({
  reservation,
  t,
  busy,
  onStatus,
  onClose,
  onEdit = null,
  tableLabel = null,
  tables = [],
  onAssign = null,
  assignBusy = false,
  assignError = "",
  isProvider = false,
  behandlerName = "",
  highlight = false,
  onAllergyAction = null,
  allergyActionBusy = false,
}) {
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

  // One state-matched primary action (the natural next step) carries the
  // focus; destructive / secondary actions demote to a quiet text row — no
  // more five equal-weight buttons competing for the tap.
  let primary = null;
  const secondary = [];
  if (r.status === "requested") {
    primary = { label: t("rsvpConfirmAction", "Confirm"), to: "confirmed", icon: Check };
    secondary.push({ id: "decline", label: t("rsvpDeclineAction", "Decline"), to: "cancelled" });
  } else if (r.status === "confirmed") {
    primary = { label: t("rsvpSeatAction", "Seat"), to: "seated", icon: Armchair };
    secondary.push({ id: "no_show", label: t("rsvpNoShowAction", "No-show"), to: "no_show" });
    secondary.push({ id: "cancel", label: t("rsvpCancelAction", "Cancel"), to: "cancelled" });
  } else if (r.status === "seated") {
    primary = { label: t("rsvpCompleteAction", "Complete"), to: "completed", icon: CheckCircle2 };
  }
  const PrimaryIcon = primary?.icon || null;

  return (
    // Phone: a real bottom sheet — backdrop stays visible above it, so tap-out
    // finally works one-handed (the old full-screen right panel's only dismiss
    // was a 36px X in the far corner). Desktop (≥sm): the exact right slide-in
    // panel as before, pixel-identical. Scroll lock + Esc come with the Sheet.
    <Sheet
      onClose={onClose}
      desktop="right"
      panelClassName={
        "bg-white dark:bg-gray-900 shadow-2xl border-t sm:border-t-0 sm:border-l border-gray-200 dark:border-gray-800 transition-shadow duration-700 " +
        (highlight ? "ring-2 ring-inset ring-gray-900 dark:ring-gray-100" : "")
      }
    >
        {/* Scrollable detail — the action bar below stays pinned. */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {fmtTime(r.starts_at)}–{fmtTime(r.ends_at)}
              </div>
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {r.guest_name || "—"}
              </div>
              {/* Provider (salon) → the behandling sub-line; table venues keep
                  the party-size sub-line. */}
              {isProvider ? (
                r.service_name ? (
                  <div className="text-[13px] text-gray-500 dark:text-gray-400 truncate">
                    {r.service_name}
                  </div>
                ) : null
              ) : (
                <div className="text-[13px] text-gray-500 dark:text-gray-400 tabular-nums">
                  {r.party_size + " " + t("rsvpCoversHelper", "guests")}
                </div>
              )}
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

          {/* Unconfirmed AI allergy SUGGESTION — dashed (not a solid alarm),
              additive to any confirmed block above. The owner confirms (merges
              into the real allergy) or dismisses (false positive). Honest copy:
              "possible", "we read this" — never a claimed fact. */}
          {r.ai_allergy?.has_ai_suggested_allergy && (
            <div className="rounded-lg px-3 py-2.5 text-sm border border-dashed border-amber-300 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300">
              <div className="font-semibold flex items-center gap-1.5">
                <HelpCircle className="w-4 h-4" aria-hidden />
                {t("rsvpAiAllergyTitle", "Possible allergy — please confirm")}
              </div>
              <div className="mt-0.5">
                {(r.ai_allergy.ai_tags || []).length
                  ? t("rsvpAiAllergyBody", "Read from the note: {tags}", {
                      tags: r.ai_allergy.ai_tags.map((k) => t(`allergen_${k}`, k)).join(", "),
                    })
                  : t("rsvpAiAllergyGeneric", "The note mentions an allergy, but no specific one.")}
                {r.ai_allergy.ai_severity === "severe" && (
                  <span className="ml-1 font-semibold">
                    {t("rsvpAiAllergySevereHint", "(sounds severe)")}
                  </span>
                )}
              </div>
              {onAllergyAction && (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={allergyActionBusy}
                    iconLeft={<Check className="w-4 h-4" />}
                    onClick={() => onAllergyAction("confirm")}
                  >
                    {t("rsvpAiAllergyConfirm", "Confirm allergy")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={allergyActionBusy}
                    onClick={() => onAllergyAction("dismiss")}
                  >
                    {t("rsvpAiAllergyDismiss", "Not an allergy")}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            {/* Provider (salon) → Behandling + Behandler rows; table venues
                keep the Table row. */}
            {isProvider ? (
              <>
                {r.service_name && (
                  <DetailRow label={t("rsvpColBehandling", "Behandling")} value={r.service_name} />
                )}
                <DetailRow
                  label={t("rsvpColBehandler", "Behandler")}
                  value={behandlerName || t("rsvpBookValgfriOwner", "Valgfri behandler")}
                />
              </>
            ) : (
              tableLabel && <DetailRow label={t("rsvpColTable", "Table")} value={tableLabel} />
            )}
            {r.guest_phone && (
              <DetailRow
                label={t("rsvpDetailPhone", "Phone")}
                value={
                  <a
                    href={`tel:${String(r.guest_phone).replace(/\s+/g, "")}`}
                    className="inline-flex items-center gap-1.5 text-gray-900 dark:text-gray-100 underline-offset-2 hover:underline"
                  >
                    <Phone className="w-3.5 h-3.5 text-gray-400" aria-hidden />
                    {r.guest_phone}
                  </a>
                }
              />
            )}
            {r.guest_email && (
              <DetailRow
                label={t("rsvpDetailEmail", "Email")}
                value={
                  <a
                    href={`mailto:${r.guest_email}`}
                    className="text-gray-900 dark:text-gray-100 underline-offset-2 hover:underline break-all"
                  >
                    {r.guest_email}
                  </a>
                }
              />
            )}
            {r.occasion && <DetailRow label={t("rsvpOccasion", "Occasion")} value={r.occasion} />}
          </div>

          {/* Assign / move table — for live bookings (not combined seatings,
              which span multiple tables and are managed by the engine).
              Picking a table PATCHes immediately; 409 slot_unavailable shows
              an honest inline error and leaves the booking untouched. */}
          {!isProvider &&
            onAssign &&
            tables.length > 0 &&
            ["requested", "confirmed", "seated"].includes(r.status) &&
            !(Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length > 1) && (
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t("rsvpAssignTable", "Assign table")}
                </label>
                <select
                  value={r.resource_id ? String(r.resource_id) : ""}
                  disabled={busy || assignBusy}
                  onChange={(e) => onAssign(r, e.target.value || null)}
                  aria-label={t("rsvpAssignTable", "Assign table")}
                  className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm disabled:opacity-50"
                >
                  <option value="">
                    {r.resource_id
                      ? t("rsvpNoTable", "No table")
                      : t("rsvpChooseTable", "Choose a table…")}
                  </option>
                  {tables.map((tb) => (
                    <option key={tb.id} value={String(tb.id)}>
                      {tb.label} · {tb.capacity_seats} {t("rsvpSeats", "seats")}
                    </option>
                  ))}
                </select>
                {assignError && (
                  <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">{assignError}</p>
                )}
              </div>
            )}

          {r.guest_notes && (
            <p className="text-sm text-gray-600 dark:text-gray-300">{r.guest_notes}</p>
          )}
        </div>

        {/* Pinned action bar — one primary next-step, destructive demoted to
            a quiet text row so the obvious action is unmistakable. */}
        {(primary || secondary.length > 0) && (
          <div
            className="shrink-0 border-t border-gray-200 dark:border-gray-800 p-4 space-y-3 bg-white/90 dark:bg-gray-900/90 backdrop-blur"
            style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
          >
            {primary && (
              <Button
                variant="primary"
                size="lg"
                disabled={busy}
                onClick={() => onStatus(r, primary.to)}
                className="w-full justify-center gap-2"
              >
                {PrimaryIcon && <PrimaryIcon className="w-4 h-4" aria-hidden />}
                {primary.label}
              </Button>
            )}
            {(secondary.length > 0 || (onEdit && (r.status === "requested" || r.status === "confirmed"))) && (
              <div className="flex items-center justify-center gap-3">
                {onEdit && (r.status === "requested" || r.status === "confirmed") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onEdit(r)}
                    className="text-sm font-medium px-2 py-1.5 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors disabled:opacity-50"
                  >
                    {t("rsvpEditAction", "Edit")}
                  </button>
                )}
                {secondary.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onStatus(r, a.to)}
                    className="text-sm font-medium px-2 py-1.5 rounded-md text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
    </Sheet>
  );
}

// ─── Seat-now (mark a free table occupied with a walk-in) ─────────────
// Two launch paths, same sheet:
//   • Tile-launched — `table` is the tapped resource object (preset table,
//     no picker). Byte-identical to the original behaviour.
//   • Header-launched — `table === SEAT_WALK_IN_PICK`; the host PICKS a table
//     from `tables` (the live free/busy list). Defaults to the first free
//     table; busy tables are annotated + disabled. On submit both paths call
//     the same `onSeat({ resource_id, party_size, guest_name })`.
function SeatNowSheet({ table, tables = [], t, busy, onSeat, onClose }) {
  const pickMode = table === SEAT_WALK_IN_PICK;
  // First currently-free table is the sensible default pick.
  const firstFreeId = useMemo(() => {
    const free = tables.find((tb) => !tb.busy);
    return free ? String(free.id) : "";
  }, [tables]);
  const [pickedId, setPickedId] = useState(firstFreeId);
  // Keep the default pick fresh if the free set changes while the sheet is open
  // (a table clears / fills on the 60s tick) and nothing valid is chosen yet.
  useEffect(() => {
    if (pickMode && !pickedId && firstFreeId) setPickedId(firstFreeId);
  }, [pickMode, pickedId, firstFreeId]);
  const chosenTable = pickMode
    ? tables.find((tb) => String(tb.id) === String(pickedId)) || null
    : table;
  const [party, setParty] = useState(String(table?.capacity_seats || 2));
  const [name, setName] = useState("");
  // Keep party sensible for the picked table's capacity default.
  useEffect(() => {
    if (pickMode && chosenTable) setParty(String(chosenTable.capacity_seats || 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId]);
  if (!table) return null;
  const sizes = [1, 2, 3, 4, 5, 6, 8];
  const canSeat = pickMode ? !!chosenTable && !chosenTable.busy : true;
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      <div
        className="relative w-full sm:max-w-sm bg-white dark:bg-gray-900 rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-gray-800 shadow-2xl p-5 space-y-4 animate-fadeIn"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("rsvpSeatNowTitle", "Seat guests")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {chosenTable
                ? chosenTable.label +
                  " · " +
                  chosenTable.capacity_seats +
                  " " +
                  t("rsvpCoversHelper", "guests")
                : t("rsvpSeatWalkIn", "Seat walk-in")}
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
        {/* Table picker — header-launched walk-in only. Free tables first;
            busy ones stay selectable-looking but are labelled + disabled so
            the host can't seat onto an occupied table. */}
        {pickMode && (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpSeatWalkInTable", "Table")}
            </label>
            <select
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value)}
              aria-label={t("rsvpSeatWalkInTable", "Table")}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
            >
              {tables.length === 0 && (
                <option value="">{t("rsvpSeatWalkInNoTables", "No tables")}</option>
              )}
              {tables.map((tb) => (
                <option key={tb.id} value={String(tb.id)} disabled={tb.busy}>
                  {tb.label}
                  {tb.capacity_seats ? ` · ${tb.capacity_seats}` : ""}
                  {tb.busy ? ` — ${t("rsvpSeatWalkInBusy", "occupied")}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
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
          disabled={!canSeat}
          className="w-full justify-center"
          onClick={() => {
            if (!canSeat || !chosenTable) return;
            onSeat({
              resource_id: chosenTable.id,
              party_size: Math.max(1, Math.min(100, parseInt(party, 10) || 2)),
              guest_name: name.trim() || t("rsvpWalkIn", "Walk-in"),
            });
          }}
        >
          {t("rsvpSeatNowBtn", "Seat now")}
        </Button>
      </div>
    </div>
  );
}

// ─── New booking (owner takes a phone booking for a future slot) ──────
// 15-minute slot options for the time select, 06:00–23:45 — the full business
// day (06:00 is the app-wide business-day cutoff). The old 12:00 floor made
// half a salon/bakery morning unbookable from the owner's own sheet ("book me
// for 09:15" was literally impossible). 15-min granularity matches the public
// widget without pretending to be the availability engine (the backend's
// auto-assign stays the source of truth on submit).
const QUARTER_TIMES = (() => {
  const out = [];
  const pad = (n) => String(n).padStart(2, "0");
  for (let m = 6 * 60; m <= 23 * 60 + 45; m += 15) {
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  }
  return out;
})();

// Default time for a new booking. For a future day it's the evening service
// start (18:00). For TODAY it's the next quarter-hour from NOW (clamped to
// 23:45) — a walk-up/soon booking is almost always for later today, so the
// host shouldn't have to scroll back from 18:00 at lunch.
function defaultBookingTime(forDay) {
  let m = 18 * 60;
  if (forDay === isoDay(new Date())) {
    const now = new Date();
    m = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  }
  // Clamp into the QUARTER_TIMES range (06:00–23:45) so the default always
  // maps to a real <option>. Future days keep the 18:00 evening default
  // (restaurants' expectation); today's floor is simply the first real slot.
  if (m < 6 * 60) m = 6 * 60;
  if (m > 23 * 60 + 45) m = 23 * 60 + 45;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// NewBookingSheet — the host takes a future (phone) booking: date, time,
// party, name, optional phone. Submits through the page-level handler so
// the 409 room_full warning ("honest pushback") can keep the sheet open
// and offer "book anyway (no table)" vs "pick another time".
// ─── Edit booking — "move us to 20:00 / we're 6 not 4" without the dishonest
// cancel-and-recreate (which falsely notified the guest "aflyst"). PATCHes the
// booking through the same occupancy machinery; a taken slot is an honest 409.
function EditBookingSheet({ reservation, t, busy, error, onSubmit, onClose }) {
  const r = reservation;
  const [date, setDate] = useState(r.starts_at ? r.starts_at.slice(0, 10) : "");
  const [time, setTime] = useState(r.starts_at ? r.starts_at.slice(11, 16) : "18:00");
  const [party, setParty] = useState(String(r.party_size || 2));
  const [name, setName] = useState(r.guest_name || "");
  const [phone, setPhone] = useState(r.guest_phone || "");
  const sizes = [1, 2, 3, 4, 5, 6, 8];
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      <div
        className="relative w-full sm:max-w-sm bg-white dark:bg-gray-900 rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-gray-800 shadow-2xl p-5 space-y-4 animate-fadeIn max-h-[90vh] overflow-y-auto"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("rsvpEditTitle", "Edit booking")}
          </h3>
          <button type="button" onClick={onClose} aria-label={t("close", "Close")}
            className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("rsvpEditDate", "Date")}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("rsvpEditTime", "Time")}</label>
            <select value={time} onChange={(e) => setTime(e.target.value)}
              className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100 tabular-nums">
              {QUARTER_TIMES.map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("rsvpColParty", "Party")}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {sizes.map((n) => (
              <button key={n} type="button" onClick={() => setParty(String(n))}
                className={"h-11 min-w-[44px] px-3 rounded-lg border text-sm font-medium tabular-nums " +
                  (String(n) === party
                    ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                    : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600")}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("rsvpNbGuestName", "Guest name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100" />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("rsvpEditPhone", "Phone")}</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
            className="mt-1.5 w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm text-gray-900 dark:text-gray-100" />
        </div>
        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-3 py-2 rounded-lg text-sm">{error}</div>
        )}
        <Button variant="primary" size="lg" busy={busy} className="w-full justify-center"
          onClick={() => onSubmit({
            starts_at: `${date}T${time}:00`,
            party_size: Math.max(1, Math.min(100, parseInt(party, 10) || r.party_size)),
            guest_name: name.trim() || null,
            guest_phone: phone.trim() || null,
          })}>
          {t("rsvpEditSave", "Save changes")}
        </Button>
      </div>
    </div>
  );
}

function NewBookingSheet({
  day,
  t,
  busy,
  warning,
  onClearWarning,
  error,
  onSubmit,
  onClose,
  isProvider = false,
  behandlinger = [],
  providerStations = [],
  tables = [],
}) {
  const [date, setDate] = useState(day);
  const [time, setTime] = useState(() => defaultBookingTime(day));
  const [party, setParty] = useState("2");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  // Optional table pin (TABLE venues). "" = auto-assign (backend picks a table
  // via the availability engine). A chosen id is posted as resource_id; if it's
  // taken the backend returns a clean 409 and we surface it honestly.
  const [resourceId, setResourceId] = useState("");
  const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // Provider (salon) selections. behandlingId is required; stylistId "" =
  // Valgfri behandler (no pinned behandler).
  const [behandlingId, setBehandlingId] = useState(() =>
    behandlinger.length === 1 ? String(behandlinger[0].id) : "",
  );
  const [stylistId, setStylistId] = useState("");
  const [behandlingMissing, setBehandlingMissing] = useState(false);

  const submit = (allowOverflow) => {
    const guest_name = name.trim();
    if (!guest_name) {
      setNameMissing(true);
      return;
    }
    if (isProvider) {
      if (!behandlingId) {
        setBehandlingMissing(true);
        return;
      }
      onSubmit({
        guest_name,
        guest_phone: phone.trim() || null,
        date,
        time,
        behandling_id: behandlingId,
        stylist_resource_id: stylistId || null,
      });
      return;
    }
    onSubmit(
      {
        guest_name,
        guest_phone: phone.trim() || null,
        party_size: Math.max(1, Math.min(100, parseInt(party, 10) || 2)),
        date,
        time,
        // "" = auto-assign; a chosen id pins that specific table.
        resource_id: resourceId || null,
      },
      allowOverflow,
    );
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      <div
        className="relative w-full sm:max-w-sm bg-white dark:bg-gray-900 rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-gray-800 shadow-2xl p-5 space-y-4 animate-fadeIn max-h-[90vh] overflow-y-auto"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {isProvider
              ? t("rsvpNewBookingProvider", "Book en tid")
              : t("rsvpNewBooking", "New booking")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Provider (salon) tidsbestilling — behandling → behandler, ahead of
            dato → tid. No behandlinger yet → an honest guide to add them
            first; the Create button is disabled below until one is added. */}
        {isProvider && behandlinger.length === 0 && (
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300">
            {t(
              "rsvpBookNoBehandlinger",
              "Add a behandling first (Behandlinger tab) to take a tidsbestilling.",
            )}
          </div>
        )}
        {isProvider && behandlinger.length > 0 && (
          <>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpBookBehandlingLabel", "Behandling")}
              </label>
              <select
                value={behandlingId}
                onChange={(e) => {
                  setBehandlingId(e.target.value);
                  if (e.target.value) setBehandlingMissing(false);
                }}
                aria-label={t("rsvpPublicPickBehandling", "Vælg behandling")}
                className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
              >
                <option value="">{t("rsvpPublicPickBehandling", "Vælg behandling")}</option>
                {behandlinger.map((b) => {
                  const mins = t("rsvpBehandlingMinutes", "{n} min", { n: b.duration_min });
                  const price = b.price_kr != null ? ` · ${b.price_kr} kr.` : "";
                  return (
                    <option key={b.id} value={String(b.id)}>
                      {b.name} · {mins}
                      {price}
                    </option>
                  );
                })}
              </select>
              {behandlingMissing && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                  {t("rsvpBookBehandlingRequired", "Choose a behandling.")}
                </p>
              )}
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpBookBehandlerLabel", "Behandler")}
              </label>
              <select
                value={stylistId}
                onChange={(e) => setStylistId(e.target.value)}
                aria-label={t("rsvpPublicPickBehandler", "Vælg behandler")}
                className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
              >
                {/* Default = Valgfri behandler (no pinned behandler). */}
                <option value="">{t("rsvpBookValgfriOwner", "Valgfri behandler")}</option>
                {providerStations.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.staff_name || s.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpDateLabel", "Date")}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
                if (warning) onClearWarning();
              }}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpTimeLabel", "Time")}
            </label>
            <select
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (warning) onClearWarning();
              }}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
            >
              {QUARTER_TIMES.map((tm) => (
                <option key={tm} value={tm}>
                  {tm}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Party size — TABLE venues only. A provider tidsbestilling is one
            customer; the behandling sets the booking length, not party size. */}
        {!isProvider && (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpPartySize", "Party size")}
            </label>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {sizes.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setParty(String(n));
                    if (warning) onClearWarning();
                  }}
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
        )}

        {/* Optional table — TABLE venues only. Blank = auto-assign (the engine
            picks). Pinning a table posts resource_id; a taken table returns a
            clean 409 the page surfaces as honest room-full pushback. */}
        {!isProvider && tables.length > 0 && (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpBookingTableOptional", "Table (optional — auto if blank)")}
            </label>
            <select
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                if (warning) onClearWarning();
              }}
              aria-label={t("rsvpBookingTableOptional", "Table (optional — auto if blank)")}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
            >
              <option value="">{t("rsvpBookingTableAuto", "Auto")}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={String(tb.id)}>
                  {tb.label}
                  {tb.capacity_seats ? ` · ${tb.capacity_seats}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpNbGuestName", "Guest name")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameMissing && e.target.value.trim()) setNameMissing(false);
            }}
            maxLength={160}
            placeholder={t("rsvpNamePh", "Anna Hansen")}
            className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
          />
          {nameMissing && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">
              {t("rsvpNameRequired", "Enter your name.")}
            </p>
          )}
        </div>

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpPhone", "Phone (optional)")}
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            placeholder={t("rsvpPhonePh", "+45 12 34 56 78")}
            className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
          />
        </div>

        {/* Honest room-full pushback — the room can't seat this party at that
            time. The host decides: take it anyway (waitlist-style, no table)
            or pick another time. */}
        {warning && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300 space-y-2.5">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {warning.seats != null
                ? t("rsvpRoomFullWarn", "That time is full — {n} seats.", { n: warning.seats })
                : t("rsvpRoomFullShort", "That time is full.")}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={() => submit(true)}>
                {t("rsvpBookAnyway", "Book anyway (no table)")}
              </Button>
              <Button variant="ghost" size="md" disabled={busy} onClick={onClearWarning}>
                {t("rsvpPickAnotherTime", "Pick another time")}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <Button
          variant="primary"
          size="lg"
          busy={busy}
          disabled={isProvider && behandlinger.length === 0}
          className="w-full justify-center"
          onClick={() => submit(false)}
        >
          {t("rsvpCreateBooking", "Create booking")}
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

// Allergy signal for a reservation: "severe" | "other" | null. Severity
// drives color everywhere a booking renders (red = severe, amber = any
// other recorded allergy/intolerance) — staff must never have to open a
// booking to learn it carries an allergy.
function allergyLevel(r) {
  const has =
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity;
  if (!has) return null;
  return r.allergy_severity === "severe" ? "severe" : "other";
}

// Hover tooltip for a timeline block — includes the allergy detail so the
// host can read tags/notes without opening the drawer.
function blockTitle(r, labels, t) {
  const base = `${fmtTime(r.starts_at)} ${r.guest_name || ""} (${r.party_size}) · ${labels[r.status] || r.status}`;
  if (!allergyLevel(r)) return base;
  const detail = [
    (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
    r.allergy_note,
  ]
    .filter(Boolean)
    .join(" · ");
  const label =
    r.allergy_severity === "severe"
      ? t("rsvpAllergySevere", "Severe allergy")
      : t("rsvpAllergyFlag", "Allergy");
  return `${base}\n⚠ ${label}${detail ? ": " + detail : ""}`;
}

function TimelineView({ reservations, resources, day, t, onSelect, onStatus }) {
  // One-tap seat from a booking bar. `justSeatedId` drives THE single ceremonial
  // beat (the ~500ms scale settle below); it self-clears so the bar returns to
  // stillness and never re-fires on a later render. The colour flip to the
  // inverted seated fill is the same optimistic status update the drawer uses.
  const [justSeatedId, setJustSeatedId] = useState(null);
  const seatFromBar = useCallback(
    (r) => {
      setJustSeatedId(r.id);
      onStatus?.(r, "seated");
      window.setTimeout(
        () => setJustSeatedId((id) => (id === r.id ? null : id)),
        550,
      );
    },
    [onStatus],
  );
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

  // Bookings with NO table yet (requested/confirmed) — without this lane
  // they'd be invisible on the timeline, which is how overbookings hide.
  // Greedy interval-packing into sub-lanes so overlapping blocks never
  // cover each other.
  const unassigned = useMemo(() => {
    const blocks = holding
      .filter(
        (r) =>
          !r.resource_id &&
          !(Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length) &&
          ["requested", "confirmed"].includes(r.status) &&
          r.starts_at,
      )
      .map((r) => {
        let s = minOfDay(r.starts_at);
        let e = r.ends_at ? minOfDay(r.ends_at) : s + 90;
        if (e <= s) e += 1440;
        return { r, s, e, lane: 0 };
      })
      .sort((a, b) => a.s - b.s || a.e - b.e);
    const laneEnds = [];
    blocks.forEach((b) => {
      let li = laneEnds.findIndex((end) => end <= b.s);
      if (li === -1) {
        laneEnds.push(b.e);
        li = laneEnds.length - 1;
      } else {
        laneEnds[li] = b.e;
      }
      b.lane = li;
    });
    return { blocks, laneCount: Math.max(1, laneEnds.length) };
  }, [holding]);

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

  // Live "now" playhead tick. A 30s cadence advances nowX by 0.6px (PX × 0.5min)
  // — visibly creeps once the CSS glide smooths it — without a 60fps loop that
  // would drain an always-on host-stand tablet. Today-only (a past/future plan
  // has no live line, so don't schedule a needless timer); re-syncs the instant
  // the screen wakes / tab refocuses. Hooks live AFTER todayIso so the
  // [day, todayIso] dep array never reads a TDZ const (the Layout regression
  // lesson) and stay before the tables.length early return below.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (day !== todayIso) return undefined;
    const sync = () => setNowTick(Date.now());
    const id = setInterval(sync, 30000);
    const onVis = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [day, todayIso]);

  const nowD = new Date(nowTick);
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
      {/* THE ONE ceremonial beat for seating — a single ~500ms scale settle,
          then stillness. The global prefers-reduced-motion rule (index.css)
          already collapses this animation to ~0.01ms, so no local guard. */}
      <style>{`@keyframes bbSeatSettle{from{transform:scale(1.015)}to{transform:scale(1)}}.bb-seat-settle{animation:bbSeatSettle 500ms cubic-bezier(0.22,1,0.36,1)}`}</style>
      <div className="relative" style={{ minWidth: RAIL_W + bodyW }}>
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
            {/* The "now" indicator is now ONE continuous .bb-playhead overlay,
                mounted once at the bottom of the grid (a 7px dot rides here in
                the axis). No per-row pill/line — see the overlay below. */}
          </div>
        </div>

        {/* Unassigned lane — bookings still without a table, ABOVE the room
            so the host can't miss them. Amber = needs attention. Click a
            block → same detail drawer (where the Assign-table control is). */}
        {unassigned.blocks.length > 0 && (
          <div
            className="flex border-b border-gray-200 dark:border-gray-800"
            style={{ height: unassigned.laneCount * 44 }}
          >
            <div
              style={{ width: RAIL_W }}
              className="shrink-0 sticky left-0 z-10 bg-amber-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 px-2 flex flex-col justify-center"
            >
              <span className="text-sm font-semibold text-amber-700 dark:text-amber-400 truncate leading-tight">
                {t("rsvpUnassignedLane", "Unassigned")}
              </span>
              <span className="text-[10px] text-amber-600/80 dark:text-amber-500/80 tabular-nums">
                {unassigned.blocks.length}
              </span>
            </div>
            <div style={{ width: bodyW }} className="relative bg-amber-50/40 dark:bg-amber-900/10">
              {hours.map((m) => (
                <span
                  key={m}
                  style={{ left: (m - startMin) * PX }}
                  className="absolute top-0 bottom-0 border-l border-gray-100 dark:border-gray-800"
                  aria-hidden
                />
              ))}
              {/* per-row now-line removed → single .bb-playhead overlay below */}
              {unassigned.blocks.map(({ r, s, e, lane }) => {
                const left = Math.max(0, (s - startMin) * PX);
                const width = Math.max(30, (Math.min(e, endMin) - Math.max(s, startMin)) * PX - 2);
                const allergy = allergyLevel(r);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onSelect(r)}
                    title={blockTitle(r, labels, t)}
                    style={{ left, width, top: lane * 44 + 5, height: 34 }}
                    className={
                      "absolute rounded-md border border-dashed border-amber-500 dark:border-amber-500 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 px-1.5 overflow-hidden text-left flex flex-col justify-center" +
                      (allergy === "severe" ? " ring-2 ring-inset ring-red-500 dark:ring-red-400" : "")
                    }
                  >
                    <span className="text-[11px] font-semibold leading-none truncate">
                      {fmtTime(r.starts_at)} · {r.party_size}
                    </span>
                    <span className="text-[10px] leading-tight truncate opacity-90 mt-0.5 flex items-center gap-0.5">
                      {allergy && (
                        <AlertTriangle
                          className={"w-3 h-3 shrink-0 " + (allergy === "severe" ? "text-red-500" : "text-amber-600 dark:text-amber-400")}
                          aria-hidden
                        />
                      )}
                      {r.guest_name || t("rsvpGuest", "Guest")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
                {/* per-row now-line removed → single .bb-playhead overlay below */}
                {blocks.map((r) => {
                  let s = minOfDay(r.starts_at);
                  let e = minOfDay(r.ends_at);
                  if (e <= s) e += 1440;
                  const left = Math.max(0, (s - startMin) * PX);
                  const width = Math.max(30, (Math.min(e, endMin) - Math.max(s, startMin)) * PX - 2);
                  const combined = (r.combined_resource_ids || []).length > 1;
                  const allergy = allergyLevel(r);
                  // One-tap seat: only a CONFIRMED bar (a 'requested' booking is
                  // acknowledged via the drawer's Confirm first — mirrors the
                  // drawer state machine), and only when the bar is wide enough
                  // that the 44px seat control still leaves ≥44px of body tap zone
                  // for the drawer (88 − 44 = 44). Narrow bars keep drawer-only
                  // seating — a graceful fallback, never a hidden dead-end.
                  const showSeat =
                    !!onStatus &&
                    r.status === "confirmed" &&
                    width >= 88;
                  return (
                    <Fragment key={r.id + id}>
                    <button
                      type="button"
                      onClick={() => onSelect(r)}
                      title={blockTitle(r, labels, t)}
                      style={{ left, width, top: 5, height: ROW_H - 12 }}
                      className={
                        "absolute rounded-md border px-1.5 overflow-hidden text-left flex flex-col justify-center transition-colors duration-500 " +
                        blockClass(r.status) +
                        (justSeatedId === r.id ? " bb-seat-settle" : "") +
                        (allergy === "severe"
                          ? " ring-2 ring-inset ring-red-500 dark:ring-red-400"
                          : allergy
                            ? " ring-2 ring-inset ring-amber-400 dark:ring-amber-500"
                            : "")
                      }
                    >
                      <span className="text-[11px] font-semibold leading-none truncate flex items-center gap-0.5">
                        {fmtTime(r.starts_at)} · {r.party_size}
                        {combined && <Link2 className="w-3 h-3 shrink-0" aria-hidden />}
                      </span>
                      <span className="text-[10px] leading-tight truncate opacity-90 flex items-center gap-0.5 mt-0.5">
                        {allergy && (
                          <AlertTriangle
                            className={"w-3 h-3 shrink-0 " + (allergy === "severe" ? "text-red-500" : "text-amber-600 dark:text-amber-400")}
                            aria-hidden
                          />
                        )}
                        {r.guest_name || t("rsvpGuest", "Guest")}
                      </span>
                    </button>
                    {showSeat && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          seatFromBar(r);
                        }}
                        title={t("rsvpSeatAction", "Seat")}
                        aria-label={t("rsvpSeatNowAria", "Seat {name}", {
                          name: r.guest_name || t("rsvpGuest", "Guest"),
                        })}
                        style={{ left: left + width - 44, width: 44, top: (ROW_H - 44) / 2, height: 44 }}
                        className="absolute z-10 flex items-center justify-center rounded-r-md text-gray-500 hover:text-gray-900 hover:bg-gray-900/5 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-white/10 transition-colors"
                      >
                        <Armchair className="w-4 h-4 shrink-0" aria-hidden />
                      </button>
                    )}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Live "now" playhead — ONE continuous element over the whole grid so
            it's seamless top-to-bottom (no per-row seams). GPU-composited via
            translateX; glides on the 30s tick (.bb-playhead transition). Sits
            above blocks (z-5) but below the sticky rail/axis (z-20), which mask
            it where it scrolls under the 116px name column. pointer-events-none
            so it never steals a tap from the booking happening right now. Keyed
            on the time window so a bounds recompute remounts (no streak across
            the grid) and re-plays the single arrival beat. */}
        {nowX != null && (
          <div
            key={`ph-${startMin}-${endMin}`}
            aria-hidden="true"
            className="bb-playhead absolute top-0 bottom-0 z-[5] pointer-events-none"
            style={{
              left: 0,
              transform: `translateX(${RAIL_W + nowX}px)`,
              width: 0,
              willChange: "transform",
            }}
          >
            <div
              className="bb-playhead-line absolute top-8 bottom-0 bg-gray-900 dark:bg-gray-100"
              style={{ left: -0.75, width: 1.5 }}
            />
            <div
              className="bb-playhead-dot absolute top-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-900 dark:bg-gray-100"
              style={{ width: 7, height: 7 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Loading skeletons — calm pulsing placeholders shaped like each view, so the
// layout holds its frame while data lands (premium beats a bare "Loading…").
function FloorSkeleton() {
  const tables = [64, 64, 84, 64, 104, 84, 64];
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-950 p-6 min-h-[300px]">
      <div className="flex flex-wrap gap-x-12 gap-y-10 animate-pulse">
        {tables.map((s, i) => (
          <div
            key={i}
            className="rounded-full bg-gray-200/80 dark:bg-gray-800"
            style={{ width: s, height: s }}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
      <div className="h-8 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/80" />
      <div className="p-3 space-y-3 animate-pulse">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-9 w-20 shrink-0 rounded bg-gray-100 dark:bg-gray-800" />
            <div
              className="h-9 rounded bg-gray-100 dark:bg-gray-800"
              style={{ width: `${35 + ((i * 17) % 55)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Salon first-run card — shown in the Book tab when a provider (salon) venue
// has no bookable station (self-chair) yet. The owner confirms the hours they
// open (seeded salon-flavored, editable) and ONE tap seeds the self-chair,
// persists the hours, and enables reservations via
// POST /reservations/salon/quick-setup. Presentational: the parent owns the
// hours state, the busy/error flags, and the write. It NEVER writes on render.
function SalonFirstRunCard({
  t,
  hours,
  setHourDay,
  applyMonToAll,
  behandlingerCount,
  busy,
  error,
  onOpen,
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 space-y-5 max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-xl bg-gray-900 text-white dark:bg-white dark:text-gray-900">
          <CalendarCheck className="w-5 h-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("rsvpSalonFirstRunTitle", "Take your first booking")}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t(
              "rsvpSalonFirstRunBody",
              "Confirm the hours you're open and guests can book you online.",
            )}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          <Clock className="w-3.5 h-3.5" aria-hidden />
          {t("rsvpSalonHoursSuggestion", "Suggested — change if it doesn't fit")}
        </div>
        <WeekHoursEditor
          t={t}
          hours={hours}
          setHourDay={setHourDay}
          onApplyMonToAll={applyMonToAll}
        />
      </div>

      {/* Soft, non-blocking nudge — the owner can open for booking now; a
          behandling just makes the guest's pick richer. */}
      {behandlingerCount === 0 && (
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300 flex items-start gap-2">
          <Scissors className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" aria-hidden />
          <span>
            {t(
              "rsvpSalonAddBehandlingNudge",
              "Add a behandling so guests can pick a service.",
            )}
          </span>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <Button
        variant="primary"
        size="lg"
        busy={busy}
        iconLeft={<Check className="w-4 h-4" />}
        className="w-full sm:w-auto justify-center"
        onClick={onOpen}
      >
        {busy
          ? t("rsvpSalonOpeningForBooking", "Opening…")
          : t("rsvpSalonOpenForBooking", "Open for booking")}
      </Button>
    </div>
  );
}

/* ─── DayRail — the desktop day rail (≥1280px only) ────────────────────
   The single-day book can't answer "how's Saturday looking", and on a wide
   screen the page was leaving ~400px of dead pixels (it was capped at
   max-w-5xl). This fills that space with the two questions an owner actually
   has: WHICH DAY, and AM I COVERED.

   The second half is the part a booking tool can't do. BonBox holds the
   roster as well as the book, so the rail can say "48 covers · 3 on shift"
   and flag the mismatch. DinnerBooking knows the covers; Planday knows the
   roster; only this knows both.

   Density comes from the page's EXISTING type scale (10/11/12/13px — no new
   sizes), tabular numerals so the counts line up in a column, and tight
   leading so a whole month plus a per-day count fits in 300px. Days with
   nothing booked render blank, not "0" — 31 zeros is noise.

   Colour stays meaningful: gray-900 for the selected day, amber ONLY where
   covers outrun the roster. No heatmap — a rainbow month would look like a
   dashboard and say less than one amber Saturday does. */
function DayRail({ day, onPick, t, waitlistCount = 0, onOpenWaitlist }) {
  const { lang } = useLanguage();
  const [month, setMonth] = useState(() => (day || isoDay(new Date())).slice(0, 7));
  const [load, setLoad] = useState({});
  const [loading, setLoading] = useState(true);

  // Follow the book when the owner jumps to a date in another month (arrows,
  // date picker, deep link) so the rail never shows a different month than
  // the day that's open.
  useEffect(() => {
    if (day && day.slice(0, 7) !== month) setMonth(day.slice(0, 7));
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .get("/reservations/month-load", { params: { month } })
      .then((res) => {
        if (!alive) return;
        const map = {};
        (res.data?.days || []).forEach((d) => { map[d.date] = d; });
        setLoad(map);
      })
      .catch(() => { if (alive) setLoad({}); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month]);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  // Monday-first, matching the Danish week (getDay() is Sunday-first).
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m, 0).getDate();
  // The APP's language, not the browser's — a Danish owner on an English-locale
  // laptop must still read "juli 2026". Same convention the date stepper uses.
  const monthLabel = first.toLocaleDateString(lang, { month: "long", year: "numeric" });

  const shiftMonth = (delta) => {
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const sel = load[day] || null;
  // "Heavy" = more covers than the roster can plausibly carry. 12 covers per
  // person on shift is a deliberately forgiving rule of thumb — it should fire
  // on the obvious Saturday, not nag on an ordinary Tuesday. Never fires when
  // no roster exists (nothing to compare against ⇒ no honest claim to make).
  const isHeavy = (d) => d && d.staff_on > 0 && d.covers > d.staff_on * 12;

  return (
    <aside
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 tabular-nums"
      aria-label={t("rsvpRailAria", "Day overview")}
    >
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[11px] uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">
          {monthLabel}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label={t("rsvpRailPrevMonth", "Previous month")}
            className="w-6 h-6 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label={t("rsvpRailNextMonth", "Next month")}
            className="w-6 h-6 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-[10px] text-gray-400 dark:text-gray-500 text-center mb-1">
        {(t("rsvpRailWeekdays", "M,T,O,T,F,L,S") || "M,T,O,T,F,L,S")
          .split(",")
          .map((w, i) => <div key={i}>{w}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center">
        {Array.from({ length: lead }).map((_, i) => <div key={`p${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const dnum = i + 1;
          const iso = `${month}-${String(dnum).padStart(2, "0")}`;
          const info = load[iso];
          const selected = iso === day;
          const heavy = isHeavy(info);
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              aria-label={`${iso}${info?.covers ? ` — ${info.covers}` : ""}`}
              aria-current={selected ? "date" : undefined}
              className={
                "rounded-md py-1 leading-[1.1] transition-colors " +
                (selected
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : heavy
                    ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800")
              }
            >
              <span className="block text-[11px]">{dnum}</span>
              <span
                className={
                  "block text-[10px] " +
                  (selected
                    ? "text-white/70 dark:text-gray-900/70"
                    : heavy
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-gray-400 dark:text-gray-500")
                }
              >
                {info?.covers ? info.covers : " "}
              </span>
            </button>
          );
        })}
      </div>

      {/* Selected day — covers vs roster, the answer the book alone can't give */}
      <div className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100 truncate">
            {relativeDayLabel(day, t, lang)}
          </span>
          <span className="text-[13px] text-gray-900 dark:text-gray-100">
            {loading ? "" : sel?.covers || 0}
          </span>
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
          {t("rsvpRailDayLine", "{covers} guests · {staff} on shift", {
            covers: sel?.covers || 0,
            staff: sel?.staff_on || 0,
          })}
        </p>
        {isHeavy(sel) && (
          <div className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1.5 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-px" aria-hidden />
            <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
              {t("rsvpRailHeavy", "Busy day for this roster — check staffing.")}
            </p>
          </div>
        )}
      </div>

      {/* Venteliste lives here on desktop: you act on it DURING service, while
          looking at the book — not from the bottom of the page. */}
      {waitlistCount > 0 && (
        <button
          type="button"
          onClick={onOpenWaitlist}
          className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800 w-full text-left group"
        >
          <span className="text-[11px] uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">
            {t("rsvpWaitlistTitle", "Venteliste")} · {waitlistCount}
          </span>
          <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 group-hover:text-gray-900 dark:group-hover:text-gray-100">
            {t("rsvpRailWaitlistJump", "Show the waiting parties")}
          </span>
        </button>
      )}
    </aside>
  );
}

// `day`/`onDayChange` are OPTIONAL — pass them and the book becomes a
// controlled component so the desktop DayRail beside it can drive the date;
// omit them (host-stand pop-out, tests) and it keeps its own state exactly as
// before. Every internal setDay call passes a plain value, never a functional
// updater, so the alias below is a faithful swap.
function BookSection({ t, businessType, tableFloor = false, day: dayProp, onDayChange }) {
  const { lang } = useLanguage();
  const confirm = useConfirm();
  // Host-stand pop-out chrome lives in THIS component's return (the top bar +
  // full-screen wrapper), so it needs its own auth/router bindings — they are
  // NOT threaded down as props. `standalone` is derived from the path exactly
  // as the parent does. (Without these three, the Book tab threw
  // "ReferenceError: standalone is not defined" and crashed the whole page.)
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const standalone = location.pathname.endsWith("/reservations/stand");
  // TABLE venues (dining/bar) get the Floor ("plan") lens; provider (salon) /
  // no-floor (bakery/retail) venues never do — gated on the venue TYPE, with a
  // grandfather for venues that already have a real table plan. `tableFloor`
  // is computed once by the parent (type OR has-tables) and passed down.
  // Provider (salon) venues take a real tidsbestilling (behandling → behandler
  // → dato → tid) instead of a table booking — an ADDITIVE branch; the table
  // flow is left byte-identical.
  const isProvider = bookingModeFor(businessType) === "provider";
  const [dayLocal, setDayLocal] = useState(() => isoDay(new Date()));
  const day = dayProp ?? dayLocal;
  const setDay = onDayChange ?? setDayLocal;
  // Live minute tick so a confirmed booking that's past its time surfaces as
  // "forsinket" (late) in the list as service runs — the Floor/Timeline had a
  // now-line, the list (the screen owners stare at) didn't. Cheap 60s re-render.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  // Venteliste (waitlist) — active count for the cockpit + the parties the
  // backend surfaces when a booking is cancelled/no-showed (a table just freed).
  const [waitlistCount, setWaitlistCount] = useState(0);
  const [spotMatches, setSpotMatches] = useState([]);
  // Bumped on every successful book refetch → tells WaitlistSection to resync
  // so the Venteliste is "spot on" the instant a booking changes (status flip,
  // table move/clear, new booking, walk-in), not just on a day change.
  const [bookTick, setBookTick] = useState(0);
  const [view, setView] = useState(() => {
    try {
      const saved = localStorage.getItem(RSVP_VIEW_KEY) || "liste";
      // A non-table venue can't show the plan lens — a stale "plan" preference
      // falls back to the list, never a dead Floor view.
      return saved === "plan" && !tableFloor ? "liste" : saved;
    } catch {
      return "liste";
    }
  });
  const [data, setData] = useState(null);
  const [resources, setResources] = useState([]);
  // Tracks the first resources fetch so the salon first-run card only shows
  // once we KNOW there are no stations (never flashes for an established salon
  // while resources are still in flight).
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  // The canonical venue seat capacity from GET /resources — active, non-deleted,
  // non-provider tables only, the SAME number the booking engine allows against.
  // The occupancy gauge divides by THIS (not a raw resources.reduce, which wrongly
  // counted inactive/provider rows). Null until the first fetch → the gauge falls
  // back to the reduce so an older API without the field never breaks.
  const [venueSeats, setVenueSeats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actioningId, setActioningId] = useState(null);
  // Filters (Liste view).
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [zoneFilter, setZoneFilter] = useState("all");
  // "Note type" filter — organise the book by the rule-based note intent
  // (accessibility / birthday / …). A FILTER only; the list stays time-ordered.
  const [noteTypeFilter, setNoteTypeFilter] = useState("all");
  // Busy flag for the AI-allergy confirm/dismiss action in the drawer.
  const [allergyBusy, setAllergyBusy] = useState(false);
  // The reservation open in the detail drawer (from a Liste row, a Plan
  // tile, or a timeline block). null = drawer closed.
  const [selected, setSelected] = useState(null);
  // Seat-now: the free table the host is seating a walk-in onto.
  const [seatTarget, setSeatTarget] = useState(null);
  const [seating, setSeating] = useState(false);
  // New booking (owner takes a phone booking for a future slot).
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [roomFull, setRoomFull] = useState(null); // {seats} on 409 room_full
  const [createError, setCreateError] = useState("");
  // Assign/move table from the detail drawer.
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState("");
  // Provider (salon) only — the behandlinger catalog the New-booking sheet
  // picks from (active only). Soft-fail to []. Stylist stations come from
  // `resources` (kind:"provider"); the public list/drawer resolves the
  // behandler name from those.
  const [behandlinger, setBehandlinger] = useState([]);
  // Salon first-run — a provider venue with no self-chair / stylist station
  // yet. The owner confirms the hours they're open (seeded salon-flavored)
  // and one tap seeds the self-chair, persists the hours, and enables
  // reservations (POST /reservations/salon/quick-setup). Writes ONLY on tap.
  const [salonHours, setSalonHours] = useState(() => defaultSalonHours());
  const [salonSetupBusy, setSalonSetupBusy] = useState(false);
  const [salonSetupError, setSalonSetupError] = useState("");

  // ── Deep-link: /reservations?booking=<id>&date=<iso> ──────────────────
  // A live host-stand alert, the 8am brief, or a push lands the owner on the
  // EXACT booking instead of the generic list. We treat the URL id as a hint
  // only — the drawer is re-pointed from the freshly-fetched row, never from
  // anything carried in the URL (PSD2-callback doctrine: re-derive, don't
  // trust). The id is enough; no PII ever rides in the query string.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepBookingId = searchParams.get("booking");
  const deepDate = searchParams.get("date");
  // One calm ring on the opened drawer (~one ceremonial beat, then stillness).
  const [deepLinkPulse, setDeepLinkPulse] = useState(false);
  // Honest dead-link note: the booking was cancelled/purged before we arrived.
  const [deepLinkGone, setDeepLinkGone] = useState(false);

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
        // Signal the Venteliste to resync against the freshly-loaded book.
        setBookTick((n) => n + 1);
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
      // Prefer the backend's canonical seat total; keep null if an older API
      // omits it so the gauge can fall back to the raw reduce.
      const vs = res.data?.venue_seats_total;
      setVenueSeats(Number.isFinite(vs) ? vs : null);
    } catch {
      setResources([]);
      setVenueSeats(null);
    } finally {
      setResourcesLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchBook(day);
  }, [day, fetchBook]);
  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  // Live book — the screen the owner stares at MID-SERVICE must not go stale.
  // Without this, a public booking, a cancellation, or a host-stand flip made
  // on another device stays invisible until someone hunts for the manual
  // refresh button. Two honest signals, no websockets (single-worker backend):
  //   1. Refetch the moment the screen wakes / tab refocuses (the phone was in
  //      a pocket for 20 minutes — same pattern as the timeline's now-line).
  //   2. A gentle 75s poll, TODAY only (a past/future day's book doesn't drift
  //      mid-service) and only while visible (don't drain the host-stand).
  // SILENT: no setLoading, so the list never flashes or jumps under the thumb;
  // an in-flight ref stops overlapping fetches from racing each other.
  const liveRefreshInFlight = useRef(false);
  const refreshBookSilently = useCallback(async () => {
    if (liveRefreshInFlight.current) return;
    liveRefreshInFlight.current = true;
    try {
      const res = await api.get("/reservations/book", { params: { day } });
      setData(res.data || null);
      setBookTick((n) => n + 1); // Venteliste resyncs against the fresh book
    } catch {
      /* silent — the manual refresh + the next wake/poll still exist */
    } finally {
      liveRefreshInFlight.current = false;
    }
  }, [day]);
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") refreshBookSilently();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    let pollId;
    if (day === isoDay(new Date())) {
      pollId = setInterval(() => {
        if (document.visibilityState === "visible") refreshBookSilently();
      }, 75000);
    }
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      if (pollId) clearInterval(pollId);
    };
  }, [day, refreshBookSilently]);

  // Provider venues only — load the active behandlinger catalog the New-
  // booking sheet offers. Soft-fail: no catalog → the sheet shows the
  // "add a behandling first" guidance and stays closed-friendly. Exposed as a
  // callback so the salon quick-setup can refetch it (the first-run nudge
  // clears once a behandling exists).
  const fetchBehandlinger = useCallback(async () => {
    if (!isProvider) return;
    try {
      const res = await api.get("/reservations/behandlinger");
      const list = Array.isArray(res.data?.behandlinger) ? res.data.behandlinger : [];
      setBehandlinger(list.filter((b) => b.active !== false));
    } catch {
      setBehandlinger([]);
    }
  }, [isProvider]);

  useEffect(() => {
    fetchBehandlinger();
  }, [fetchBehandlinger]);

  // Salon first-run helpers — patch one weekday, fan Monday out to the week,
  // and the one-tap quick-setup that opens the salon for booking.
  const setSalonHourDay = (key, patch) =>
    setSalonHours((h) => ({ ...h, [key]: { ...h[key], ...patch } }));
  const applySalonMonToAll = () =>
    setSalonHours((h) => {
      const mon = h.mon;
      const next = {};
      DAY_KEYS.forEach((k) => {
        next[k] = { ...mon };
      });
      return next;
    });
  const openSalonForBooking = async () => {
    if (salonSetupBusy) return; // guard against double-submit
    setSalonSetupBusy(true);
    setSalonSetupError("");
    try {
      await api.post("/reservations/salon/quick-setup", {
        booking_hours: serializeBookingHours(salonHours),
      });
      // Refetch so the self-chair now appears (providerStations > 0 → the
      // first-run card falls away and the live book + New-booking sheet
      // render); refresh the behandlinger catalog too.
      await fetchResources();
      await fetchBehandlinger();
    } catch (e) {
      setSalonSetupError(
        e?.response?.data?.detail?.error ||
          t("rsvpSalonSetupError", "Couldn't open for booking. Try again."),
      );
    } finally {
      setSalonSetupBusy(false);
    }
  };

  // Step 1 — a deep-link for another day switches the book to that day first;
  // the day effect above then refetches. (No-op when the date matches or is
  // absent — we just resolve against the day already loaded.)
  useEffect(() => {
    if (!deepBookingId) return;
    if (deepDate && /^\d{4}-\d{2}-\d{2}$/.test(deepDate) && deepDate !== day) {
      setDay(deepDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepBookingId, deepDate]);

  // Step 2 — once the target day's book has landed, re-point the drawer to the
  // fresh row and strip the params so a refresh doesn't re-open. A booking that
  // no longer exists (cancelled / purged) shows an honest inline note, never a
  // blank drawer or a 404.
  useEffect(() => {
    if (!deepBookingId) return;
    // Still waiting to arrive on the right day, or mid-fetch — let it settle.
    if (deepDate && /^\d{4}-\d{2}-\d{2}$/.test(deepDate) && deepDate !== day) return;
    if (loading) return;
    const fresh = (data?.reservations || []).find(
      (r) => String(r.id) === String(deepBookingId),
    );
    if (fresh) {
      setSelected(fresh);
      setDeepLinkPulse(true);
      setDeepLinkGone(false);
    } else {
      setSelected(null);
      setDeepLinkGone(true);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("booking");
    next.delete("date");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepBookingId, deepDate, day, loading, data]);

  // Deep-link from the freed-table owner push: ?waitlist=<match_id> lands the
  // owner on the Venteliste with that waiting party highlighted (reuses the
  // spotMatches highlight+ring+banner path). Strip the param so a refresh
  // doesn't re-fire. The row's own Notify/Ring actions live in WaitlistSection.
  const deepWaitlistId = searchParams.get("waitlist");
  useEffect(() => {
    if (!deepWaitlistId) return;
    pickView("liste");
    setSpotMatches([{ id: deepWaitlistId, guest_name: null }]);
    const next = new URLSearchParams(searchParams);
    next.delete("waitlist");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepWaitlistId]);

  // The ring is a single beat — fade it after the drawer has settled.
  useEffect(() => {
    if (!deepLinkPulse) return;
    const id = setTimeout(() => setDeepLinkPulse(false), 1400);
    return () => clearTimeout(id);
  }, [deepLinkPulse]);

  const setStatus = async (r, status) => {
    if (status === "cancelled") {
      const who = r.guest_name || t("rsvpGuest", "Guest");
      // A `requested` booking is DECLINED (it was never confirmed), not a
      // confirmed booking CANCELLED — honest, distinct copy for each while
      // keeping the ONE useConfirm dialog. This single confirm owns BOTH the
      // list-row and drawer decline/cancel paths (rowActions hands "cancelled"
      // straight here), so branching the copy here fixes both at once.
      const isDecline = r.status === "requested";
      if (
        !(await confirm(
          isDecline
            ? {
                title: t("rsvpDeclineConfirmTitle", "Decline this request?"),
                message: t(
                  "rsvpDeclineConfirmBody",
                  "The request from {name} is declined. They're notified if possible.",
                  { name: who },
                ),
                confirmLabel: t("rsvpDeclineAction", "Decline"),
                cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
                destructive: true,
              }
            : {
                title: t("rsvpCancelConfirmTitle", "Cancel this booking?"),
                message: t(
                  "rsvpCancelConfirmBody",
                  "The booking for {name} is cancelled. They're notified if possible.",
                  { name: who },
                ),
                confirmLabel: t("rsvpCancelConfirmYes", "Cancel booking"),
                cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
                destructive: true,
              },
        ))
      ) {
        return;
      }
    }
    setActioningId(r.id);
    // Physical feedback at the moment of decision (no-op on web): success on
    // the money moment (completed), a firm tick otherwise.
    if (status === "completed") haptic.success();
    else if (status === "cancelled" || status === "no_show") haptic.warning();
    else haptic.medium();
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
      const resp = await api.patch(`/reservations/reservations/${r.id}/status`, {
        status,
        cancel_reason: status === "cancelled" ? "owner_cancelled" : null,
      });
      // A cancel/no-show may have freed a table — surface the waiting parties
      // that fit (the backend already filtered by capacity + local day). This
      // only SHOWS them; the owner still taps Notify / Book.
      const m = resp?.data?.waitlist_matches;
      if (Array.isArray(m) && m.length) setSpotMatches(m);
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
      haptic.success();
      setSeatTarget(null);
      // The walk-in is seated NOW (today) — jump to today if viewing another
      // day so it's visible; otherwise refetch in place.
      const todayIso = isoDay(new Date());
      if (day !== todayIso) setDay(todayIso);
      else await fetchBook(day);
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      // Chosen table just got taken (race, or the picker's 60s view was stale)
      // → honest message, never a silent double-seat.
      if (e?.response?.status === 409 && code === "slot_unavailable") {
        setError(
          t("rsvpSeatTableTaken", "That table is now taken — pick another free table."),
        );
      } else {
        setError(code || t("rsvpSeatError", "Couldn't seat the guests."));
      }
    } finally {
      setSeating(false);
    }
  };

  // Take a future (phone) booking. auto_assign:true lets the backend pick a
  // table via the availability engine; a 409 room_full keeps the sheet open
  // with an honest warning and the explicit "book anyway (no table)" path
  // (allow_overflow:true → saved unassigned with overflow:true).
  const createBooking = async (form, allowOverflow = false) => {
    setCreating(true);
    setCreateError("");
    if (!allowOverflow) setRoomFull(null);
    try {
      // Provider (salon) tidsbestilling — the server resolves the duration +
      // service_name from the behandlinger catalog and books a PROVIDER. A
      // pinned behandler (stylist_resource_id) FAILS CLOSED with 409
      // stylist_unavailable — we surface it and NEVER silently rebook.
      // Omitting stylist_resource_id = "Valgfri behandler" (any free provider).
      const payload = isProvider
        ? {
            guest_name: form.guest_name,
            guest_phone: form.guest_phone,
            starts_at: `${form.date}T${form.time}:00`,
            source: "manual",
            status: "confirmed",
            behandling_id: form.behandling_id,
            ...(form.stylist_resource_id
              ? { stylist_resource_id: form.stylist_resource_id }
              : {}),
          }
        : {
            guest_name: form.guest_name,
            guest_phone: form.guest_phone,
            party_size: form.party_size,
            starts_at: `${form.date}T${form.time}:00`,
            // A pinned table posts its resource_id (no auto-assign); blank keeps
            // the engine's auto-assign. Both go through the same occupancy path —
            // a taken table returns a clean 409, never a silent double-book.
            resource_id: form.resource_id || null,
            source: "manual",
            status: "confirmed",
            auto_assign: !form.resource_id,
            ...(allowOverflow ? { allow_overflow: true } : {}),
          };
      await api.post("/reservations/book", payload);
      trackEvent("reservation_created", "reservations");  // product analytics
      setNewOpen(false);
      setRoomFull(null);
      // Jump the book to the booked date so the new booking is visible.
      if (form.date !== day) setDay(form.date);
      else await fetchBook(day);
    } catch (e) {
      const d = e?.response?.data?.detail || {};
      if (e?.response?.status === 409 && d.error === "stylist_unavailable") {
        // The pinned behandler was just taken — honest inline message, the
        // sheet stays open with the same selections so the host can pick a new
        // time or switch to Valgfri behandler. No auto-rebook.
        setCreateError(
          t(
            "rsvpBookStylistUnavailable",
            "Den valgte behandler er ikke ledig på det tidspunkt — vælg et andet tidspunkt eller 'Valgfri behandler'.",
          ),
        );
      } else if (e?.response?.status === 409 && d.error === "slot_unavailable") {
        // The owner pinned a specific table that's taken for this slot. We do
        // NOT silently re-pick — honest inline message; the sheet stays open so
        // they can choose another table (or Auto) or another time.
        setCreateError(
          t(
            "rsvpBookTableTaken",
            "That table is taken for this time — pick another table (or Auto) or another time.",
          ),
        );
      } else if (e?.response?.status === 409 && d.error === "room_full") {
        const seats = d.seats ?? d.total_seats ?? d.capacity ?? (totalCapacity || null);
        setRoomFull({ seats });
      } else {
        setCreateError(
          d.error || t("rsvpCreateError", "Couldn't create the booking."),
        );
      }
    } finally {
      setCreating(false);
    }
  };

  const openNewBooking = () => {
    setRoomFull(null);
    setCreateError("");
    setNewOpen(true);
  };

  // Open Seat-walk-in from the header (no preset tile). The sentinel tells
  // SeatNowSheet to render its table picker; a tile-launched seat-now still
  // passes the tapped resource object and skips the picker. Seating jumps to
  // today so the walk-in is visible, matching the tile flow.
  const openSeatWalkIn = () => {
    setError("");
    setSeatTarget(SEAT_WALK_IN_PICK);
  };

  // Assign / move / clear the booking's table from the detail drawer.
  // PATCH then refetch (no in-place object patching — the memo-on-identity
  // trap) and re-point the drawer at the fresh row so it shows the new table.
  const assignTable = async (r, resourceId) => {
    const current = r.resource_id ? String(r.resource_id) : null;
    const next = resourceId ? String(resourceId) : null;
    if (current === next) return;
    setAssigning(true);
    setAssignError("");
    try {
      const patchResp = await api.patch(
        `/reservations/reservations/${r.id}/table`,
        { resource_id: next },
      );
      // Clearing a table releases its hold → the backend surfaces the waiting
      // parties that now fit. Same SHOW-only contract as cancel/no-show: we
      // highlight them, the owner still taps Notify / Book.
      const m = patchResp?.data?.waitlist_matches;
      if (Array.isArray(m) && m.length) setSpotMatches(m);
      const res = await api.get("/reservations/book", { params: { day } });
      setData(res.data || null);
      // Resync the Venteliste against the just-changed book.
      setBookTick((n) => n + 1);
      const fresh = (res.data?.reservations || []).find((x) => x.id === r.id);
      if (fresh) setSelected(fresh);
    } catch (e) {
      const d = e?.response?.data?.detail || {};
      if (e?.response?.status === 409 && d.error === "slot_unavailable") {
        const label = (next && labelById[next]) || t("rsvpTableFallback", "Table");
        setAssignError(t("rsvpTableTaken", "{label} is taken at that time.", { label }));
      } else {
        setAssignError(d.error || t("rsvpAssignError", "Couldn't assign the table."));
      }
    } finally {
      setAssigning(false);
    }
  };

  // Confirm / dismiss the unconfirmed AI allergy suggestion from the drawer.
  // confirm merges it into the real allergy (+ escalates severity upward);
  // dismiss wipes the suggestion. Either way we re-point the drawer at the
  // fresh row the endpoint returns, then refetch the book.
  const actionAllergy = async (r, action) => {
    if (!r) return;
    setAllergyBusy(true);
    try {
      const resp = await api.patch(
        `/reservations/reservations/${r.id}/allergy-suggestion`,
        { action },
      );
      if (resp?.data) setSelected(resp.data);
      await fetchBook(day);
    } catch {
      await fetchBook(day);
    } finally {
      setAllergyBusy(false);
    }
  };

  // Edit-booking sheet state (opened from the drawer's Edit row).
  const [editRes, setEditRes] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const submitEdit = async (fields) => {
    if (!editRes) return;
    setEditBusy(true);
    setEditError("");
    try {
      await api.patch(`/reservations/reservations/${editRes.id}`, fields);
      haptic.success();
      setEditRes(null);
      setSelected(null);
      fetchBook(day);
    } catch (e) {
      haptic.error();
      const code = e?.response?.data?.detail?.error;
      setEditError(
        code === "slot_unavailable"
          ? t("rsvpEditSlotTaken", "The table isn't free at that time — pick another time, or move the table first.")
          : t("rsvpEditError", "Couldn't save the changes. Please try again."),
      );
    } finally {
      setEditBusy(false);
    }
  };

  // Open the detail drawer with a clean assign-error slate.
  const openDrawer = (r) => {
    setAssignError("");
    setSelected(r);
  };

  const summary = data?.summary || { total: 0, covers: 0, by_status: {} };
  // Stable identity so the memos below ([reservations]) only recompute when
  // the data actually changes — not on every render while data is null.
  const reservations = useMemo(
    () => (Array.isArray(data?.reservations) ? data.reservations : []),
    [data],
  );
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
  // Tables offered by the drawer's assign-table control — real, in-service
  // tables only (no providers, no deactivated ones).
  const assignableTables = useMemo(
    () => resources.filter((r) => r.kind !== "provider" && r.is_active !== false),
    [resources],
  );
  // Walk-in table picker (header-launched Seat-walk-in, no preset tile). Uses
  // the SAME live floor state the Floor map paints, but "busy" here means
  // OCCUPIED RIGHT NOW — a guest seated NOW can take a table whose next booking
  // is hours away, so we must NOT disable a table merely because it's reserved
  // LATER today. A table counts as busy only if it's currently seated OR its
  // booked window contains now (started, not yet ended). The occupancy
  // exclusion constraint on the backend is still the real race backstop; this
  // is only a helpful default. (deriveFloorState's "upcoming" fires for ANY
  // future booking today, which is exactly the over-broad signal we avoid.)
  const walkInTables = useMemo(() => {
    const cells = deriveFloorState(reservations, resources, nowTs);
    const occupiedNow = (c) => {
      if (c.status === "seated") return true; // someone is sitting there now
      // An upcoming booking only blocks a walk-in if its slot is happening NOW
      // (start <= now < end). A slot that starts later today leaves the table
      // free to seat a walk-in right now.
      const res = c.booking?.reservation;
      if (!res || !res.starts_at) return false;
      const startMs = new Date(res.starts_at).getTime();
      const endMs = res.ends_at
        ? new Date(res.ends_at).getTime()
        : startMs + 90 * 60000; // default turn if end missing
      return startMs <= nowTs && nowTs < endMs;
    };
    return cells
      .filter((c) => c.status !== "inactive")
      .map((c) => ({
        id: String(c.res.id),
        label: c.res.label,
        capacity_seats: c.res.capacity_seats,
        zone: c.res.zone || null,
        busy: occupiedNow(c),
      }));
  }, [reservations, resources, nowTs]);
  // Provider (salon) booking — the stylist stations the New-booking sheet
  // pins to (kind:"provider"), and a resource_id → behandler-name resolver
  // for the list/drawer. Each station carries staff_name (or label as a
  // fallback) from the resources serializer.
  const providerStations = useMemo(
    () => resources.filter((r) => r.kind === "provider" && r.is_active !== false),
    [resources],
  );
  // Salon first-run: a provider (salon) venue with no bookable station yet.
  // Show the calm "confirm hours → open for booking" card instead of an empty,
  // confusing book. `resourcesLoaded` guards the flash before resources land
  // (an established salon never sees the card blink in).
  const salonFirstRun = isProvider && resourcesLoaded && providerStations.length === 0;
  const behandlerByResourceId = useMemo(() => {
    const m = {};
    resources.forEach((r) => {
      if (r.kind === "provider") {
        m[String(r.id)] = r.staff_name || r.label || "";
      }
    });
    return m;
  }, [resources]);

  const seatedCount = summary.by_status?.seated || 0;
  const requestedCount = summary.by_status?.requested || 0;

  // ── Cockpit metrics — the day's vitals, host-stand style ───────────────
  // "Next arrival" is the earliest still-live booking yet to come (relative
  // to now when viewing today; the day's earliest otherwise) — the single
  // most host-relevant read. Belægning/utilization = covers booked against
  // total seat capacity: a calm fill gauge, honest about turns (a multi-turn
  // service can read >100%, which is simply the truth, not an error).
  const isViewingToday = day === isoDay(new Date());
  // One canonical seat count: the booking engine's own venue total. Fall back
  // to the raw reduce ONLY when an older API doesn't return the field.
  const totalCapacity = useMemo(
    () =>
      venueSeats != null
        ? venueSeats
        : resources.reduce((s, r) => s + (Number(r.capacity_seats) || 0), 0),
    [venueSeats, resources],
  );
  // Honest occupancy = PEAK CONCURRENT covers vs seats, not daily covers /
  // seats (204 covers over a whole day on 18 seats is several turns, not
  // 1133%). Sweep start/end events of the day's active bookings and take the
  // max simultaneous party-size sum; at the same minute departures are
  // processed before arrivals so back-to-back turns don't double-count.
  const { peakPct, peakTime } = useMemo(() => {
    if (totalCapacity <= 0) return { peakPct: null, peakTime: null };
    const events = [];
    reservations.forEach((r) => {
      if (!["requested", "confirmed", "seated"].includes(r.status) || !r.starts_at) return;
      let s = minOfDay(r.starts_at);
      let e = r.ends_at ? minOfDay(r.ends_at) : s + 90;
      if (e <= s) e += 1440;
      const size = Number(r.party_size) || 0;
      events.push([s, size]);
      events.push([e, -size]);
    });
    if (events.length === 0) return { peakPct: 0, peakTime: null };
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let peak = 0;
    let at = null;
    events.forEach(([m, delta]) => {
      cur += delta;
      if (cur > peak) {
        peak = cur;
        at = m;
      }
    });
    const pad = (n) => String(n).padStart(2, "0");
    return {
      peakPct: Math.min(999, Math.round((peak / totalCapacity) * 100)),
      peakTime: at == null ? null : `${pad(Math.floor((at % 1440) / 60))}:${pad(at % 60)}`,
    };
  }, [reservations, totalCapacity]);
  const nextArrival = useMemo(() => {
    const live = reservations.filter(
      (r) => !["completed", "cancelled", "no_show", "seated"].includes(r.status),
    );
    if (live.length === 0) return null;
    let pool = live;
    if (isViewingToday) {
      const cutoff = new Date().getTime() - 5 * 60 * 1000; // 5-min grace
      const ahead = live.filter((r) => {
        const ts = new Date(r.starts_at).getTime();
        return !Number.isNaN(ts) && ts >= cutoff;
      });
      if (ahead.length > 0) pool = ahead;
    }
    return (
      [...pool].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] ||
      null
    );
  }, [reservations, isViewingToday]);
  const nextArrivalHelper = useMemo(() => {
    if (!nextArrival) return t("rsvpNothingUpcoming", "Nothing upcoming");
    const name = (nextArrival.guest_name || "").trim();
    return name
      ? `${name} · ${nextArrival.party_size}`
      : t("rsvpPartyOf", "Party of {n}", { n: nextArrival.party_size });
  }, [nextArrival, t]);
  // Click a status tile → jump to the list, filtered to that status.
  const focusStatus = (status) => {
    pickView("liste");
    setStatusFilter(status);
  };
  // Click the waitlist tile → jump to the Venteliste (it renders below the
  // whole booking list). Every other cockpit tile navigates; this one was the
  // app's only dead-end stat. The tiny delay lets the liste view (and the
  // section) mount when we're switching from plan/tidslinje.
  const focusWaitlist = () => {
    pickView("liste");
    setTimeout(() => {
      document
        .getElementById("rsvp-venteliste")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  const filtered = useMemo(() => {
    let out = reservations;
    if (statusFilter !== "all") out = out.filter((r) => r.status === statusFilter);
    if (zoneFilter !== "all") {
      const ids = new Set(
        resources.filter((r) => r.zone === zoneFilter).map((r) => String(r.id)),
      );
      out = out.filter((r) => r.resource_id && ids.has(String(r.resource_id)));
    }
    // Note-type is a FILTER, never a re-sort — the book stays time-ordered.
    if (noteTypeFilter !== "all") {
      out = out.filter((r) => (r.note_intent || "") === noteTypeFilter);
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
  }, [reservations, statusFilter, zoneFilter, noteTypeFilter, q, resources]);

  const filtersOn =
    q.trim() !== "" || statusFilter !== "all" || zoneFilter !== "all" || noteTypeFilter !== "all";
  // Phone: the FilterBar's stacked full-width controls cost ~a screen of
  // chrome above the first booking — collapse behind a chip (open when a
  // filter is already active so state is never hidden). Desktop unchanged.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const resetFilters = () => {
    setQ("");
    setStatusFilter("all");
    setZoneFilter("all");
    setNoteTypeFilter("all");
  };
  // Note intents actually present in today's book — the "Note type" filter only
  // offers buckets that exist, so it never shows an empty option.
  const noteTypes = useMemo(() => {
    const s = new Set();
    for (const r of reservations) if (r.note_intent) s.add(r.note_intent);
    return Array.from(s);
  }, [reservations]);

  const columns = [
    {
      id: "time",
      label: t("rsvpColTime", "Time"),
      width: "w-24",
      render: (r) => {
        // "Late" = a confirmed guest whose start time has passed and who
        // hasn't been seated/no-showed. 5-min grace, today only (a past day
        // is history; a future day is never late). Amber = needs a decision:
        // hold the table, call them, or give it away.
        const startMs = r.starts_at ? new Date(r.starts_at).getTime() : 0;
        const lateMin =
          isViewingToday && r.status === "confirmed" && startMs
            ? Math.floor((nowTs - startMs) / 60000)
            : 0;
        return (
          <div className="leading-tight">
            <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {fmtTime(r.starts_at)}
            </div>
            {lateMin >= 5 ? (
              <div className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 tabular-nums">
                <Clock className="w-3 h-3 shrink-0" aria-hidden />
                {t("rsvpLateBy", "{n} min late", { n: lateMin })}
              </div>
            ) : (
              <div className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                {fmtTime(r.ends_at)}
              </div>
            )}
          </div>
        );
      },
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
    // Provider (salon) venues replace Party + Table with Behandling +
    // Behandler; table venues keep the original two columns byte-identical.
    ...(isProvider
      ? [
          {
            id: "behandling",
            label: t("rsvpColBehandling", "Behandling"),
            width: "w-40",
            render: (r) => (
              <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                {r.service_name || "—"}
              </span>
            ),
          },
          {
            id: "behandler",
            label: t("rsvpColBehandler", "Behandler"),
            width: "w-36",
            render: (r) => {
              const who = r.resource_id ? behandlerByResourceId[String(r.resource_id)] : "";
              return (
                <span className="inline-flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300 truncate">
                  <Scissors className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
                  {who || t("rsvpBookValgfriOwner", "Valgfri behandler")}
                </span>
              );
            },
          },
        ]
      : [
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
        ]),
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
  // Every action shows a WORD (text:true) — icon-only was ambiguous on the
  // host-stand tablet (no hover), and Decline vs Cancel were both a bare ✕.
  // Every DESTRUCTIVE action (decline / no-show / cancel) is gated behind a
  // confirm dialog so a mid-rush fat-finger can't silently kill a table.
  const rowActions = (r) => {
    const busy = actioningId === r.id;
    const who = r.guest_name || t("rsvpGuest", "Guest");
    // setStatus already owns the single "cancelled" confirm — and now picks
    // DECLINE vs CANCEL copy from r.status (a `requested` booking is declined,
    // a confirmed one is cancelled). So hand "cancelled" straight through (no
    // opts needed — they'd be dead) and never double-prompt. Other destructive
    // flips (no-show) still confirm here with their own copy.
    const guardedSet = (opts, status) => async () => {
      if (status === "cancelled") {
        setStatus(r, status);
        return;
      }
      if (await confirm({ destructive: true, ...opts })) setStatus(r, status);
    };
    const out = [];
    if (r.status === "requested") {
      out.push({ id: "confirmed", label: t("rsvpConfirmAction", "Confirm"), text: true, icon: <Check className="w-4 h-4" />, onClick: () => setStatus(r, "confirmed"), disabled: busy });
      out.push({
        id: "decline", label: t("rsvpDeclineAction", "Decline"), text: true, icon: <X className="w-4 h-4" />, variant: "danger", disabled: busy,
        onClick: guardedSet(null, "cancelled"),
      });
    } else if (r.status === "confirmed") {
      out.push({ id: "seated", label: t("rsvpSeatAction", "Seat"), text: true, icon: <Armchair className="w-4 h-4" />, onClick: () => setStatus(r, "seated"), disabled: busy });
      out.push({
        id: "no_show", label: t("rsvpNoShowAction", "No-show"), text: true, icon: <Ban className="w-4 h-4" />, variant: "danger", disabled: busy,
        onClick: guardedSet({
          title: t("rsvpNoShowConfirmTitle", "Mark as no-show?"),
          message: t("rsvpNoShowConfirmBody", "Records that {name} didn't arrive.", { name: who }),
          confirmLabel: t("rsvpNoShowAction", "No-show"),
        }, "no_show"),
      });
      out.push({
        id: "cancel", label: t("rsvpCancelAction", "Cancel"), text: true, icon: <X className="w-4 h-4" />, variant: "danger", disabled: busy,
        onClick: guardedSet(null, "cancelled"),
      });
    } else if (r.status === "seated") {
      out.push({ id: "completed", label: t("rsvpCompleteAction", "Complete"), text: true, icon: <CheckCircle2 className="w-4 h-4" />, onClick: () => setStatus(r, "completed"), disabled: busy });
    }
    return out;
  };

  // Phone-only compact booking row (DataTable mobileRow): tonight's book scans
  // like a paper book — time down the left edge (late guests amber), name +
  // party + allergy flag, status pill, ONE state-matched primary action.
  // Whole row opens the drawer; destructive flips stay in the drawer behind
  // useConfirm. Replaces the generic ~200px label:value card dump per booking.
  const compactRow = (r) => {
    const startMs = r.starts_at ? new Date(r.starts_at).getTime() : 0;
    const lateMin =
      isViewingToday && r.status === "confirmed" && startMs
        ? Math.floor((nowTs - startMs) / 60000)
        : 0;
    const hasAllergy =
      (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
      r.allergy_note ||
      r.allergy_severity;
    let primary = null;
    if (r.status === "requested")
      primary = { label: t("rsvpConfirmAction", "Confirm"), to: "confirmed" };
    else if (r.status === "confirmed")
      primary = { label: t("rsvpSeatAction", "Seat"), to: "seated" };
    else if (r.status === "seated")
      primary = { label: t("rsvpCompleteAction", "Complete"), to: "completed" };
    const busy = actioningId === r.id;
    return (
      <div
        className="flex items-center gap-3 cursor-pointer"
        onClick={() => openDrawer(r)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDrawer(r);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="w-14 shrink-0 leading-tight">
          <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {fmtTime(r.starts_at)}
          </div>
          {lateMin >= 5 && (
            <div className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400 tabular-nums">
              <Clock className="w-3 h-3 shrink-0" aria-hidden />
              +{lateMin}m
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {r.guest_name || "—"}
            {hasAllergy && (
              <AlertTriangle
                className={
                  "inline w-3.5 h-3.5 ml-1 -mt-0.5 " +
                  (r.allergy_severity === "severe" ? "text-red-500" : "text-amber-500")
                }
                aria-label={t("rsvpAllergyFlag", "Allergy")}
              />
            )}
          </div>
          <div className="inline-flex items-center gap-1 text-[12px] text-gray-500 dark:text-gray-400 tabular-nums max-w-full">
            <Users className="w-3 h-3 shrink-0" aria-hidden />
            {r.party_size}
            {isProvider && r.service_name && (
              <span className="truncate">· {r.service_name}</span>
            )}
          </div>
        </div>
        <StatusPill status={r.status} label={labels[r.status] || r.status} />
        {primary && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setStatus(r, primary.to);
            }}
            className="h-11 px-3 shrink-0 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs font-semibold disabled:opacity-50 active:scale-95 transition"
          >
            {primary.label}
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className={
        standalone
          ? "min-h-screen bg-gray-50 dark:bg-gray-950 px-4 sm:px-6 lg:px-8 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] space-y-4"
          : "space-y-4"
      }
    >
      {/* Host-stand top bar — only in the /reservations/stand pop-out, which
          renders outside the app <Layout />. A slim brand row + a Luk that
          closes the popped tab (or falls back to the full app). */}
      {standalone && (
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-gray-900 text-white dark:bg-white dark:text-gray-900 shrink-0">
              <CalendarCheck className="w-5 h-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight truncate">
                {isProvider
                  ? t("rsvpStandTitleProvider", "Aftaler")
                  : t("rsvpStandTitle", "Reservationer")}
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-tight truncate">
                {user?.business_name ? `${user.business_name} · ` : ""}
                {t("rsvpStandMode", "Vært-skærm")}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              try {
                window.close();
              } catch {
                /* tab wasn't script-opened — the navigate below is the fallback */
              }
              navigate("/reservations");
            }}
            className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
          >
            <X className="w-4 h-4" aria-hidden />
            <span className="hidden sm:inline">{t("close", "Luk")}</span>
          </button>
        </div>
      )}
      {/* Salon first-run — a provider (salon) venue with no self-chair yet
          gets a calm "confirm your hours → open for booking" card in place of
          the empty, confusing book. One tap seeds the self-chair + enables
          reservations; the live book renders the moment a station exists. */}
      {salonFirstRun && (
        <SalonFirstRunCard
          t={t}
          hours={salonHours}
          setHourDay={setSalonHourDay}
          applyMonToAll={applySalonMonToAll}
          behandlingerCount={behandlinger.length}
          busy={salonSetupBusy}
          error={salonSetupError}
          onOpen={openSalonForBooking}
        />
      )}

      {!salonFirstRun && (
        <>
      {/* Toolbar: day controls (left) + view toggle (right). Every control is
          a ≥44px tap target for the Windows host-stand / tablet. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date stepper — ◂ step a day ▸, tap the centre to jump via the
              native picker. The relative label ("I dag" / "I morgen") gives
              instant orientation; the numeric date sits quietly beneath. */}
          <div className="inline-flex items-stretch rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
            <button
              type="button"
              onClick={() => setDay(shiftDay(day, -1))}
              aria-label={t("rsvpPrevDay", "Previous day")}
              className="w-10 inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <label className="relative h-11 flex flex-col items-center justify-center px-3 cursor-pointer border-x border-gray-200 dark:border-gray-700 min-w-[7.5rem] hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors focus-within:ring-2 focus-within:ring-inset focus-within:ring-gray-900 dark:focus-within:ring-gray-100">
              <span className="text-[13px] font-semibold leading-none text-gray-900 dark:text-gray-100">
                {relativeDayLabel(day, t, lang)}
              </span>
              <span className="text-[11px] leading-none text-gray-500 dark:text-gray-400 tabular-nums mt-1">
                {fmtDkDate(day)}
              </span>
              <input
                type="date"
                value={day}
                onChange={(e) => e.target.value && setDay(e.target.value)}
                aria-label={t("rsvpBookDay", "Reservation date")}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </label>
            <button
              type="button"
              onClick={() => setDay(shiftDay(day, 1))}
              aria-label={t("rsvpNextDay", "Next day")}
              className="w-10 inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          {day !== isoDay(new Date()) && (
            <button
              type="button"
              onClick={() => setDay(isoDay(new Date()))}
              className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
            >
              {t("rsvpToday", "Today")}
            </button>
          )}
          <button
            type="button"
            onClick={() => fetchBook(day)}
            aria-label={t("rsvpRefresh", "Refresh")}
            className="inline-flex items-center justify-center h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Pop the book out to its own full-screen door screen (no sidebar).
              Opens /reservations/stand in a new tab — a dedicated host-stand
              display. Hidden while already inside the pop-out. */}
          {!standalone && (
            <button
              type="button"
              onClick={() =>
                window.open("/reservations/stand", "_blank", "noopener,noreferrer")
              }
              aria-label={t("rsvpOpenStand", "Open host-stand view")}
              title={t("rsvpOpenStand", "Open host-stand view")}
              className="inline-flex items-center justify-center h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
            >
              <ExternalLink className="w-5 h-5" />
            </button>
          )}
          <TabPills
            tabs={[
              { id: "liste", label: t("rsvpViewListe", "List") },
              // Floor lens only for TABLE venues (gated on venue TYPE).
              ...(tableFloor ? [{ id: "plan", label: t("rsvpViewPlan", "Floor") }] : []),
              { id: "tidslinje", label: t("rsvpViewTimeline", "Timeline") },
            ]}
            activeId={view}
            onChange={pickView}
            ariaLabel={t("rsvpViewAria", "Reservation views")}
          />
          {/* Seat walk-in — always reachable for TABLE venues, in every day
              lens (List / Timeline / Floor), not only by tapping a free tile
              on the Floor map. Opens SeatNowSheet in table-picker mode. */}
          {tableFloor && !isProvider && (
            <Button
              variant="primary"
              size="lg"
              iconLeft={<Armchair className="w-4 h-4" />}
              onClick={openSeatWalkIn}
            >
              {t("rsvpSeatWalkIn", "Seat walk-in")}
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            iconLeft={<Plus className="w-4 h-4" />}
            onClick={openNewBooking}
          >
            {isProvider
              ? t("rsvpNewBookingProvider", "Book en tid")
              : t("rsvpNewBooking", "New booking")}
          </Button>
        </div>
      </div>

      {/* Cockpit — the day's vitals as a host-stand command center. Covers
          is the headline (booking count folded into its helper); Seated and
          Awaiting are click-to-filter into the list; Next arrival opens that
          booking; Belægning is a calm fill gauge. Awaiting goes amber when
          requests pile up — otherwise the whole row stays calm gray. */}
      {/* On mobile these six vitals pack into a compact 3-across, 2-row grid
          (dense tiles, tighter gap) so they read as a glance-bar instead of
          four rows of tall cards pushing the booking list off-screen. From
          sm: up it's the original 3-col → 6-col layout at full scale. */}
      <div className="grid grid-cols-3 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <StatCard
          dense
          label={t("rsvpCovers", "Covers")}
          value={summary.covers}
          helper={
            summary.total === 1
              ? t("rsvpCoversBookingsOne", "{n} booking", { n: summary.total })
              : t("rsvpCoversBookings", "{n} bookings", { n: summary.total })
          }
        />
        <StatCard
          dense
          label={t("rsvpSeatedNow", "Seated now")}
          value={seatedCount}
          // The one LIVE number on the page — guests physically in the room
          // right now. Emerald only while that's true; the moment the room is
          // empty it falls back to neutral so the colour always means
          // "something is happening", never decoration.
          accent={seatedCount > 0 ? "success" : "neutral"}
          helper={t("rsvpSeatedHelper", "in the room")}
          onClick={() => focusStatus("seated")}
          selected={view === "liste" && statusFilter === "seated"}
        />
        <StatCard
          dense
          label={t("rsvpNextArrival", "Next arrival")}
          value={nextArrival ? fmtTime(nextArrival.starts_at) : "—"}
          helper={nextArrivalHelper}
          onClick={nextArrival ? () => openDrawer(nextArrival) : null}
        />
        <StatCard
          dense
          label={t("rsvpAwaiting", "Awaiting")}
          value={requestedCount}
          accent={requestedCount > 0 ? "warn" : "neutral"}
          helper={t("rsvpAwaitingHelper", "to confirm")}
          onClick={() => focusStatus("requested")}
          selected={view === "liste" && statusFilter === "requested"}
        />
        <StatCard
          dense
          label={t("rsvpUtilization", "Occupancy")}
          value={peakPct == null ? "—" : `${peakPct}%`}
          // Over 100% means more covers than seats at the peak — a real
          // problem the owner should see before service, not a neutral fact.
          // It was rendering 192% in plain gray. 85%+ is "nearly full" (amber:
          // worth knowing), past 100% is red. Unknown capacity stays neutral —
          // with no seat count there's no honest claim to make.
          accent={
            peakPct == null ? "neutral"
              : peakPct > 100 ? "critical"
                : peakPct >= 85 ? "warn"
                  : "neutral"
          }
          helper={
            totalCapacity <= 0
              ? t("rsvpUtilNoSeats", "set table seats")
              : peakTime
                ? t("rsvpUtilPeakAt", "peak {time}", { time: peakTime })
                : t("rsvpUtilHelper", "of {n} seats", { n: totalCapacity })
          }
        />
        <StatCard
          dense
          label={t("rsvpWlCockpitToday", "On waitlist")}
          value={waitlistCount}
          accent={waitlistCount > 0 ? "warn" : "neutral"}
          helper={t("rsvpWlWaiting", "Waiting")}
          onClick={focusWaitlist}
        />
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Honest dead-link note — a deep-link pointed at a booking that's since
          been cancelled or purged. We land on its day, say so plainly, and let
          the owner dismiss it. Never a blank drawer or a 404. */}
      {deepLinkGone && (
        <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 px-4 py-3 rounded-xl text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">
            {t("rsvpDeepLinkGone", "This reservation no longer exists.")}
          </span>
          <button
            type="button"
            onClick={() => setDeepLinkGone(false)}
            aria-label={t("close", "Close")}
            className="shrink-0 -my-0.5 -mr-1 h-7 w-7 inline-flex items-center justify-center rounded-lg hover:bg-amber-100/70 dark:hover:bg-amber-900/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Liste (the polished data-table) ── */}
      {view === "liste" && (
        <>
          <button
            type="button"
            onClick={() => setMobileFiltersOpen((v) => !v)}
            className="sm:hidden inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-600 dark:text-gray-300"
          >
            <SlidersHorizontal className="w-4 h-4" aria-hidden />
            {t("rsvpFilterChip", "Filter")}
            {filtersOn && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />
            )}
          </button>
          <div className={mobileFiltersOpen || filtersOn ? "" : "hidden sm:block"}>
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
            {noteTypes.length > 0 && (
              <FilterBar.Select
                label={t("rsvpFilterNoteType", "Note type")}
                value={noteTypeFilter}
                onChange={setNoteTypeFilter}
                options={[
                  { value: "all", label: t("rsvpFilterAll", "All") },
                  ...noteTypes.map((n) => ({ value: n, label: noteIntentLabel(n, t) || n })),
                ]}
              />
            )}
            {filtersOn && <FilterBar.Reset onClick={resetFilters} label={t("reset", "Reset")} />}
          </FilterBar>
          </div>

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey="id"
            loading={loading}
            rowActions={rowActions}
            onRowClick={openDrawer}
            mobileBreakpoint="md"
            mobileRow={compactRow}
            empty={
              <Empty
                icon={CalendarCheck}
                title={t("rsvpBookEmpty", "No reservations for {date} yet.", { date: fmtDkDate(day) })}
                body={
                  filtersOn
                    ? t("rsvpNoMatch", "No bookings match your filters.")
                    : t("rsvpBookEmptyBody", "Bookings will appear here as they come in.")
                }
              />
            }
          />

          {/* Venteliste — parties we couldn't seat. A cancel/no-show above
              hands us the fitting matches (spotMatches) to highlight. The id
              is the scroll target for the cockpit's waitlist tile. */}
          <div id="rsvp-venteliste" className="scroll-mt-4">
            <WaitlistSection
              day={day}
              spotMatches={spotMatches}
              refreshTick={bookTick}
              onCountChange={setWaitlistCount}
              onConverted={() => fetchBook(day)}
            />
          </div>
        </>
      )}

      {/* ── Plan (visual floor) ── */}
      {view === "plan" &&
        (loading ? (
          <FloorSkeleton />
        ) : (
          <FloorView
            reservations={reservations}
            resources={resources}
            t={t}
            businessType={businessType}
            onSelect={openDrawer}
            onSeatNow={setSeatTarget}
            onResourcesChanged={fetchResources}
          />
        ))}

      {/* ── Tidslinje (service timeline grid) ── */}
      {view === "tidslinje" &&
        (loading ? (
          <TimelineSkeleton />
        ) : (
          <TimelineView
            reservations={reservations}
            resources={resources}
            day={day}
            t={t}
            onSelect={openDrawer}
            onStatus={setStatus}
          />
        ))}
        </>
      )}

      {/* Shared detail drawer — opened from a Liste row, a Plan tile, or a
          timeline block. Status actions reuse the same optimistic handler. */}
      {selected && (
        <ReservationDrawer
          reservation={selected}
          tableLabel={resolveTableLabel(selected, labelById)}
          isProvider={isProvider}
          behandlerName={
            selected.resource_id ? behandlerByResourceId[String(selected.resource_id)] : ""
          }
          t={t}
          busy={actioningId === selected.id}
          tables={assignableTables}
          onAssign={assignTable}
          assignBusy={assigning}
          assignError={assignError}
          highlight={deepLinkPulse}
          onEdit={(r) => { setEditError(""); setEditRes(r); }}
          onAllergyAction={(action) => actionAllergy(selected, action)}
          allergyActionBusy={allergyBusy}
          onStatus={(r, to) => {
            setStatus(r, to);
            setSelected(null);
          }}
          onClose={() => {
            setSelected(null);
            setAssignError("");
            setDeepLinkPulse(false);
          }}
        />
      )}

      {editRes && (
        <EditBookingSheet
          reservation={editRes}
          t={t}
          busy={editBusy}
          error={editError}
          onSubmit={submitEdit}
          onClose={() => setEditRes(null)}
        />
      )}

      {/* Seat-now sheet — opened by tapping a FREE tile on the Plan view, OR
          from the header "Seat walk-in" button (SEAT_WALK_IN_PICK sentinel →
          the sheet shows a table picker over the live free/busy list). */}
      {seatTarget && (
        <SeatNowSheet
          table={seatTarget}
          tables={walkInTables}
          t={t}
          busy={seating}
          onSeat={seatWalkIn}
          onClose={() => setSeatTarget(null)}
        />
      )}

      {/* New booking sheet — the host takes a future (phone) booking. For a
          provider (salon) venue this is a tidsbestilling: behandling →
          behandler → dato → tid. */}
      {newOpen && (
        <NewBookingSheet
          day={day}
          t={t}
          busy={creating}
          warning={roomFull}
          onClearWarning={() => setRoomFull(null)}
          error={createError}
          onSubmit={createBooking}
          isProvider={isProvider}
          behandlinger={behandlinger}
          providerStations={providerStations}
          tables={assignableTables}
          onClose={() => {
            setNewOpen(false);
            setRoomFull(null);
            setCreateError("");
          }}
        />
      )}
    </div>
  );
}

function StatusPill({ status, label }) {
  // Unknown status falls back to the neutral "completed" treatment (same
  // fail-soft intent as the old `|| bg-gray-400`).
  const s = STATUS_PILL[status] || STATUS_PILL.completed;
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs whitespace-nowrap ${s.pill}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`}
        aria-hidden="true"
      />
      <span
        className={
          s.strike
            ? "line-through decoration-gray-400 decoration-1 dark:decoration-gray-600"
            : undefined
        }
      >
        {label}
      </span>
    </span>
  );
}

// ─── Floor / resources ────────────────────────────────────────────────
// Suggested-zone chips — tap-to-fill the zone input with one of the venue
// archetype's preset labels. Purely a convenience / nicer default; the owner
// can still type anything. Hidden once a zone string is present so it never
// nags. Matches the FilterBar / chip aesthetic (gray, rounded, soft border).
function ZonePresetChips({ profile, t, value, onPick }) {
  if (!profile.zonePresetKeys.length) return null;
  if (value && value.trim()) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-gray-400 dark:text-gray-500">
        {t("venueZoneSuggest", "Suggested")}
      </span>
      {profile.zonePresetKeys.map((k) => {
        const label = t(k, "");
        return (
          <button
            key={k}
            type="button"
            onClick={() => onPick(label)}
            className="inline-flex items-center h-7 px-2.5 rounded-full border border-gray-200 dark:border-gray-700 text-[11px] font-medium text-gray-600 hover:text-gray-900 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function FloorSection({ t, businessType }) {
  const confirm = useConfirm();
  // Account venue archetype — drives the section's vocabulary (heading,
  // intro, empty state, icon) and the suggested zone-preset chips.
  const profile = venueProfile(businessType);
  const VenueIcon = profile.icon;
  // Provider (salon) venues author STYLIST STATIONS instead of tables: each
  // station is a `kind:"provider"` resource bound to a StaffMember, and its
  // availability comes 100% from that staff member's published shifts.
  const isProvider = bookingModeFor(businessType) === "provider";
  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [capMsg, setCapMsg] = useState(null); // {cap, current, limit, plan, upgrade_to}

  // Provider-mode: the staff roster the stylist picker chooses from. Fetched
  // once on mount, only when isProvider. Soft-fail to [].
  const [staffMembers, setStaffMembers] = useState([]);
  const [staffId, setStaffId] = useState("");

  // Clear-leftover-tables (provider venues with tables from an earlier setup).
  const [clearingTables, setClearingTables] = useState(false);
  const [tablesNoticeDismissed, setTablesNoticeDismissed] = useState(false);

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

  // Provider mode only — fetch the staff roster the stylist picker chooses
  // from. `GET /staff/members` returns a top-level array of StaffMember rows
  // ({ id, name, … }); normalise the `{ members: [...] }` shape too. Soft-fail.
  useEffect(() => {
    if (!isProvider) return;
    let alive = true;
    api
      .get("/staff/members")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res.data)
          ? res.data
          : Array.isArray(res.data?.members)
            ? res.data.members
            : [];
        setStaffMembers(list);
      })
      .catch(() => {
        if (alive) setStaffMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [isProvider]);

  // staff_id → display name, for resource rows. Falls back to a server-supplied
  // staff name field if the serializer ever adds one.
  const staffNameById = useMemo(() => {
    const m = {};
    for (const s of staffMembers) m[String(s.id)] = s.name || s.full_name || "";
    return m;
  }, [staffMembers]);

  const chosenStaff = staffMembers.find((s) => String(s.id) === String(staffId)) || null;

  // Provider mode: create a stylist (behandler) station. Same 402 cap-handling
  // + error handling as the table path — only the payload + validation branch.
  const addProviderStation = async () => {
    if (!staffId) {
      setError(t("rsvpProviderStaffRequired", "Pick a stylist for this station."));
      return;
    }
    const stationLabel =
      label.trim() || (chosenStaff && (chosenStaff.name || chosenStaff.full_name)) || "";
    setSaving(true);
    setError("");
    setCapMsg(null);
    try {
      const res = await api.post("/reservations/resources", {
        kind: "provider",
        staff_id: staffId,
        label: stationLabel,
        capacity_seats: 1,
        combinable: false,
        zone: null,
      });
      setResources((prev) => [...prev, res.data]);
      setStaffId("");
      setLabel("");
    } catch (e) {
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

  // Provider venue with leftover tables (from a previous setup / test data):
  // delete each non-provider resource sequentially. STOP on the first failure
  // (e.g. the backend rejects a table that still has upcoming reservations) and
  // surface the backend error — never delete provider stations, never swallow.
  const leftoverTables = useMemo(
    () => resources.filter((r) => r.kind !== "provider"),
    [resources],
  );
  const clearLeftoverTables = async () => {
    const n = leftoverTables.length;
    if (n === 0) return;
    if (
      !(await confirm({
        message: t(
          "rsvpClearTablesConfirm",
          "Remove the {n} leftover tables? This can't be undone.",
          { n },
        ),
        destructive: true,
      }))
    )
      return;
    setClearingTables(true);
    setError("");
    setCapMsg(null);
    try {
      for (const r of leftoverTables) {
        try {
          await api.delete(`/reservations/resources/${r.id}`);
        } catch (e) {
          // Halt and report: some tables may have deleted, this one is blocked.
          setError(
            e?.response?.data?.detail?.error ||
              t(
                "rsvpClearTablesBlocked",
                "Some tables still have upcoming bookings — cancel or move those first.",
              ),
          );
          return;
        }
      }
    } finally {
      setClearingTables(false);
      // Refresh either way so the list reflects exactly what was removed.
      fetchResources();
    }
  };

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

  const saveLabel = async (r, nextLabel) => {
    const label = String(nextLabel || "").trim().slice(0, 120);
    // Empty or unchanged → no-op (the input keeps showing the saved name).
    if (!label || label === r.label) return;
    // Optimistic.
    setResources((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, label } : x)),
    );
    try {
      await api.patch(`/reservations/resources/${r.id}`, { label });
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
    if (!(await confirm({ message: t("rsvpTableDeleteConfirm", "Remove this table?"), destructive: true }))) return;
    setResources((prev) => prev.filter((x) => x.id !== r.id));
    try {
      await api.delete(`/reservations/resources/${r.id}`);
    } catch {
      fetchResources();
    }
  };

  // Rows in the SAME (sort_order, label) order GET /resources returns, so the
  // list here mirrors what the booking engine and timeline show. Reorder is
  // computed against this order (never the raw fetch order).
  const sortedResources = useMemo(
    () =>
      [...resources].sort(
        (a, b) =>
          (a.sort_order || 0) - (b.sort_order || 0) ||
          (a.label || "").localeCompare(b.label || ""),
      ),
    [resources],
  );

  // Owner fixes table order. We REINDEX by position (assign sort_order = list
  // index), not swap raw values — because every legacy table ships with
  // sort_order 0, so a 0↔0 value swap is a no-op and the arrows would look
  // dead. Reindexing renumbers the shown list 0..n-1, guaranteeing distinct,
  // monotonic order and unsticking all-zero floors on the very first tap.
  // Optimistic; PATCH only the rows whose value actually changed; refetch on
  // failure. Arrow-only by design; no drag-and-drop.
  const moveResource = async (r, dir) => {
    const list = sortedResources;
    const idx = list.findIndex((x) => x.id === r.id);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
    const reordered = [...list];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    const nextOrder = new Map(reordered.map((x, i) => [x.id, i]));
    const changed = reordered.filter((x, i) => (Number(x.sort_order) || 0) !== i);
    // Optimistic: renumber the shown rows so they settle into place at once.
    setResources((prev) =>
      prev.map((x) =>
        nextOrder.has(x.id) ? { ...x, sort_order: nextOrder.get(x.id) } : x,
      ),
    );
    try {
      await Promise.all(
        changed.map((x) =>
          api.patch(`/reservations/resources/${x.id}`, {
            sort_order: nextOrder.get(x.id),
          }),
        ),
      );
    } catch {
      fetchResources();
    }
  };

  return (
    <div className="space-y-4">
      {isProvider ? (
        <div>
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
            {t("rsvpProvidersTitle", "Stylists & stations")}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t(
              "rsvpProvidersIntro",
              "Add each stylist as a bookable station. Their published shifts decide when guests can book them.",
            )}
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            profile.floorIntroKey,
            "Add the tables guests can be seated at. Capacity drives which party sizes a slot can take.",
          )}
        </p>
      )}

      {/* Provider venue with leftover tables — offer a one-click clear so the
          owner can switch fully to the stylist view. Dismissible; never touches
          provider stations. */}
      {isProvider && leftoverTables.length > 0 && !tablesNoticeDismissed && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {t(
                "rsvpClearTablesNotice",
                "You have {n} tables from an earlier setup. Clear them to switch fully to the stylist view.",
                { n: leftoverTables.length },
              )}
            </p>
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                busy={clearingTables}
                onClick={clearLeftoverTables}
                iconLeft={<Trash2 className="w-4 h-4" />}
              >
                {t("rsvpClearTablesBtn", "Clear tables")}
              </Button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setTablesNoticeDismissed(true)}
            aria-label={t("dismiss", "Dismiss")}
            className="shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-lg text-amber-700/70 hover:text-amber-900 hover:bg-amber-100 dark:text-amber-300/70 dark:hover:text-amber-100 dark:hover:bg-amber-900/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Provider add-form — a stylist picker + optional label override. The
          station's availability is its staff member's published shifts. */}
      {isProvider && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) addProviderStation();
          }}
          className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3"
        >
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpAddStation", "Add a station")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              aria-label={t("rsvpProviderPickStaff", "Choose a stylist")}
              className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
            >
              <option value="">{t("rsvpProviderPickStaff", "Choose a stylist")}</option>
              {staffMembers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.full_name || String(s.id)}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("rsvpStationLabelPh", "Station name (optional)")}
              maxLength={120}
              className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
            />
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {t(
              "rsvpProviderShiftHint",
              "A stylist is bookable only during their published shifts. Add shifts in Vagtplan.",
            )}
          </p>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="lg" busy={saving} iconLeft={<Plus className="w-4 h-4" />}>
              {t("rsvpAddStationBtn", "Add station")}
            </Button>
          </div>
        </form>
      )}

      {/* Table authoring (quick setup + add-table) — only for table venues. */}
      {!isProvider && (
      <>
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
        <ZonePresetChips profile={profile} t={t} value={bulkZone} onPick={setBulkZone} />

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
        <ZonePresetChips profile={profile} t={t} value={zone} onPick={setZone} />
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
      </>
      )}

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
          <VenueIcon className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {isProvider
              ? t("rsvpProvidersEmpty", "No stylists yet — add one to take appointments.")
              : t(profile.floorEmptyKey, "No tables yet — add your first above.")}
          </p>
        </div>
      ) : isProvider ? (
        <ul className="space-y-2">
          {resources
            .filter((r) => r.kind === "provider")
            .map((r) => {
              const staffName = r.staff_name || staffNameById[String(r.staff_id)] || "";
              return (
                <li
                  key={r.id}
                  className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <VenueIcon className="w-4 h-4 text-gray-400 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                      {r.label}
                    </span>
                    {r.staff_id ? (
                      staffName && staffName !== r.label ? (
                        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400 truncate">
                          {staffName}
                        </span>
                      ) : null
                    ) : r.follows_opening_hours ? (
                      // The owner "self-chair": no staff member, but bookable —
                      // it follows the confirmed weekly opening hours. Neutral
                      // gray, NOT the amber "needs a stylist" warning.
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {t("rsvpProviderFollowsHours", "Follows opening hours")}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                        {t("rsvpProviderNoStaff", "No stylist")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
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
              );
            })}
        </ul>
      ) : (
        <ul className="space-y-2">
          {sortedResources.map((r, idx) => (
            <li
              key={r.id}
              // flex-wrap below sm: ~340px of fixed-width controls in a 343px
              // viewport collapsed the flex-1 rename input to 0px. Phone now
              // wraps to two lines (name full-width, controls beneath);
              // desktop (sm:nowrap) is pixel-identical.
              className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3"
            >
              {/* Reorder — fixes an out-of-order table list (e.g. 6,7,8,1,2).
                  Up/down each a full 44px tap target; disabled at the ends. */}
              <div className="flex shrink-0 -ml-1">
                <button
                  type="button"
                  onClick={() => moveResource(r, "up")}
                  disabled={idx === 0}
                  aria-label={t("rsvpMoveUpAria", "Move {label} up", { label: r.label })}
                  className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <ChevronUp className="w-5 h-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => moveResource(r, "down")}
                  disabled={idx === sortedResources.length - 1}
                  aria-label={t("rsvpMoveDownAria", "Move {label} down", { label: r.label })}
                  className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <ChevronDown className="w-5 h-5" aria-hidden />
                </button>
              </div>
              <div className="min-w-0 flex items-center gap-2 flex-1 basis-full sm:basis-auto order-first sm:order-none">
                <VenueIcon className="w-4 h-4 text-gray-400 shrink-0" aria-hidden />
                {/* Inline rename — a visibly editable field (subtle border + fill +
                    pencil cue) so any owner can tell the name is renameable at a glance.
                    Saves on blur (Enter commits, Esc reverts), same UX as seats. */}
                <div className="group relative min-w-0 flex-1">
                  <input
                    type="text"
                    defaultValue={r.label}
                    maxLength={120}
                    onBlur={(e) => saveLabel(r, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      else if (e.key === "Escape") {
                        e.currentTarget.value = r.label;
                        e.currentTarget.blur();
                      }
                    }}
                    aria-label={t("rsvpTableNameAria", "Name of {label}", { label: r.label })}
                    title={t("rsvpTableRenameHint", "Click to rename")}
                    className="w-full h-11 pl-2.5 pr-8 rounded-lg border border-gray-200 bg-gray-50/70 text-base sm:text-sm font-medium text-gray-800 hover:border-gray-300 focus:border-gray-400 focus:bg-white dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-100 dark:hover:border-gray-600 dark:focus:border-gray-500 dark:focus:bg-gray-800 focus:outline-none transition-colors"
                  />
                  <Pencil
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 group-focus-within:text-gray-600 dark:text-gray-500 dark:group-focus-within:text-gray-300"
                    aria-hidden
                  />
                </div>
                {r.zone && (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {r.zone}
                  </span>
                )}
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

// ─── Behandlinger (salon service catalog) — S2 ─────────────────────────
// Salon owners curate their list of services (treatments): a name, a duration,
// and an OPTIONAL display price. Mirrors FloorSection's add/list/delete + 402
// cap-nudge idiom (same gray-900 primitives, same setCapMsg shape). Honesty:
// the price is DISPLAY-ONLY and durations are informational for now — the
// intro copy says so; this does NOT take bookings or charge (that's S3).
function BehandlingerSection({ t }) {
  const confirm = useConfirm();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [capMsg, setCapMsg] = useState(null); // {cap, current, limit, plan, upgrade_to}

  // Add-form state.
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("30");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/reservations/behandlinger");
      setItems(Array.isArray(res.data?.behandlinger) ? res.data.behandlinger : []);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpBehandlingError", "Couldn't load your behandlinger."),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const addItem = async () => {
    if (!name.trim()) {
      setError(t("rsvpBehandlingNameRequired", "Give the behandling a name."));
      return;
    }
    setSaving(true);
    setError("");
    setCapMsg(null);
    try {
      // duration clamps to the backend's 15..600; an empty price → null (the
      // display-only field is optional).
      const duration_min = Math.max(15, Math.min(600, parseInt(duration, 10) || 30));
      const priceNum = price.trim() === "" ? null : Math.max(0, parseInt(price, 10) || 0);
      const res = await api.post("/reservations/behandlinger", {
        name: name.trim(),
        duration_min,
        price_kr: priceNum,
      });
      // Prepend the new service so the owner sees it immediately.
      setItems((prev) => [res.data, ...prev]);
      setName("");
      setDuration("30");
      setPrice("");
    } catch (e) {
      // Same 402 cap-handling as FloorSection — structured payload under
      // `detail` (billing.enforce_cap), with a top-level fallback.
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
            t("rsvpBehandlingAddError", "Couldn't add the behandling."),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (b) => {
    const next = !b.active;
    // Optimistic.
    setItems((prev) => prev.map((x) => (x.id === b.id ? { ...x, active: next } : x)));
    try {
      await api.patch(`/reservations/behandlinger/${b.id}`, { active: next });
    } catch {
      fetchItems();
    }
  };

  const removeItem = async (b) => {
    if (!(await confirm({ message: t("rsvpBehandlingDeleteConfirm", "Remove this behandling?"), destructive: true }))) return;
    setItems((prev) => prev.filter((x) => x.id !== b.id));
    try {
      await api.delete(`/reservations/behandlinger/${b.id}`);
    } catch {
      fetchItems();
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          {t("rsvpBehandlingerTitle", "Behandlinger")}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t(
            "rsvpBehandlingerIntro",
            "List the behandlinger you offer with a duration and an optional price. Durations are informational and the price is display-only for now — this doesn't take bookings or charge yet.",
          )}
        </p>
      </div>

      {/* Add behandling — a real <form> so Enter submits from any field. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving) addItem();
        }}
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3"
      >
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {t("rsvpBehandlingAddTitle", "Add a behandling")}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("rsvpBehandlingNamePh", "Name (e.g. Klip dame)")}
            maxLength={120}
            aria-label={t("rsvpBehandlingNameLabel", "Behandling name")}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm"
          />
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              value={duration}
              onChange={(e) => setDuration(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              placeholder={t("rsvpBehandlingDurationLabel", "Duration")}
              aria-label={t("rsvpBehandlingDurationLabel", "Duration")}
              className="w-full h-11 pl-3 pr-12 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              {t("rsvpBehandlingMinSuffix", "min")}
            </span>
          </div>
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              placeholder={t("rsvpBehandlingPriceLabel", "Price (optional)")}
              aria-label={t("rsvpBehandlingPriceLabel", "Price (optional)")}
              className="w-full h-11 pl-3 pr-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              kr.
            </span>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="lg" busy={saving} iconLeft={<Plus className="w-4 h-4" />}>
            {t("rsvpBehandlingAddBtn", "Add behandling")}
          </Button>
        </div>
      </form>

      {/* Cap-exceeded message + upgrade nudge — same shape as FloorSection. */}
      {capMsg && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 p-4 space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t(
              "rsvpBehandlingCapHit",
              "You've reached your plan's behandling limit ({limit}). Upgrade to add more.",
              { limit: capMsg.limit ?? capMsg.current ?? "" },
            )}
          </p>
          <UpgradeNudge
            intent="inline"
            tier={capMsg.upgrade_to === "pro" ? "pro" : "starter"}
            benefit={t("rsvpBehandlingCapBenefit", "More behandlinger")}
          />
        </div>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Behandling list */}
      {loading ? (
        <div className="text-sm text-gray-500">{t("loading", "Loading…")}</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 py-10 text-center">
          <Clock className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("rsvpBehandlingEmpty", "No behandlinger yet — add your first above.")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((b) => (
            <li
              key={b.id}
              className={
                "rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 flex items-center justify-between gap-3 " +
                (b.active ? "" : "opacity-60")
              }
            >
              <div className="min-w-0 flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-400 shrink-0" aria-hidden />
                <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                  {b.name}
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                  {t("rsvpBehandlingDurationValue", "{n} min", { n: b.duration_min })}
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                  {b.price_kr != null ? formatKr(b.price_kr, { decimals: 0 }) : "—"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleActive(b)}
                  aria-pressed={!!b.active}
                  aria-label={t("rsvpBehandlingActiveLabel", "Active")}
                  title={t("rsvpBehandlingActiveLabel", "Active")}
                  className={
                    "h-11 px-3 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-colors " +
                    (b.active
                      ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                      : "border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200")
                  }
                >
                  <CheckCircle2 className="w-4 h-4" aria-hidden />
                  <span className="hidden sm:inline">{t("rsvpBehandlingActiveLabel", "Active")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeItem(b)}
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
// EmbedOnWebsite — "Sæt på din hjemmeside": the two copy-paste ways an owner
// puts BonBox booking where guests actually start. A styled BUTTON (an <a>
// link — works on any site, zero risk, opens the BonBox page) and an inline
// IFRAME (the widget lives in-page; needs the /r/ frame-ancestors CSP). Both
// snippets use inline styles so they render correctly without the host site's
// CSS. Plus a one-liner for the two link-only channels (Google Maps profile,
// Instagram bio) — no build, just their existing link.
function EmbedOnWebsite({ publicUrl, venueName, t }) {
  const [copied, setCopied] = useState(""); // "" | "button" | "iframe"

  const label = t("rsvpEmbedButtonLabel", "Book bord");
  const safeName = (venueName || "BonBox").replace(/"/g, "&quot;");
  // The iframe MUST load the /r/ form: only that route carries the
  // frame-ancestors CSP that lets a third-party site embed it (the bare
  // /{slug} route inherits the site-wide frame-ancestors 'none'). Same page,
  // embeddable headers. The button is a full-page link, so bare slug is fine.
  const embedSrc = publicUrl.replace(/\/([^/]+)\/?$/, "/r/$1");
  const buttonSnippet =
    `<a href="${publicUrl}" target="_blank" rel="noopener"\n` +
    `  style="display:inline-flex;align-items:center;gap:8px;padding:12px 22px;` +
    `border-radius:12px;background:#111827;color:#fff;font:600 15px/1 system-ui,` +
    `sans-serif;text-decoration:none">${label}</a>`;
  const iframeSnippet =
    `<iframe src="${embedSrc}?embed=1" title="${label} — ${safeName}"\n` +
    `  width="100%" height="720" loading="lazy"\n` +
    `  style="border:0;max-width:460px;border-radius:16px"></iframe>`;

  // Hand-off email. A mailto: only OPENS the owner's mail app pre-filled —
  // we never send anything on their behalf.
  const mailtoHref =
    "mailto:?subject=" +
    encodeURIComponent(t("rsvpEmbedMailSubject", "Booking on our website")) +
    "&body=" +
    encodeURIComponent(
      t(
        "rsvpEmbedMailBody",
        "Hi — could you add table booking to our website?\n\nEither this button, anywhere on the site:\n\n{button}\n\nOr the whole booking form inside a page:\n\n{iframe}\n\nBoth are plain copy-paste HTML.\n\nThanks!",
        { button: buttonSnippet, iframe: iframeSnippet },
      ),
    );

  const copy = async (key, text) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
      }
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? "" : c)), 2500);
    } catch { /* clipboard blocked — the owner can still select the text */ }
  };

  const Snippet = ({ k, code, heading, sub }) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{heading}</p>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">{sub}</p>
        </div>
        <button
          type="button"
          onClick={() => copy(k, code)}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {copied === k ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied === k ? t("rsvpCopied", "Copied") : t("rsvpEmbedCopyCode", "Copy code")}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-gray-50 dark:bg-gray-950 border border-gray-100 dark:border-gray-800 p-2.5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 font-mono whitespace-pre">{code}</pre>
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
          <Globe className="w-4 h-4 text-gray-400" aria-hidden />
          {t("rsvpEmbedTitle", "Add to your website")}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {t(
            "rsvpEmbedSub",
            "Two ways to put booking on your own site — or send them to whoever looks after it.",
          )}
        </p>
      </div>

      <Snippet
        k="button"
        code={buttonSnippet}
        heading={t("rsvpEmbedButtonHeading", "A “Book bord” button")}
        sub={t("rsvpEmbedButtonSub", "Works on any site. Opens your booking page.")}
      />
      <div className="space-y-1.5">
        <Snippet
          k="iframe"
          code={iframeSnippet}
          heading={t("rsvpEmbedIframeHeading", "Or embed it in the page")}
          sub={t("rsvpEmbedIframeSub", "The booking form appears inside your page.")}
        />
        {/* The one genuinely missing step: WHERE this goes. Pasting HTML is
            only obvious if you already know your site builder has a block
            for it. */}
        <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
          {t(
            "rsvpEmbedIframeWhere",
            "In WordPress, Wix or Squarespace: add an “Embed HTML” block, then paste.",
          )}
        </p>
      </div>

      {/* Most owners don't edit their own site — hand the whole thing to
          whoever does, in one tap. Opens THEIR mail app pre-filled; nothing
          is sent on their behalf. */}
      <a
        href={mailtoHref}
        className="inline-flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <Mail className="w-3.5 h-3.5" aria-hidden="true" />
        {t("rsvpEmbedSendDev", "Send to whoever runs my site")}
      </a>
    </div>
  );
}


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
    guest_can_pick_table: false,
    max_combo_size: "",
    contact_phone: "",
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
      guest_can_pick_table: !!s.guest_can_pick_table,
      max_combo_size: s.max_combo_size ?? "",
      contact_phone: s.contact_phone ?? "",
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
      const code = e?.response?.data?.detail?.error;
      if (code === "slug_reserved") {
        setSlugError(
          t("rsvpSlugReserved", "That word is reserved — pick a different link."),
        );
      } else if (e?.response?.status === 409) {
        setSlugError(t("rsvpSlugTaken", "That link is taken — try another."));
      } else {
        setSlugError(code || t("rsvpSlugError", "Couldn't update the link."));
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
    settings.guest_can_pick_table = !!form.guest_can_pick_table;
    if (toInt(form.max_combo_size) !== undefined) {
      settings.max_combo_size = Math.max(2, Math.min(6, toInt(form.max_combo_size)));
    }
    // Contact phone shown on the public booking page. Trimmed; blank → null
    // (clears it, falling back to the business profile phone server-side).
    settings.contact_phone = form.contact_phone.trim().slice(0, 40) || null;
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

      {/* Add to your website — button + iframe snippets, once the page is live. */}
      {enabled && publicUrl && (
        <EmbedOnWebsite publicUrl={publicUrl} venueName={data?.business_name} t={t} />
      )}

      {/* Opening / booking hours — the hours each weekday a guest can book.
          These feed the slot generator (reservation_service reads
          booking_hours first, before any fallback), so the times guests see
          come from when the owner actually opens, not a hard-coded default. */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
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

        <WeekHoursEditor
          t={t}
          hours={hours}
          setHourDay={setHourDay}
          onApplyMonToAll={applyMonToAll}
        />

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
        {/* Contact phone — shown on the public booking page so guests can call
            (big groups, questions). Blank uses the business profile phone. */}
        <div>
          <label
            htmlFor="rsvp-contact-phone"
            className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t("rsvpContactPhone", "Contact phone (shown to guests)")}
          </label>
          <input
            id="rsvp-contact-phone"
            type="tel"
            inputMode="tel"
            value={form.contact_phone}
            onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
            placeholder={t("rsvpContactPhonePh", "+45 12 34 56 78")}
            maxLength={40}
            className="w-full sm:max-w-[18rem] h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100"
          />
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
            {t("rsvpContactPhoneHint", "Guests see a tap-to-call link on your booking page. Leave blank to use your business phone.")}
          </p>
        </div>
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
        {/* Guest table-choice — when off (default), the public widget hides the
            floor picker and auto-assigns the best free table (owner keeps
            seating control). */}
        <div className="pt-3 border-t border-gray-100 dark:border-gray-800">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!form.guest_can_pick_table}
              onChange={(e) => setForm((f) => ({ ...f, guest_can_pick_table: e.target.checked }))}
              className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
              {t("rsvpGuestPickSetting", "Let guests choose their table")}
              <span className="block text-xs text-gray-400 dark:text-gray-500">
                {t("rsvpGuestPickSettingHint", "Off: the booking page auto-assigns the best free table (you keep seating control). On: guests can tap a specific table on the floor map.")}
              </span>
            </span>
          </label>
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
        {!smsUnlocked && canPurchaseInApp() && (
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
