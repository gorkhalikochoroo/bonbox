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
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEEKDAY_KEY, toMin, sittingMinutes, openTimesFor, hm, bookableHoursFromSettings } from "../utils/bookingTimes";
import { warningFrom, roomFullText } from "../utils/bookingRefusal";
import { createPortal } from "react-dom";
import {
  CalendarCheck,
  Plus,
  Minus,
  Trash2,
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
  Settings,
  SlidersHorizontal,
  ExternalLink,
  HelpCircle,
  Pencil,
  Mail,
  Volume2,
  VolumeX,
  LogOut,
  MoreHorizontal,
  Hourglass,
  Gauge,
  ListOrdered,
  Loader2,
  CalendarOff,
  WifiOff,
  Unplug,
} from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import api from "../services/api";
import { haptic } from "../utils/haptics";
import { getSoundStatus, subscribeSound, testSound } from "../utils/sound";
import { RESERVATIONS_CHANGED_EVENT } from "../lib/liveAlertKinds";
import {
  BOOK_FRESH_EVENT,
  BOOK_UNREACHABLE_EVENT,
  WAKE_GAP_MS,
  safetyReloadMs,
  unwatchBook,
  watchBook,
} from "../lib/bookLive";
import { clearStandToken, rememberStandLayout, rememberedStandLayout, setStandToken, standTokenFromPath } from "../services/standAuth";
import { bookFailWords } from "../utils/bookFailWords";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import PartySizeChips from "../components/reservations/PartySizeChips";
import { zoneTones } from "../utils/zoneColors";
import { lateMinutes, overdueMinutes, overByText } from "../utils/serviceClock";
import { useEntitlements } from "../hooks/useEntitlements";
import Button from "../components/ui/Button";
import Sheet from "../components/ui/Sheet";
import TabPills from "../components/ui/TabPills";
import UpgradeNudge from "../components/ui/UpgradeNudge";
import DataTable from "../components/ui/DataTable";
import StatStrip from "../components/ui/StatStrip";
import UpcomingRail from "../components/reservations/UpcomingRail";
import { selectUpcoming } from "../utils/upcomingArrivals";
import { monthName } from "../utils/monthlyRecord";
import FilterBar from "../components/ui/FilterBar";
import Empty from "../components/ui/Empty";
import FloorPlan from "../components/FloorPlan";
// deriveFloorState + fmtTime live in utils/floorState so they can be tested;
// one definition each, imported here.
import { deriveFloorState, fmtTime } from "../utils/floorState";
import {
  WALK_IN_SIZES, walkInOptions, closeMsFor, coverCounts, stayMinutes, bySeatedTime, comboRules, seatingNow,
  tablesOf, sameTables, stampIso, bookedWithinSitting,
} from "../utils/hostStand";
import InsightsSection from "../components/reservations/InsightsSection";
import WaitlistSection from "../components/reservations/WaitlistSection";
// The door screen's own build swaps these two for stand/standNoTableFitsSheet
// and stand/standEditBookingSheet (scripts/standBuild.mjs STAND_SWAPS): loaded
// on first use there (fix round 27 Oct; MERGE §5 item 4).
import NoTableFitsSheet from "../components/reservations/NoTableFitsSheet";
import EditBookingSheet from "../components/reservations/EditBookingSheet";
import { useEscToClose, useSheetFocus } from "../hooks/useSheetFocus";
import { snapStart } from "../utils/snapStart";
import AllergyLine, { AllergyIcon } from "../components/reservations/AllergyWords";
import { allergyFacts, allergySentence } from "../utils/allergyWords";
import FreedTableNudge from "../components/reservations/FreedTableNudge";
import { freedSince } from "../utils/freedTables";
import { BookUnavailable, StandNotConnected } from "../components/reservations/BookStates";
import WebsiteBookingKit from "../components/reservations/WebsiteBookingKit";
import BookingNameRow from "../components/reservations/BookingNameRow";
import BookingAccentRow from "../components/reservations/BookingAccentRow";
import BookingLogoRow from "../components/reservations/BookingLogoRow";
import PublicWaitlistSwitch from "../components/reservations/PublicWaitlistSwitch";
import ClosuresCard, { PauseControl } from "../components/reservations/ClosuresCard";
import { isHeldForCheck, heldWhy, heldWanted, heldForPlanCap, heldLooksLikeBot, botApprovalConfirm } from "../utils/bookingHeld";
import PlanCapBanner, { PlanCapHeldNudge, monthCapFromSettings } from "../components/reservations/PlanCapBanner";
// R2 (27 Oct 2026): spam clean-up — the drawer's Spam, a whole wave, the
// block list in Indstillinger.
import { SpamButton, SpamWaveBox, SpamMarkedLine } from "../components/reservations/SpamActions";
import ContactBlocksCard from "../components/reservations/ContactBlocksCard";
// R9 (27 Oct 2026): settings that tell the truth — the link card with old
// links, one save per card, the phone's jump row, "booking went on".
import BookingLinkCard from "../components/reservations/BookingLinkCard";
import BookingLiveNotice from "../components/reservations/BookingLiveNotice";
import CardSaveBar from "../components/reservations/CardSaveBar";
import SettingsJumpRow from "../components/reservations/SettingsJumpRow";
import { announceActivation, takeActivation } from "../utils/bookingActivation";
import { hoursSource, pacingGap } from "../utils/settingsTruth";
import { activePause, closureOn, fmtClosureRange, todayIso } from "../utils/closures";
import BehandlingRow from "../components/reservations/BehandlingRow";
import SalonRhythmCard from "../components/reservations/SalonRhythmCard";
import WeekHoursEditor from "../components/reservations/WeekHoursEditor";
import StartTimesChoice from "../components/reservations/StartTimesChoice";
import {
  DAY_KEYS, HOURS_SHAPE, cardBookingHours, defaultBookingHours, defaultSalonHours,
  hasSavedBookingHours, hoursProblem, hoursProblemWords, lastBookingSitting,
  parseBookingHours, serializeBookingHours, slotStepOf, snapLasts,
} from "../utils/bookingHours";
import SalonAttention from "../components/reservations/SalonAttention";
import SalonWeekCapacity, { SalonDayCapacity } from "../components/reservations/SalonCapacity";
import StylistRow, { isOwnChair, tidyName, STYLIST_NAME_MAX } from "../components/reservations/StylistRow";
import StylistAddCard from "../components/reservations/StylistAddCard";
import { canPurchaseInApp } from "../utils/platform";
import { venueProfile, bookingModeFor, usesTableFloor, speaksAppointments } from "../config/venueProfiles";
import { formatKr } from "../utils/currency";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { parseServerTime } from "../utils/serverTime";
import { guestText } from "../utils/guestText";


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
  // One vocabulary across list, timeline and floor (Manoj, 1 Oct 2026 —
  // "colour with meaning"): blue = booked and coming, green = in the room,
  // amber = needs an answer, red = gone wrong, grey = history.
  confirmed: {
    pill: "font-medium bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800/60",
    dot: "bg-sky-500 dark:bg-sky-400",
  },
  seated: {
    // The only solid fill — the live state is the heaviest mark in the
    // column. emerald-700 keeps white text at AA (5.5:1).
    pill: "font-semibold bg-emerald-700 text-white dark:bg-emerald-400 dark:text-emerald-950",
    dot: "bg-white/80 dark:bg-emerald-950/60",
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
  // Not a stored status: a confirmed party past its time (5 min grace).
  late: {
    pill: "font-medium bg-orange-50 text-orange-800 ring-1 ring-inset ring-orange-600/25 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-800/60",
    dot: "bg-orange-500 dark:bg-orange-400",
  },
  // Not a stored status: a seated party past its booked end — still in the
  // room (solid, like seated), but red: the table must be turned.
  overdue: {
    pill: "font-semibold bg-red-600 text-white",
    dot: "bg-white/80",
  },
};

// A booking's status as a 3px bar at the row's left edge (the Vagtplan role
// bar's shape) — readable down a list without reading a word. Late = a
// confirmed party past its time.
// The 600 stops: a 3px mark still clears 3:1 on white (amber-400 was 1.7:1).
const STATUS_BAR = {
  requested: "bg-amber-600 dark:bg-amber-400",
  confirmed: "bg-sky-600 dark:bg-sky-400",
  late: "bg-orange-600 dark:bg-orange-400",
  seated: "bg-emerald-600 dark:bg-emerald-400",
  overdue: "bg-red-600 dark:bg-red-400",
  completed: "bg-gray-300 dark:bg-gray-600",
  no_show: "bg-red-500 dark:bg-red-400",
  cancelled: "bg-gray-200 dark:bg-gray-700",
};

// Zone colours: utils/zoneColors (hollow rings, clear of the status hues).
function ZoneDot({ dot }) {
  if (!dot) return null;
  return <span className={"inline-block w-2 h-2 rounded-full border-2 shrink-0 " + dot.cls} role="img" aria-label={dot.zone} title={dot.zone} />;
}

// One "late" and one "over time" everywhere — list, drawer, timeline, floor
// and strip: utils/serviceClock.

// The statuses whose party sizes the server counts as the day's covers.
const COVER_STATUSES = ["confirmed", "seated", "completed"];

// Local YYYY-MM-DD for the book's day picker (defaults to today).
function isoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Table pickers in the order the floor and timeline use: "Bord 2" before
// "Bord 10", not API insertion order.
function byTableLabel(a, b) {
  return String(a?.label || "").localeCompare(String(b?.label || ""), "da", { numeric: true, sensitivity: "base" });
}

// The venue's SERVICE day. The server files every booking by business day
// (06:00 cutoff for food service); the page asked for the calendar day, so a
// drop-in seated at 00:20 vanished from "I dag" and the stand jumped to an
// empty tomorrow at midnight with guests still at the tables. Table venues
// all close their day at 06:00; a salon booking nothing between midnight and
// six loses nothing by the same rule.
function serviceDayIso() {
  return businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
}

// dd/mm/yyyy for DK-style display where a date is shown.
function fmtDkDate(isoStr) {
  if (!isoStr) return "";
  const [y, m, d] = isoStr.split("-");
  return `${d}/${m}/${y}`;
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
  const today = serviceDayIso();
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

// Same, short — "I morgen 2/10", "Lør. 4/10" — for a row that also carries a
// time and a name ("Søndag 27/9 · 1…" truncated in the search results).
function shortDayLabel(iso, t, locale) {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  const today = serviceDayIso();
  let head;
  if (iso === today) head = t("rsvpToday", "Today");
  else if (iso === shiftDay(today, 1)) head = t("rsvpDayTomorrow", "Tomorrow");
  else if (iso === shiftDay(today, -1)) head = t("rsvpDayYesterday", "Yesterday");
  else {
    try {
      const wd = new Date(y, m - 1, d).toLocaleDateString(locale || "en", { weekday: "short" });
      head = wd.charAt(0).toUpperCase() + wd.slice(1);
    } catch {
      head = "";
    }
  }
  return `${head} ${d}/${m}`.trim();
}

// Booking hours — the card's state, the stored shape (one or two periods a
// day, a last booking time), parsing, saving and the checks: utils/
// bookingHours.js (R8). The weekday rows: components/reservations/
// WeekHoursEditor.jsx.

// Tab ids — kept as a const so the ?tab= deep-link (e.g. from the Insights
// "Turn on SMS reminders" action) can validate against the real set.
const RSVP_TABS = ["book", "floor", "behandlinger", "insights", "settings"];

export default function ReservationsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { hasFeature, isReady } = useEntitlements();
  // The side column's second card ("Kommende") needs the book's own data and
  // actions, so the book portals it into this slot instead of lifting state.
  const [railSlot, setRailSlot] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Host stand (/reservations/stand) — the door screen front of house runs.
  // Re-derived from the path because `standalone` is a local const inside
  // BookSection and CANNOT be threaded up: ReservationsPage takes zero
  // parameters and App.jsx passes nothing. That is exactly why the page title,
  // the tab pills and the 300px day rail still rendered on the stand — nothing
  // up here knew it was a service screen.
  // Two different things wear the name "stand":
  //   isStandDevice — opened at /stand/<token> by a PAIRED DEVICE. No session
  //                   at all; authenticates by the token in the path.
  //   isHostStand   — the door-screen CHROME (stripped nav, service layout),
  //                   which both the owner's pop-out and a paired device use.
  const isStandDevice = location.pathname.startsWith("/stand/");
  const isHostStand =
    isStandDevice || location.pathname.endsWith("/reservations/stand");

  // On iOS the stand ships NO manifest (see the selector in index.html), so
  // Add-to-Home bookmarks this exact URL and takes the icon's label from
  // apple-mobile-web-app-title. Point that at the venue, because a host tapping
  // a home screen wants "Bistro Nørrebro", not a second icon called "BonBox"
  // sitting beside the owner app. Restored on unmount so the owner app's own
  // install is untouched.
  useEffect(() => {
    if (!isHostStand || typeof document === "undefined") return undefined;
    const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (!meta) return undefined;
    const prev = meta.getAttribute("content");
    const venue = user?.business_name;
    meta.setAttribute("content", venue ? `${venue} — Vært` : "Vært-skærm");
    return () => {
      if (prev === null) meta.removeAttribute("content");
      else meta.setAttribute("content", prev);
    };
  }, [isHostStand, user?.business_name]);

  // Per-vertical adaptation (Phase A). `bookingMode` gates the Floor tab
  // (TABLE-only) on the venue TYPE; `isProvider` (salon) drives the
  // Aftaler/Tidsbestilling vocabulary swap. Pure config read — no refetch.
  const businessType = user?.business_type;
  // Resources fetched at page level (Insights zone filter + the floor
  // grandfather just below). Soft-fail: the page works without it. The state
  // lives up here so the grandfather flag is in scope before the tab logic.
  const [pageResources, setPageResources] = useState([]);
  // Did that read answer? null = not yet, true = it did, false = it failed.
  // "We could not ask" is never "there are none" (the salon cards' rule) —
  // onlineNotReady below may only be drawn from an answer.
  const [pageResourcesRead, setPageResourcesRead] = useState(null);
  // GRANDFATHER: a venue whose TYPE isn't table-booking but that has ALREADY
  // configured tables keeps its Floor — Phase A type-gating must never strip a
  // surface the owner already built (e.g. a legacy / personal-mode account with
  // a real table plan + live reservations). A table is any non-provider resource.
  const hasTableResources = useMemo(
    () => pageResources.some((r) => r.kind !== "provider"),
    [pageResources],
  );
  const isProvider = bookingModeFor(businessType) === "provider";
  // The WORDS the page speaks: a salon, a shop and a repair trade book a
  // customer for a time (Tidsbestilling · Aftaler · Kunder), food and bars a
  // table. Wording only — `isProvider` stays the engine switch.
  const apptWords = speaksAppointments(businessType);
  // A real TABLE plan exists → the 2D table-plan view + table-style authoring.
  // (A salon with leftover tables from an earlier setup also counts, so the
  // grandfather/clear-tables path stays reachable.)
  // R11 (B11): a paired door screen has no session, so the venue type is
  // unknown until /resources answers. Until then it keeps the shape this
  // device last had — a table venue unless it learned otherwise — so the
  // lens switch, the drop-in button and the drop-in row are there from the
  // first paint instead of pushing the night down when the tables arrive.
  // A read that FAILED is no answer either (P0-1, walk 27 Oct: after a 429
  // the lenses and the drop-in vanished a second after open): the shape
  // stays until a read gets through.
  const standGuessTables =
    isStandDevice && pageResourcesRead !== true && rememberedStandLayout() !== "provider";
  const tablePlan = usesTableFloor(businessType) || hasTableResources || standGuessTables;
  useEffect(() => {
    if (isStandDevice && pageResourcesRead === true) {
      rememberStandLayout(hasTableResources ? "table" : "provider");
    }
  }, [isStandDevice, pageResourcesRead, hasTableResources]);
  // The authoring tab is visible for table venues, venues with existing
  // tables, AND provider venues that need to author stylist (behandler)
  // stations — without it a fresh salon could never create a bookable
  // provider station, so the engine would never return slots.
  const showFloor = tablePlan || isProvider;

  // The book's date lives HERE, not inside BookSection, so the desktop day
  // rail and the book are driven by one value and can never disagree about
  // which day is open. BookSection stays uncontrolled everywhere else (host
  // stand, tests) — see its `day`/`onDayChange` props.
  const [bookDay, setBookDay] = useState(() => serviceDayIso());

  // The active tab is DERIVED from the URL (?tab=), so the query string is the
  // single source of truth — a deep-link (e.g. the Insights "Turn on SMS
  // reminders" action → ?tab=settings) and the browser back/forward button are
  // honoured for free, with no mirror state to keep in sync. Falls back to
  // "book" for a missing / unknown value.
  const tab = useMemo(() => {
    try {
      // The stand shows the book only; its settings door is the gear in the
      // stand header, which navigates to the owner page with ?tab=settings.
      if (isHostStand) return "book";
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
  }, [location.search, showFloor, isProvider, isHostStand]);

  // Fetch the page-level resources (used by the Insights zone filter + the
  // floor grandfather above). Soft-fail — the page works without it.
  useEffect(() => {
    // A paired device has no session, so hasFeature reads false and this
    // effect used to return early — leaving pageResources empty, which made
    // the floor grandfather (hasTableResources) false and silently hid the
    // Gulv tab. The device was showing a host stand with no floor plan.
    // The venue's entitlement is enforced server-side on the wrapped endpoint,
    // so the client gate is the owner's concern, not the device's.
    // P0-1 (walk 27 Oct): the paired device's tables now come from its BOOK's
    // own read, handed up (roomRead below) — one read on open, not two, and
    // the book's one retry per reload after a failed read (R10, acceptBook)
    // brings the answer up here too. Nothing here asks again by itself.
    if (isStandDevice) return undefined;
    if (!isReady || !hasFeature("reservations")) return undefined;
    let alive = true;
    api
      .get("/reservations/resources")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res.data?.resources) ? res.data.resources : null;
        setPageResources(list || []);
        setPageResourcesRead(list !== null);
      })
      .catch(() => {
        if (alive) {
          setPageResources([]);
          setPageResourcesRead(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [isReady, hasFeature, isStandDevice]);

  // The paired device's book read its tables: an array is the answer, null a
  // read that failed with no room on screen yet. "We could not ask" is never
  // "there are none": a room once read stays (as in the book, R10).
  const roomRead = useCallback((list) => {
    if (Array.isArray(list)) {
      setPageResources(list);
      setPageResourcesRead(true);
    } else {
      setPageResourcesRead((was) => (was === true ? true : false));
    }
  }, []);

  // Push 7 — a shop or a workshop (booking mode "none": no Floor tab, no
  // behandler) with nothing the availability engine can book. The engine
  // (reservation_service.available_slots) books active tables and active
  // behandler stations only; with neither, the public page returns no slot
  // on any day. Settings then says so instead of offering online booking as
  // if it worked (QA: "Din offentlige side er live" over a page that showed
  // every day closed). Unknown — not answered yet, or the read failed —
  // never claims it. The book and the waitlist are untouched.
  const onlineNotReady =
    bookingModeFor(businessType) === "none" &&
    pageResourcesRead === true &&
    !pageResources.some((r) => r.is_active !== false);

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
  //
  // A PAIRED DEVICE IS EXEMPT. It has no session, so useEntitlements sees no
  // plan and reads as Free — which showed a host an UPGRADE WALL on the tablet
  // at the door of a venue that is already paying. The entitlement that matters
  // is the OWNER'S, and the server already enforces it: every wrapped stand
  // endpoint runs enforce_feature(user, "reservations") against the venue
  // re-derived from the link row. So this client gate is both wrong and
  // redundant here — if the venue genuinely lacks the feature, the API returns
  // 402 and the page surfaces that honestly instead of guessing.
  // __STAND_BUILD__ (R11): the door screen's own build is only ever a paired
  // device, so the owner's gate and its upgrade card are left out of it.
  if (!__STAND_BUILD__ && !isStandDevice) {
    if (!isReady) return null;
    if (!hasFeature("reservations")) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
        <PageTitle t={t} isProvider={apptWords} />
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
  }

  return (
    // max-w-5xl (1024px) was capping this page on every screen, so hiding the
    // sidebar freed pixels the page then refused to use — ~400 dead on a 1440
    // display. The cap only lifts at xl, exactly where the day rail appears;
    // below that the single column is still the right shape.
    <div
      className={
        isHostStand
          ? "space-y-4"
          // The page's one piece of atmosphere (Manoj, 1 Oct 2026:
          // "background … nice"): a soft light of the brand green behind the
          // header, fading out before the content — painted as this box's own
          // background. (An absolutely placed layer needed `isolate`, and that
          // stacking context trapped the sheets under the phone's bottom bar.)
          // Rides the brand token, so dark mode gets its own lighter green.
          : "p-4 md:p-8 max-w-5xl xl:max-w-[1400px] 2xl:max-w-[1728px] mx-auto space-y-4 sm:space-y-6 " +
            "bg-no-repeat bg-[radial-gradient(65%_24rem_at_50%_0%,rgb(var(--brand-green-accent)/0.14),transparent_70%)] " +
            "dark:bg-[radial-gradient(65%_24rem_at_50%_0%,rgb(var(--brand-green-accent)/0.08),transparent_70%)]" +
            // Phone: the same light, shortened so it fades out at the tabs
            // (0.7 × 10rem = 112px) instead of running 384px down behind the
            // stepper and the stats. Compound dark: — `dark:` is emitted after
            // `max-sm:` (index.css custom variant).
            " max-sm:bg-[radial-gradient(65%_10rem_at_50%_0%,rgb(var(--brand-green-accent)/0.14),transparent_70%)]" +
            " max-sm:dark:bg-[radial-gradient(65%_10rem_at_50%_0%,rgb(var(--brand-green-accent)/0.08),transparent_70%)]"
      }
    >
      {/* BookSection's own standalone wrapper already sets full-bleed padding
          and safe-area insets, and its header already prints the venue name and
          "Vært-skærm" — the owner wrapper and title would double both. */}
      {!__STAND_BUILD__ && !isHostStand && (
        <PageTitle t={t} isProvider={apptWords} websiteHref="/reservations?tab=settings&show=website" />
      )}
      {!__STAND_BUILD__ && !isHostStand && (
      <TabPills
        tabs={[
          // Salon (provider) reads "Aftaler" (the appointment book) instead of
          // "Reservation book"; the booking primitive underneath is unchanged.
          { id: "book", label: apptWords ? t("rsvpTabBookProvider", "Appointments") : t("rsvpTabBook", "Reservation book") },
          // Floor/station tab — table venues, venues with existing tables, AND
          // provider venues (where it authors stylist stations). Provider venues
          // read "Behandlere"; table venues keep "Floor".
          ...(showFloor
            ? [
                {
                  id: "floor",
                  // A shop or a workshop that built places reads "Pladser":
                  // its tab said "Borde" (Push 8 review).
                  label: isProvider
                    ? t("rsvpTabProviders", "Stylists")
                    : apptWords
                      ? t("rsvpTabFloorAppt", "Spaces")
                      : t("rsvpTabFloor", "Floor"),
                },
              ]
            : []),
          // Behandlinger (salon service catalog) — salon (provider) venues only.
          // "Behandlinger" stays Danish in every UI language (DK terminology lock).
          ...(isProvider
            ? [{ id: "behandlinger", label: t("rsvpTabBehandlinger", "Services") }]
            : []),
          { id: "insights", label: t("rsvpTabInsights", "Insights") },
          // A salon has five sections. On a 390px phone the fifth was cut
          // (DA 310px of words + 80px of gaps in a 358px row — rubric S12):
          // there Indstillinger stands as the gear (the word stays as its
          // name for a screen reader) and the gaps share the row. sm: up and
          // every other venue are unchanged.
          {
            id: "settings",
            label: t("rsvpTabSettings", "Settings"),
            ...(isProvider ? { phoneIcon: Settings } : {}),
          },
        ]}
        activeId={tab}
        onChange={changeTab}
        ariaLabel={apptWords ? t("rsvpTabsAriaAppt", "Appointment book sections") : t("rsvpTabsAria", "Reservation sections")}
        size="lg"
        phone="underline"
        phoneSpread={isProvider}
        // Phone: 8px under the title row instead of the column's 16 — the
        // tabs belong to the title (they are the page's sections).
        className="max-sm:-mt-2"
      />
      )}

      {/* R9: adding the first table (or behandler) switched online booking
          on — said here, on whichever tab did it, until dismissed. */}
      {!__STAND_BUILD__ && !isHostStand && <BookingLiveNotice t={t} />}

      {/* Two columns from xl (1280px) up — the rail is additive, so below that
          breakpoint this collapses to exactly the single column shipped
          before. min-w-0 on the book so a wide timeline scrolls inside its
          own column instead of pushing the grid open. */}
      {tab === "book" && (
        <div
          className={
            isHostStand
              ? ""
              // The calendar rail only where the full table still fits beside
              // it: from 1680. At 1280–1440 it left the book 666–752px, and
              // at 1536 it still clipped the row actions.
              : "min-[1680px]:grid min-[1680px]:grid-cols-[300px_minmax(0,1fr)] min-[1680px]:gap-6 min-[1680px]:items-start"
          }
        >
          {/* A host never changes the date mid-service, and the month grid was
              holding the prime top-left of a screen read at arm's length. */}
          {!__STAND_BUILD__ && !isHostStand && (
          <div className="hidden min-[1680px]:block min-[1680px]:sticky min-[1680px]:top-6">
            <DayRail day={bookDay} onPick={setBookDay} t={t} apptWords={apptWords} />
            <div ref={setRailSlot} className="mt-4 empty:hidden" />
          </div>
          )}
          <div className="min-w-0">
            <BookSection
              t={t}
              businessType={user?.business_type}
              tableFloor={tablePlan}
              day={bookDay}
              onDayChange={setBookDay}
              railSlot={isHostStand ? null : railSlot}
              onRoomRead={isStandDevice ? roomRead : null}
            />
          </div>
        </div>
      )}
      {/* The owner's tabs — never in the door screen's own build (R11). */}
      {!__STAND_BUILD__ && tab === "floor" && showFloor && <FloorSection t={t} businessType={user?.business_type} />}
      {!__STAND_BUILD__ && tab === "behandlinger" && isProvider && <BehandlingerSection t={t} />}
      {/* Insights mounts lazily (only when its tab is open) so it never blocks
          the Book view's first paint; the fetch fires on mount. */}
      {!__STAND_BUILD__ && tab === "insights" && <InsightsSection t={t} zones={insightsZones} />}
      {!__STAND_BUILD__ && tab === "settings" && (
        <SettingsSection t={t} user={user} tablePlan={tablePlan} onlineNotReady={onlineNotReady} />
      )}
    </div>
  );
}

function PageTitle({ t, isProvider = false, websiteHref = "" }) {
  // Salon (provider) reads "Tidsbestilling" with an Aftaler-flavoured subtitle.
  // The booking primitive underneath is unchanged — this is vocabulary + IA
  // only (Phase A is NOT appointment-grade; honesty gate #2).
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-xl sm:text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
          <CalendarCheck className="w-5 h-5 sm:w-6 sm:h-6 shrink-0 text-gray-700 dark:text-gray-200" aria-hidden />
          {isProvider ? t("rsvpOwnerTitleProvider", "Appointments") : t("rsvpOwnerTitle", "Reservations")}
        </h1>
        {/* The way in to "Book bord på din hjemmeside" from every tab — it
            used to live only at the bottom of Settings. Quiet, and in the
            title row, so it adds no row of its own on a phone. Below 390px
            the label does not fit beside the title (at 360 it pushed
            "Reservationer" 20px past its box), so it is the globe alone —
            named by aria-label, explained by title. flex-wrap is the net for
            a longer title or wider font: the entry drops to its own line
            rather than cutting the title. */}
        {websiteHref && (
          <Link
            to={websiteHref}
            data-testid="rsvp-website-entry"
            aria-label={t("rsvpWebEntry")}
            title={t("rsvpWebEntry")}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 h-10 sm:h-9 min-h-0! px-3 max-[389px]:w-10 max-[389px]:px-0 rounded-lg border border-[rgb(var(--surface-line))] bg-[rgb(var(--surface-card))] text-[13px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-green-accent))]"
          >
            <Globe className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
            <span className="max-[389px]:hidden">{t("rsvpWebEntry")}</span>
          </Link>
        )}
      </div>
      {/* Hidden on a phone. It tells a first-time owner what this page IS,
          which is worth 40px on a laptop and worth nothing to a host at 19:30
          who opened it to seat a walk-in — measured, it was part of 877px of
          chrome sitting above the floor plan on a 390px screen. */}
      <p className="hidden sm:block text-sm text-gray-600 dark:text-gray-400 mt-1">
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

// A toolbar button's face on a phone: the same bordered surface as the day
// stepper beside it, so each toolbar row reads as one set of controls. From
// sm: up these buttons keep their bare icon look.
// Phone controls are 40px with 13px text: at 44px and 14px every row was a
// slab, and the toolbar alone filled a third of the screen. 40px is still well
// clear of WCAG 2.2's 24px target minimum; `min-h-0!` releases index.css's
// global 44px touch floor for exactly these controls.
const PHONE_TOOL =
  "max-sm:min-h-0! max-sm:text-[13px] " +
  "max-sm:border max-sm:border-[rgb(var(--surface-line))] max-sm:bg-[rgb(var(--surface-card))] " +
  "max-sm:hover:bg-gray-50 max-sm:dark:hover:bg-gray-700";
// Square, stretched to the height of the row it sits in (the stepper: a 40px
// centre and ◂ ▸ inside its 1px border, 42px in all — at 38px inside the border
// the day arrows were 38px targets).
const PHONE_TOOL_SQUARE = "max-sm:h-auto max-sm:w-10 max-sm:shrink-0";
// Drop-in and New booking on a phone: equal halves of one 40px row.
const PHONE_ACTION = "max-sm:h-10 max-sm:min-h-0! max-sm:px-3 max-sm:text-[13px]";

// Status → localized label. Shared by the Liste status column + (later) the
// floor/timeline. Mirrors the map ReservationRow used.
// `checkedIn`: a shop or a workshop (appointment words, no chair) — its
// customer is checked in ("Tjek ind" → "Tjekket ind"), nobody "sits". The
// salon keeps "Sidder": its customer is in the chair.
function statusLabels(t, checkedIn = false) {
  return {
    requested: t("rsvpStatusRequested", "Requested"),
    confirmed: t("rsvpStatusConfirmed", "Confirmed"),
    seated: checkedIn ? t("rsvpStatusSeatedAppt", "Checked in") : t("rsvpStatusSeated", "Seated"),
    completed: t("rsvpStatusCompleted", "Completed"),
    no_show: t("rsvpStatusNoShow", "No-show"),
    cancelled: t("rsvpStatusCancelled", "Cancelled"),
  };
}

// Table(s) cell — a combined seating shows the "Bord 1 + Bord 2" chip, a
// single table its label, an unassigned booking a muted dash.
// `apptWords`: a shop's or a workshop's place ("Plads"), never a table.
function TablesCell({ r, labelById, t, seatsById = null, zoneById = null, apptWords = false }) {
  // More guests than the table(s) seat — after "Gem alligevel" this showed
  // only on the floor plan ("10/8"). Live bookings only.
  const heldIds = Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
    ? r.combined_resource_ids : r.resource_id ? [r.resource_id] : [];
  const seats = seatsById ? heldIds.reduce((sum, id) => sum + (seatsById[String(id)] || 0), 0) : 0;
  const over = seats > 0 && Number(r.party_size) > seats && ["requested", "confirmed", "seated"].includes(r.status);
  const overTag = over ? (
    <span
      className="ml-1 inline-flex items-center gap-0.5 text-[12px] font-medium tabular-nums text-gray-700 dark:text-gray-200"
      title={apptWords
        ? t("rsvpOverFullAppt", "{n} people at {seats} places.", { n: r.party_size, seats })
        : t("rsvpOverFull", "{n} guests at {seats} seats.", { n: r.party_size, seats })}
    >
      {r.party_size}/{seats}
    </span>
  ) : null;
  const combined =
    Array.isArray(r.combined_resource_labels) && r.combined_resource_labels.length > 1
      ? r.combined_resource_labels
      : null;
  if (combined) {
    return (
      <span className="inline-flex items-center">
      <span
        title={combined.join(" + ")}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 max-w-[9.5rem] truncate"
      >
        <Link2 className="w-3.5 h-3.5 shrink-0" aria-hidden />
        {combined.join(" + ")}
      </span>
      {overTag}
      </span>
    );
  }
  if (r.resource_id) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
        <ZoneDot dot={zoneById ? zoneById[String(r.resource_id)] : null} />
        {labelById[String(r.resource_id)] || (apptWords ? t("rsvpSeatWalkInTableAppt", "Space") : t("rsvpTableFallback", "Table"))}
        {overTag}
      </span>
    );
  }
  // A live booking with no table is something the host has to fix — say so,
  // like the phone row does, instead of a bare dash. Amber: it needs the
  // host (R11 — a confirmed group "Intet bord" read as a quiet grey fact).
  if (["confirmed", "seated"].includes(r.status)) {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 dark:text-amber-300 whitespace-nowrap" data-no-table="">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        {apptWords ? t("rsvpNoTableShortAppt", "No space") : t("rsvpNoTableShort", "No table")}
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
// How long a finished party sat: "52 min", "1 t 4 min".
function stayText(min, t) {
  return min < 60
    ? t("rsvpStayMin", "{n} min", { n: min })
    : t("rsvpStayHours", "{h} h {m} min", { h: Math.floor(min / 60), m: min % 60 });
}

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
    guestText(r.allergy_note),
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
        <AllergyIcon
          // An octagon for severe, a triangle otherwise (R11, B8) — never
          // colour alone. A cancelled booking's allergy is history — grey.
          level={severe ? "severe" : "allergy"}
          role="img"
          className={"w-4 h-4 " + (r.status === "cancelled" ? "text-gray-400 dark:text-gray-500" : severe ? "text-red-600 dark:text-red-400" : "text-amber-500 dark:text-amber-400")}
          aria-label={severe ? t("rsvpSevSevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
          title={allergyTitle || (severe ? t("rsvpSevSevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy"))}
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
        <PartyPopper className="w-4 h-4" aria-label={guestText(r.occasion)} title={guestText(r.occasion)} />
      )}
      {r.source === "public" && (
        <Globe className="w-4 h-4" aria-label={t("rsvpSourceOnline", "online")} title={t("rsvpSourceOnline", "online")} />
      )}
      {r.source === "walk_in" && (
        <Footprints className="w-4 h-4" aria-label={t("rsvpSourceWalkIn", "drop-in")} title={t("rsvpSourceWalkIn", "drop-in")} />
      )}
    </div>
  );
}

// Phase-3 lens lands here. Honest placeholder until then.
function ComingSoonView({ icon, title, body }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] py-12 text-center">
      <div className="text-gray-300 dark:text-gray-600 mb-2 flex justify-center">{icon}</div>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  );
}

// ─── Plan (visual floor) ──────────────────────────────────────────────
// Per-table live state (seated > upcoming > free) comes from
// utils/floorState.deriveFloorState — including the hold window that keeps a
// table booked for tonight from reading "occupied" at lunch.
// FloorView — the Floor lens of the book. A thin adapter: it derives the
// per-table live state (deriveFloorState) and the "your next booking" accent
// id, then hands them to the premium 2D FloorPlan (the spatial room with
// draggable tables, chairs, zone bands, and edit/save). The tap + seat-now
// handlers are passed straight through so FloorPlan reuses the page's shared
// ReservationDrawer + SeatNowSheet.
function FloorView({ reservations, resources, t, businessType, onSelect, onSeatNow, onResourcesChanged, canArrange = true, fixtures = [], fitToScreen = false }) {
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
    // The door screen's own build loads the plan the first time the Plan
    // lens opens (src/stand/standFloorPlan.jsx, R11): its skeleton stands in
    // meanwhile. In the owner app nothing waits here.
    <Suspense fallback={<FloorSkeleton />}>
      <FloorPlan
        cells={cells}
        nowMs={nowMs}
        t={t}
        businessType={businessType}
        onSelect={onSelect}
        onSeatNow={onSeatNow}
        nextBookingId={nextBookingId}
        onResourcesChanged={onResourcesChanged}
        canArrange={canArrange}
        fixtures={fixtures}
        fitToScreen={fitToScreen}
      />
    </Suspense>
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

// Several tables for one party ("Bord 3 + Bord 4") — the way through "no
// table seats 12", which the refusal tells the host to do and which had no
// control. Tables taken at the booking's time can't be ticked.
// `apptWords`: a shop's or a workshop's places, counted as people.
function TableCombiner({ r, tables, busyIds, t, busy, onSave, apptWords = false }) {
  const current = (Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
    ? r.combined_resource_ids
    : r.resource_id ? [r.resource_id] : []
  ).map(String);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(current);
  const seatsOf = Object.fromEntries(tables.map((tb) => [String(tb.id), Number(tb.capacity_seats) || 0]));
  const total = picked.reduce((sum, id) => sum + (seatsOf[id] || 0), 0);
  if (!open) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => { setPicked(current); setOpen(true); }}
        // A real button — as plain text it read as a caption.
        className="mt-2 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
      >
        <Link2 className="w-4 h-4" aria-hidden />
        {apptWords
          ? current.length > 1 ? t("rsvpCombineChangeAppt", "Change spaces") : t("rsvpCombineTablesAppt", "Join spaces")
          : current.length > 1 ? t("rsvpCombineChange", "Change tables") : t("rsvpCombineTables", "Push tables together")}
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2.5">
      <div className={"text-[12px] tabular-nums " + (total >= r.party_size ? "text-gray-500 dark:text-gray-400" : "font-medium text-gray-800 dark:text-gray-100")}>
        {apptWords
          ? Number(r.party_size) === 1
            ? t("rsvpCombineSeatsOneAppt", "{seats} places for 1 person", { seats: total })
            : t("rsvpCombineSeatsAppt", "{seats} places for {n} people", { seats: total, n: r.party_size })
          : Number(r.party_size) === 1
            ? t("rsvpCombineSeatsOne", "{seats} seats for 1 guest", { seats: total })
            : t("rsvpCombineSeats", "{seats} seats for {n} guests", { seats: total, n: r.party_size })}
      </div>
      {/* Every table, no inner scroll: Bord 11–13 and Vindue 1 hid below a
          208px box with nothing saying there was more. */}
      <div className="grid grid-cols-2 gap-1">
        {[...tables].sort(byTableLabel).map((tb) => {
          const id = String(tb.id);
          const on = picked.includes(id);
          const taken = busyIds.has(id) && !current.includes(id);
          return (
            <label
              key={id}
              className={"flex items-center gap-2 h-10 px-2 rounded-md text-sm " + (taken ? "opacity-50" : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800")}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={busy || taken || (!on && picked.length >= 6)}
                onChange={() => setPicked((p) => (on ? p.filter((x) => x !== id) : [...p, id]))}
                className="w-4 h-4 accent-gray-900 dark:accent-gray-100"
              />
              <span className="truncate text-gray-900 dark:text-gray-100">{tb.label}</span>
              <span className="ml-auto text-[12px] tabular-nums text-gray-500 dark:text-gray-400">
                {taken ? t("rsvpTableTakenShort", "taken") : tb.capacity_seats}
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="md"
          variant="primary"
          disabled={busy || picked.length < 2}
          // In table order, so it reads "Bord 3 + Bord 6", not tap order.
          onClick={() => onSave([...tables].sort(byTableLabel).map((tb) => String(tb.id)).filter((id) => picked.includes(id)))}
        >
          {apptWords ? t("rsvpCombineSaveAppt", "Use these spaces") : t("rsvpCombineSave", "Seat at these tables")}
        </Button>
        <Button size="md" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          {t("cancel", "Cancel")}
        </Button>
      </div>
    </div>
  );
}

function ReservationDrawer({
  reservation,
  t,
  busy,
  onStatus,
  onClose,
  // A paired door device (/stand/<token>): no session, no plan to change.
  onStand = false,
  onEdit = null,
  tableLabel = null,
  tables = [],
  onAssign = null,
  assignBusy = false,
  assignError = "",
  isProvider = false,
  // Appointment words (a salon, a shop, a repair trade): "Tjek ind", not
  // "Sæt til bords"; people, not guests (vertical-fit review, Oct 2026).
  apptWords = false,
  // A shop or a workshop: "Tjekket ind", not "Sidder" (statusLabels).
  checkedIn = false,
  behandlerName = "",
  highlight = false,
  onAllergyAction = null,
  allergyActionBusy = false,
  allergyActionError = "",
  nowTs = 0,
  // Tables another live booking holds at this booking's time.
  busyIds = new Set(),
  onAssignMany = null,
  // Not today's book: say which day, and no "Seat" (it was offered for a
  // booking next Monday, with a confirm that named only the time).
  isToday = true,
  dayLabel = null,
  // A HELD online booking (bookingHeld.js): the booking screen kept it for
  // the owner's OK. Amber "Tjek før du bekræfter" + why (R1 D7).
  held = false,
  // R2: spam clean-up (components/reservations/SpamActions.jsx) — the
  // owner's book only; null on a paired stand device (no owner session).
  // Called with the server's answer after a spam mark, an undo or a wave.
  onSpamDone = null,
}) {
  if (!reservation) return null;
  const r = reservation;
  // "Didn't arrive" can't be true before they were due — a no-show tapped
  // at 17:00 for a 19:30 booking emptied the table and logged a false miss.
  const due = !r.starts_at || !nowTs || new Date(r.starts_at).getTime() <= nowTs;
  // Seats at the table(s) this booking holds — "12 at 8 seats" after a
  // "Gem alligevel" was only visible on the floor plan.
  const heldIds = (Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
    ? r.combined_resource_ids
    : r.resource_id ? [r.resource_id] : []).map(String);
  const heldSeats = tables
    .filter((tb) => heldIds.includes(String(tb.id)))
    .reduce((sum, tb) => sum + (Number(tb.capacity_seats) || 0), 0);
  // Live, single-table bookings get the table as a select (move it there).
  const canAssign =
    !isProvider &&
    !!onAssign &&
    tables.length > 0 &&
    ["requested", "confirmed", "seated"].includes(r.status) &&
    !(Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length > 1);
  const labels = statusLabels(t, checkedIn);
  const hasAllergy =
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity;
  const severe = r.allergy_severity === "severe";
  const allergyText = [
    (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
    guestText(r.allergy_note),
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
    if (isToday) primary = { label: apptWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatAction", "Seat"), to: "seated", icon: Armchair };
    if (due) secondary.push({ id: "no_show", label: t("rsvpNoShowAction", "No-show"), to: "no_show" });
    secondary.push({ id: "cancel", label: t("rsvpCancelAction", "Cancel"), to: "cancelled" });
  } else if (r.status === "seated") {
    primary = { label: t("rsvpCompleteAction", "Complete"), to: "completed", icon: CheckCircle2 };
    // A mis-tap on "Sæt til bords" had no way back. A drop-in has no booking
    // to go back to — "undo" turned it into a fake, late reservation — so
    // it is removed instead (no guest notice; nobody booked).
    if (r.source === "walk_in") {
      secondary.push({ id: "remove_walkin", label: t("rsvpRemoveWalkIn", "Remove drop-in"), to: "cancelled" });
    } else {
      secondary.push({ id: "reopen", label: t("rsvpUndoSeat", "Undo seating"), to: "confirmed" });
    }
  } else if (r.status === "no_show") {
    // A no-show tapped by mistake, or a party that turns up late, has to be
    // recoverable — the drawer used to offer only "Close".
    secondary.push({ id: "reopen", label: t("rsvpReopenAction", "Reopen"), to: "confirmed" });
  } else if (r.status === "completed") {
    secondary.push({ id: "reopen", label: t("rsvpReopenAction", "Reopen"), to: "seated" });
  }
  const PrimaryIcon = primary?.icon || null;

  return (
    // Phone: a real bottom sheet — backdrop stays visible above it, so tap-out
    // finally works one-handed (the old full-screen right panel's only dismiss
    // was a 36px X in the far corner). Desktop (≥sm): the exact right slide-in
    // panel as before, pixel-identical. Scroll lock + Esc come with the Sheet.
    <Sheet
      onClose={onClose}
      // A name for screen readers: the booking it shows.
      ariaLabel={`${guestText(r.guest_name) || t("rsvpGuest", "Guest")} · ${fmtTime(r.starts_at)}`}
      desktop="right"
      panelClassName={
        "bg-white dark:bg-[rgb(var(--surface-raised))] shadow-2xl border-t sm:border-t-0 sm:border-l border-gray-200 dark:border-[rgb(var(--surface-line-strong))] transition-shadow duration-700 " +
        (highlight ? "ring-2 ring-inset ring-gray-900 dark:ring-gray-100" : "")
      }
    >
        {/* Scrollable detail — the action bar below stays pinned. */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {dayLabel && <span className="text-gray-500 dark:text-gray-400 font-medium">{dayLabel} · </span>}
                {fmtTime(r.starts_at)}–{fmtTime(r.ends_at)}
              </div>
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {guestText(r.guest_name) || "—"}
              </div>
              {held && (
                <div data-testid="rsvp-held-drawer" className="mt-1 space-y-0.5">
                  <div className="inline-flex items-center gap-1 text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                    {t("rsvpHeldLabel", "Check before you confirm")}
                  </div>
                  <p className="text-[12px] leading-snug text-gray-600 dark:text-gray-400">
                    {heldWhy(r, t, { apptWords })}
                  </p>
                  {/* R1b: held because the plan's monthly cap is reached —
                      the upgrade nudge (web only). Never on the door screen
                      (fix round 27 Oct): a paired device has no session and
                      no plan to change — its own build drops it whole. */}
                  {!__STAND_BUILD__ && !onStand && heldForPlanCap(r) && <PlanCapHeldNudge t={t} apptWords={apptWords} />}
                  {/* The table(s) or the stylist it was booked for — it holds
                      none of them until it is confirmed. */}
                  {heldWanted(r) && (
                    <p data-testid="rsvp-held-wanted" className="text-[12px] leading-snug text-gray-600 dark:text-gray-400">
                      {t("rsvpHeldWanted", "Booked for: {what}", { what: heldWanted(r) })}
                    </p>
                  )}
                </div>
              )}
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
                  {/* One is one here too: a shop's single customer read
                      "1 people" in English. */}
                  {apptWords
                    ? Number(r.party_size) === 1
                      ? t("rsvpPersonOne", "1 person")
                      : t("rsvpPartyPeople", "{n} people", { n: r.party_size })
                    : Number(r.party_size) === 1
                      ? t("rsvpPartyOne", "1 guest")
                      : t("rsvpPartyN", "{n} guests", { n: r.party_size })}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close", "Close")}
              className="-mt-1 h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* A party past its time reads "Forsinket · +30 min", in the list's
              orange; a table running over "Overtid · +47 min" in red — the
              drawer said "Bekræftet" and a calm green "Sidder". */}
          {overdueMinutes(r, nowTs, isToday) ? (
            <StatusPill status="overdue" label={t("rsvpOverduePill", "Over time · {txt}", { txt: overByText(t, overdueMinutes(r, nowTs, isToday)) })} />
          ) : lateMinutes(r, nowTs, isToday) ? (
            <StatusPill status="late" label={t("rsvpLatePillText", "Late · {txt}", { txt: overByText(t, lateMinutes(r, nowTs, isToday)) })} />
          ) : (
            <StatusPill status={r.status} label={labels[r.status] || r.status} />
          )}
          {/* R2: marked as spam — said, not a bare "Aflyst". */}
          <SpamMarkedLine r={r} t={t} apptWords={apptWords} />
          {/* R2: an open online request made with many others — decline the
              whole wave in one go (asks the server how big it is). */}
          {!__STAND_BUILD__ && onSpamDone && <SpamWaveBox r={r} t={t} apptWords={apptWords} onDone={onSpamDone} />}

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
                <AllergyIcon level={severe ? "severe" : "allergy"} className="w-4 h-4" aria-hidden />
                {severe ? t("rsvpSevSevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
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
              {/* An allergy the host thinks they confirmed, and didn't, is the
                  one failure on this drawer nobody can afford to miss. The
                  handler used to swallow the error and silently refetch, so
                  the prompt just reappeared and the host tapped again. */}
              {allergyActionError && (
                <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">{allergyActionError}</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            {/* Provider (salon) → Behandling + Behandler rows; table venues
                keep the Table row. */}
            {isProvider ? (
              <>
                {r.service_name && (
                  <DetailRow label={t("rsvpColBehandling", "Service")} value={r.service_name} />
                )}
                <DetailRow
                  label={t("rsvpColBehandler", "Stylist")}
                  value={behandlerName || t("rsvpBookValgfriOwner", "Any stylist")}
                />
              </>
            ) : (
              // The table select below already names it — the drawer said
              // "Bord 2" twice, once as a row and once in the select.
              tableLabel && !canAssign && (
                <DetailRow label={apptWords ? t("rsvpColTableAppt", "Space") : t("rsvpColTable", "Table")} value={tableLabel} />
              )
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
            {r.occasion && <DetailRow label={t("rsvpOccasion", "Occasion")} value={guestText(r.occasion)} />}
          </div>

          {/* Assign / move table — for live bookings (not combined seatings,
              which span multiple tables and are managed by the engine).
              Picking a table PATCHes immediately; 409 slot_unavailable shows
              an honest inline error and leaves the booking untouched. */}
          {canAssign && (
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {apptWords
                    ? r.resource_id ? t("rsvpColTableAppt", "Space") : t("rsvpAssignTableAppt", "Assign a space")
                    : r.resource_id ? t("rsvpColTable", "Table") : t("rsvpAssignTable", "Assign table")}
                </label>
                <select
                  id="rsvp-drawer-table"
                  value={r.resource_id ? String(r.resource_id) : ""}
                  disabled={busy || assignBusy}
                  onChange={(e) => onAssign(r, e.target.value || null)}
                  aria-label={apptWords ? t("rsvpAssignTableAppt", "Assign a space") : t("rsvpAssignTable", "Assign table")}
                  className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm disabled:opacity-50 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
                >
                  <option value="">
                    {apptWords
                      ? r.resource_id
                        ? t("rsvpNoTableShortAppt", "No space")
                        : t("rsvpChooseTableAppt", "Choose a space…")
                      : r.resource_id
                        ? t("rsvpNoTable", "No table")
                        : t("rsvpChooseTable", "Choose a table…")}
                  </option>
                  {/* Taken at this time → can't be picked (it silently
                      refused); too small → still allowed, but said. */}
                  {[...tables].sort(byTableLabel).map((tb) => {
                    const id = String(tb.id);
                    const taken = busyIds.has(id) && id !== String(r.resource_id || "");
                    const small = Number(tb.capacity_seats) < Number(r.party_size);
                    return (
                      <option key={tb.id} value={id} disabled={taken}>
                        {/* One is one: "Bord 1 · 1 plads", as the sheets say; a
                            shop's place counts people ("Plads 1 · 1 pers."). */}
                        {tb.label} · {tb.capacity_seats} {capacityWord(t, tb.capacity_seats, apptWords)}
                        {taken ? ` · ${t("rsvpTableTakenShort", "taken")}` : small ? ` · ${t("rsvpTableTooSmallShort", "too small")}` : ""}
                      </option>
                    );
                  })}
                </select>
                {heldSeats > 0 && Number(r.party_size) > heldSeats && (
                  <p className="mt-1.5 text-[12px] font-medium text-gray-700 dark:text-gray-200">
                    {apptWords
                      ? t("rsvpOverFullAppt", "{n} people at {seats} places.", { n: r.party_size, seats: heldSeats })
                      : t("rsvpOverFull", "{n} guests at {seats} seats.", { n: r.party_size, seats: heldSeats })}
                  </p>
                )}
                {assignError && (
                  <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">{assignError}</p>
                )}
                {onAssignMany && tables.length > 1 && (
                  <TableCombiner r={r} tables={tables} busyIds={busyIds} t={t} busy={busy || assignBusy} onSave={(ids) => onAssignMany(r, ids)} apptWords={apptWords} />
                )}
              </div>
            )}
          {/* A party already across several tables can change them here. */}
          {!canAssign && !isProvider && onAssignMany && tables.length > 1 &&
            ["requested", "confirmed", "seated"].includes(r.status) && (
              <div>
                {heldSeats > 0 && Number(r.party_size) > heldSeats && (
                  <p className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
                    {apptWords
                      ? t("rsvpOverFullAppt", "{n} people at {seats} places.", { n: r.party_size, seats: heldSeats })
                      : t("rsvpOverFull", "{n} guests at {seats} seats.", { n: r.party_size, seats: heldSeats })}
                  </p>
                )}
                {assignError && <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">{assignError}</p>}
                <TableCombiner r={r} tables={tables} busyIds={busyIds} t={t} busy={busy || assignBusy} onSave={(ids) => onAssignMany(r, ids)} apptWords={apptWords} />
              </div>
            )}

          {r.guest_notes && (
            <p className="text-sm text-gray-600 dark:text-gray-300">{guestText(r.guest_notes)}</p>
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
                iconLeft={PrimaryIcon ? <PrimaryIcon className="w-4 h-4" aria-hidden /> : null}
              >
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
                    className={`text-sm font-medium px-2 py-1.5 rounded-md text-gray-500 dark:text-gray-400 ${a.id === "reopen" ? "hover:text-gray-900 dark:hover:text-gray-100" : "hover:text-red-600 dark:hover:text-red-400"} transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1`}
                  >
                    {a.label}
                  </button>
                ))}
                {/* R2: "Spam" — online bookings only, a quiet word like the rest. */}
                {!__STAND_BUILD__ && onSpamDone && <SpamButton r={r} t={t} apptWords={apptWords} busy={busy} onDone={onSpamDone} />}
              </div>
            )}
          </div>
        )}
    </Sheet>
  );
}

// The party ladder (1–10 + an 11+ box): components/reservations/PartySizeChips.

// ─── Seat-now (mark a free table occupied with a walk-in) ─────────────
// Two launch paths, same sheet:
//   • Tile-launched — `table` is the tapped resource object (preset table,
//     no picker). Byte-identical to the original behaviour.
//   • Header-launched — `table === SEAT_WALK_IN_PICK`; the host PICKS a table
//     from `tables` (the live free/busy list). Defaults to the first free
//     table; busy tables are annotated + disabled. On submit both paths call
//     the same `onSeat({ resource_id, party_size, guest_name })`.
// useSheetFocus / useEscToClose — every sheet's keyboard rules: hooks/useSheetFocus.js.

// The seat sheet's value for "the tables the engine pushes together".
const JOINED_PICK = "__joined";

// `apptWords`: a shop or a workshop (venueProfiles.speaksAppointments) checks
// a customer in at a place, counted as people — "Tjek en kunde ind", "Plads",
// "Antal personer". It read "Sæt gæster til bords / BORD / ANTAL GÆSTER" (QA
// item 8, Push 8 review). The restaurant's words are untouched.
// A place's capacity in words: a table has seats ("2 pladser"); a shop's or a
// workshop's place holds people, as its Spaces tab says ("2 pers."). "Plads 3
// · 2 pladser" read as a place of two places, and English said "1 seat" on a
// workshop (Push 8 review). One is one: "1 plads", "1 person".
function capacityWord(t, n, apptWords) {
  const one = Number(n) === 1;
  if (apptWords) return one ? t("rsvpPersonUnitAppt", "person") : t("rsvpPeopleUnitAppt", "people");
  return one ? t("rsvpSeatOne", "seat") : t("rsvpSeats", "seats");
}

function SeatNowSheet({ table, tables = [], t, busy, onSeat, onClose, initialParty = null, seatingFor = null, bookedWithin = null, error = "", onWaitlist = null, apptWords = false, roomUnknown = false, onRetryRoom = null }) {
  const pickMode = table === SEAT_WALK_IN_PICK;
  useEscToClose(onClose, busy);
  const dialogRef = useSheetFocus();

  // PARTY FIRST, TABLE FOLLOWS. This used to run the other way: pick the first
  // free table, then default the party to THAT TABLE'S CAPACITY. So a couple
  // walking in opened the sheet on a six-top with party 6, and changing party
  // to 2 left them on the six-top — the sheet quietly proposed burning the
  // best table in the room on the commonest walk-in there is.
  //
  // A host doesn't think table-then-party. They hear "two, please" and look
  // for somewhere to put two. So party leads, and the table is re-suggested to
  // the SMALLEST free table that actually fits.
  const [party, setParty] = useState(() =>
    // The stand's "6+" drop-in button opens this sheet already on 6 — the
    // host only changes it when more walked in.
    initialParty
      ? String(initialParty)
      : apptWords
        // A shop or a workshop checks in one customer, as "Book en tid" and
        // its public page do: on 2 the sheet pre-joined two places and one
        // tap checked one customer in across both (Push 8 review).
        ? "1"
        : // Tapping a specific table on the floor still means "seat them here",
          // but even then the party is whoever walked in — so default to 2
          // unless the table physically cannot take 2.
          String(Math.min(2, Number(table?.capacity_seats) || 2) || 2),
  );
  const [name, setName] = useState("");
  const capacityUnit = (n) => capacityWord(t, n, apptWords);
  // Once the host picks a table by hand, stop moving it under them.
  const [tableTouched, setTableTouched] = useState(false);

  /** Before the venue's rules are in: the smallest table that is free now,
   *  has no booking coming up and seats `n` — else nothing. It used to fall
   *  back to the largest free table, or to one reserved soon: six guests met
   *  a pre-picked 4-top ("Bordet har 4 pladser — du sætter 6."), and a full
   *  room a table booked at 13.02 the server then refused. A table the party
   *  does not fit, or one that is not free for their sitting, is the host's
   *  call, never the sheet's. */
  const bestFreeFor = useCallback(
    (n) => {
      const pick = tables
        .filter((tb) => !tb.busy && !tb.reservedAt && (Number(tb.capacity_seats) || 0) >= n)
        .sort((a, b) => (a.capacity_seats || 0) - (b.capacity_seats || 0))[0];
      return pick ? String(pick.id) : "";
    },
    [tables],
  );

  // Where the stand's drop-in row seats n guests now — seatingFor, the ONE
  // rule (utils/hostStand.seatingNow): the smallest table free for their whole
  // sitting, else the tables the booking engine pushes together. The sheet
  // pre-picks exactly that, and lists the joined set when that is the
  // seating, so "6+ · Free now" lands on what the row counted. Its own rule
  // (any table with no booking in the next two hours) pre-picked a six-top
  // booked at 21.10 for a 150-minute sitting — the server refused it — and
  // two joined tables where the six-top was free for the whole sitting.
  // seatingFor null (the venue's rules not in yet): the best guess below.
  const partyN = Number(party) || 2;
  // The rules are in: seatingFor answers, and its "nothing" is an answer too —
  // no table (or joined set) is free for this party's whole sitting, so
  // nothing is pre-picked and the sheet says so. Before the rules: the guess
  // in bestFreeFor, which never picks a table they do not fit.
  const rulesKnown = pickMode && typeof seatingFor === "function";
  const ruleFor = useCallback(
    (n) => (rulesKnown ? seatingFor(n) : null),
    [rulesKnown, seatingFor],
  );
  const seatingNowFor = useMemo(() => ruleFor(partyN), [ruleFor, partyN]);
  // A table booked inside this party's sitting (the start, ms) — the server
  // refuses every seat there (409 slot_unavailable). It was listed as a
  // choice ("Bord 2 — reserveret 00.37"), "Sæt til bords" lit up under "Ingen
  // ledige borde", and the refusal said the table had just been taken: a
  // loop (Push 8 review). With the rules in, such a table cannot be picked.
  const clashAt = useCallback(
    (tb) => (rulesKnown && typeof bookedWithin === "function" && tb && !tb.busy ? bookedWithin(tb.id, partyN) : null),
    [rulesKnown, bookedWithin, partyN],
  );
  const joinedNow = seatingNowFor && seatingNowFor.tableIds.length > 1 ? seatingNowFor : null;
  const autoPick = useCallback(
    (n) => {
      if (rulesKnown) {
        const s = ruleFor(n);
        return s ? (s.tableIds.length > 1 ? JOINED_PICK : String(s.tableId)) : "";
      }
      return bestFreeFor(n);
    },
    [rulesKnown, ruleFor, bestFreeFor],
  );
  // Nothing to seat them at now: with the rules, no seating is free for the
  // whole sitting; without them, only when every table is taken right now.
  // (Never while the tables could not be read: unknown is not "none free"
  // — fix round 6, the sheet says the tables are being asked for again.)
  const noneFree = pickMode && !roomUnknown && (rulesKnown
    ? !seatingNowFor
    : tables.length > 0 && tables.every((tb) => tb.busy));
  // …and why. Tables standing free that are all too small for this party (a
  // seven in a room of four- and six-tops, an empty room and a party of ten)
  // is not "no table free": the host can see the free tables, and the
  // waitlist will not make a four-top seat ten. The sheet says what is true —
  // no free table seats them — and the host may still pick one by hand.
  // Free for the sitting, as bestFreeFor reads it: a table booked in 20
  // minutes is not one the host can see standing free for this party — a
  // full room said "no table free" to a party of two and "no free table
  // seats 3 — choose one yourself" to a party of three (Push 8 review).
  // With the rules in: free for this party's whole sitting, as the picker
  // offers them.
  const freeNowTables = pickMode
    ? tables.filter((tb) => !tb.busy && (rulesKnown && typeof bookedWithin === "function" ? clashAt(tb) == null : !tb.reservedAt))
    : [];
  const noneFitsFree =
    noneFree &&
    freeNowTables.length > 0 &&
    freeNowTables.every((tb) => (Number(tb.capacity_seats) || 0) < partyN);

  const [pickedId, setPickedId] = useState(() =>
    pickMode ? autoPick(Number(party) || 2) : "",
  );

  // A hand-picked table that is now taken — the book was read again after the
  // server refused it (409): another host seated someone there. Or one that
  // is no longer free for the whole sitting: more guests came, a longer one.
  const pickedTaken =
    pickMode &&
    pickedId !== "" &&
    pickedId !== JOINED_PICK &&
    !!tables.find((tb) => String(tb.id) === String(pickedId) && (tb.busy || clashAt(tb) != null));

  // Re-suggest as the party changes, and keep the pick valid if a table frees
  // up or fills on the 60s tick. Never overrides a hand-picked table — unless
  // that pick was the joined set and there is none for this party any more,
  // or the table it names is now taken (it stayed selected, listed as free,
  // and a second tap met the same refusal).
  // "Nothing" is a suggestion too: a pick made for two does not stay under six.
  useEffect(() => {
    if (!pickMode) return;
    if (tableTouched && !(pickedId === JOINED_PICK && !joinedNow) && !pickedTaken) return;
    // The host's pick is gone: suggestions lead again until they pick anew.
    if (pickedTaken && tableTouched) setTableTouched(false);
    const next = autoPick(partyN);
    if (next !== pickedId) setPickedId(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickMode, tableTouched, partyN, autoPick, joinedNow, pickedTaken]);

  const chosenTable = pickMode
    ? pickedId === JOINED_PICK
      ? joinedNow
        ? { id: JOINED_PICK, label: joinedNow.label, capacity_seats: joinedNow.seats, busy: false }
        : null
      : tables.find((tb) => String(tb.id) === String(pickedId)) || null
    : table;
  // Honest warning rather than a silent bad seat: the host may deliberately
  // put 4 on a 2-top by pushing chairs together, so this informs, never blocks.
  const tableTooSmall =
    !!chosenTable &&
    (Number(chosenTable.capacity_seats) || 0) < (Number(party) || 0);
  if (!table) return null;
  const canSeat = pickMode
    ? !!chosenTable && !chosenTable.busy && (chosenTable.id === JOINED_PICK || clashAt(chosenTable) == null)
    : true;
  const seat = () => {
    if (busy || !canSeat || !chosenTable) return;
    onSeat({
      ...(chosenTable.id === JOINED_PICK
        ? { resource_ids: joinedNow.tableIds }
        : { resource_id: chosenTable.id }),
      party_size: Math.max(1, Math.min(100, parseInt(party, 10) || 2)),
      guest_name: name.trim() || t("rsvpWalkIn", "Drop-in"),
    });
  };
  return (
    <div ref={dialogRef} tabIndex={-1} aria-labelledby="rsvp-seat-title" className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center outline-none" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      {/* A form, like the other sheets — Enter in the name field seats them. */}
      <form
        onSubmit={(e) => { e.preventDefault(); seat(); }}
        className="relative w-full sm:max-w-sm bg-white dark:bg-[rgb(var(--surface-raised))] rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] shadow-2xl p-5 space-y-4 animate-fadeIn"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="rsvp-seat-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {apptWords ? t("rsvpSeatNowTitleAppt", "Check a customer in") : t("rsvpSeatNowTitle", "Seat guests")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {chosenTable
                ? chosenTable.label +
                  " · " +
                  chosenTable.capacity_seats +
                  " " +
                  // A table has seats; "4 gæster" read as the party. One is
                  // "1 plads", never "1 pladser". A shop's place: people.
                  capacityUnit(chosenTable.capacity_seats)
                : apptWords
                  ? t("rsvpSeatWalkInAppt", "Check in a drop-in")
                  : t("rsvpSeatWalkIn", "Seat a drop-in")}
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
        {/* The tables could not be read (fix round 6, gate P3): "unknown",
            never "Ingen borde · Ingen ledige borde lige nu". The book's own
            words, a way to ask again, and the waitlist — the door keeps a
            way forward. Seat stays off: there is no table to name yet. */}
        {pickMode && roomUnknown && (
          <div role="status" data-seat-room-unknown="" className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
            <p className="text-[13px] leading-snug font-medium text-gray-800 dark:text-gray-100">
              {apptWords
                ? t("rsvpRoomUnknownAppt", "Couldn't load the spaces — trying again.")
                : t("rsvpRoomUnknown", "Couldn't load the tables — trying again.")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {onRetryRoom && (
                <button
                  type="button"
                  onClick={onRetryRoom}
                  className="h-10 px-3 rounded-lg border border-gray-300 text-[13px] font-semibold text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
                >
                  {t("tryAgain", "Try again")}
                </button>
              )}
              {onWaitlist && (
                <button
                  type="button"
                  onClick={() => onWaitlist(partyN)}
                  className="h-10 px-3 rounded-lg border border-gray-300 text-[13px] font-semibold text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
                >
                  {t("rsvpWlAdd", "Add to waitlist")}
                </button>
              )}
            </div>
          </div>
        )}
        {/* Table picker — header-launched walk-in only. Free tables first;
            busy ones stay selectable-looking but are labelled + disabled so
            the host can't seat onto an occupied table. */}
        {pickMode && !roomUnknown && (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {apptWords ? t("rsvpSeatWalkInTableAppt", "Space") : t("rsvpSeatWalkInTable", "Table")}
            </label>
            <select
              value={pickedId}
              onChange={(e) => {
                // A deliberate pick wins over the auto-suggestion from here on.
                setTableTouched(true);
                setPickedId(e.target.value);
              }}
              aria-label={apptWords ? t("rsvpSeatWalkInTableAppt", "Space") : t("rsvpSeatWalkInTable", "Table")}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            >
              {tables.length === 0 && (
                <option value="">
                  {apptWords ? t("rsvpSeatWalkInNoTablesAppt", "No spaces") : t("rsvpSeatWalkInNoTables", "No tables")}
                </option>
              )}
              {/* Nothing pre-picked: the host chooses. */}
              {tables.length > 0 && pickedId === "" && (
                <option value="" disabled>
                  {apptWords ? t("rsvpSeatPickTableAppt", "Choose a space") : t("rsvpSeatPickTable", "Choose a table")}
                </option>
              )}
              {joinedNow && (
                <option value={JOINED_PICK}>
                  {apptWords
                    ? t("rsvpSeatJoinedOptionAppt", "{tables} · {seats} places together", {
                        tables: joinedNow.label,
                        seats: joinedNow.seats,
                      })
                    : t("rsvpSeatJoinedOption", "{tables} · {seats} seats, pushed together", {
                        tables: joinedNow.label,
                        seats: joinedNow.seats,
                      })}
                </option>
              )}
              {[...tables].sort(byTableLabel).map((tb) => {
                // Booked inside this party's sitting: said, and not a choice.
                const clash = clashAt(tb);
                const reservedAt = clash != null ? clash : tb.reservedAt;
                return (
                <option key={tb.id} value={String(tb.id)} disabled={tb.busy || clash != null} data-clash={clash != null ? "" : undefined}>
                  {tb.label}
                  {tb.capacity_seats
                    ? ` · ${tb.capacity_seats} ${capacityUnit(tb.capacity_seats)}`
                    : ""}
                  {tb.busy
                    ? ` — ${t("rsvpSeatWalkInBusy", "occupied")}`
                    : reservedAt
                      ? ` — ${t("rsvpSeatWalkInReserved", "reserved {time}", { time: new Date(reservedAt).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }) })}`
                      : ""}
                </option>
                );
              })}
            </select>
            {tableTooSmall && (
              /* Informs, never blocks — a host may deliberately push chairs
                 together, and the stand must not argue with the room. */
              <p className="mt-1.5 text-[12px] leading-snug font-medium text-gray-700 dark:text-gray-200">
                {(apptWords
                  ? t("rsvpSeatTableSmallAppt", "That space takes {seats} — you're checking in {party}.")
                  : t("rsvpSeatTableSmall", "That table seats {seats} — you're seating {party}."))
                  .replace("{seats}", chosenTable?.capacity_seats ?? "?")
                  .replace("{party}", party)}
              </p>
            )}
            {/* A full room says so here, with the way forward — not a
                pre-picked table the server then refuses. */}
            {noneFree && (
              <div role="status" data-seat-none-free={noneFitsFree ? "size" : "room"} className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                <p className="text-[13px] leading-snug font-medium text-gray-800 dark:text-gray-100">
                  {noneFitsFree
                    ? apptWords
                      ? t("rsvpSeatNoneFitsAppt", "No free space fits {n} — choose one yourself, or put them on the waitlist", { n: partyN })
                      : t("rsvpSeatNoneFits", "No free table seats {n} — choose a table yourself, or put them on the waitlist", { n: partyN })
                    : apptWords
                      ? t("rsvpSeatNoneFreeAppt", "No space free right now — put them on the waitlist")
                      : t("rsvpSeatNoneFree", "No table free right now — put them on the waitlist")}
                </p>
                {onWaitlist && (
                  <button
                    type="button"
                    onClick={() => onWaitlist(partyN)}
                    className="mt-2 h-10 px-3 rounded-lg border border-gray-300 text-[13px] font-semibold text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
                  >
                    {t("rsvpWlAdd", "Add to waitlist")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {/* The New booking and Edit sheets' own words — this one said "PERS.". */}
            {apptWords ? t("rsvpPartySizeAppt", "People") : t("rsvpPartySize", "Party size")}
          </label>
          {/* Was its own [1,2,3,4,5,6,8] ladder — a walk-in of 7 or 9 could
              not be typed at all. Now the one shared ladder. */}
          <PartySizeChips value={party} onChange={setParty} t={t} apptWords={apptWords} />
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
            placeholder={t("rsvpWalkIn", "Drop-in")}
            className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
        </div>
        {/* The server's no (a 409: the table just went) is said HERE — on
            the page it sat behind the open sheet. */}
        {error && (
          <p role="alert" className="text-[13px] leading-snug font-medium text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          busy={busy}
          disabled={!canSeat}
          className="w-full justify-center"
        >
          {apptWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatNowBtn", "Seat now")}
        </Button>
      </form>
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
// Default time for a new booking. For a future day it's the evening service
// start (18:00). For TODAY it's the next quarter-hour from NOW (clamped to
// 23:45) — a walk-up/soon booking is almost always for later today, so the
// host shouldn't have to scroll back from 18:00 at lunch.
function defaultBookingTime(forDay) {
  let m = 18 * 60;
  if (forDay === serviceDayIso()) {
    const now = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    // After midnight (still tonight's service day) a new booking is for a
    // later service — it defaulted to 06:00, a time no restaurant opens.
    if (nowM >= 6 * 60) m = Math.ceil(nowM / 15) * 15;
  }
  // Clamp into the QUARTER_TIMES range (06:00–23:45) so the default always
  // maps to a real <option>. Future days keep the 18:00 evening default
  // (restaurants' expectation); today's floor is simply the first real slot.
  if (m < 6 * 60) m = 6 * 60;
  if (m > 23 * 60 + 45) m = 23 * 60 + 45;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Bookable times (open hours, sitting length): utils/bookingTimes.js.
function pickBookingTime(dateIso, openHours, sitting = 0) {
  const fallback = defaultBookingTime(dateIso);
  const { times, known, closed } = openTimesFor(dateIso, openHours, sitting);
  if (!known || closed || times.includes(fallback)) return fallback;
  return times.find((q) => q >= fallback) || (times.includes("18:00") ? "18:00" : times[0]);
}

// warningFrom + roomFullText live in utils/bookingRefusal.js (pure, tested).

// snapStart (a start that no longer fits moves, and says so): utils/snapStart.js.

// NewBookingSheet — the host takes a future (phone) booking: date, time,
// party, name, optional phone. Submits through the page-level handler so
// the 409 room_full warning ("honest pushback") can keep the sheet open
// and offer "book anyway (no table)" vs "pick another time".
// EditBookingSheet lives in components/reservations/EditBookingSheet.jsx (fix
// round 27 Oct): the door screen's own build loads it on first use.

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
  // Appointment words (salon, shop, repair trade): the labels only. A shop
  // books one customer by default, not a table for two.
  apptWords = isProvider,
  // A shop or a workshop: no allergy field — the server stores none for it
  // (allergens.collects_allergies; Push 8 review: "ALLERGI (VALGFRI) · fx
  // nødder, gluten" on a bike workshop's "Book en tid").
  noAllergy = false,
  behandlinger = [],
  providerStations = [],
  tables = [],
  openHours = null,
  bookingRules = null,
  // R9: the owner's closed dates and pauses (GET /settings) — a chip says
  // when the chosen day is closed for online booking.
  closures = [],
}) {
  // Opened from a past day's book, a new booking still starts today.
  const [date, setDate] = useState(() => (day < serviceDayIso() ? serviceDayIso() : day));
  const [time, setTime] = useState(() => pickBookingTime(day < serviceDayIso() ? serviceDayIso() : day, openHours, isProvider ? 0 : sittingMinutes(2, bookingRules)));
  const [timeNote, setTimeNote] = useState("");
  const [party, setParty] = useState(apptWords && !isProvider ? "1" : "2");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // A caller's note and allergy go in on the first pass — they needed a
  // second trip through Rediger, and a phoned "nødeallergi" is exactly the
  // thing a host must not have to remember to add later.
  const [note, setNote] = useState("");
  const [allergy, setAllergy] = useState("");
  // How bad — "nødder, alvorlig" stayed amber until a second trip to Rediger.
  const [allergySeverity, setAllergySeverity] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  // Optional table pin (TABLE venues). "" = auto-assign (backend picks a table
  // via the availability engine). A chosen id is posted as resource_id; if it's
  // taken the backend returns a clean 409 and we surface it honestly.
  const [resourceId, setResourceId] = useState("");
  // Provider (salon) selections. behandlingId is required; stylistId "" =
  // Valgfri behandler (no pinned behandler).
  const [behandlingId, setBehandlingId] = useState(() =>
    behandlinger.length === 1 ? String(behandlinger[0].id) : "",
  );
  const [stylistId, setStylistId] = useState("");
  const [behandlingMissing, setBehandlingMissing] = useState(false);
  // How long this booking holds its table/chair — a start time is only
  // offered when the whole of it ends by closing.
  const lengthFor = (p, bid) => {
    if (!isProvider) return sittingMinutes(parseInt(p, 10) || 2, bookingRules);
    const b = behandlinger.find((x) => String(x.id) === String(bid));
    return Number(b?.duration_min) || 0;
  };
  // The chosen day's holds, so a table already booked at the chosen time says
  // so in the list — the host found out only after "Opret reservation".
  const [dayRows, setDayRows] = useState([]);
  useEffect(() => {
    if (isProvider || !date) return undefined;
    let live = true;
    api.get("/reservations/book", { params: { day: date } })
      .then((res) => { if (live) setDayRows(res?.data?.reservations || []); })
      .catch(() => { if (live) setDayRows([]); });
    return () => { live = false; };
  }, [date, isProvider]);
  const tableTaken = useMemo(() => {
    const out = {};
    if (isProvider || !time || !date) return out;
    const a0 = new Date(`${date}T${time}:00`).getTime();
    const a1 = a0 + (lengthFor(party, behandlingId) || 90) * 60000;
    for (const x of dayRows) {
      if (!["requested", "confirmed", "seated"].includes(x.status) || !x.starts_at) continue;
      const b0 = new Date(x.starts_at).getTime();
      const b1 = x.ends_at ? new Date(x.ends_at).getTime() : b0 + 90 * 60000;
      if (!(b0 < a1 && a0 < b1)) continue;
      const ids = Array.isArray(x.combined_resource_ids) && x.combined_resource_ids.length
        ? x.combined_resource_ids : x.resource_id ? [x.resource_id] : [];
      ids.forEach((id) => { if (!out[String(id)]) out[String(id)] = x.starts_at; });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayRows, date, time, party, behandlingId, isProvider]);
  const sitting = lengthFor(party, behandlingId);
  const dayTimes = openTimesFor(date, openHours, sitting);
  // A longer booking can push the chosen start past closing: move it to the
  // latest start that still fits rather than offer a time that is refused.
  const snapTime = (len, onDate = date, n = parseInt(party, 10) || 2) => {
    const { to, note } = snapStart({ dateIso: onDate, time, openHours, sitting: len, n, service: isProvider, t });
    setTime(to);
    setTimeNote(note);
  };
  // A missing name is said under the field — and the field gets the focus,
  // since on a phone it sat above the fold while the tap was on Create.
  const nameRef = useRef(null);

  // A time that has passed is asked about once, not booked as "Bekræftet"
  // on a note nobody reads (it went through on the first tap).
  const [pastWarn, setPastWarn] = useState(false);
  const isPast = () => {
    const today = serviceDayIso();
    if (date < today) return true;
    if (date > today) return false;
    const now = new Date();
    let nowM = now.getHours() * 60 + now.getMinutes();
    if (nowM < 6 * 60) nowM += 1440; // after midnight: still tonight's service
    const [h, m] = String(time).split(":").map(Number);
    let at = h * 60 + m;
    if (at < 6 * 60) at += 1440;
    return at < nowM - 15;
  };
  const submit = (allowOverflow, pastOk = false) => {
    const guest_name = name.trim();
    if (!guest_name) {
      setNameMissing(true);
      nameRef.current?.focus?.();
      return;
    }
    if (!pastOk && isPast()) {
      setPastWarn(true);
      return;
    }
    setPastWarn(false);
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
        guest_notes: note.trim() || null,
        allergy_note: noAllergy ? null : allergy.trim() || null,
        allergy_severity: !noAllergy && allergy.trim() && allergySeverity ? allergySeverity : null,
      },
      allowOverflow,
    );
  };

  // Esc closes the sheet, as every other dialog in the app does.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  const dialogRef = useSheetFocus();

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      aria-labelledby="rsvp-new-title"
      className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center outline-none"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      {/* Fields scroll; the refusal and Create stay pinned at the bottom —
          Create sat below the fold at 1366×768 and on every phone, and the
          refusal appeared where nobody was looking. A form, so the phone
          keyboard's Go creates the booking. */}
      <form
        onSubmit={(e) => { e.preventDefault(); if (!busy && !(isProvider && behandlinger.length === 0)) submit(false); }}
        className="relative w-full sm:max-w-sm flex flex-col max-h-[90vh] overflow-hidden bg-white dark:bg-[rgb(var(--surface-raised))] rounded-t-xl sm:rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] shadow-2xl animate-fadeIn"
      >
        {/* Title and close stay put while the fields scroll. */}
        <div
          className="shrink-0 flex items-start justify-between gap-3 pt-5 pb-1"
          style={{ paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
        >
          <h3 id="rsvp-new-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {apptWords
              ? t("rsvpNewBookingProvider", "Book an appointment")
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
        <div
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-3 pb-5 space-y-4"
          style={{ paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
        >

        {/* Provider (salon) tidsbestilling — behandling → behandler, ahead of
            dato → tid. No behandlinger yet → an honest guide to add them
            first; the Create button is disabled below until one is added. */}
        {isProvider && behandlinger.length === 0 && (
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300">
            {t(
              "rsvpBookNoBehandlinger",
              "Add a service first (Services tab) to take an appointment.",
            )}
          </div>
        )}
        {isProvider && behandlinger.length > 0 && (
          <>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpBookBehandlingLabel", "Service")}
              </label>
              <select
                value={behandlingId}
                onChange={(e) => {
                  setBehandlingId(e.target.value);
                  if (e.target.value) setBehandlingMissing(false);
                  snapTime(lengthFor(party, e.target.value));
                }}
                aria-label={t("rsvpPublicPickBehandling", "Vælg behandling")}
                className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
              >
                <option value="">{t("rsvpPublicPickBehandling", "Vælg behandling")}</option>
                {behandlinger.map((b) => {
                  const mins = t("rsvpBehandlingMinutes", "{n} min", { n: b.duration_min });
                  // Was a bare `${b.price_kr} kr.` — a 1.200 kr. behandling
                  // read "1200 kr." here and "1.200 kr." on the Behandlinger
                  // tab, the same price spelled two ways in one flow.
                  // formatKr already ends in "kr.", so no literal suffix.
                  const price =
                    b.price_kr != null ? ` · ${formatKr(b.price_kr, { decimals: 0 })}` : "";
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
                  {t("rsvpBookBehandlingRequired", "Choose a service.")}
                </p>
              )}
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpBookBehandlerLabel", "Stylist")}
              </label>
              <select
                value={stylistId}
                onChange={(e) => setStylistId(e.target.value)}
                aria-label={t("rsvpPublicPickBehandler", "Vælg behandler")}
                className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
              >
                {/* Default = Valgfri behandler (no pinned behandler). */}
                <option value="">{t("rsvpBookValgfriOwner", "Any stylist")}</option>
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
            <label htmlFor="nb-date" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpDateLabel", "Date")}
            </label>
            <input
              id="nb-date"
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) {
                  setDate(e.target.value);
                  // A time the new day can't take moves to the nearest one it
                  // can (it used to jump to the 18:00 default), and says so.
                  snapTime(sitting, e.target.value);
                  setPastWarn(false);
                }
                if (warning) onClearWarning();
              }}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums dark:[color-scheme:dark] text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="nb-time" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("rsvpTimeLabel", "Time")}
            </label>
            <select
              id="nb-time"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setTimeNote("");
                setPastWarn(false);
                if (warning) onClearWarning();
              }}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            >
              {/* Only the times the venue takes bookings (a time typed
                  elsewhere stays selectable rather than vanishing). */}
              {(dayTimes.times.includes(time) ? dayTimes.times : [...dayTimes.times, time].sort()).map((tm) => (
                <option key={tm} value={tm}>
                  {hm(tm)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {dayTimes.closed && (
          <p className="-mt-2 text-[12px] text-gray-600 dark:text-gray-300">
            {t("rsvpClosedThatDayShort", "You're closed that day.")}
          </p>
        )}
        {/* R9: the day is closed (or paused) for ONLINE booking — the owner
            can still write a booking in (decision 3), and is told why
            guests found no time that day. */}
        {(() => {
          const shut = closureOn(closures, date);
          if (!shut) return null;
          return (
            <p role="status" data-testid="nb-closure-chip" className="-mt-2 flex items-start gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-2.5 py-1.5 text-[12px] leading-snug text-gray-700 dark:text-gray-200">
              <CalendarOff className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" aria-hidden />
              <span>
                {shut.kind === "pause"
                  ? t("rsvpNewPausedDay", "Online booking is paused that day. You can still book here.")
                  : shut.note
                    ? t("rsvpNewClosedDayNote", "Closed for online booking that day ({note}). You can still book here.", { note: shut.note })
                    : t("rsvpNewClosedDay", "Closed for online booking that day. You can still book here.")}
              </span>
            </p>
          );
        })()}
        {timeNote && !dayTimes.closed && (
          <p role="status" className="-mt-2 text-[12px] text-gray-600 dark:text-gray-300">{timeNote}</p>
        )}
        {date < serviceDayIso() && (
          <p className="-mt-2 text-[12px] text-gray-600 dark:text-gray-300">
            {t("rsvpPastDateNote", "That day has already passed.")}
          </p>
        )}

        {/* Party size — TABLE venues only. A provider tidsbestilling is one
            customer; the behandling sets the booking length, not party size. */}
        {!isProvider && (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {apptWords ? t("rsvpPartySizeAppt", "People") : t("rsvpPartySize", "Party size")}
            </label>
            {/* Same ladder as Seat-now and Edit now — this sheet's own 1–10
                was the widest of the three, so nothing here narrows. */}
            <PartySizeChips
              value={party}
              onChange={(v) => {
                setParty(v);
                // A bigger party sits longer: a start time that no longer
                // ends by closing moves to the latest one that does.
                snapTime(lengthFor(v, behandlingId), date, parseInt(v, 10) || 2);
                if (warning) onClearWarning();
              }}
              t={t}
              apptWords={apptWords}
            />
          </div>
        )}

        {/* Optional table — TABLE venues only. Blank = auto-assign (the engine
            picks). Pinning a table posts resource_id; a taken table returns a
            clean 409 the page surfaces as honest room-full pushback. */}
        {!isProvider && tables.length > 0 && (
          <div>
            {/* A shop's or a workshop's place, never a table (Push 8 review:
                "BORD (VALGFRIT — VÆLGES AUTOMATISK)" over "Plads 1 · 1"). */}
            <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {apptWords
                ? t("rsvpBookingTableOptionalAppt", "Space (optional — auto if blank)")
                : t("rsvpBookingTableOptional", "Table (optional — auto if blank)")}
            </label>
            <select
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                if (warning) onClearWarning();
              }}
              aria-label={apptWords
                ? t("rsvpBookingTableOptionalAppt", "Space (optional — auto if blank)")
                : t("rsvpBookingTableOptional", "Table (optional — auto if blank)")}
              className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            >
              <option value="">{t("rsvpBookingTableAuto", "Auto")}</option>
              {[...tables].sort(byTableLabel).map((tb) => {
                const takenAt = tableTaken[String(tb.id)];
                const small = tb.capacity_seats && (parseInt(party, 10) || 0) > tb.capacity_seats;
                return (
                  <option key={tb.id} value={String(tb.id)} disabled={!!takenAt && String(tb.id) !== resourceId}>
                    {tb.label}
                    {tb.capacity_seats ? ` · ${tb.capacity_seats}` : ""}
                    {takenAt
                      ? ` · ${t("rsvpTableOptBooked", "booked {time}", { time: fmtTime(takenAt) })}`
                      : small ? ` · ${t("rsvpTableOptSmall", "too small")}` : ""}
                  </option>
                );
              })}
            </select>
            {/* The pinned table got taken by a time change: say it here, not
                after Opret. */}
            {resourceId && tableTaken[resourceId] && (
              <p className="mt-1.5 text-[12px] text-gray-700 dark:text-gray-300">
                ⚠ {apptWords
                  ? t("rsvpTablePickedTakenAppt", "{table} is booked at {time} — pick another space, or Auto.", {
                    table: (tables.find((tb) => String(tb.id) === resourceId) || {}).label || t("rsvpTableFallbackAppt", "The space"),
                    time: fmtTime(tableTaken[resourceId]),
                  })
                  : t("rsvpTablePickedTaken", "{table} is booked at {time} — pick another table, or Auto.", {
                    table: (tables.find((tb) => String(tb.id) === resourceId) || {}).label || t("rsvpTableFallback", "Table"),
                    time: fmtTime(tableTaken[resourceId]),
                  })}
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="nb-name" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {apptWords ? t("rsvpNbGuestNameProvider", "Customer's name") : t("rsvpNbGuestName", "Guest name")}
          </label>
          <input
            id="nb-name"
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameMissing && e.target.value.trim()) setNameMissing(false);
            }}
            maxLength={160}
            placeholder={t("rsvpNamePh", "Anna Hansen")}
            className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
          {nameMissing && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">
              {/* Was rsvpNameRequired — the PUBLIC guest page's own key, so
                  the owner taking a booking over the phone was told
                  "Indtast dit navn." about somebody else's name. */}
              {apptWords
                ? t("rsvpOwnerGuestNameRequiredAppt", "Enter the customer's name.")
                : t("rsvpOwnerGuestNameRequired", "Enter the guest's name.")}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="nb-phone" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpPhone", "Phone (optional)")}
          </label>
          <input
            id="nb-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            placeholder={t("rsvpPhonePh", "+45 12 34 56 78")}
            className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
        </div>

        {!isProvider && (
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label htmlFor="nb-note" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpNewNote", "Note (optional)")}
              </label>
              <input
                id="nb-note"
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder={apptWords
                  ? t("rsvpNewNotePhAppt", "What it's for, any wishes…")
                  : t("rsvpNewNotePh", "Birthday, high chair, window table…")}
                className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
              />
            </div>
            {!noAllergy && (
            <div>
              <label htmlFor="nb-allergy" className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpNewAllergy", "Allergy (optional)")}
              </label>
              <input
                id="nb-allergy"
                type="text"
                value={allergy}
                onChange={(e) => setAllergy(e.target.value)}
                maxLength={500}
                placeholder={t("rsvpNewAllergyPh", "e.g. nuts, gluten")}
                className="mt-1.5 w-full h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
              />
              {allergy.trim() && (
                <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label={t("rsvpEditAllergy", "Allergi")}>
                  {[
                    { v: "preference", label: t("rsvpSevPreference", "Præference") },
                    { v: "intolerance", label: t("rsvpSevIntolerance", "Intolerance") },
                    { v: "severe", label: t("rsvpSevSevere", "Alvorlig") },
                  ].map((sv) => {
                    const on = sv.v === allergySeverity;
                    return (
                      <button key={sv.v} type="button" aria-pressed={on}
                        onClick={() => setAllergySeverity(on ? "" : sv.v)}
                        className={"h-10 px-3 rounded-lg border text-sm font-medium " + (on
                          ? sv.v === "severe"
                            ? "bg-red-600 text-white border-red-600"
                            : "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                          : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300")}>
                        {sv.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            )}
          </div>
        )}

        </div>
        <div
          className="shrink-0 border-t border-gray-100 dark:border-[rgb(var(--surface-line))] px-5 pt-3 space-y-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}
        >
        {/* Honest room-full pushback — the room can't seat this party at that
            time. The host decides: take it anyway (waitlist-style, no table)
            or pick another time. */}
        {warning && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5 text-sm text-gray-800 dark:text-gray-100 space-y-2.5">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {/* "room_full" is raised whenever auto-assign finds no table,
                  which is two different facts. When nothing is actually
                  occupying the room at that time, saying "full" contradicts a
                  book showing zero covers and makes a host turn away a caller
                  they could have seated. */}
              {roomFullText(warning, t, sitting)}
            </div>
            {/* Combining is on by default, but it only uses tables marked as
                combinable — with fewer than two, big parties never get one. */}
            {warning.tooBig && (tables || []).filter((tb) => tb.combinable).length < 2 && (
              <p className="text-[13px]">
                {t("rsvpCombineHint", "To seat big parties automatically, mark the tables that can be pushed together under Tables.")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* Reached only after the past-time question (if any) was answered. */}
              <Button variant="secondary" size="md" disabled={busy} onClick={() => submit(true, true)}>
                {apptWords ? t("rsvpBookAnywayAppt", "Book anyway (no space)") : t("rsvpBookAnyway", "Book anyway (no table)")}
              </Button>
              {/* Another time can't help when no table is big enough — nor
                  when there are no tables at all (a brand-new venue). */}
              {!warning.tooBig && warning.seats !== 0 && (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={busy}
                  // Straight to the time field — focus landed on <body>.
                  onClick={() => { onClearWarning(); document.getElementById("nb-time")?.focus(); }}
                >
                  {t("rsvpPickAnotherTime", "Pick another time")}
                </Button>
              )}
            </div>
          </div>
        )}

        {pastWarn && !warning && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5 text-sm text-gray-800 dark:text-gray-100 space-y-2.5">
            <div className="font-semibold flex items-start gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span>{t("rsvpPastTimeWarn", "That time has already passed. Book it anyway?")}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={() => submit(false, true)}>
                {t("rsvpPastBookAnyway", "Book anyway")}
              </Button>
              <Button
                variant="ghost"
                size="md"
                disabled={busy}
                onClick={() => { setPastWarn(false); document.getElementById("nb-time")?.focus(); }}
              >
                {t("rsvpPickAnotherTime", "Pick another time")}
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          busy={busy}
          disabled={isProvider && behandlinger.length === 0}
          className="w-full justify-center"
        >
          {apptWords ? t("rsvpCreateBookingProvider", "Book the time") : t("rsvpCreateBooking", "Create booking")}
        </Button>
        </div>
      </form>
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
function blockTitle(r, labels, t, late = 0, over = 0) {
  const word = over
    ? t("rsvpOverduePill", "Over time · {txt}", { txt: overByText(t, over) })
    : late ? t("rsvpLatePillText", "Late · {txt}", { txt: overByText(t, late) }) : labels[r.status] || r.status;
  const base = `${fmtTime(r.starts_at)} ${guestText(r.guest_name) || ""} (${r.party_size}) · ${word}`;
  if (!allergyLevel(r)) return base;
  const detail = [
    (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
    guestText(r.allergy_note),
  ]
    .filter(Boolean)
    .join(" · ");
  const label =
    r.allergy_severity === "severe"
      ? t("rsvpSevSevere", "Severe allergy")
      : t("rsvpAllergyFlag", "Allergy");
  return `${base}\n⚠ ${label}${detail ? ": " + detail : ""}`;
}

// Width of the chair control on a timeline bar (see TimelineView).
const SEAT_W = 32;

// A bar's top line is "HH.MM · N" (+ a link icon for a combined table).
// Estimated, not measured: 11px semibold tabular digits run ~6.3px a
// character, which is all the chair's placement needs — it only has to
// know whether the line leaves room beside it.
function timelineTopLineWidth(r, combined) {
  const text = `${fmtTime(r.starts_at)} · ${r.party_size}`;
  return Math.ceil(text.length * 6.3) + (combined ? 14 : 0);
}

// A bar's time + name, kept in view. A booking that started before the
// scrolled-to hour used to slide its label under the sticky table column —
// "amilien Berg". The label now sticks just right of that column and rides
// along inside its own bar. (The bar clips with overflow:clip, not hidden:
// hidden would make the bar a scroll container and pin the label to it.)
function TimelineBarLabel({ stickyLeft, children }) {
  return (
    <span className="sticky self-start flex flex-col min-w-0 max-w-full" style={{ left: stickyLeft }}>
      {children}
    </span>
  );
}

// `checkedInWords`: a shop or a workshop — its customer is checked in at a
// place ("Tjekket ind", "Tjek {name} ind"), never seated at a table.
function TimelineView({ reservations, resources, day, t, onSelect, onStatus, openHours = null, checkedInWords = false }) {
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
  const zoneByTable = useMemo(() => zoneTones(resources).byId, [resources]);

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
          // Seated without a table too — a party of 12 "booked without a
          // table" vanished from the timeline the moment it was seated.
          ["requested", "confirmed", "seated"].includes(r.status) &&
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

  // The day's opening hours, widened by any booking outside them (min start
  // → max end), hour-aligned and at least 4h. Bookings alone made a quiet
  // lunch read 12–16 with the evening missing; neither → 16–23.
  const { startMin, endMin } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    const wins = openHours?.[WEEKDAY_KEY[new Date(`${day}T12:00:00`).getDay()]];
    (Array.isArray(wins) ? wins : []).forEach(([a, b]) => {
      const s = toMin(a);
      let e = toMin(b);
      if (e <= s) e += 1440;
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    });
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
  }, [holding, openHours, day]);

  const ROW_H = 52;
  const RAIL_W = 116;
  const hours = [];
  for (let m = startMin; m <= endMin; m += 60) hours.push(m);
  const labels = statusLabels(t, checkedInWords);

  const todayIso = serviceDayIso();

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

  // The grid fills the box whenever the whole day fits at 1 px/min or more —
  // at a fixed 1.2, 1440 left ~240px of empty grid after closing and 960 hid
  // 23px of it behind a scrollbar. Narrower than that (phone, tablet
  // portrait) it stays at 1.2, where a 90-minute bar still has room for a
  // name, and scrolls. A callback ref: the box mounts once tables load.
  const [boxW, setBoxW] = useState(0);
  const boxRef = useRef(null);
  const measureRef = useCallback((el) => {
    boxRef.current = el;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setBoxW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const span = endMin - startMin;
  const fitPx = boxW > RAIL_W ? (boxW - RAIL_W - 2) / span : 0;
  const PX = fitPx >= 1 ? fitPx : 1.2; // px per minute
  const bodyW = span * PX;

  const nowD = new Date(nowTick);
  const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
  const nowX =
    day === todayIso && nowMin >= startMin && nowMin <= endMin ? (nowMin - startMin) * PX : null;

  // Where the grid opens when it is wider than the screen (phone, tablet
  // portrait): at now on today, else at the first booking — it opened at
  // the day's first hour, with tonight's bookings off to the right.
  const firstStart = useMemo(() => {
    const ms = holding.filter((r) => r.starts_at).map((r) => minOfDay(r.starts_at));
    return ms.length ? Math.min(...ms) : null;
  }, [holding]);
  const scrolledFor = useRef("");
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !boxW || el.scrollWidth <= el.clientWidth + 4 || scrolledFor.current === day) return;
    const at = day === todayIso && nowMin >= startMin && nowMin <= endMin ? nowMin : firstStart;
    if (at == null) return;
    scrolledFor.current = day;
    // Only when that point is off-screen — the day's first hour stays in
    // view whenever it can.
    if (RAIL_W + (at - startMin + 60) * PX > el.clientWidth) {
      el.scrollLeft = Math.max(0, (at - 30 - startMin) * PX);
    }
  }, [day, todayIso, nowMin, startMin, endMin, firstStart, PX, boxW]);

  if (tables.length === 0) {
    return (
      <ComingSoonView
        icon={<CalendarCheck className="w-8 h-8" />}
        title={checkedInWords ? t("rsvpFloorEmptyTitleAppt", "No spaces yet") : t("rsvpFloorEmptyTitle", "No tables yet")}
        body={checkedInWords
          ? t("rsvpFloorEmptyBodyAppt", "Add spaces on the Spaces tab to see them here.")
          : t("rsvpFloorEmptyBody", "Add tables on the Floor tab to see your room here.")}
      />
    );
  }

  // Status carried by fill weight (not hue): seated = inverted gray-900,
  // requested = dashed/provisional, confirmed = solid bordered.
  // The book's colours, on the bars (one vocabulary with the list and the
  // floor): green in the room, blue booked and coming, amber a request to
  // answer (dashed — not yet a promise), orange a confirmed party running
  // late. Opaque fills in both themes, so the seat control can share them.
  const BLOCK = {
    seated: "bg-emerald-100 text-emerald-950 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-700",
    requested: "bg-amber-50 text-amber-950 border-dashed border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-600",
    late: "bg-orange-50 text-orange-950 border-orange-400 dark:bg-orange-950 dark:text-orange-100 dark:border-orange-600",
    confirmed: "bg-sky-50 text-sky-950 border-sky-300 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-700",
    // Seated and still there past the booked end: the bar runs on to now.
    overdue: "bg-red-50 text-red-950 border-red-400 dark:bg-red-950 dark:text-red-100 dark:border-red-600",
  };
  const SEAT_FACE = {
    confirmed: "bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:hover:bg-sky-900",
    late: "bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-950 dark:text-orange-300 dark:hover:bg-orange-900",
  };
  const overOf = (r) => overdueMinutes(r, nowTick, day === todayIso);
  const blockKind = (r) => (overOf(r) ? "overdue" : lateMinutes(r, nowTick, day === todayIso) ? "late" : r.status);

  return (
    <div ref={measureRef} className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] overflow-x-auto">
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
                // Centred on its tick, except the two ends: the first label sat
                // half under the table rail ("7:00"), the last half off-canvas.
                className={"absolute top-1.5 text-[11px] tabular-nums text-gray-500 dark:text-gray-400 " +
                  (m === startMin ? "pl-1" : m === endMin ? "-translate-x-full pr-1" : "-translate-x-1/2")}
              >
                {String(Math.floor((m % 1440) / 60)).padStart(2, "0")}.00
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
              className="shrink-0 sticky left-0 z-10 bg-gray-50 dark:bg-[rgb(var(--surface-card))] border-r border-gray-200 dark:border-[rgb(var(--surface-line))] px-2 flex flex-col justify-center"
            >
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight inline-flex items-center gap-1">
                {checkedInWords ? t("rsvpUnassignedLaneAppt", "No space") : t("rsvpUnassignedLane", "Unassigned")}
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                {unassigned.blocks.length}
              </span>
            </div>
            <div style={{ width: bodyW }} className="relative bg-gray-50/70 dark:bg-gray-800/30">
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
                    title={blockTitle(r, labels, t, lateMinutes(r, nowTick, day === todayIso), overOf(r))}
                    style={{ left, width, top: lane * 44 + 5, height: 34 }}
                    // The booking's own colour — the lane already says "no
                    // table"; amber-dashed for every bar read as "request".
                    className={
                      "absolute rounded-md border px-1.5 overflow-clip text-left flex flex-col justify-center " +
                      (BLOCK[blockKind(r)] || BLOCK.confirmed)
                    }
                  >
                    <TimelineBarLabel stickyLeft={RAIL_W + 6}>
                      <span className="text-[11px] font-semibold leading-none truncate">
                        {fmtTime(r.starts_at)} · {r.party_size}
                      </span>
                      {/* Was text-[10px] opacity-90 — the guest name, the one
                          string a host scans the timeline FOR, rendered under
                          the 11px floor and faded. 11px + 11px still clears the
                          34px lane (11 + 2 + ~14). */}
                      <span className="text-[11px] leading-tight truncate mt-0.5 flex items-center gap-0.5">
                        {allergy && (
                          <AllergyIcon
                            level={allergy === "severe" ? "severe" : "allergy"}
                            className={"w-3 h-3 shrink-0 " + (allergy === "severe" ? "text-red-500" : "text-amber-600 dark:text-amber-400")}
                            aria-hidden
                          />
                        )}
                        {guestText(r.guest_name) || t("rsvpGuest", "Guest")}
                      </span>
                    </TimelineBarLabel>
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
                className="shrink-0 sticky left-0 z-10 bg-white dark:bg-[rgb(var(--surface-card))] border-r border-gray-200 dark:border-[rgb(var(--surface-line))] px-2 flex flex-col justify-center"
              >
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate leading-tight">
                  {tbl.label}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 min-w-0">
                  <ZoneDot dot={zoneByTable[id]} />
                  <span className="truncate">{[tbl.zone, tbl.capacity_seats + "p"].filter(Boolean).join(" · ")}</span>
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
                  // A party still seated past its end holds the table until
                  // now — the bar stopped at the booked end and the table
                  // looked free while they were still eating.
                  if (overOf(r)) e = Math.max(e, nowMin < s ? nowMin + 1440 : nowMin);
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
                  // One-tap seat. The chair used to sit over the right end of
                  // the bar at full height — on top of the guest NAME, so
                  // "Sofie Holm" read "Sofie Hol🪑" and a long party name lost
                  // its last word. It now sits on the TOP line, beside the
                  // short "12.00 · 2", and the name keeps the bar's whole
                  // width. It only appears where that line has room for it
                  // (estimated from the line's own characters); a bar too
                  // short keeps drawer-only seating, as before. Only a
                  // CONFIRMED bar — a 'requested' booking is confirmed in the
                  // drawer first, mirroring the drawer's state machine.
                  const topLineW = timelineTopLineWidth(r, combined);
                  const showSeat =
                    !!onStatus &&
                    day === todayIso &&
                    r.status === "confirmed" &&
                    width >= 6 + topLineW + 4 + SEAT_W;
                  return (
                    <Fragment key={r.id + id}>
                    <button
                      type="button"
                      onClick={() => onSelect(r)}
                      title={blockTitle(r, labels, t, lateMinutes(r, nowTick, day === todayIso), overOf(r))}
                      style={{ left, width, top: 5, height: ROW_H - 12 }}
                      className={
                        "absolute rounded-md border px-1.5 overflow-clip text-left flex flex-col justify-center transition-colors duration-500 " +
                        (BLOCK[blockKind(r)] || BLOCK.confirmed) +
                        // No allergy ring round the bar: red/amber outlines
                        // read as "running long" / "request". The triangle in
                        // the label carries it.
                        (justSeatedId === r.id ? " bb-seat-settle" : "")
                      }
                    >
                      <TimelineBarLabel stickyLeft={RAIL_W + 6}>
                        <span className="text-[11px] font-semibold leading-none truncate flex items-center gap-0.5">
                          {fmtTime(r.starts_at)} · {r.party_size}
                          {combined && <Link2 className="w-3 h-3 shrink-0" aria-hidden />}
                        </span>
                        {/* Same as the unassigned lane: the name was 10px and
                            faded. Bar height is ROW_H − 12 = 40px, so two 11px
                            lines fit with room to spare. */}
                        <span className="text-[11px] leading-tight truncate flex items-center gap-0.5 mt-0.5">
                          {allergy && (
                            <AllergyIcon
                              level={allergy === "severe" ? "severe" : "allergy"}
                              className={"w-3 h-3 shrink-0 " + (allergy === "severe" ? "text-red-500" : "text-amber-600 dark:text-amber-400")}
                              aria-hidden
                            />
                          )}
                          {guestText(r.guest_name) || t("rsvpGuest", "Guest")}
                        </span>
                      </TimelineBarLabel>
                    </button>
                    {showSeat && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          seatFromBar(r);
                        }}
                        title={checkedInWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatAction", "Seat")}
                        aria-label={checkedInWords
                          ? t("rsvpSeatNowAriaAppt", "Check {name} in", {
                              name: guestText(r.guest_name) || t("rsvpColGuestAppt", "Customer"),
                            })
                          : t("rsvpSeatNowAria", "Seat {name}", {
                              name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
                            })}
                        // Top half of the bar's right end — the time line's
                        // free space. Its own surface, so a name scrolled
                        // under it (the sticky label) is cut, not overprinted.
                        style={{ left: left + width - SEAT_W - 1, width: SEAT_W, top: 6, height: (ROW_H - 14) / 2 }}
                        className={"absolute z-10 flex items-center justify-center rounded-tr-md transition-colors " + (SEAT_FACE[blockKind(r)] || SEAT_FACE.confirmed)}
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
    <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] overflow-hidden">
      <div className="h-8 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))]" />
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
  // The hours on the card are the owner's SAVED ones (Indstillinger →
  // Åbningstider), not a suggestion: the label says so, and the tap keeps
  // them unless the owner edits a day here (R1 A1).
  hoursSaved = false,
  // Her name for her own chair — what customers read in "Vælg behandler".
  // It used to be the business name (R7). Optional: blank = "Indehaver".
  chairName = "",
  onChairName = null,
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-5 sm:p-6 space-y-5 max-w-2xl">
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
          {hoursSaved
            ? t("rsvpSalonHoursSaved", "Your saved hours. Change them if you need to")
            : t("rsvpSalonHoursSuggestion", "Suggested — change if it doesn't fit")}
        </div>
        {/* A stored second period (a lunch break) is shown and can be
            taken away here; adding one lives in Indstillinger (R8), so the
            first booking stays one tap. */}
        <WeekHoursEditor
          t={t}
          hours={hours}
          setHourDay={setHourDay}
          onApplyMonToAll={applyMonToAll}
          addMode="day"
        />
        {/* R9: not a third set of hours — the card writes the same booking
            hours as Indstillinger → Åbningstider. */}
        <p data-testid="salon-hours-same" className="text-xs text-gray-500 dark:text-gray-400">
          {t("rsvpSalonHoursSame", "These are the same hours as Settings → Opening hours (bookings): change them here or there. The opening hours under Profile are not used for bookings.")}
        </p>
      </div>

      {onChairName && (
        <div className="max-w-sm">
          <label htmlFor="salon-first-run-name" className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">
            {t("rsvpSelfChairNameLabel", "Your name (customers see it)")}
          </label>
          <input
            id="salon-first-run-name"
            type="text"
            value={chairName}
            onChange={(e) => onChairName(e.target.value)}
            placeholder={t("rsvpSelfChairNamePh", "e.g. Anna")}
            maxLength={STYLIST_NAME_MAX}
            autoComplete="given-name"
            className="w-full h-11 max-sm:h-10 max-sm:min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
        </div>
      )}

      {/* No service yet: a customer picks a behandling before any time, so
          the page can take no booking (R1 A4). Amber — it needs the owner. */}
      {behandlingerCount === 0 && (
        <div
          role="status"
          data-testid="salon-no-service-warn"
          className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-900/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-100 flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-1.5">
            <p>{t("rsvpSalonNoServiceWarn", "Customers can't book until you add a service.")}</p>
            <Link
              to="/reservations?tab=behandlinger"
              data-testid="salon-add-service-cta"
              className="inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2"
            >
              <Scissors className="w-3.5 h-3.5" aria-hidden />
              {t("rsvpSalonAddServiceCta", "Add a service")}
            </Link>
          </div>
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

   Colour stays meaningful: gray-900 for the selected day, a heavier grey ONLY where
   covers outrun the roster. No heatmap — a rainbow month would look like a
   dashboard and say less than one marked Saturday does. (Amber is the
   request colour now — Manoj, 1 Oct 2026.) */
// `apptWords`: a salon, a shop, a workshop — its days hold appointments and
// customers, not reservations and guests.
function DayRail({ day, onPick, t, waitlistCount = 0, onOpenWaitlist, apptWords = false }) {
  const { lang } = useLanguage();
  const [month, setMonth] = useState(() => (day || serviceDayIso()).slice(0, 7));
  const [load, setLoad] = useState({});
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);

  // Follow the book when the owner jumps to a date in another month (arrows,
  // date picker, deep link) so the rail never shows a different month than
  // the day that's open.
  useEffect(() => {
    if (day && day.slice(0, 7) !== month) setMonth(day.slice(0, 7));
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when a booking is created or changes status elsewhere on the page —
  // the rail said "I morgen 0 gæster" right after a 4-top was booked for tomorrow.
  const [railNonce, setRailNonce] = useState(0);
  useEffect(() => {
    const bump = () => setRailNonce((n) => n + 1);
    window.addEventListener("bonbox-reservations-changed", bump);
    return () => window.removeEventListener("bonbox-reservations-changed", bump);
  }, []);

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
        setTotals(res.data?.month_totals || null);
      })
      .catch(() => { if (alive) { setLoad({}); setTotals(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month, railNonce]);

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
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-3 tabular-nums"
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
        {t("rsvpRailWeekdays", "M,T,W,T,F,S,S")
          .split(",")
          .map((w, i) => <div key={i}>{w}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center relative">
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
                "group relative rounded-md py-1 leading-[1.1] transition-colors " +
                (selected
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : heavy
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-semibold hover:bg-gray-200 dark:hover:bg-gray-700"
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
                      ? "text-gray-700 dark:text-gray-200"
                      : "text-gray-400 dark:text-gray-500")
                }
              >
                {info?.covers ? info.covers : " "}
              </span>

              {/* Peek. The grid could always show covers; what it could not show
                  was the SHAPE of a day without opening it — how many separate
                  bookings those covers arrive in, and whether anyone is
                  rostered. Both numbers are already in this response, so this
                  reads nothing new; it stops the owner clicking thirty-one days
                  to find the one that needs them.
                  Silent on empty days — an empty tooltip is worse than none. */}
              {info && (info.bookings || info.staff_on) ? (
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-20
                             hidden group-hover:block group-focus-visible:block
                             whitespace-nowrap rounded-lg px-2 py-1
                             bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900
                             text-[10.5px] font-medium shadow-lg"
                >
                  {info.bookings || 0}&nbsp;{apptWords ? t("rsvpPeekBookingsAppt", "appointments") : t("rsvpPeekBookings", "bookings")}
                  {info.covers
                    ? ` \u00b7 ${info.covers} ${
                        apptWords
                          ? info.covers === 1 ? t("rsvpPeekCustomerOne", "customer") : t("rsvpPeekCustomers", "customers")
                          : info.covers === 1 ? t("rsvpPeekGuestOne", "guest") : t("rsvpPeekGuests", "guests")
                      }`
                    : ""}
                  {/* Roster only when we HAVE one. "0 on shift" would read as a
                      staffing alarm when it usually means the week is unplanned. */}
                  {info.staff_on ? ` \u00b7 ${info.staff_on} ${t("rsvpPeekOnShift", "on shift")}` : ""}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* The month as a record — "how did September go?". Same definitions as
          Indsigt → Måned for måned (cancelled bookings don't count; guests
          are confirmed/seated/completed parties), so the two always agree. */}
      {!loading && totals?.bookings > 0 && (
        <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
          {(() => {
            // One key per singular/plural shape — both counts can be 1.
            const vars = { month: monthName(month, lang, false), bookings: totals.bookings, guests: totals.guests };
            if (apptWords) {
              if (totals.bookings === 1) {
                return totals.guests === 1
                  ? t("rsvpRailMonthOneApptOneCustomer", "{month}: 1 appointment · 1 customer", vars)
                  : t("rsvpRailMonthOneAppt", "{month}: 1 appointment · {guests} customers", vars);
              }
              return totals.guests === 1
                ? t("rsvpRailMonthApptOneCustomer", "{month}: {bookings} appointments · 1 customer", vars)
                : t("rsvpRailMonthAppt", "{month}: {bookings} appointments · {guests} customers", vars);
            }
            if (totals.bookings === 1) {
              return totals.guests === 1
                ? t("opsRsvpRailMonthOneBookingOneGuest", "{month}: 1 booking · 1 guest", vars)
                : t("rsvpRailMonthTotalOne", "{month}: 1 booking · {guests} guests", vars);
            }
            return totals.guests === 1
              ? t("opsRsvpRailMonthOneGuest", "{month}: {bookings} bookings · 1 guest", vars)
              : t("rsvpRailMonthTotal", "{month}: {bookings} bookings · {guests} guests", vars);
          })()}
        </p>
      )}

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
          {apptWords
            ? (sel?.covers || 0) === 1
              ? t("rsvpRailDayLineOneAppt", "1 customer · {staff} on shift", { staff: sel?.staff_on || 0 })
              : t("rsvpRailDayLineAppt", "{covers} customers · {staff} on shift", {
                  covers: sel?.covers || 0,
                  staff: sel?.staff_on || 0,
                })
            : (sel?.covers || 0) === 1
              ? t("rsvpRailDayLineOne", "1 guest · {staff} on shift", { staff: sel?.staff_on || 0 })
              : t("rsvpRailDayLine", "{covers} guests · {staff} on shift", {
                  covers: sel?.covers || 0,
                  staff: sel?.staff_on || 0,
                })}
        </p>
        {isHeavy(sel) && (
          <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-2.5 py-1.5 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-gray-600 dark:text-gray-300 shrink-0 mt-px" aria-hidden />
            <p className="text-[11px] text-gray-700 dark:text-gray-200 leading-snug">
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

/**
 * Live audibility chip for the host stand.
 *
 * The stand's whole reason to exist is that it makes a noise when a severe
 * allergy arrives. Web audio on an iPad can be killed by a single accidental
 * tap in Control Centre, and until now that failed SILENTLY — the chime simply
 * stopped and nothing on screen said so. This chip is the instrument: it shows
 * whether the next alert will actually be heard, and tapping it plays the
 * urgent tone so a host can confirm with their own ears before service.
 *
 * Deliberately not a toggle. Turning alert sound off is a real setting that
 * lives in the alert centre; this is a health indicator you can test, which is
 * a different thing and must not be confusable with a mute button.
 */
function StandSoundChip({ t }) {
  const [state, setState] = useState(() => getSoundStatus());
  const [testing, setTesting] = useState(false);

  useEffect(() => subscribeSound(setState), []);

  const ok = state.ok;
  return (
    <button
      type="button"
      onClick={() => {
        setTesting(true);
        Promise.resolve(testSound("urgent")).finally(() =>
          setTimeout(() => setTesting(false), 700),
        );
      }}
      aria-label={t("rsvpStandTestSound", "Test lyden")}
      title={
        ok
          ? t("rsvpStandSoundOnHint", "Lyden virker. Tryk for at teste.")
          : t(
              "rsvpStandSoundOffHint",
              "Der kommer ingen lyd. Tjek lydstyrke og lydløs-knap, og tryk for at teste igen.",
            )
      }
      className={
        "inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
        (ok
          ? "text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800"
          : "text-gray-800 bg-gray-100 hover:bg-gray-200 dark:text-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700")
      }
    >
      {ok ? (
        <Volume2 className="w-4 h-4" aria-hidden />
      ) : (
        <VolumeX className="w-4 h-4" aria-hidden />
      )}
      <span className="hidden sm:inline">
        {testing
          ? t("rsvpStandSoundTesting", "Afspiller…")
          : ok
            ? t("rsvpStandSoundOn", "Lyd aktiv")
            : t("rsvpStandSoundOff", "Lyd slået fra")}
      </span>
    </button>
  );
}

/**
 * Overflow menu for the host stand.
 *
 * The stand is a door tablet on an unlocked owner session. Owner settings used
 * to be a single unlabelled gear tap away, which put the full financial app
 * one accidental press from anyone standing at the counter. Moving it behind a
 * deliberate two-step keeps it reachable for the owner — front of house still
 * has a visible door, not a hidden one — without leaving it under a guest's
 * thumb.
 *
 * "Luk" only appears when the tab can genuinely close itself (script-opened,
 * so window.opener exists). On an installed home-screen stand window.close()
 * is a no-op, and the old fallback navigated the host INTO the owner app —
 * the exact thing this screen exists to avoid. There, the honest end-of-shift
 * action is logging out.
 */
/**
 * "Install on this device", as a stand menu row.
 *
 * The existing InstallHostStandHint lives inside SettingsSection — which the
 * stand forces away — so on the one screen meant to live on a tablet the
 * install affordance was unreachable. Renders nothing once installed; there is
 * nothing honest to offer then.
 */
// `apptWords`: a shop's or a workshop's counter screen ("Skærm ved disken") —
// never "the host stand" (Push 8 review: its ⋯ menu said "Åbner direkte på
// vært-skærmen" under the header "Skærm ved disken").
function StandInstallItem({ t, className, apptWords = false }) {
  const [installEvent, setInstallEvent] = useState(null);
  const [installed, setInstalled] = useState(() => _isStandaloneDisplay());
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallEvent(e);
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

  if (installed) return null;

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={className}
        onClick={async () => {
          if (installEvent) {
            try {
              installEvent.prompt();
              await installEvent.userChoice;
            } catch {
              /* stale event — harmless */
            }
            setInstallEvent(null);
            return;
          }
          setShowHow((v) => !v);
        }}
      >
        <Download className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
        <span className="min-w-0">
          {t("rsvpStandInstall", "Installér på enheden")}
          <span className="block text-[11px] text-gray-500 dark:text-gray-400">
            {apptWords
              ? t("rsvpStandInstallHintAppt", "Opens straight to the counter screen")
              : t("rsvpStandInstallHint", "Åbner direkte på vært-skærmen")}
          </span>
        </span>
      </button>
      {showHow && !installEvent && (
        <p className="px-3 pb-2.5 -mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          {_isIOSDevice()
            ? apptWords
              ? t("rsvpInstallManualIOSProvider", "In Safari: tap Share, then Add to Home Screen. The icon opens straight to the appointment book.")
              : t(
                "rsvpInstallManualIOS",
                "In Safari: tap Share, then Add to Home Screen. The icon opens straight to this screen.",
              )
            : t(
                "rsvpInstallManual",
                "In Edge or Chrome: open the ⋯ menu → Apps → Install this site as an app.",
              )}
        </p>
      )}
    </>
  );
}

// `onUnpair` (R10): a PAIRED device (/stand/<token>) has no session to log
// out of — its "Log ud" sent the door iPad to the OWNER login. There the end
// action is "Afbryd denne skærm": the device lets go of its own link.
function StandMenu({ t, onLogout, apptWords = false, onUnpair = null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const canClose = typeof window !== "undefined" && !!window.opener;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item =
    "flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("rsvpStandMore", "Mere")}
        className="inline-flex items-center justify-center h-10 w-10 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      >
        <MoreHorizontal className="w-5 h-5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-60 overflow-hidden rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] bg-white dark:bg-[rgb(var(--surface-raised))] shadow-xl"
        >
          {/* target=_blank so the stand itself never leaves the stand. */}
          <a
            href="/reservations?tab=settings"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            <Settings className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
            <span className="min-w-0">
              {t("rsvpStandSettings", "Indstillinger")}
              <span className="block text-[11px] text-gray-500 dark:text-gray-400">
                {t("rsvpStandSettingsHint", "Åbner ejer-appen i en ny fane")}
              </span>
            </span>
          </a>
          <StandInstallItem t={t} className={item} apptWords={apptWords} />
          <div className="h-px bg-gray-200 dark:bg-gray-800" />
          {onUnpair ? (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onUnpair();
              }}
            >
              <Unplug className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
              <span className="min-w-0">
                {t("rsvpStandUnpair", "Disconnect this screen")}
                <span className="block text-[11px] text-gray-500 dark:text-gray-400">
                  {t("rsvpStandUnpairHint", "A new code is needed to connect again")}
                </span>
              </span>
            </button>
          ) : canClose ? (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                window.close();
              }}
            >
              <X className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
              {t("close", "Luk")}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              <LogOut className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
              {t("logout", "Log ud")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// R10: a cockpit drawn without a book says "—", never a confident 0. A door
// iPad restarted while the wifi was down read "0 gæster · 0 sidder" over a
// night that simply could not be read. The waitlist cell keeps its own
// three-state count (WaitlistSection), and "next" already says "—".
const COCKPIT_COUNTS = new Set(["covers", "seated", "awaiting", "occupancy"]);
function cockpitWhenUnknown(known, items) {
  if (known) return items;
  return items.map((it) =>
    COCKPIT_COUNTS.has(it.key)
      ? { ...it, value: "—", helper: "", tone: "neutral", accent: "neutral", onClick: null, selected: false }
      : it,
  );
}

// `day`/`onDayChange` are OPTIONAL — pass them and the book becomes a
// controlled component so the desktop DayRail beside it can drive the date;
// omit them (host-stand pop-out, tests) and it keeps its own state exactly as
// before. Every internal setDay call passes a plain value, never a functional
// updater, so the alias below is a faithful swap.
// The room's own asks after a failed read of the tables (fix round 5).
const ROOM_RETRY_MS = [5000, 15000, 30000];

function BookSection({ t, businessType, tableFloor = false, day: dayProp, onDayChange, railSlot = null, onRoomRead = null }) {
  const { lang } = useLanguage();
  const confirm = useConfirm();
  // Host-stand pop-out chrome lives in THIS component's return (the top bar +
  // full-screen wrapper), so it needs its own auth/router bindings — they are
  // NOT threaded down as props. `standalone` is derived from the path exactly
  // as the parent does. (Without these three, the Book tab threw
  // "ReferenceError: standalone is not defined" and crashed the whole page.)
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Both doors into the door screen: the owner's pop-out (/reservations/stand)
  // and a paired device (/stand/<token>). Kept in sync with the parent's
  // isHostStand — this is re-derived rather than threaded because
  // ReservationsPage takes zero props.
  const standalone =
    location.pathname.endsWith("/reservations/stand") ||
    location.pathname.startsWith("/stand/");
  // The ONE of those two doors that has NO session. The distinction matters
  // for Arrange room and `standalone` cannot carry it: the owner's pop-out has
  // a real cookie and saves a layout fine, while a paired device's calls are
  // rewritten by standRewrite() onto /stand/<token>/… — and the layout route
  // is deliberately absent from stand_link.py's allow-list, which
  // test_owner_config_paths_404_under_the_stand_prefix pins. So a host could
  // drag the whole room on the door tablet, hit Save, and get a 404 toast with
  // the work gone. Don't offer the door.
  const isStandDevice = location.pathname.startsWith("/stand/");
  // TABLE venues (dining/bar) get the Floor ("plan") lens; provider (salon) /
  // no-floor (bakery/retail) venues never do — gated on the venue TYPE, with a
  // grandfather for venues that already have a real table plan. `tableFloor`
  // is computed once by the parent (type OR has-tables) and passed down.
  // Provider (salon) venues take a real tidsbestilling (behandling → behandler
  // → dato → tid) instead of a table booking — an ADDITIVE branch; the table
  // flow is left byte-identical.
  const isProvider = bookingModeFor(businessType) === "provider";
  // The words: a salon, a shop and a repair trade book a customer for a time
  // (Aftaler · Kunder · Tjek ind), food and bars a table (vertical-fit review,
  // Oct 2026). Wording only — `isProvider` stays the engine switch.
  const apptWords = speaksAppointments(businessType);
  const [dayLocal, setDayLocal] = useState(() => serviceDayIso());
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
  // R11 (B7): a group confirmed onto no table — {r, facts} from the server's
  // 409 no_table_fits — and the sheet's own busy flag (move + confirm).
  const [noFit, setNoFit] = useState(null);
  const [noFitBusy, setNoFitBusy] = useState(false);
  // R11 (B10): the freed-table nudge above the night — {matches, day} — and
  // the bookings THIS screen freed (their matches came with the answer, so a
  // reload must not ask again for them).
  const [freedNudge, setFreedNudge] = useState(null);
  const selfFreedRef = useRef(new Set());
  const waitlistCountRef = useRef(0);
  useEffect(() => { waitlistCountRef.current = waitlistCount; }, [waitlistCount]);
  // Waiting parties that fit a table that just freed: ringed in the
  // Venteliste (spotMatches) AND named at the top of the book (the nudge).
  const surfaceMatches = useCallback((m, forDay) => {
    if (!Array.isArray(m) || m.length === 0) return;
    setSpotMatches(m);
    setFreedNudge({ matches: m, day: forDay });
  }, []);
  // Bumped on every successful book refetch → tells WaitlistSection to resync
  // so the Venteliste is "spot on" the instant a booking changes (status flip,
  // table move/clear, new booking, walk-in), not just on a day change.
  const [bookTick, setBookTick] = useState(0);
  const [viewPref, setView] = useState(() => {
    // The stand always opens on the list: a host starts from a name spoken at
    // the door, and only the list has the search index and a one-tap Seat. It
    // must also not inherit whatever lens the owner last used on a laptop.
    if (standalone) return "liste";
    try {
      return localStorage.getItem(RSVP_VIEW_KEY) || "liste";
    } catch {
      return "liste";
    }
  });
  // The lens on screen. Plan and Timeline both lay out TABLES (the timeline's
  // lanes are the tables): a venue with no table plan — a salon, a shop — got
  // "Ingen borde endnu" there, so it only has the list. The saved preference
  // is kept, so a table plan that loads late still opens on the owner's lens.
  const view = !tableFloor && viewPref !== "liste" ? "liste" : viewPref;
  const [data, setData] = useState(null);
  const [resources, setResources] = useState([]);
  // Non-bookable room objects (bar, entrance, window, wall). Deliberately its
  // OWN state and never merged into `resources` — see fetchResources.
  const [fixtures, setFixtures] = useState([]);
  // Tracks the first resources fetch so the salon first-run card only shows
  // once we KNOW there are no stations (never flashes for an established salon
  // while resources are still in flight).
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  // "We could not ask" is not "there are none". Both first-run cards below make
  // a claim about the owner's OWN setup, so neither may be drawn from a fetch
  // that failed — see the catch in fetchResources.
  const [resourcesFailed, setResourcesFailed] = useState(false);
  // Does the book hold anything at all — a booking on any day, a party
  // waiting? (GET /resources book_has_entries.) null = not answered / an older
  // API: unknown, which never hides a book.
  const [bookHasEntries, setBookHasEntries] = useState(null);
  // The canonical venue seat capacity from GET /resources — active, non-deleted,
  // non-provider tables only, the SAME number the booking engine allows against.
  // The occupancy gauge divides by THIS (not a raw resources.reduce, which wrongly
  // counted inactive/provider rows). Null until the first fetch → the gauge falls
  // back to the reduce so an older API without the field never breaks.
  const [venueSeats, setVenueSeats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // When the book last actually arrived, and whether the most recent silent
  // poll failed. Together they are the only honest answer to "is what I am
  // looking at still true?" — see the stale chip in the toolbar.
  const [lastOkAt, setLastOkAt] = useState(() => Date.now());
  const [liveFailed, setLiveFailed] = useState(false);
  // R10 — the door iPad stays on.
  // The day whose book `data` holds. A refresh of THAT day that fails keeps
  // it on screen (the last good book); another day's book is never shown
  // under this day's name.
  const shownDayRef = useRef(null);
  const dataRef = useRef(null);
  // The first load of a day failed: there is no book to show. In words, never
  // the server's code, and never the empty state's "Ingen reservationer".
  const [loadError, setLoadError] = useState("");
  // Consecutive polls that could not reach BonBox (lib/bookLive), and what
  // the browser itself says about the network.
  const [pollFailures, setPollFailures] = useState(0);
  const [browserOffline, setBrowserOffline] = useState(() => {
    try {
      return typeof navigator !== "undefined" && navigator.onLine === false;
    } catch {
      return false;
    }
  });
  // A paired door screen whose link answers 404, confirmed by a second read:
  // removed by the owner, or unpaired. One calm screen instead of the book (V10).
  const [standGone, setStandGone] = useState(false);
  // The revision of the book on screen; non-null once the server is known to
  // send them, which lets the safety-net reload slow down.
  const [bookRev, setBookRev] = useState(null);
  const watchIdRef = useRef(null);
  if (watchIdRef.current === null) watchIdRef.current = `book-${Math.random().toString(36).slice(2)}`;
  const lastFetchAtRef = useRef(0);
  // A reload of the book on screen is under way (no skeleton any more —
  // the refresh icon turns instead, so a tap is answered at once).
  const [refreshing, setRefreshing] = useState(false);
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
  const [allergyError, setAllergyError] = useState("");
  // The reservation open in the detail drawer (from a Liste row, a Plan
  // tile, or a timeline block). null = drawer closed.
  const [selected, setSelected] = useState(null);
  // Seat-now: the free table the host is seating a walk-in onto.
  const [seatTarget, setSeatTarget] = useState(null);
  const [seating, setSeating] = useState(false);
  // The stand's drop-in buttons: the size "6+" pre-fills the seat sheet with,
  // the "seated at 22" line after a one-tap seat, and the Venteliste form
  // request when nothing fits now.
  const [seatParty, setSeatParty] = useState(null);
  // A refused seat from the open seat sheet, said inside it.
  const [seatError, setSeatError] = useState("");
  const [walkInDone, setWalkInDone] = useState(null);
  const [wlAddRequest, setWlAddRequest] = useState(null);
  // New booking (owner takes a phone booking for a future slot).
  const [newOpen, setNewOpen] = useState(false);
  // The venue's bookable hours per weekday, for the new-booking time picker.
  const [openHours, setOpenHours] = useState(null);
  // …and how long each party size holds a table, so a start is only offered
  // when the whole sitting ends by closing.
  const [bookingRules, setBookingRules] = useState(null);
  // Is the public page on, and under which slug — for the salon's
  // "customers can't book yet" check below. Only the owner's /settings
  // carries it; a paired stand device can never reach /settings, so there it
  // stays unknown (null), as it always did. The hours and turn times come
  // from the booking-rules door below, not from here.
  const [publicPage, setPublicPage] = useState(null); // {enabled, slug}
  useEffect(() => {
    if (isStandDevice) return undefined;
    let alive = true;
    api.get("/reservations/settings")
      .then((r) => {
        if (!alive) return;
        setPublicPage({
          enabled: !!r.data?.reservations_enabled,
          slug: r.data?.reservation_slug || null,
          // false = no opening hours saved: a self-chair has no time to offer.
          hoursDeclared: r.data?.hours_declared !== false,
          // Tells a held online booking from a group request (bookingHeld.js).
          groupThreshold: r.data?.settings?.group_request_threshold,
          // R1b: the plan's monthly cap — used, cap and what reaching it
          // does — for the book's banner (PlanCapBanner).
          monthCap: monthCapFromSettings(r.data),
          // R9: closed dates and pauses, so the new-booking sheet can say
          // the chosen day is closed for ONLINE booking (still bookable here).
          closures: Array.isArray(r.data?.closures) ? r.data.closures : [],
        });
        // The salon first-run card shows the hours the owner already SAVED
        // (not the suggestion), unless they have started editing the card.
        const savedHours = r.data?.settings?.booking_hours;
        if (hasSavedBookingHours(savedHours) && !salonHoursDirtyRef.current) {
          setSalonHours(parseBookingHours(savedHours, defaultSalonHours));
          setSalonHoursSaved(true);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isStandDevice]);
  // Whether those two have actually ARRIVED. openHours null can be a real
  // answer (hours never declared), so it cannot say this by itself — and the
  // stand's drop-in row may claim "free now" / "approx. 20.30" only from the
  // venue's own turn times and closing time, never from defaults.
  const [rulesLoaded, setRulesLoaded] = useState(false);
  // Whether this server seats ONE party across joined tables (resource_ids).
  // The booking-rules door shipped with that, so its answer says so. An older
  // server drops resource_ids unread, auto-picks tables of its own and
  // answers 201 — the stand said "seated at 6 + 7" for a party sat somewhere
  // else (the frontend goes live minutes before the API does). Until the door
  // has answered, joined tables are neither offered nor sent; single tables
  // seat exactly as before.
  const [joinCapable, setJoinCapable] = useState(false);
  // Asked again on the minute tick while the rules or that answer are
  // missing — a door tablet whose Wi-Fi was not up after waking, a server
  // mid-deploy (404) — and never again once both are in. One ask at a time,
  // and a failure says nothing: the row just keeps saying nothing.
  const rulesRetry = rulesLoaded && joinCapable ? "done" : nowTs;
  const rulesAsking = useRef(false);
  const rulesMounted = useRef(true);
  useEffect(() => {
    rulesMounted.current = true;
    return () => { rulesMounted.current = false; };
  }, []);
  useEffect(() => {
    if (rulesRetry === "done" || rulesAsking.current) return;
    rulesAsking.current = true;
    const hasRules = (r) => !!(r?.data?.settings && typeof r.data.settings === "object");
    const apply = (r) => {
      // Undeclared hours are unknown, not "closed every day" — see
      // bookableHoursFromSettings. The waitlist reads the same state.
      setOpenHours(bookableHoursFromSettings(r.data));
      setBookingRules(r.data.settings);
      setRulesLoaded(true);
    };
    // One door for both: the owner's own booking-rules route, or — on a
    // paired device, whose calls are rewritten onto /stand/<token>/… — the
    // device's read-only door (stand_link.py). Turn times, the table-joining
    // rule and the hours; the device can never reach /settings.
    api.get("/reservations/booking-rules")
      .then((r) => {
        if (!rulesMounted.current) return undefined;
        if (hasRules(r)) {
          apply(r);
          setJoinCapable(true);
          return undefined;
        }
        throw new Error("no booking rules");
      })
      .catch(() => {
        // The owner on a server without that door: the rules as before, from
        // /settings, and single tables until the door answers on a later tick.
        // Not loaded stays not loaded: the pickers offer every quarter and the
        // drop-in row says nothing it cannot know.
        if (!rulesMounted.current || isStandDevice || rulesLoaded) return undefined;
        return api.get("/reservations/settings").then((r) => {
          if (rulesMounted.current && hasRules(r)) apply(r);
        });
      })
      .catch(() => {})
      .finally(() => { rulesAsking.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStandDevice, rulesRetry]);
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
  // The card's hours are the owner's saved ones, and whether the owner has
  // edited them on the card — only an edit replaces saved hours (R1 A1).
  const [salonHoursSaved, setSalonHoursSaved] = useState(false);
  const salonHoursDirtyRef = useRef(false);
  const [salonSetupBusy, setSalonSetupBusy] = useState(false);
  const [salonSetupError, setSalonSetupError] = useState("");
  // Her name for her own chair (R7) — never the business name.
  const [salonChairName, setSalonChairName] = useState("");

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

  // Stand day-picker. On the host stand the centre of the date stepper opens
  // the SAME month grid the owner rail uses (per-day booking counts included)
  // instead of the native date input — a host jumping to next Saturday should
  // not tap the arrow seven times, and a native picker on a kiosk tablet is
  // whatever that OS decides to show.
  const [dayPickerOpen, setDayPickerOpen] = useState(false);
  const dayPickerRef = useRef(null);
  useEffect(() => {
    if (!dayPickerOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setDayPickerOpen(false);
    };
    const onDown = (e) => {
      if (dayPickerRef.current && !dayPickerRef.current.contains(e.target)) {
        setDayPickerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [dayPickerOpen]);

  const pickView = (v) => {
    setView(v);
    // A host glancing at the Floor must not silently retarget the owner's page.
    if (standalone) return;
    try {
      localStorage.setItem(RSVP_VIEW_KEY, v);
    } catch {
      /* private mode — non-fatal */
    }
  };

  // Resources power the zone filter + table-label resolution (and, next
  // phases, the floor + timeline rails). Soft-fail: the book still works.
  // R10: a refresh that fails keeps the room already on screen — tables do
  // not vanish because the wifi blinked — and a first load that failed is
  // asked again as soon as a book gets through (acceptBook below).
  const resourcesOkRef = useRef(false);
  const resourcesFailedRef = useRef(false);
  // The paired device's page learns its tables from THIS read (P0-1): a ref,
  // so fetchResources keeps its identity and is never asked again for it.
  const onRoomReadRef = useRef(onRoomRead);
  onRoomReadRef.current = onRoomRead;
  const fetchResources = useCallback(async () => {
    try {
      const res = await api.get("/reservations/resources");
      setResources(Array.isArray(res.data?.resources) ? res.data.resources : []);
      onRoomReadRef.current?.(Array.isArray(res.data?.resources) ? res.data.resources : null);
      // Decorative room objects, kept in their OWN state. Never merged into
      // `resources` — deriveFloorState, the seat gauge and every table picker
      // iterate that array and must keep counting only bookable things.
      setFixtures(Array.isArray(res.data?.fixtures) ? res.data.fixtures : []);
      // Prefer the backend's canonical seat total; keep null if an older API
      // omits it so the gauge can fall back to the raw reduce.
      const vs = res.data?.venue_seats_total;
      setVenueSeats(Number.isFinite(vs) ? vs : null);
      const he = res.data?.book_has_entries;
      setBookHasEntries(typeof he === "boolean" ? he : null);
      resourcesOkRef.current = true;
      resourcesFailedRef.current = false;
      setResourcesFailed(false);
    } catch {
      // A room that was already read stays as it was (R10).
      if (resourcesOkRef.current) return;
      onRoomReadRef.current?.(null);
      setFixtures([]);
      // The empty array is what the gauge and the pickers need in order to
      // render at all — but it is NOT an answer about how many tables this
      // venue has, and `resourcesLoaded` in the finally made it look like one.
      setResources([]);
      setVenueSeats(null);
      resourcesFailedRef.current = true;
      setResourcesFailed(true);
    } finally {
      setResourcesLoaded(true);
    }
  }, []);

  // ── R10: the door iPad stays on ───────────────────────────────────────
  // The day on screen, readable from handlers that outlive a render.
  const dayRef = useRef(day);
  dayRef.current = day;
  const bookRevRef = useRef(null);
  bookRevRef.current = bookRev;

  // A 404 on a PAIRED device may mean its link is dead. Asked once more
  // through the cheapest wrapped read before the book gives way to "not
  // connected": a stray 404 must never take the door's book away mid-service.
  const confirmStandGone = useCallback(async () => {
    try {
      await api.get("/reservations/changes", { _noRetry: true });
      return false;
    } catch (e) {
      return e?.response?.status === 404;
    }
  }, []);

  // A book for `forDay` arrived: show it, and tell the 20-second check
  // (lib/bookLive) which day is on screen and the revision it carries.
  const acceptBook = useCallback(
    (forDay, body) => {
      const book = body || null;
      // R11 (B10): a booking that freed a table since the last read of this
      // same day — changed on another screen, so no answer brought its
      // waiting matches here. Ask once per booking (the stand's door is
      // wrapped: /stand/<token>/waitlist/matches). Nobody waiting: no ask.
      const prevBook = dataRef.current;
      if (prevBook && book && shownDayRef.current === forDay && waitlistCountRef.current !== 0) {
        const ids = freedSince(prevBook.reservations, book.reservations, selfFreedRef.current);
        for (const id of ids) {
          selfFreedRef.current.add(id);
          api.get("/reservations/waitlist/matches", { params: { freed_reservation_id: id } })
            .then((res) => surfaceMatches(res?.data?.matches, forDay))
            .catch(() => {});
        }
      }
      setData(book);
      dataRef.current = book;
      shownDayRef.current = forDay;
      // When the book last actually ARRIVED. See the Offline line below.
      setLastOkAt(Date.now());
      lastFetchAtRef.current = Date.now();
      setLiveFailed(false);
      setPollFailures(0);
      setLoadError("");
      setStandGone(false);
      const rev = book && typeof book.rev === "string" && book.rev ? book.rev : null;
      setBookRev(rev);
      watchBook(watchIdRef.current, forDay, rev);
      // Signal the Venteliste to resync against the freshly-loaded book.
      setBookTick((n) => n + 1);
      // A link that just opened a book is this device's pairing: /stand
      // reopens it after a restart (services/standAuth).
      if (isStandDevice) setStandToken(standTokenFromPath(location.pathname));
      // The tables could not be read before; the network is back. (While the
      // room's own timed asks run, they ask — never two at once.)
      if (resourcesFailedRef.current && !roomBackoffRef.current) fetchResources();
    },
    [isStandDevice, location.pathname, fetchResources, surfaceMatches],
  );

  // A read of the book failed. Three honest outcomes, never a blank night:
  //   • a paired device whose link is dead → one calm "not connected" screen,
  //     and the guests leave the screen with it;
  //   • this day's book is on screen → it STAYS, and the toolbar says
  //     "Offline · viser bogen fra 19.42";
  //   • no book for this day yet → words (never the server's code), and the
  //     page asks again by itself.
  const bookFailed = useCallback(
    async (forDay, e, { quiet = false } = {}) => {
      if (isStandDevice && e?.response?.status === 404 && (await confirmStandGone())) {
        setStandGone(true);
        setData(null);
        dataRef.current = null;
        shownDayRef.current = null;
        setBookRev(null);
        unwatchBook(watchIdRef.current);
        return;
      }
      if (dataRef.current && shownDayRef.current === forDay) {
        setLiveFailed(true);
        return;
      }
      if (quiet) return; // the load of this day says its own failure
      setData(null);
      dataRef.current = null;
      shownDayRef.current = null;
      setLoadError(
        bookFailWords(e, t, t("rsvpBookError", "Couldn't load the reservation book."), { apptWords, load: true }),
      );
    },
    [isStandDevice, confirmStandGone, t, apptWords],
  );

  const fetchBook = useCallback(
    async (forDay) => {
      // This day's book is on screen: refresh it in place — no skeleton
      // flash after every tap, and a failure keeps it.
      const inPlace = !!dataRef.current && shownDayRef.current === forDay;
      if (!inPlace) {
        setLoading(true);
        // The check must not compare another day's revision meanwhile.
        watchBook(watchIdRef.current, forDay, null);
      } else {
        setRefreshing(true);
      }
      setError("");
      try {
        const res = await api.get("/reservations/book", { params: { day: forDay } });
        // A later day change superseded this answer: it is not this day's book.
        if (dayRef.current !== forDay) return;
        acceptBook(forDay, res.data);
      } catch (e) {
        if (dayRef.current !== forDay) return;
        await bookFailed(forDay, e);
      } finally {
        if (dayRef.current === forDay) setLoading(false);
        if (inPlace) setRefreshing(false);
      }
    },
    [acceptBook, bookFailed],
  );

  // Load the book when the DAY changes — not when a callback's identity
  // does (a dictionary arriving gives `t` a new identity, which re-read the
  // whole book for nothing).
  const fetchBookRef = useRef(fetchBook);
  fetchBookRef.current = fetchBook;
  useEffect(() => {
    fetchBookRef.current(day);
  }, [day]);
  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  // Tables that could not be read (none on screen) are asked again on their
  // own — 5 s, 15 s and 30 s apart — and after that with each reload of the
  // book (acceptBook). Capped: three timed asks, then one per reload; an
  // answer stops it (fix round 5, gate G: nothing re-asked for 45 s+ while
  // every row read "Intet bord").
  const roomBackoffRef = useRef(false);
  useEffect(() => {
    if (!resourcesFailed) return undefined;
    let cancelled = false;
    let timer = null;
    let step = 0;
    roomBackoffRef.current = true;
    const next = () => {
      if (cancelled) return;
      if (step >= ROOM_RETRY_MS.length) {
        roomBackoffRef.current = false;     // from here on, with the book's reloads
        return;
      }
      timer = setTimeout(async () => {
        step += 1;
        await fetchResources();
        if (!cancelled && resourcesFailedRef.current) next();
      }, ROOM_RETRY_MS[step]);
    };
    next();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [resourcesFailed, fetchResources]);

  // Live book — the screen the owner stares at MID-SERVICE must not go stale.
  // Without this, a public booking, a cancellation, or a host-stand flip made
  // on another device stays invisible until someone hunts for the manual
  // refresh button. Honest signals, no websockets (single-worker backend):
  //   1. The 20-second check (useLiveAlerts + lib/bookLive) asks the server
  //      for the revision of the day on screen; a different one reloads the
  //      book here (R10: every change, by anyone, within ~20 s).
  //   2. The moment the screen wakes / tab refocuses — unless the revision
  //      check is live, which asks the same question for less.
  //   3. A safety-net reload, TODAY only and only while visible: every ~2 min
  //      once revisions are known to work, every ~75 s against a server that
  //      sends none.
  // SILENT: no setLoading, so the list never flashes or jumps under the thumb;
  // an in-flight ref stops overlapping fetches from racing each other.
  const liveRefreshInFlight = useRef(false);
  const refreshBookSilently = useCallback(async () => {
    if (liveRefreshInFlight.current) return;
    const forDay = dayRef.current;
    liveRefreshInFlight.current = true;
    try {
      const res = await api.get("/reservations/book", { params: { day: forDay } });
      if (dayRef.current !== forDay) return;
      acceptBook(forDay, res.data);
    } catch (e) {
      // Silent no longer means INVISIBLE. The poll used to swallow every
      // failure while the now-line, the ETAs and the "forsinket" chips kept
      // ticking off the 60s clock — so a stand whose wifi had dropped looked
      // MORE alive than one that was merely quiet. The book stays; the
      // toolbar says how old it is (see `bookOffline`).
      if (dayRef.current !== forDay) return;
      await bookFailed(forDay, e, { quiet: true });
    } finally {
      liveRefreshInFlight.current = false;
    }
  }, [acceptBook, bookFailed]);

  // The handlers below outlive a render; they call the newest reload through
  // this ref, so a re-render never restarts their timers.
  const refreshRef = useRef(refreshBookSilently);
  refreshRef.current = refreshBookSilently;

  // What the 20-second check learns (lib/bookLive), and what the browser
  // itself says about the network.
  useEffect(() => {
    const onFresh = (e) => {
      if (e?.detail?.day && e.detail.day !== dayRef.current) return;
      // Proven current: the book on screen is what the server has now.
      setLastOkAt(Date.now());
      setLiveFailed(false);
      setPollFailures(0);
    };
    const onUnreachable = (e) => {
      const n = Number(e?.detail?.failures);
      setPollFailures(Number.isFinite(n) && n >= 0 ? n : 1);
    };
    const onOnline = () => setBrowserOffline(false);
    const onOffline = () => setBrowserOffline(true);
    window.addEventListener(BOOK_FRESH_EVENT, onFresh);
    window.addEventListener(BOOK_UNREACHABLE_EVENT, onUnreachable);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener(BOOK_FRESH_EVENT, onFresh);
      window.removeEventListener(BOOK_UNREACHABLE_EVENT, onUnreachable);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  // Leaving the page: the check stops asking about this book.
  useEffect(() => {
    const id = watchIdRef.current;
    return () => unwatchBook(id);
  }, []);

  // No book for this day could be read: ask again by itself — sooner at
  // first, then less often (5 s, 10 s … at most a minute, each a little
  // random so a room of screens does not ask together), and at once when the
  // network comes back. Stops the moment a book arrives.
  useEffect(() => {
    if (!loadError || standGone) return undefined;
    let cancelled = false;
    let timer = null;
    let attempt = 0;
    const tryNow = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") await refreshRef.current();
      if (!cancelled) plan();
    };
    const plan = () => {
      attempt += 1;
      const span = Math.min(5000 * 2 ** (attempt - 1), 60000);
      timer = setTimeout(tryNow, Math.round(span * (1 - 0.2 * Math.random())));
    };
    const onOnline = () => {
      clearTimeout(timer);
      timer = setTimeout(tryNow, Math.round(Math.random() * 1500));
    };
    plan();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [loadError, standGone]);

  // Roll the host stand onto the new day. `day` is set once at mount and the
  // poll below only arms while day === today, so a stand left running by the
  // door was pinned to yesterday AND had stopped polling by morning — while the
  // now-line kept ticking, so it looked alive. Checked every minute; the poll
  // re-arms for free because this effect's dependency IS `day`.
  useEffect(() => {
    if (!standalone) return undefined;
    const id = setInterval(() => {
      const today = serviceDayIso();
      if (day !== today) setDay(today);
    }, 60000);
    return () => clearInterval(id);
  }, [standalone, day, setDay]);

  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const onWake = () => {
      if (!visible()) return;
      // The revision check is live: the poll wakes with the screen and
      // reloads only if the day moved — no full reload per wake.
      if (bookRevRef.current) return;
      // One reload per wake: visibilitychange and focus fire together.
      if (Date.now() - lastFetchAtRef.current < WAKE_GAP_MS) return;
      refreshRef.current();
    };
    // The live poll saw a booking arrive or the day move (R10): reload now,
    // on whichever day is open. The page's OWN "I just changed something"
    // (no detail) is followed by its own reload — this one waits a moment and
    // is skipped when that reload has already landed, so one tap is one
    // request, not two.
    const pending = new Set();
    const onChanged = (e) => {
      if (e?.detail?.from === "live") {
        refreshRef.current();
        return;
      }
      const askedAt = Date.now();
      const id = setTimeout(() => {
        pending.delete(id);
        if (lastFetchAtRef.current < askedAt) refreshRef.current();
      }, 1500);
      pending.add(id);
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener(RESERVATIONS_CHANGED_EVENT, onChanged);
    // The safety net: a full quiet reload, today only, visible only.
    let timer = null;
    let alive = true;
    const plan = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        if (visible() && Date.now() - lastFetchAtRef.current > WAKE_GAP_MS) refreshRef.current();
        plan();
      }, safetyReloadMs(!!bookRevRef.current));
    };
    if (day === serviceDayIso()) plan();
    return () => {
      alive = false;
      clearTimeout(timer);
      pending.forEach((id) => clearTimeout(id));
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener(RESERVATIONS_CHANGED_EVENT, onChanged);
    };
  }, [day]);

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
  const setSalonHourDay = (key, patch) => {
    salonHoursDirtyRef.current = true;
    setSalonHours((h) => ({ ...h, [key]: { ...h[key], ...patch } }));
  };
  const applySalonMonToAll = () => {
    salonHoursDirtyRef.current = true;
    setSalonHours((h) => {
      const mon = h.mon;
      const next = {};
      DAY_KEYS.forEach((k) => {
        next[k] = { ...mon };
      });
      return next;
    });
  };
  const openSalonForBooking = async () => {
    if (salonSetupBusy) return; // guard against double-submit
    // Two periods that overlap, or a time left empty, never reach the
    // server: the card says which day (R8).
    const problem = hoursProblem(salonHours, { withLast: false });
    if (problem) {
      setSalonSetupError(hoursProblemWords(problem, t, lang));
      return;
    }
    setSalonSetupBusy(true);
    setSalonSetupError("");
    try {
      await api.post("/reservations/salon/quick-setup", {
        // A chair never reads a last booking time; none is sent.
        booking_hours: serializeBookingHours(salonHours, { withLast: false }),
        // This card shows two periods a day: its week is the owner's (R8).
        hours_shape: HOURS_SHAPE,
        // Saved hours stay unless the owner edited them on this card.
        replace_hours: salonHoursDirtyRef.current,
        // What customers call her chair (R7): her name, else "Indehaver".
        chair_name: tidyName(salonChairName).slice(0, STYLIST_NAME_MAX) ||
          t("rsvpSelfChairDefaultName", "Owner"),
      });
      // Refetch so the self-chair now appears (providerStations > 0 → the
      // first-run card falls away and the live book + New-booking sheet
      // render); refresh the behandlinger catalog too.
      await fetchResources();
      await fetchBehandlinger();
    } catch (e) {
      // Words, never the server's code (R10, V10).
      setSalonSetupError(
        bookFailWords(e, t, t("rsvpSalonSetupError", "Couldn't open for booking. Try again."), { apptWords }),
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
  // A link to a DAY alone (/reservations?date=<iso>, no booking): the
  // "N bookinger ligger allerede på disse dage" link on a closed date, and the
  // owner's "Mange nye online-bookinger" push (R1). The book opens on that
  // day; the param is then dropped so a refresh starts on it, not back here.
  useEffect(() => {
    if (deepBookingId || !deepDate) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(deepDate) && deepDate !== day) setDay(deepDate);
    const next = new URLSearchParams(searchParams);
    next.delete("date");
    setSearchParams(next, { replace: true });
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
    if (loading || !data) return;
    // …and the list on screen must BE that day's. Right after the switch the
    // previous day's book is still in `data` until the new one lands, and the
    // booking was looked for there: every search result on another day said
    // "this reservation no longer exists".
    if (data.date && data.date !== day) return;
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

  // The search on OTHER days — "booked Saturday under Hansen" was unfindable
  // without paging the day rail, because the box filtered the open day only.
  // Owner session only: the door stand has no route for it, by design.
  const [found, setFound] = useState({ q: "", list: [], failed: false });
  useEffect(() => {
    const needle = q.trim();
    if (isStandDevice || needle.length < 2) return undefined;
    let alive = true;
    const id = setTimeout(() => {
      api.get("/reservations/search", { params: { q: needle } })
        .then((r) => { if (alive) setFound({ q: needle, list: Array.isArray(r.data?.results) ? r.data.results : [], failed: false }); })
        .catch(() => { if (alive) setFound({ q: needle, list: [], failed: true }); });
    }, 250);
    return () => { alive = false; clearTimeout(id); };
  }, [q, isStandDevice]);
  const searchLive = !isStandDevice && q.trim().length >= 2 && found.q === q.trim();
  // Typed, not answered yet: the other-day hits arrived a second after
  // "Intet matcher", which read as the final word.
  const searchPending = !isStandDevice && q.trim().length >= 2 && found.q !== q.trim();
  const otherDayHits = searchLive ? found.list.filter((h) => h.day !== day) : [];
  const openOtherDay = (h) => {
    const next = new URLSearchParams(searchParams);
    next.set("booking", h.id);
    next.set("date", h.day);
    setSearchParams(next, { replace: true });
  };

  // The ring is a single beat — fade it after the drawer has settled.
  useEffect(() => {
    if (!deepLinkPulse) return;
    const id = setTimeout(() => setDeepLinkPulse(false), 1400);
    return () => clearTimeout(id);
  }, [deepLinkPulse]);

  // onProceed runs once every confirm has said yes — the drawer closes
  // then, not before: "Behold" on the cancel question closed it anyway.
  // The tables a booking holds (a combination, or its one table).
  const heldOf = (x) => (Array.isArray(x?.combined_resource_ids) && x.combined_resource_ids.length
    ? x.combined_resource_ids.map(String) : x?.resource_id ? [String(x.resource_id)] : []);
  // "Bord 2 is still taken" — a party SEATED there, running over or never
  // marked finished. Seating on top of it put two parties "Sidder" on a
  // 2-top. One tap finishes them and seats this party; the other choice
  // opens this booking on its tables.
  const occupiedConfirm = ({ table, name, overMin, endsAt }, guest) => {
    const occName = name || t("rsvpGuest", "Guest");
    const who = guest || t("rsvpGuest", "Guest");
    const tbl = table || t("rsvpTableFallback", "Table");
    return confirm({
      title: t("rsvpTableTakenTitle", "{table} is still taken", { table: tbl }),
      message: overMin
        ? t("rsvpTableTakenOverBody", "{name} is still seated there — {txt} over time. Finish them and seat {guest}, or give {guest} another table.", { name: occName, txt: overByText(t, overMin), guest: who })
        : t("rsvpTableTakenBody", "{name} is seated there until {time}. Finish them and seat {guest}, or give {guest} another table.", { name: occName, time: endsAt ? fmtTime(endsAt) : "—", guest: who }),
      confirmLabel: t("rsvpFinishAndSeat", "Finish {name} and seat", { name: occName.split(" ")[0] }),
      cancelLabel: t("rsvpPickAnotherTable", "Another table"),
    });
  };
  // R2: after a spam mark, an undo or a whole wave — the book reloads, the
  // drawer closes, a table freed for real shows the waiting parties that fit
  // (as a cancel does), and the plan-cap banner takes the fresh month count
  // (spam gives the month's quota back).
  const spamDone = (data) => {
    const m = data?.waitlist_matches;
    if (Array.isArray(m) && m.length) setSpotMatches(m);
    const cap = data ? monthCapFromSettings(data) : null;
    if (cap) setPublicPage((p) => (p ? { ...p, monthCap: cap } : p));
    setSelected(null);
    try { window.dispatchEvent(new Event("bonbox-reservations-changed")); } catch { /* no window */ }
    fetchBook(day);
  };
  // "Andet bord": open the booking with its table picker in focus — focus
  // used to land on "Sæt til bords" again.
  const openOnTables = (r) => {
    openDrawer(r);
    setTimeout(() => {
      const el = document.getElementById("rsvp-drawer-table");
      if (el) { el.scrollIntoView?.({ block: "center" }); el.focus({ preventScroll: true }); }
    }, 150);
  };
  const setStatus = async (r, status, onProceed = null, opts = {}) => {
    // R2: a HELD online booking that looks like a robot's (a hidden field
    // filled, a form filled in seconds, a link in the name, a contact the
    // owner marked as spam) is never approved in one tap — the phone row's
    // "Bekræft" and the drawer's ask once more, with the reason.
    if ((status === "confirmed" || status === "seated") && !opts.retried && heldLooksLikeBot(r)) {
      if ((await confirm(botApprovalConfirm(r, t, { apptWords, to: status }))) !== true) return;
    }
    let finishFirst = opts.finishFirst || null;
    if (!finishFirst && status === "seated" && r.status !== "seated") {
      const mine = heldOf(r);
      const occ = mine.length
        ? reservations.find((x) => x.id !== r.id && x.status === "seated" && heldOf(x).some((id) => mine.includes(id)))
        : null;
      if (occ) {
        const ok = await occupiedConfirm({
          table: resolveTableLabel(occ, labelById),
          name: guestText(occ.guest_name),
          overMin: overdueMinutes(occ, Date.now()),
          endsAt: occ.ends_at,
        }, guestText(r.guest_name));
        if (!ok) { openOnTables(r); return; }
        finishFirst = { id: occ.id, name: guestText(occ.guest_name) };
      }
    }
    // Seating a booking hours early is almost always the wrong row (a 20:00
    // party seated at 10:05 started its turn timer and held the table all
    // day). Ask once when it is more than an hour ahead; reopening a
    // finished table is not a first seating and is never asked about.
    if (status === "seated" && r.status !== "completed" && r.starts_at) {
      const aheadMin = (new Date(r.starts_at).getTime() - Date.now()) / 60000;
      if (aheadMin > 60) {
        const who = guestText(r.guest_name) || t("rsvpGuest", "Guest");
        // Someone else due on the same table inside their sitting: say who
        // and when, before the host commits — it was silent.
        const mine = Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
          ? r.combined_resource_ids.map(String) : r.resource_id ? [String(r.resource_id)] : [];
        const nowMs = Date.now();
        const endMs = nowMs + (Number(r.duration_min) || 90) * 60000;
        const next = reservations
          .filter((x) => x.id !== r.id && ["requested", "confirmed", "seated"].includes(x.status) && x.starts_at)
          .filter((x) => {
            const ids = Array.isArray(x.combined_resource_ids) && x.combined_resource_ids.length
              ? x.combined_resource_ids.map(String) : x.resource_id ? [String(x.resource_id)] : [];
            const s0 = new Date(x.starts_at).getTime();
            const s1 = x.ends_at ? new Date(x.ends_at).getTime() : s0 + 90 * 60000;
            return ids.some((id) => mine.includes(id)) && s0 < endMs && s1 > nowMs;
          })
          .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1))[0];
        const nextTable = next ? resolveTableLabel(next, labelById) || t("rsvpTableFallback", "Table") : null;
        const heldSeats = mine.reduce((sum, id) => sum + (seatsById[id] || 0), 0);
        const overLine = heldSeats > 0 && Number(r.party_size) > heldSeats
          ? " " + t("rsvpSeatOverFull", "{n} guests at {seats} seats.", { n: r.party_size, seats: heldSeats })
          : "";
        const clashLine = !next
          ? ""
          : new Date(next.starts_at).getTime() - nowMs >= 30 * 60000
            ? " " + t("rsvpSeatEarlyUntil", "{table} is booked at {time} — they can sit until then.", { table: nextTable, time: fmtTime(next.starts_at) })
            : " " + t("rsvpSeatEarlyTaken", "{table} is needed at {time} — give them another table first.", { table: nextTable, time: fmtTime(next.starts_at) });
        if (
          !(await confirm({
            title: apptWords
              ? t("rsvpSeatEarlyTitleAppt", "Check {name} in now?", { name: who })
              : t("rsvpSeatEarlyTitle", "Seat {name} now?", { name: who }),
            message: (apptWords
              ? t("rsvpSeatEarlyBodyAppt", "The appointment is at {time}. Checking in now starts their time now.", { time: fmtTime(r.starts_at) })
              : t("rsvpSeatEarlyBody", "The booking is for {time}. Seating now starts their table time.", { time: fmtTime(r.starts_at) })) + clashLine + overLine,
            confirmLabel: apptWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatAction", "Seat"),
            cancelLabel: t("rsvpSeatEarlyNotNow", "Not now"),
          }))
        ) {
          return;
        }
      }
    }
    if (status === "no_show") {
      const who = guestText(r.guest_name) || t("rsvpGuest", "Guest");
      if (
        !(await confirm({
          title: t("rsvpNoShowConfirmTitle", "Mark as no-show?"),
          message: t("rsvpNoShowConfirmBody", "Records that {name} didn't arrive.", { name: who }),
          confirmLabel: t("rsvpNoShowAction", "No-show"),
          destructive: true,
        }))
      ) {
        return;
      }
    }
    // A drop-in removed again (seated by mistake) is not a cancelled booking:
    // its own words, nobody notified, and it leaves the lists and counts.
    const removingWalkIn = status === "cancelled" && r.source === "walk_in";
    // Declining a BOT-LIKE held booking whose address never had a mail from
    // us: say nothing to it (the server holds to the same rule). A
    // person-like hold (`held.bot === false`, fix round 2) is told within
    // the venue's held-mail budget — the server says so if it could not be.
    // An older server sends no `bot`: then every unmailed hold is silent.
    const silentHeldDecline = status === "cancelled" && r.status === "requested"
      && isHeldForCheck(r, publicPage?.groupThreshold) && r.guest_mailed === false
      && r.held?.bot !== false;
    // R11 (B7): confirming a request that holds no table — a group — gives it
    // the tables the engine would. The app asks to hear first when none fit
    // (409 no_table_fits → NoTableFitsSheet); "Bekræft uden bord" says
    // "confirm" on purpose.
    const confirmsNoTable = status === "confirmed" && r.status === "requested"
      && !isProvider && heldOf(r).length === 0;
    if (removingWalkIn) {
      if (
        !(await confirm({
          title: t("rsvpRemoveWalkInTitle", "Remove this drop-in?"),
          message: t("rsvpRemoveWalkInBody", "The table is freed. Nobody is notified."),
          confirmLabel: t("rsvpRemoveWalkInCta", "Remove"),
          cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
          destructive: true,
        }))
      ) {
        return;
      }
    } else if (status === "cancelled") {
      const who = guestText(r.guest_name) || (apptWords ? t("rsvpColGuestAppt", "Customer") : t("rsvpGuest", "Guest"));
      // A `requested` booking is DECLINED (it was never confirmed), not a
      // confirmed booking CANCELLED — honest, distinct copy for each while
      // keeping the ONE useConfirm dialog. This single confirm owns BOTH the
      // list-row and drawer decline/cancel paths (rowActions hands "cancelled"
      // straight here), so branching the copy here fixes both at once.
      const isDecline = r.status === "requested";
      // A HELD online booking (R1): the guest hears only if we already wrote
      // to that address about it — a bot's typed address gets no mail, and
      // the owner is told which it is before they tap.
      const heldDecline = isDecline && isHeldForCheck(r, publicPage?.groupThreshold);
      const silent = heldDecline && r.guest_mailed === false && r.held?.bot !== false;
      // A person-like hold we never wrote to: mailed if the day's budget for
      // held requests allows; a toast says so when it did not.
      const maybeMail = heldDecline && r.guest_mailed === false && !silent;
      if (
        !(await confirm(
          heldDecline
            ? {
                title: t("rsvpDeclineConfirmTitle", "Decline this request?"),
                // A salon, a shop, a workshop: "the customer", never "the
                // guest" (apptWords — R1a).
                message: silent
                  ? t("rsvpHeldDeclineBodySilent", "The request from {name} is declined without an e-mail — we never wrote to that address. Call them if it was real.", { name: who })
                  : maybeMail
                    ? (apptWords
                      ? t("rsvpHeldDeclineBodyMaybeAppt", "The request from {name} is declined. We e-mail the customer if today's limit for held requests allows — you'll be told if not.", { name: who })
                      : t("rsvpHeldDeclineBodyMaybe", "The request from {name} is declined. We e-mail the guest if today's limit for held requests allows — you'll be told if not.", { name: who }))
                    : (apptWords
                      ? t("rsvpHeldDeclineBodyMailAppt", "The request from {name} is declined. The customer gets an e-mail about it.", { name: who })
                      : t("rsvpHeldDeclineBodyMail", "The request from {name} is declined. The guest gets an e-mail about it.", { name: who })),
                confirmLabel: silent
                  ? t("rsvpHeldDeclineSilentAction", "Decline without a message")
                  : t("rsvpDeclineAction", "Decline"),
                cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
                destructive: true,
              }
            : isDecline
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
                // rsvpOwnerCancelConfirm*, not rsvpCancelConfirm* — the latter
                // is the GUEST self-cancel on the public booking page, written
                // in the second person and carrying no name. Sharing one key
                // meant this dialog told the owner "You're welcome to book
                // again" and silently dropped {name}.
                title: t("rsvpOwnerCancelConfirmTitle", "Cancel this booking?"),
                message: t(
                  "rsvpOwnerCancelConfirmBody",
                  "The booking for {name} is cancelled. They're notified if possible.",
                  { name: who },
                ),
                confirmLabel: t("rsvpOwnerCancelConfirmYes", "Cancel booking"),
                cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
                destructive: true,
              },
        ))
      ) {
        return;
      }
    }
    onProceed?.();
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
              row.id === r.id ? { ...row, status }
                : finishFirst && row.id === finishFirst.id ? { ...row, status: "completed" } : row,
            ),
          }
        : prev,
    );
    try {
      if (finishFirst) {
        await api.patch(`/reservations/reservations/${finishFirst.id}/status`, { status: "completed" });
      }
      const resp = await api.patch(`/reservations/reservations/${r.id}/status`, {
        status,
        cancel_reason: removingWalkIn ? "walk_in_removed" : status === "cancelled" ? "owner_cancelled" : null,
        ...(removingWalkIn || silentHeldDecline ? { notify_guest: false } : {}),
        ...(confirmsNoTable ? { if_no_table: opts.ifNoTable === "confirm" ? "confirm" : "ask" } : {}),
        ...(opts.moveTo ? { starts_at: opts.moveTo } : {}),
      });
      // Where the confirmed group sits now — said, as every other change on
      // the book is (R11). Or that it sits nowhere yet, on purpose.
      const placed = resp?.data?.tables_assigned;
      const placedAt = Array.isArray(placed?.labels) ? placed.labels.filter(Boolean).join(" + ") : "";
      if (status === "confirmed" && placedAt) {
        toast({
          severity: "success",
          // The new time only when the server says it moved (an older server
          // ignores the move and confirms at the time it had).
          message: opts.movedTo && (!opts.moveTo || resp?.data?.moved_to)
            ? t("rsvpMovedConfirmed", "Moved to {time} and confirmed — {name} has {tables}.", {
                time: hm(opts.movedTo), name: guestText(r.guest_name) || t("rsvpGuest", "Guest"), tables: placedAt,
              })
            : t("rsvpConfirmedTables", "Confirmed — {name} has {tables}.", {
                name: guestText(r.guest_name) || t("rsvpGuest", "Guest"), tables: placedAt,
              }),
        });
      } else if (status === "confirmed" && resp?.data?.no_table_fits) {
        toast({
          severity: "notice",
          message: apptWords
            ? t("rsvpConfirmedNoTableAppt", "{name} is confirmed without a space — give them a space before they arrive.", { name: guestText(r.guest_name) || t("rsvpColGuestAppt", "Customer") })
            : t("rsvpConfirmedNoTable", "{name} is confirmed without a table — give them tables before they arrive.", { name: guestText(r.guest_name) || t("rsvpGuest", "Guest") }),
        });
      }
      // A cancel/no-show may have freed a table — surface the waiting parties
      // that fit (the backend already filtered by capacity + local day). This
      // only SHOWS them; the owner still taps Notify / Book.
      const m = resp?.data?.waitlist_matches;
      if (status === "cancelled" || status === "no_show") selfFreedRef.current.add(r.id);
      if (Array.isArray(m) && m.length) surfaceMatches(m, day);
      // The server could not do the obvious thing — say so, never silently.
      const kept = resp?.data?.early_kept;
      if (kept) {
        // A late party keeps its booked window when the table is needed
        // soon: "keeps 15.00" said nothing useful at 17.12.
        const wasLate = r.starts_at && new Date(r.starts_at).getTime() < Date.now();
        toast({
          severity: "notice",
          message: wasLate
            ? t("rsvpSeatLateKept", "{table} is needed at {time} — {name} has it until then.", {
                table: kept.table || t("rsvpTableFallback", "Table"), time: hm(kept.at), name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
              })
            : t("rsvpSeatEarlyKept", "{table} is needed at {time}, so the booking keeps {booked}. Give them another table in the booking.", {
                table: kept.table || t("rsvpTableFallback", "Table"), time: hm(kept.at), booked: fmtTime(r.starts_at),
              }),
        });
      }
      // Seated early or late, the sitting now runs from now — said, not a
      // booking that silently moved from 18.00 to 17.07.
      const movedFrom = resp?.data?.moved_from;
      if (movedFrom && status === "seated" && !finishFirst) {
        toast({
          severity: "info",
          message: t("rsvpSeatedMovedFrom", "{name} is seated — the table is theirs until {end} (booked {booked}).", {
            name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
            end: fmtTime(resp.data.ends_at),
            booked: fmtTime(movedFrom),
          }),
        });
      }
      if (status === "no_show") {
        toast({
          severity: "info",
          message: t("rsvpNoShowDone", "{name} is marked as no-show. Reopen the booking if they turn up.", {
            name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
          }),
        });
      }
      // Every change on the book is said, not just some: finishing, a
      // cancel and a removed drop-in only changed a colour.
      const doneName = guestText(r.guest_name) || t("rsvpGuest", "Guest");
      if (status === "completed" && !finishFirst) {
        const tbl = resolveTableLabel(r, labelById);
        toast({
          severity: "success",
          message: tbl
            ? (Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length > 1
              ? t("rsvpFinishedDoneMany", "{name} finished — {table} are free.", { name: doneName, table: tbl })
              : t("rsvpFinishedDone", "{name} finished — {table} is free.", { name: doneName, table: tbl }))
            : t("rsvpFinishedDoneNoTable", "{name} finished.", { name: doneName }),
        });
      } else if (status === "cancelled") {
        toast({
          severity: "info",
          message: removingWalkIn
            ? t("rsvpWalkInRemovedDone", "Drop-in removed — the table is free.")
            : r.status === "requested"
              ? t("rsvpDeclinedDone", "The request from {name} is declined.", { name: doneName })
              : t("rsvpCancelledDone", "The booking for {name} is cancelled.", { name: doneName }),
        });
      }
      // The venue reached its daily guest-mail ceiling: the change is saved,
      // but the guest was not e-mailed — say so, so the owner tells them.
      const gSkip = resp?.data?.guest_email_skipped;
      if (gSkip?.code === "guest_email_owner_cap") {
        toast({ severity: "notice", message: t("rsvpGuestMailOwnerCap", { cap: gSkip.cap }) });
      } else if (gSkip?.code === "guest_email_address_cap") {
        // This guest's address was already mailed enough today (per-mailbox bound).
        toast({ severity: "notice", message: t("rsvpGuestMailAddressCap", { cap: gSkip.cap }) });
      } else if (gSkip?.code === "held_mail_budget") {
        // A held request declined after the day's held-request mails ran out.
        toast({
          severity: "notice",
          message: apptWords
            ? t("rsvpGuestMailHeldBudgetAppt", "Declined. The customer was not e-mailed: today's e-mails for held requests are used up. Call the customer if it was real.")
            : t("rsvpGuestMailHeldBudget", "Declined. The guest was not e-mailed: today's e-mails for held requests are used up. Call the guest if it was real."),
        });
      }
      if (finishFirst) {
        toast({
          severity: "success",
          message: t("rsvpFinishedAndSeated", "{done} finished — {name} seated at {table}.", {
            done: finishFirst.name || t("rsvpGuest", "Guest"),
            name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
            table: resolveTableLabel(resp?.data || r, labelById) || t("rsvpTableFallback", "Table"),
          }),
        });
      }
      // Undo said nothing — the row just changed colour.
      if (r.status === "seated" && status === "confirmed" && !resp?.data?.restore_blocked) {
        toast({
          severity: "info",
          message: t("rsvpUndoSeatDone", "Seating undone — {name} is booked for {time} again.", {
            name: guestText(r.guest_name) || t("rsvpGuest", "Guest"), time: fmtTime(resp?.data?.starts_at || r.starts_at),
          }),
        });
      }
      const blocked = resp?.data?.restore_blocked;
      if (blocked) {
        toast({
          severity: "notice",
          message: t("rsvpUndoNotRestored", "Couldn't give {booked} back — {table} is taken then. The booking stays at {now}.", {
            booked: hm(blocked.booked_at), table: blocked.table || t("rsvpTableFallback", "Table"), now: fmtTime(resp.data.starts_at),
          }),
        });
      }
      window.dispatchEvent(new Event("bonbox-reservations-changed"));
      await fetchBook(day);
      // Seated with no table (a 12 "booked without a table"): the booking
      // opens on its tables, so giving them some is the next tap — not a hunt.
      const row = resp?.data;
      if (status === "seated" && row && !row.resource_id && !(Array.isArray(row.combined_resource_ids) && row.combined_resource_ids.length)) {
        setAssignError("");
        setSelected(row);
      }
    } catch (e) {
      const d = e?.response?.data?.detail || {};
      // "Flyt til … og bekræft" against an API from before the one-request
      // move (the deploy window: the app can land a step ahead of the API).
      // That server ignores starts_at and answers for the time the request
      // had — its `at` is not the move's. Then the old two steps: move the
      // request, then Bekræft as usual (fix round 27 Oct). Once only.
      if (e?.response?.status === 409 && d.error === "no_table_fits" && confirmsNoTable
          && opts.moveTo && opts.movedTo && d.at && d.at !== opts.movedTo && !opts.legacyMove) {
        try {
          await api.patch(`/reservations/reservations/${r.id}`, { starts_at: opts.moveTo });
        } catch (e2) {
          await fetchBook(day);
          setError(bookFailWords(e2, t, t("rsvpActionError", "Action failed. Please try again."), { apptWords }));
          return;
        }
        await setStatus(r, status, null, { movedTo: opts.movedTo, legacyMove: true, retried: true });
        return;
      }
      // R11 (B7): no table fits the group — nothing changed on the server.
      // The book reloads (the optimistic "confirmed" goes back to a request)
      // and the sheet says so and offers what can be done.
      if (e?.response?.status === 409 && d.error === "no_table_fits" && confirmsNoTable) {
        await fetchBook(day);
        setNoFit({ r, facts: d });
        return;
      }
      if (e?.response?.status === 409 && d.error === "table_occupied" && d.occupant && !opts.retried) {
        await fetchBook(day);
        const ok = await occupiedConfirm({
          table: d.occupant.table, name: guestText(d.occupant.name), overMin: d.occupant.over_min, endsAt: d.occupant.ends_at,
        }, guestText(r.guest_name));
        setActioningId(null);
        if (ok) await setStatus(r, status, null, { finishFirst: { id: d.occupant.id, name: guestText(d.occupant.name) }, retried: true });
        else openOnTables(r);
        return;
      }
      // Approving a held online booking (R1 fix round) whose table or chair
      // went meanwhile: said in words, as a toast — the book reload below
      // clears the page's error line, and a raw "slot_unavailable" said
      // nothing anyway.
      const heldConflict = e?.response?.status === 409 && d.held
        ? (d.error === "stylist_unavailable"
          ? t("rsvpHeldApproveStylistTaken", "The stylist the customer chose isn't free at {time} any more. Call the customer, or decline it.", { time: fmtTime(r.starts_at) })
          : isProvider
          ? t("rsvpHeldApproveNoTime", "No stylist is free at {time} any more. Call the customer, or decline it.", { time: fmtTime(r.starts_at) })
          : apptWords
          ? t("rsvpHeldApproveNoTableAppt", "No space is free at {time} any more. Open the appointment and pick a space yourself, or decline it.", { time: fmtTime(r.starts_at) })
          : t("rsvpHeldApproveNoTable", "No table is free at {time} any more. Open the booking and place it yourself, or decline it.", { time: fmtTime(r.starts_at) }))
        : null;
      // Read the book again FIRST: the reload clears the page's error line,
      // so a refusal said before it was gone before anyone read it (R10 —
      // a lost race said in words, and left on screen). Never the code.
      await fetchBook(day);
      if (heldConflict) {
        toast({ severity: "notice", message: heldConflict });
      } else if (confirmsNoTable && e?.response?.status === 409 && d.error === "slot_unavailable") {
        // The tables the server picked went to another screen in the same
        // instant (the exclusion constraint) — a second tap picks afresh.
        setError(apptWords
          ? t("rsvpConfirmTakenAgainAppt", "That space was taken a moment ago. Tap Confirm again.")
          : t("rsvpConfirmTakenAgain", "Those tables were taken a moment ago. Tap Confirm again."));
      } else {
        setError(
          d.error === "table_occupied"
            ? t("rsvpTableStillTaken", "{table} is still taken — finish the party there first, or pick another table.", {
                table: d.occupant?.table || t("rsvpTableFallback", "Table"),
              })
            : bookFailWords(e, t, t("rsvpActionError", "Action failed. Please try again."), { apptWords }),
        );
      }
    } finally {
      setActioningId(null);
    }
  };

  // R11 (B7): "Flyt til 21.45 og bekræft" — the request moves to a time the
  // server said tables fit and is confirmed there, in ONE request (fix round
  // 27 Oct): moved and confirmed together or not at all, and the guest gets
  // ONE mail — the confirmation, naming the new time and the one asked for.
  // Bekræft's own answers apply: the tables are picked and held, or the
  // sheet comes back with what is true now (nothing moved).
  const moveAndConfirm = async (r, hhmm) => {
    const date = String(r.starts_at || "").slice(0, 10) || day;
    const starts = `${date}T${hhmm}:00`;
    setNoFitBusy(true);
    try {
      setNoFit(null);
      await setStatus({ ...r, starts_at: starts }, "confirmed", null, { movedTo: hhmm, moveTo: starts });
    } finally {
      setNoFitBusy(false);
    }
  };

  // Seat a walk-in NOW on a free table → the table goes occupied (seated).
  // `resource_ids` (2+) seats them across tables pushed together, all held or
  // none — the joined set the booking engine itself would use.
  // `inSheet`: the seat sheet is open over the page — its refusal is said in
  // the sheet (an error on the page sat behind it, unseen on a phone).
  const seatWalkIn = async ({ resource_id = null, resource_ids = null, party_size, guest_name }, { inSheet = false } = {}) => {
    setSeating(true);
    setError("");
    setSeatError("");
    const say = inSheet ? setSeatError : setError;
    const joined = Array.isArray(resource_ids) && resource_ids.length > 1;
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const startsAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
      const res = await api.post("/reservations/book", {
        guest_name,
        party_size,
        starts_at: startsAt,
        ...(joined ? { resource_id: null, resource_ids } : { resource_id }),
        source: "walk_in",
        status: "seated",
      });
      haptic.success();
      setSeatTarget(null);
      setSeatParty(null);
      // The walk-in is seated NOW (today) — jump to today if viewing another
      // day so it's visible; otherwise refetch in place.
      const todayIso = serviceDayIso();
      // The day rail counts from its own month query — tell it (it read 16
      // while the book said 19).
      window.dispatchEvent(new Event("bonbox-reservations-changed"));
      if (day !== todayIso) setDay(todayIso);
      else await fetchBook(day);
      return res?.data || null;
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      const conflict = e?.response?.status === 409;
      // One table, standing free, with a booking inside the party's sitting
      // in the book the host was looking at: that booking is the refusal.
      const bookedTable = !joined && resource_id
        ? assignableTables.find((x) => String(x.id) === String(resource_id))
        : null;
      const bookedAt = bookedTable && !walkInTables.find((x) => x.id === String(resource_id) && x.busy)
        ? bookedWithinSitting(bookedTable, reservations, Date.now(), sittingMinutes(party_size, bookingRules))
        : null;
      const bookedLabel = bookedTable?.label || "";
      // Chosen table just got taken (race, or the picker's 60s view was stale)
      // → honest message, never a silent double-seat.
      // A shop or a workshop hears of places and appointments, not tables
      // and parties.
      let msg;
      if (conflict && joined && (code === "slot_unavailable" || code === "room_full")) {
        msg = apptWords
          ? t("rsvpSeatTablesTakenAppt", "Those spaces are no longer free together — pick another space.")
          : t("rsvpSeatTablesTaken", "Those tables are no longer free together — pick another table.");
      } else if (conflict && code === "slot_unavailable" && bookedAt != null) {
        // Not taken: a booking lands inside their sitting. "Bordet er nu
        // optaget" sent the host round a loop at an empty table (Push 8
        // review).
        const vars = {
          table: bookedLabel,
          time: new Date(bookedAt).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }),
        };
        msg = apptWords
          ? t("rsvpSeatTableBookedSoonAppt", "{table} is booked at {time} and isn't free for the whole visit — pick another space.", vars)
          : t("rsvpSeatTableBookedSoon", "{table} is reserved at {time} and isn't free for the whole sitting — pick another table, or put them on the waitlist.", vars);
      } else if (conflict && code === "slot_unavailable") {
        msg = apptWords
          ? t("rsvpSeatTableTakenAppt", "That space is now taken — pick another free space.")
          : t("rsvpSeatTableTaken", "That table is now taken — pick another free table.");
      } else if (conflict && code === "table_occupied") {
        const occupant = e.response.data.detail.occupant?.table;
        msg = apptWords
          ? t("rsvpTableStillTakenAppt", "{table} is still taken — finish the appointment there first, or pick another space.", {
              table: occupant || t("rsvpTableFallbackAppt", "The space"),
            })
          : t("rsvpTableStillTaken", "{table} is still taken — finish the party there first, or pick another table.", {
              table: occupant || t("rsvpTableFallback", "Table"),
            });
      } else {
        // Words, never the server's code (R10, V10).
        msg = bookFailWords(e, t, apptWords
          ? t("rsvpSeatErrorAppt", "Couldn't check the customer in.")
          : t("rsvpSeatError", "Couldn't seat the guests."), { apptWords });
      }
      // A 409 means the room moved under the stand — another host, another
      // device, or a view up to 60 s old. Read the book again, so the sheet
      // stops offering (and pre-picking) the table just refused and the
      // header counts behind it are the room's. Before the message: the
      // reload clears the page's error line.
      if (conflict) await fetchBook(day);
      say(msg);
      return null;
    } finally {
      setSeating(false);
    }
  };

  // The stand's one-tap drop-in. A size with a seating free for a whole
  // sitting seats them there at once — the smallest table that fits, or the
  // tables the engine pushes together — and says where, with "Skift bord"
  // one tap away. "6+" opens the seat sheet on 6 — the exact size is the
  // host's to say. No table free: the Venteliste form opens with the party
  // size filled in (it needs a phone to text them). Rules not loaded: no
  // claim was made, so no one-tap seat either — the seat sheet opens on the
  // size and the host picks the table.
  const walkInTap = async (opt) => {
    if (seating) return;
    setWalkInDone(null);
    if (opt.freeNow && opt.size < WALK_IN_SIZES[WALK_IN_SIZES.length - 1]) {
      const joined = Array.isArray(opt.tableIds) && opt.tableIds.length > 1;
      const sent = joined ? opt.tableIds : [opt.tableId];
      const row = await seatWalkIn({
        ...(joined ? { resource_ids: opt.tableIds } : { resource_id: opt.tableId }),
        party_size: opt.size,
        guest_name: t("rsvpWalkIn", "Drop-in"),
      });
      if (row) setWalkInDone(seatedReport(row, sent, opt.size));
      return;
    }
    if (opt.freeNow || opt.unknown) {
      setError("");
      setSeatError("");
      setSeatParty(opt.size);
      setSeatTarget(SEAT_WALK_IN_PICK);
      return;
    }
    setWlAddRequest({ party: opt.size, n: Date.now() });
    focusWaitlist();
  };
  // What the stand says after a seat: where the SERVER holds the party — its
  // answer (combined_resource_ids / resource_id) named by the tables' labels,
  // never the tables the stand asked for. `moved` when those differ: a server
  // that ignored the tables it was sent and picked its own — said in amber,
  // naming where the party actually sits, never as a green "seated at".
  const seatedReport = (row, sentIds, size) => ({
    row,
    size,
    label: resolveTableLabel(row, labelById) || "",
    moved: !sameTables(tablesOf(row), sentIds),
    asked: (sentIds || []).map((id) => labelById[String(id)] || "").filter(Boolean).join(" + "),
  });
  // The seat sheet's "Seat now": the same seat. A drop-in seated from the
  // sheet (its table picker — the header's button, "6+", a size tapped before
  // the rules were in) gets the line a one-tap seat gets, named from the
  // server's answer: "6 gæster sat ved Bord 6 + Bord 7" — the joined 6+ seat
  // said nothing at all. A table tapped on the floor stays silent where the
  // party sits as asked; the amber line when it does not.
  const seatFromSheet = async (p) => {
    const fromPicker = seatTarget === SEAT_WALK_IN_PICK;
    const row = await seatWalkIn(p, { inSheet: true });
    if (!row) return;
    const report = seatedReport(row, p.resource_ids || [p.resource_id], p.party_size);
    if (report.moved || fromPicker) setWalkInDone(report);
  };
  // The sheet's "Tilføj til venteliste" when no table is free for the party:
  // the same Venteliste form the drop-in row opens, on that party size.
  const waitlistFromSheet = (party) => {
    setSeatTarget(null);
    setSeatParty(null);
    setSeatError("");
    setWlAddRequest({ party, n: Date.now() });
    focusWaitlist();
  };
  // The "seated at 22" line clears itself — it reports, it does not ask. The
  // amber "seated elsewhere" line stays until the host closes it: the floor
  // is not what the stand said.
  useEffect(() => {
    if (!walkInDone || walkInDone.moved) return undefined;
    const id = setTimeout(() => setWalkInDone(null), 20000);
    return () => clearTimeout(id);
  }, [walkInDone]);

  // The line itself — in the drop-in row, or floating where that row is not
  // on screen. On a phone the sentence takes the whole first line and the
  // buttons go under it: beside them it was cut to "7 gæster sat ved
  // Bord 2…" (144 of 279 px at 360) — the second table, often across the
  // room, never showed. It wraps; it is never cut.
  const walkInDoneLine = (floating) =>
    walkInDone && (
      <div
        className={
          (floating ? "" : "mt-2 pt-2 border-t border-gray-100 dark:border-[rgb(var(--surface-line))] ") +
          "flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm " +
          (walkInDone.moved ? "text-amber-800 dark:text-amber-200" : "text-gray-700 dark:text-gray-200")
        }
        role="status"
        data-walkin-done={walkInDone.moved ? "moved" : "seated"}
      >
        {walkInDone.moved ? (
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden />
        )}
        {/* Named from the server's answer. Where it seated the party
            elsewhere than asked, the line says so — and where. */}
        <span
          data-walkin-done-text=""
          className="min-w-0 flex-1 basis-[calc(100%-1.5rem)] sm:basis-0 break-words leading-snug"
        >
          {apptWords
            ? walkInDone.moved
              ? walkInDone.label
                ? t("rsvpWalkInSeatedElsewhereAppt", "Checked in at {table} — not at {asked}", {
                    table: walkInDone.label,
                    asked: walkInDone.asked || "—",
                  })
                : t("rsvpWalkInSeatedNoTableAppt", "Checked in without a space — not at {asked}", {
                    asked: walkInDone.asked || "—",
                  })
              : walkInDone.size === 1
                ? t("rsvpWalkInSeatedOneAppt", "1 person checked in at {table}", { table: walkInDone.label || "" })
                : t("rsvpWalkInSeatedAppt", "{n} people checked in at {table}", { n: walkInDone.size, table: walkInDone.label || "" })
            : walkInDone.moved
            ? walkInDone.label
              ? t("rsvpWalkInSeatedElsewhere", "Seated at {table} — not at {asked}", {
                  table: walkInDone.label,
                  asked: walkInDone.asked || "—",
                })
              : t("rsvpWalkInSeatedNoTable", "Seated without a table — not at {asked}", {
                  asked: walkInDone.asked || "—",
                })
            : walkInDone.size === 1
              ? t("rsvpWalkInSeatedOne", "1 guest seated at {table}", { table: walkInDone.label || "" })
              : t("rsvpWalkInSeated", "{n} guests seated at {table}", { n: walkInDone.size, table: walkInDone.label || "" })}
        </span>
        <button
          type="button"
          onClick={() => {
            const fresh = reservations.find((x) => String(x.id) === String(walkInDone.row.id));
            openDrawer(fresh || walkInDone.row);
            setWalkInDone(null);
          }}
          className="ml-auto shrink-0 h-9 px-3 rounded-lg text-xs font-semibold border border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
        >
          {apptWords ? t("rsvpWalkInChangeTableAppt", "Change space") : t("rsvpWalkInChangeTable", "Change table")}
        </button>
        <button
          type="button"
          onClick={() => setWalkInDone(null)}
          aria-label={t("close", "Close")}
          className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>
    );

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
            ...(form.guest_notes ? { guest_notes: form.guest_notes } : {}),
            ...(form.allergy_note ? { allergy_note: form.allergy_note } : {}),
            ...(form.allergy_severity ? { allergy_severity: form.allergy_severity } : {}),
            source: "manual",
            status: "confirmed",
            // A venue with no table plan (a shop, a workshop) has nothing to
            // assign: asking the engine for a table only bounced every booking
            // off "room full — book without a table". Saved as it is.
            auto_assign: !form.resource_id && tableFloor,
            ...(allowOverflow ? { allow_overflow: true } : {}),
          };
      const created = await api.post("/reservations/book", payload);
      trackEvent("reservation_created", "reservations");  // product analytics
      // Say what was made — New booking closed in silence (the waitlist's Book
      // said "booket 19.30 · Bord 2"), and booking another day also jumped
      // the book to that date without a word.
      {
        const row = created?.data || {};
        const when = (form.date === serviceDayIso() ? "" : shortDayLabel(form.date, t, lang) + " ") + fmtTime(row.starts_at || `${form.date}T${form.time}:00`);
        const table = resolveTableLabel(row, labelById);
        const name = form.guest_name || t("rsvpGuest", "Guest");
        toast({
          severity: "success",
          message: table
            ? t("rsvpBookedToast", "{name} booked {when} · {table}", { name, when, table })
            : apptWords
              ? t("rsvpBookedToastAppt", "{name} booked {when}", { name, when })
              : t("rsvpBookedToastNoTable", "{name} booked {when} — no table yet", { name, when }),
        });
      }
      // The day rail's per-day counts come from a separate month query.
      window.dispatchEvent(new Event("bonbox-reservations-changed"));
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
        setRoomFull(warningFrom(d, form.time, totalCapacity));
      } else {
        setCreateError(
          bookFailWords(e, t, t("rsvpCreateError", "Couldn't create the booking."), { apptWords }),
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
    setSeatError("");
    setSeatTarget(SEAT_WALK_IN_PICK);
  };

  // Assign / move / clear the booking's table from the detail drawer.
  // PATCH then refetch (no in-place object patching — the memo-on-identity
  // trap) and re-point the drawer at the fresh row so it shows the new table.
  const assignTable = async (r, resourceId, many = null) => {
    const current = r.resource_id ? String(r.resource_id) : null;
    const next = resourceId ? String(resourceId) : null;
    if (!many && current === next) return;
    setAssigning(true);
    setAssignError("");
    try {
      const patchResp = await api.patch(
        `/reservations/reservations/${r.id}/table`,
        many ? { resource_ids: many } : { resource_id: next },
      );
      // Clearing a table releases its hold → the backend surfaces the waiting
      // parties that now fit. Same SHOW-only contract as cancel/no-show: we
      // highlight them, the owner still taps Notify / Book.
      const m = patchResp?.data?.waitlist_matches;
      if (!many && !next) selfFreedRef.current.add(r.id);
      if (Array.isArray(m) && m.length) surfaceMatches(m, day);
      const res = await api.get("/reservations/book", { params: { day } });
      setData(res.data || null);
      // Resync the Venteliste against the just-changed book.
      setBookTick((n) => n + 1);
      const fresh = (res.data?.reservations || []).find((x) => x.id === r.id);
      if (fresh) setSelected(fresh);
      // Pushing tables together changed where the party sits — say it, as
      // every other change on the book does.
      if (many) {
        toast({
          severity: "success",
          message: t("rsvpCombinedDone", "{name} now has {tables}.", {
            name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
            tables: many.map((id) => labelById[String(id)]).filter(Boolean).join(" + "),
          }),
        });
      }
    } catch (e) {
      const d = e?.response?.data?.detail || {};
      if (e?.response?.status === 409 && d.error === "table_occupied") {
        setAssignError(t("rsvpTableStillTaken", "{table} is still taken — finish the party there first, or pick another table.", {
          table: d.occupant?.table || t("rsvpTableFallback", "Table"),
        }));
      } else if (e?.response?.status === 409 && d.error === "slot_unavailable") {
        const label = many
          ? many.map((id) => labelById[String(id)]).filter(Boolean).join(" + ")
          : (next && labelById[next]) || t("rsvpTableFallback", "Table");
        setAssignError(t("rsvpTableTaken", "{label} is taken at that time.", { label }));
      } else {
        setAssignError(bookFailWords(e, t, t("rsvpAssignError", "Couldn't assign the table."), { apptWords }));
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
    setAllergyError("");
    try {
      const resp = await api.patch(
        `/reservations/reservations/${r.id}/allergy-suggestion`,
        { action },
      );
      if (resp?.data) setSelected(resp.data);
      await fetchBook(day);
    } catch (e) {
      // This used to be a bare `catch { await fetchBook(day); }`. On a paired
      // host stand it swallowed a 404 — the route was not wrapped, so the
      // control could never work — and the refetch made the "muligt: gluten —
      // bekræft?" prompt reappear unchanged. The host reads that as "it didn't
      // register, tap again", not as "this is broken", and a guest's allergy
      // silently stays unconfirmed. Say it instead.
      setAllergyError(
        bookFailWords(e, t, t("rsvpAllergyActionError", "Couldn't save that. The allergy is unchanged."), { apptWords }),
      );
      await fetchBook(day);
    } finally {
      setAllergyBusy(false);
    }
  };

  // Edit-booking sheet state (opened from the drawer's Edit row).
  const [editRes, setEditRes] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  // The edit's own honest refusal (six on a two-top, a sitting past closing).
  const [editWarning, setEditWarning] = useState(null);
  const toast = useToast();
  const submitEdit = async (fields, ctx = {}) => {
    if (!editRes) return;
    setEditBusy(true);
    setEditError("");
    setEditWarning(null);
    try {
      const res = await api.patch(`/reservations/reservations/${editRes.id}`, fields);
      haptic.success();
      // More guests than the table seats (or a taken table at the new time):
      // the server moved them to one that fits — say where, or the host
      // walks the party to the old table.
      const mv = res?.data?.moved;
      if (mv && !mv.to) {
        toast({
          severity: "notice",
          message: t("rsvpEditNoTableNow", "{name} is saved without a table — {table} is booked from {time}.", {
            name: guestText(res.data.guest_name) || t("rsvpGuest", "Guest"),
            table: mv.clash_table || mv.from || t("rsvpTableFallback", "Table"),
            time: hm(mv.clash_at || ""),
          }),
        });
      } else if (mv?.to) {
        toast({
          severity: "success",
          message: mv.from
            ? mv.clash_table
              ? t("rsvpEditMovedClash", "{name} moved to {to} — {from} is booked from {time}.", { name: guestText(res.data.guest_name) || t("rsvpGuest", "Guest"), to: mv.to, from: mv.from, time: hm(mv.clash_at) })
              : mv.from_seats
                ? t("rsvpEditMovedSeats", "{name} moved to {to} — {from} seats {seats}.", { name: guestText(res.data.guest_name) || t("rsvpGuest", "Guest"), to: mv.to, from: mv.from, seats: mv.from_seats })
                : t("rsvpEditMovedTable", "{name} moved to {to} — {from} didn't fit.", { name: guestText(res.data.guest_name) || t("rsvpGuest", "Guest"), to: mv.to, from: mv.from })
            : t("rsvpEditMovedTableShort", "{name} is now at {to}.", { name: guestText(res.data.guest_name) || t("rsvpGuest", "Guest"), to: mv.to }),
        });
      }
      // "Gem alligevel" kept the booking as typed although it doesn't fit —
      // say what that means. Nine on a 4-top used to save with the sheet
      // just closing.
      const kept = res?.data?.kept;
      if (!mv && kept) {
        const name = guestText(res.data.guest_name) || t("rsvpGuest", "Guest");
        toast({
          severity: "info",
          message: kept.party > kept.seats && kept.table
            ? t("rsvpEditKeptOverFull", "Saved — {name}: {n} guests at {table} ({seats} seats). Push tables together when they arrive.", {
                name, n: kept.party, table: kept.table, seats: kept.seats,
              })
            : kept.ends
              ? t("rsvpEditKeptPastClose", "Saved — {name} sits until {time}, after closing.", { name, time: hm(kept.ends) })
              : t("rsvpEditKeptSaved", "Saved — {name} is kept as typed.", { name }),
        });
      }
      // Moved, but the venue reached its daily guest-mail ceiling: saved, the
      // guest was not e-mailed — say so, so the owner tells them.
      const gSkip = res?.data?.guest_email_skipped;
      if (gSkip?.code === "guest_email_owner_cap") {
        toast({ severity: "notice", message: t("rsvpGuestMailOwnerCap", { cap: gSkip.cap }) });
      } else if (gSkip?.code === "guest_email_address_cap") {
        // This guest's address was already mailed enough today (per-mailbox bound).
        toast({ severity: "notice", message: t("rsvpGuestMailAddressCap", { cap: gSkip.cap }) });
      }
      setEditRes(null);
      setSelected(null);
      fetchBook(day);
    } catch (e) {
      haptic.error();
      const d = e?.response?.data?.detail || {};
      if (e?.response?.status === 409 && d.error === "room_full") {
        setEditWarning(warningFrom(d, ctx.time || (fields.starts_at || "").slice(11, 16), totalCapacity));
      } else {
        setEditError(
          d.error === "slot_unavailable"
            ? t("rsvpEditSlotTaken", "The table isn't free at that time — pick another time, or move the table first.")
            : d.error === "not_editable"
              ? t("rsvpEditNotEditable", "A seated or finished booking can't change time or party — reopen it first.")
              : t("rsvpEditError", "Couldn't save the changes. Please try again."),
        );
      }
    } finally {
      setEditBusy(false);
    }
  };

  // Open the detail drawer with a clean assign-error slate.
  const openDrawer = (r) => {
    setAssignError("");
    setSelected(r);
  };

  // The strip counts from the rows on screen (the same rule the server
  // uses): the server's own totals arrive with the NEXT fetch, so after an
  // optimistic change — a drop-in removed — the strip showed the old numbers
  // for a second or two.
  const summary = useMemo(() => {
    const rows = Array.isArray(data?.reservations) ? data.reservations : [];
    const by_status = {};
    let covers = 0;
    for (const r of rows) {
      by_status[r.status] = (by_status[r.status] || 0) + 1;
      if (COVER_STATUSES.includes(r.status)) covers += Number(r.party_size) || 0;
    }
    return { total: rows.length, covers, by_status };
  }, [data]);
  // Stable identity so the memos below ([reservations]) only recompute when
  // the data actually changes — not on every render while data is null.
  const reservations = useMemo(
    () => (Array.isArray(data?.reservations) ? data.reservations : []),
    [data],
  );
  // A shop or a workshop checks its customer in; nobody sits (statusLabels).
  const checkedInWords = apptWords && !isProvider;
  const labels = statusLabels(t, checkedInWords);

  const zones = useMemo(
    () => [...new Set(resources.map((r) => r.zone).filter(Boolean))],
    [resources],
  );
  const seatsById = useMemo(
    () => Object.fromEntries(resources.map((x) => [String(x.id), Number(x.capacity_seats) || 0])),
    [resources],
  );
  const zoneById = useMemo(() => zoneTones(resources).byId, [resources]);
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
  // The tables could not be read and none are on screen: UNKNOWN, never
  // "no tables" (fix round 5, gate G). The book says so and keeps working.
  const roomUnknown = resourcesFailed && resources.length === 0;
  // Tables another live booking holds during the open booking's time — the
  // drawer marks them instead of letting a pick bounce off a 409.
  const busyForSelected = useMemo(() => {
    const out = new Set();
    if (!selected?.starts_at) return out;
    const a0 = new Date(selected.starts_at).getTime();
    const a1 = selected.ends_at ? new Date(selected.ends_at).getTime() : a0 + 90 * 60000;
    // This party sits down now (seated, or due within half an hour / late):
    // a table someone is SEATED at is taken until they are finished, however
    // long past their booked end — the drawer offered it as free.
    const sitsNow = selected.status === "seated"
      || (["requested", "confirmed"].includes(selected.status) && a0 - nowTs <= 30 * 60000);
    for (const x of reservations) {
      if (x.id === selected.id || !["requested", "confirmed", "seated"].includes(x.status) || !x.starts_at) continue;
      const b0 = new Date(x.starts_at).getTime();
      const booked1 = x.ends_at ? new Date(x.ends_at).getTime() : b0 + 90 * 60000;
      const b1 = x.status === "seated" && sitsNow ? Math.max(booked1, nowTs + 60000) : booked1;
      if (b0 < a1 && a0 < b1) {
        const ids = Array.isArray(x.combined_resource_ids) && x.combined_resource_ids.length
          ? x.combined_resource_ids : x.resource_id ? [x.resource_id] : [];
        ids.forEach((id) => out.add(String(id)));
      }
    }
    return out;
  }, [selected, reservations, nowTs]);
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
        // A booking that starts within the next two hours: seating a walk-in
        // there collides with it. The picker chose such tables silently.
        reservedAt: (() => {
          const tid = String(c.res.id);
          const soon = (reservations || [])
            .filter((r) => ["confirmed", "requested"].includes(r.status)
              && (String(r.resource_id) === tid || (r.combined_resource_ids || []).map(String).includes(tid)))
            .map((r) => new Date(r.starts_at).getTime())
            .filter((ms) => ms > nowTs && ms - nowTs < 120 * 60000)
            .sort((a, b) => a - b)[0];
          return soon ? new Date(soon).toISOString() : null;
        })(),
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
  // A provider (salon) venue with no bookable station yet: nobody can book it
  // online. `resourcesLoaded` guards the flash before resources land (an
  // established salon never sees a card blink in); !resourcesFailed: a
  // dropped connection used to read as "no stations yet" and offer to set up
  // a salon that has been running for a year.
  const salonNeedsSetup =
    isProvider && resourcesLoaded && !resourcesFailed && providerStations.length === 0;
  // Salon first-run: the calm "confirm hours → open for booking" card IN
  // PLACE OF the book — so only when there is genuinely nothing in it: no
  // booking on any day, nobody waiting (the server says so; unknown = no
  // card), and nothing on the day on screen. A café that became a salon has
  // no behandler yet but does have bookings and a waitlist; the card used to
  // hide every one of them (vertical-fit review, Oct 2026). They get the book
  // and a short note pointing at Behandlere instead (salon-setup-nudge).
  const salonFirstRun =
    isProvider && resourcesLoaded && !resourcesFailed && providerStations.length === 0 &&
    bookHasEntries === false &&
    !(data?.reservations?.length > 0) &&
    waitlistCount === 0;
  // A live booking page that offers NO time in the next 14 days. For a salon
  // that is the usual dead end: a behandler whose shifts are not published,
  // or no behandler the engine can book (vertical-fit audit, Oct 2026). Asks
  // the SAME summary the customer's page reads (party 1 — one chair), so the
  // banner and the page cannot disagree. A failed read says nothing.
  const [noBookableTimes, setNoBookableTimes] = useState(false);
  // …because the salon offers no service a customer can pick (R1 A4).
  const [noServiceOnline, setNoServiceOnline] = useState(false);
  useEffect(() => {
    // A salon that still needs a behandler gets the first-run card or the
    // setup note — never this banner on top of them.
    if (!isProvider || standalone || salonNeedsSetup || !publicPage?.enabled || !publicPage?.slug) {
      setNoBookableTimes(false);
      return undefined;
    }
    let alive = true;
    api.get(`/public/reservations/${publicPage.slug}/availability-summary`, {
      params: { from: serviceDayIso(), days: 14, party: 1 },
    })
      // Not at the monthly cap: "no bookable time" would be false there — the
      // shifts are fine, online booking is paused (its own monitor code).
      .then((r) => {
        if (!alive) return;
        setNoBookableTimes(Array.isArray(r.data?.days) && !r.data?.next_open_day && r.data?.closed_reason !== "not_accepting");
        setNoServiceOnline(r.data?.closed_reason === "no_service");
      })
      .catch(() => { if (alive) { setNoBookableTimes(false); setNoServiceOnline(false); } });
    return () => { alive = false; };
  }, [isProvider, standalone, salonNeedsSetup, publicPage, providerStations.length]);
  const behandlerByResourceId = useMemo(() => {
    const m = {};
    resources.forEach((r) => {
      if (r.kind === "provider") {
        m[String(r.id)] = r.staff_name || r.label || "";
      }
    });
    return m;
  }, [resources]);
  // Does this booking hold a TABLE rather than a behandler's chair? A café
  // that became a salon keeps its bookings, and they render as the table
  // bookings they are (vertical-fit review, Oct 2026). A salon appointment
  // carries its behandling (service_name); a resource that is not one of the
  // venue's providers is a table. Before the resources land: no.
  const holdsTable = useCallback((r) => {
    if (!r || r.service_name || !resourcesLoaded) return false;
    if (Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length) return true;
    return !!r.resource_id && !(String(r.resource_id) in behandlerByResourceId);
  }, [resourcesLoaded, behandlerByResourceId]);

  const seatedCount = summary.by_status?.seated || 0;
  // "ved N borde" counted parties: 16 guests "at 2 tables" with one table in
  // use and one party seated with none. Count the tables, and say who has none.
  const seatedTables = useMemo(() => {
    const ids = new Set();
    let none = 0;
    for (const r of reservations) {
      if (r.status !== "seated") continue;
      const held = Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
        ? r.combined_resource_ids : r.resource_id ? [r.resource_id] : [];
      if (!held.length) none += 1;
      held.forEach((id) => ids.add(String(id)));
    }
    return { tables: ids.size, none };
  }, [reservations]);
  // Guests at the tables right now — what "Sidder nu" means to a host. The
  // strip used to show the number of seated PARTIES, which reads as people:
  // "Sidder nu 4 · i lokalet" for 16 guests at 4 tables.
  const seatedGuests = useMemo(
    () => reservations.reduce((s, r) => s + (r.status === "seated" ? Number(r.party_size) || 0 : 0), 0),
    [reservations],
  );
  const requestedCount = summary.by_status?.requested || 0;
  // The bookings those covers come from. `summary.total` counts every row of
  // the day, cancelled and no-show included, so a day of five cancellations
  // read "Gæster 0 · 5 reservationer". Same statuses as the server's covers
  // (BOOKED_COVER_STATUSES in reservation_insights_service.py).
  const coverBookings = COVER_STATUSES.reduce((n, s) => n + (summary.by_status?.[s] || 0), 0);

  // ── Cockpit metrics — the day's vitals, host-stand style ───────────────
  // "Next arrival" is the earliest still-live booking yet to come (relative
  // to now when viewing today; the day's earliest otherwise) — the single
  // most host-relevant read. Belægning/utilization = covers booked against
  // total seat capacity: a calm fill gauge, honest about turns (a multi-turn
  // service can read >100%, which is simply the truth, not an error).
  const isViewingToday = day === serviceDayIso();
  // ── Host stand: covers in the header + drop-in by party size ──────────
  // Both read today's book only: "seated now" and "free now" mean nothing on
  // another day. Recomputed on the 60s tick, like the floor.
  const standCovers = useMemo(() => coverCounts(reservations), [reservations]);
  const showStandNow = standalone && isViewingToday && !isProvider;
  // The venue's own table-joining rule (on unless switched off, at most 3) —
  // in force only on a server that holds exactly the tables it is sent
  // (joinCapable). Before that, single tables only.
  const combine = useMemo(() => comboRules(bookingRules), [bookingRules]);
  const joinNow = joinCapable ? combine : null;
  const walkIns = useMemo(() => {
    if (!showStandNow || !tableFloor) return null;
    // R11 (B11): until the tables are known the row is drawn already — the
    // same six sizes saying "—", not yet tappable — so its arrival never
    // pushes the night down (102 px, CLS 0.456 on the door iPad, 20 Oct).
    // A failed read leaves them tappable (the seat sheet still works).
    // (A failed read used to set resourcesLoaded and drop to "no tables":
    // the strip vanished — fix round 5. It stays, "—", still tappable.)
    if (!resourcesLoaded || resourcesFailed) {
      return WALK_IN_SIZES.map((size) => ({ size, unknown: true, pending: !resourcesFailed, freeNow: false, at: null }));
    }
    if (assignableTables.length === 0) return null;
    // Without the venue's turn times and closing time there is no "free now"
    // and no "approx." — a 90-minute guess in a room that never closes told
    // the door "free now" where the owner's stand said "approx. 20.30". The
    // buttons still work: each opens the seat sheet on its size.
    if (!rulesLoaded) return WALK_IN_SIZES.map((size) => ({ size, unknown: true, freeNow: false, at: null }));
    return walkInOptions({
      reservations,
      resources: assignableTables,
      nowMs: nowTs,
      sittingFor: (n) => sittingMinutes(n, bookingRules),
      closeMs: closeMsFor(day, openHours),
      combine: joinNow,
    });
  }, [showStandNow, tableFloor, assignableTables, reservations, nowTs, bookingRules, day, openHours, rulesLoaded, joinNow, resourcesLoaded, resourcesFailed]);
  // What the seat sheet pre-picks for n guests: the seating the drop-in row
  // counts for them, by the same rule (seatingNow) — a single table, or the
  // joined set. Only once the rules are in; until then the sheet guesses.
  const seatingFor = useMemo(() => {
    if (!rulesLoaded || !tableFloor) return null;
    return (n) =>
      seatingNow({
        reservations,
        resources: assignableTables,
        nowMs: nowTs,
        size: n,
        sittingMin: sittingMinutes(n, bookingRules),
        combine: joinNow,
      });
  }, [rulesLoaded, tableFloor, joinNow, reservations, assignableTables, nowTs, bookingRules]);
  // …and which table a booking claims inside n guests' sitting (its start,
  // ms): the sheet does not offer it, as the server would refuse the seat.
  const bookedWithinFor = useMemo(() => {
    if (!rulesLoaded || !tableFloor) return null;
    return (tableId, n) => {
      const tb = assignableTables.find((x) => String(x.id) === String(tableId));
      return tb ? bookedWithinSitting(tb, reservations, nowTs, sittingMinutes(n, bookingRules)) : null;
    };
  }, [rulesLoaded, tableFloor, reservations, assignableTables, nowTs, bookingRules]);
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
      // A held online booking (R1) holds nothing until confirmed: a flood of
      // them is not a full room.
      if (isHeldForCheck(r, publicPage?.groupThreshold)) return;
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
      peakTime: at == null ? null : `${pad(Math.floor((at % 1440) / 60))}.${pad(at % 60)}`,
    };
  }, [reservations, totalCapacity, publicPage?.groupThreshold]);
  const nextArrival = useMemo(() => {
    // A day that is over has no next arrival — it named a party from
    // yesterday that nobody marked.
    if (day < serviceDayIso()) return null;
    const live = reservations.filter(
      (r) => !["completed", "cancelled", "no_show", "seated"].includes(r.status),
    );
    if (live.length === 0) return null;
    let pool = live;
    if (isViewingToday) {
      // A party up to an hour late is still the one the host is waiting for —
      // it fell off "Næste ankomst" at 5 minutes, while the list showed it
      // orange. Later than that, the list and the no-show button take over.
      const cutoff = new Date().getTime() - 60 * 60 * 1000;
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
  }, [reservations, isViewingToday, day]);
  // Host-stand read: WHO is next, HOW MANY, and WHERE they sit. The table was
  // the one missing piece — a host reading this tile still had to open the
  // drawer or scan the list to find out where to walk them. Everything here is
  // already on the booking, so it costs nothing to say it.
  const nextArrivalHelper = useMemo(() => {
    if (!nextArrival) return t("rsvpNothingUpcoming", "Nothing upcoming");
    const name = (guestText(nextArrival.guest_name) || "").trim();
    const who = name
      ? `${name} · ${nextArrival.party_size}`
      : t("rsvpPartyOf", "Party of {n}", { n: nextArrival.party_size });
    const table = resolveTableLabel(nextArrival, labelById);
    const lateBy = lateMinutes(nextArrival, nowTs, isViewingToday);
    if (lateBy) {
      return t("rsvpNextLateText", "Late {txt} · {who}", { txt: overByText(t, lateBy), who: table ? `${table} · ${who}` : who });
    }
    // Table FIRST: the cockpit strip truncates the end of this line in a slim
    // cell, and where the party sits matters more to a host than the name.
    if (!table) return who;
    return name
      ? `${table} · ${nextArrival.party_size} · ${name}`
      : `${table} · ${who}`;
  }, [nextArrival, labelById, t, isViewingToday, nowTs]);
  // "Kommende" (desktop side column): the day's bookings nobody has seated yet.
  const todayIso = serviceDayIso();
  const upcomingRows = useMemo(
    () => selectUpcoming(reservations, { day, today: todayIso }),
    [reservations, day, todayIso],
  );
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

  // Cancelled bookings fold away under "Vis N aflyste": with seven rows
  // cancelled, the book was seven rows of nothing to act on.
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelledCount = useMemo(
    () => reservations.filter((r) => r.status === "cancelled" && r.cancel_reason !== "walk_in_removed").length,
    [reservations],
  );
  // The day's live bookings — what "N bookings on this day" may count. It
  // counted cancelled rows and removed drop-ins too (14 beside a strip
  // saying 2).
  const liveCount = useMemo(
    () => reservations.filter((r) => r.status !== "cancelled" && r.cancel_reason !== "walk_in_removed").length,
    [reservations],
  );
  const filtered = useMemo(() => {
    // A removed drop-in never was a booking.
    let out = reservations.filter((r) => r.cancel_reason !== "walk_in_removed");
    if (statusFilter !== "all") out = out.filter((r) => r.status === statusFilter);
    else if (!showCancelled && !q.trim()) out = out.filter((r) => r.status !== "cancelled");
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
    // Phone numbers compare digits only: "5678" found nothing for
    // "+45 12 34 56 78" — only "56 78", spaced exactly as stored, matched.
    const digits = needle.replace(/\D/g, "");
    if (needle) {
      out = out.filter(
        (r) =>
          (r.guest_name || "").toLowerCase().includes(needle) ||
          (digits.length >= 3 && String(r.guest_phone || "").replace(/\D/g, "").includes(digits)),
      );
      // A search shows cancelled rows too — after the live ones, each group
      // in time order. Three live bookings sat buried among forty "Aflyst".
      const dead = (r) => (r.status === "cancelled" || r.status === "no_show" ? 1 : 0);
      out = [...out].sort((a, b) => dead(a) - dead(b));
    }
    // The finished list is the evening's history: in the order the parties
    // sat down (each row says seated → left and how long), not booked time.
    if (statusFilter === "completed") out = [...out].sort(bySeatedTime);
    return out;
  }, [reservations, statusFilter, zoneFilter, noteTypeFilter, q, resources, showCancelled]);

  const filtersOn =
    q.trim() !== "" || statusFilter !== "all" || zoneFilter !== "all" || noteTypeFilter !== "all";
  // The dropdowns alone — what the phone's Filter chip opens.
  const selectsOn = statusFilter !== "all" || zoneFilter !== "all" || noteTypeFilter !== "all";
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

  // Party + Table — a table venue's two columns. A provider venue shows them
  // only while a row on the day holds a table (a café that became a salon);
  // a venue with no table plan shows Party alone.
  const tableColumns = [
    {
      id: "party",
      label: apptWords ? t("rsvpColPartyAppt", "People") : t("rsvpColParty", "Party"),
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
      label: apptWords ? t("rsvpColTableAppt", "Space") : t("rsvpColTable", "Table"),
      width: "w-36",
      render: (r) => <TablesCell r={r} labelById={labelById} seatsById={seatsById} zoneById={zoneById} t={t} apptWords={apptWords} />,
    },
  ];
  const dayHasTableRows = isProvider && reservations.some(holdsTable);

  const columns = [
    {
      id: "time",
      label: t("rsvpColTime", "Time"),
      width: "w-24",
      render: (r) => {
        // "Late" = a confirmed guest whose start time has passed and who
        // hasn't been seated/no-showed. 5-min grace, today only (a past day
        // is history; a future day is never late). Orange = needs a decision:
        // hold the table, call them, or give it away.
        const lateMin = lateMinutes(r, nowTs, isViewingToday);
        const overMin = overdueMinutes(r, nowTs, isViewingToday);
        const clock = overMin || lateMin;
        return (
          <div className="flex items-stretch gap-2.5">
          {/* The row's status as a bar, as on the phone list. */}
          <span
            className={"w-[3px] rounded-full shrink-0 " + (STATUS_BAR[overMin ? "overdue" : lateMin ? "late" : r.status] || STATUS_BAR.completed)}
            aria-hidden="true"
          />
          <div className="leading-tight">
            <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {fmtTime(r.starts_at)}
            </div>
            {clock ? (
              // One way to say it, as on the pill: "+49 min", "+2 t 05".
              <div className={"inline-flex items-center gap-1 text-[11px] font-medium tabular-nums whitespace-nowrap " +
                (overMin ? "text-red-700 dark:text-red-400" : "text-orange-700 dark:text-orange-400")}>
                <Clock className="w-3 h-3 shrink-0" aria-hidden />
                {overByText(t, clock)}
              </div>
            ) : (
              <div className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                {fmtTime(r.ends_at)}
              </div>
            )}
          </div>
          </div>
        );
      },
    },
    {
      id: "guest",
      // A salon, a shop, a workshop: its column is the customer.
      label: apptWords ? t("rsvpColGuestAppt", "Customer") : t("rsvpColGuest", "Guest"),
      render: (r) => (
        <div className="min-w-0 max-w-[16rem]">
          <div
            className={"text-sm font-medium text-gray-900 dark:text-gray-100 truncate " + (r.status === "cancelled" ? "line-through decoration-gray-400" : "")}
            title={guestText(r.guest_name) || undefined}
          >
            {guestText(r.guest_name) || "—"}
          </div>
          {isHeldForCheck(r, publicPage?.groupThreshold) && (
            <div data-testid="rsvp-held-label" className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3 h-3" aria-hidden />
              {t("rsvpHeldLabel", "Check before you confirm")}
            </div>
          )}
          {r.provider_absent && r.status !== "cancelled" && (
            <div data-testid="rsvp-provider-absent" className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3 h-3" aria-hidden />
              {t("rsvpProviderAbsent", "The stylist is away this day — move it or call the customer")}
            </div>
          )}
          {r.guest_phone && (
            <div className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
              {r.guest_phone}
            </div>
          )}
          {/* ANY allergy reads here, beside the name — not only a severe one —
              and in WORDS (R11, rubric B8): the level ("Alvorlig",
              "Intolerans", "Allergi"; "Mulig allergi" for the AI's
              unconfirmed reading), the allergens, then the guest's note. It
              used to be the detail in red or amber alone, so "severe" existed
              only as a colour. The flag icon stays where it is — this adds a
              second place to notice, it does not move the first. */}
          <AllergyLine r={r} t={t} cancelled={r.status === "cancelled"} />
          {/* The guest's note, on the row — it was only in the drawer, so a
              birthday cake or a high chair meant opening every booking. */}
          {(r.occasion || r.guest_notes) && (
            <div className="text-[12px] text-gray-500 dark:text-gray-400 truncate" title={[r.occasion, r.guest_notes].filter(Boolean).map(guestText).join(" · ")}>
              {[r.occasion, r.guest_notes].filter(Boolean).map(guestText).join(" · ")}
            </div>
          )}
        </div>
      ),
    },
    // Provider (salon) venues replace Party + Table with Behandling +
    // Behandler; table venues keep the original two columns byte-identical.
    // A salon that was a café keeps its table bookings readable: Party and
    // Table come back while any row on the day holds a table. A shop or a
    // workshop with no tables has party only — no "Bord" column.
    ...(isProvider
      ? [
          {
            id: "behandling",
            label: t("rsvpColBehandling", "Service"),
            width: "w-40",
            render: (r) => (
              <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                {r.service_name || "—"}
              </span>
            ),
          },
          {
            id: "behandler",
            label: t("rsvpColBehandler", "Stylist"),
            width: "w-36",
            render: (r) => {
              // A table booking has no behandler — not "Valgfri behandler".
              if (holdsTable(r)) return <span className="text-sm text-gray-400">—</span>;
              // A held booking waits on no chair; it was booked for one.
              const who = r.resource_id ? behandlerByResourceId[String(r.resource_id)] : heldWanted(r);
              return (
                <span className="inline-flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300 truncate">
                  <Scissors className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
                  {who || t("rsvpBookValgfriOwner", "Any stylist")}
                </span>
              );
            },
          },
          ...(dayHasTableRows ? tableColumns : []),
        ]
      : tableFloor ? tableColumns : tableColumns.slice(0, 1)),
    {
      id: "status",
      label: t("rsvpColStatus", "Status"),
      width: "w-32",
      // A late party is "Forsinket · +29 min" here too — the column said
      // "Bekræftet" while the drawer and the floor said late.
      render: (r) => {
        const over = overdueMinutes(r, nowTs, isViewingToday);
        const late = lateMinutes(r, nowTs, isViewingToday);
        return over
          ? <StatusPill status="overdue" label={t("rsvpOverduePill", "Over time · {txt}", { txt: overByText(t, over) })} />
          : late
          ? <StatusPill status="late" label={t("rsvpLatePillText", "Late · {txt}", { txt: overByText(t, late) })} />
          : r.status === "completed" && stayMinutes(r) != null
          ? (
            // Finished: seated → left and the time at the table, under the
            // pill — the same line the compact row carries.
            <div className="leading-tight">
              <StatusPill status={r.status} label={labels[r.status] || r.status} />
              <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap" data-stay>
                {fmtTime(stampIso(r.seated_at))} → {fmtTime(stampIso(r.completed_at))} · {stayText(stayMinutes(r), t)}
              </div>
            </div>
          )
          : <StatusPill status={r.status} label={labels[r.status] || r.status} />;
      },
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
    const who = guestText(r.guest_name) || t("rsvpGuest", "Guest");
    // setStatus already owns the single "cancelled" confirm — and now picks
    // DECLINE vs CANCEL copy from r.status (a `requested` booking is declined,
    // a confirmed one is cancelled). So hand "cancelled" straight through (no
    // opts needed — they'd be dead) and never double-prompt. Other destructive
    // flips (no-show) still confirm here with their own copy.
    const guardedSet = (opts, status) => async () => {
      // setStatus owns the cancel and no-show confirms (drawer + row alike).
      if (status === "cancelled" || status === "no_show") {
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
      if (isViewingToday) out.push({ id: "seated", label: apptWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatAction", "Seat"), text: true, icon: <Armchair className="w-4 h-4" />, onClick: () => setStatus(r, "seated"), disabled: busy });
      // The table only renders from lg up (tablet and phone use the compact
      // row), i.e. with a mouse and hover tooltips: the two destructive
      // flips go icon-only so "Sæt til bords" stays whole — at 1280 the three
      // worded pills pushed the actions off-screen.
      // Only once they were due — see ReservationDrawer.
      if (!r.starts_at || new Date(r.starts_at).getTime() <= nowTs) out.push({
        id: "no_show", label: t("rsvpNoShowAction", "No-show"), text: false, icon: <Ban className="w-4 h-4" />, variant: "danger", disabled: busy,
        onClick: guardedSet({
          title: t("rsvpNoShowConfirmTitle", "Mark as no-show?"),
          message: t("rsvpNoShowConfirmBody", "Records that {name} didn't arrive.", { name: who }),
          confirmLabel: t("rsvpNoShowAction", "No-show"),
        }, "no_show"),
      });
      out.push({
        id: "cancel", label: t("rsvpCancelAction", "Cancel"), text: false, icon: <X className="w-4 h-4" />, variant: "danger", disabled: busy,
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
    const lateMin = lateMinutes(r, nowTs, isViewingToday);
    const overMin = overdueMinutes(r, nowTs, isViewingToday);
    const hasAllergy =
      (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
      r.allergy_note ||
      r.allergy_severity;
    // A party at tables pushed together: its table names wrap on the row.
    const joinedRow = Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length > 1;
    let primary = null;
    if (r.status === "requested")
      primary = { label: t("rsvpConfirmAction", "Confirm"), to: "confirmed" };
    else if (r.status === "confirmed" && isViewingToday)
      primary = { label: apptWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatAction", "Seat"), to: "seated" };
    else if (r.status === "seated")
      primary = { label: t("rsvpCompleteAction", "Complete"), to: "completed" };
    const busy = actioningId === r.id;
    return (
      <div
        // Unfolded cancelled rows read as history, not as live bookings.
        className={"flex items-center gap-3 cursor-pointer" + (r.status === "cancelled" ? " opacity-60" : "")}
        onClick={() => openDrawer(r)}
        data-status={overMin ? "overdue" : lateMin ? "late" : r.status}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDrawer(r);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span
          className={"w-[3px] self-stretch rounded-full shrink-0 -ml-1 " + (STATUS_BAR[overMin ? "overdue" : lateMin ? "late" : r.status] || STATUS_BAR.completed)}
          aria-hidden="true"
        />
        <div className="min-w-14 shrink-0 leading-tight">
          <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {fmtTime(r.starts_at)}
          </div>
          {(overMin || lateMin) ? (
            <div className={"inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums whitespace-nowrap " +
              (overMin ? "text-red-700 dark:text-red-400" : "text-orange-700 dark:text-orange-400")}>
              <Clock className="w-3 h-3 shrink-0" aria-hidden />
              {overByText(t, overMin || lateMin)}
            </div>
          ) : null}
        </div>
        {/* The status rides the second line as a coloured dot and a word. As
            a pill beside the action button it left the NAME ~30px — "G…",
            "Fø…" — on the one line a host reads to find the guest. */}
        <div className="min-w-0 flex-1 leading-tight">
          <div className={"text-sm font-medium text-gray-900 dark:text-gray-100 truncate" + (r.status === "cancelled" ? " line-through" : "")}>
            {guestText(r.guest_name) || "—"}
            {/* The mark beside the name: an octagon for severe, a triangle
                otherwise — never colour alone (R11, B8); the words are on the
                allergy line under the table and status. */}
            {hasAllergy && r.status !== "cancelled" && (
              <AllergyIcon
                level={allergyFacts(r).level}
                className={
                  "inline w-3.5 h-3.5 ml-1 -mt-0.5 " +
                  (r.allergy_severity === "severe" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")
                }
                role="img"
                aria-label={allergySentence(r, t)}
              />
            )}
          </div>
          {isHeldForCheck(r, publicPage?.groupThreshold) && (
            <div data-testid="rsvp-held-label" className="mt-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300 truncate">
              {t("rsvpHeldLabel", "Check before you confirm")}
            </div>
          )}
          {r.provider_absent && r.status !== "cancelled" && (
            <div data-testid="rsvp-provider-absent" className="mt-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              {t("rsvpProviderAbsent", "The stylist is away this day — move it or call the customer")}
            </div>
          )}
          {/* A finished row WRAPS instead: its seated → left line ("10.20 →
              11.45 · 1 t 25 min") goes under the table and status when the
              phone cannot hold all four — it was shrink-0 on one line, so at
              360–390 px the table name went to nothing ("2 E ● Afsluttet")
              and the times ran off the card. */}
          {/* A party at tables pushed together wraps too: on one line its
              tables were cut ("Bord 8 + Bo…"), and the host had to open the
              booking to see where the party went. */}
          <div
            className={
              "mt-1 flex items-center text-[12px] text-gray-500 dark:text-gray-400 tabular-nums min-w-0 " +
              (r.status === "completed" ||
              (["confirmed", "seated"].includes(r.status) && Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length > 1) ||
              // A shop's checked-in customer: "Tjekket ind" is longer than
              // "Sidder", and at 360–375 px it left the place "Pl…" — the
              // status goes under the place instead (Push 8 review).
              (checkedInWords && r.status === "seated")
                ? "flex-wrap gap-x-2.5 gap-y-0.5"
                : "gap-2.5")
            }
            data-row-meta=""
          >
            <span className="inline-flex items-center gap-1 shrink-0">
              <Users className="w-3 h-3 shrink-0" aria-hidden />
              {r.party_size}
            </span>
            {isProvider && r.service_name && (
              <span className="truncate min-w-0">{r.service_name}</span>
            )}
            {/* Where the party sits, on the row itself — a host had to open
                every booking to find its table. No table = say so — but only
                at a table venue: a salon, a shop or a workshop has no tables
                to miss, and a salon's leftover table booking shows its table. */}
                        {/* A finished party keeps its table on the row (the history reads
                which table) — but no "No table" alarm: there is nothing to fix. */}
            {((!isProvider && tableFloor) || holdsTable(r)) && r.status === "completed" && resolveTableLabel(r, labelById) && (
              <span className={"min-w-0 " + (joinedRow ? "max-w-full whitespace-normal break-words" : "truncate")} data-row-tables="">
                {resolveTableLabel(r, labelById)}
              </span>
            )}
            {((!isProvider && tableFloor) || holdsTable(r)) && ["confirmed", "seated"].includes(r.status) && (() => {
              const tl = resolveTableLabel(r, labelById);
              const held = Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
                ? r.combined_resource_ids : r.resource_id ? [r.resource_id] : [];
              const seats = held.reduce((sum, id) => sum + (seatsById[String(id)] || 0), 0);
              // The desktop cell's "10/4", on the phone too.
              const over = seats > 0 && Number(r.party_size) > seats;
              // The booking holds a table, but the tables could not be read:
              // its name is unknown — never "Intet bord" (fix round 5; the
              // book's line says the tables are being asked for again).
              if (!tl && held.length && roomUnknown) return null;
              return tl
                ? (
                  // Tables pushed together wrap inside the row, which wraps
                  // too: "Vinduesbord 11 + Vind…" hid the third table, and its
                  // title tooltip does not open on a touch screen (review).
                  <span className={"min-w-0 max-w-full " + (joinedRow ? "whitespace-normal break-words" : "truncate")} title={tl} data-row-tables="">
                    {tl}
                    {over && <span className="ml-1 font-medium text-gray-800 dark:text-gray-100">⚠ {r.party_size}/{seats}</span>}
                  </span>
                )
                : (
                  // Amber: a live booking with no table needs the host (R11).
                  <span className="shrink-0 inline-flex items-center gap-0.5 whitespace-nowrap font-medium text-amber-700 dark:text-amber-300" data-no-table="">
                    <AlertTriangle className="w-3 h-3 text-amber-600 dark:text-amber-400" aria-hidden />
                    {apptWords ? t("rsvpNoTableShortAppt", "No space") : t("rsvpNoTableShort", "No table")}
                  </span>
                );
            })()}
            {/* "Bekræftet" is the normal state — a dot says it, and the
                table keeps its name ("B…", "M." before). Every other status
                keeps its word. */}
            {overMin
              ? <span className="shrink-0"><StatusInline status="overdue" label={t("rsvpPlanOverdue", "Over time")} /></span>
              : lateMin
              ? <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-orange-500 dark:bg-orange-400" role="img" aria-label={t("rsvpLegLate", "Late")} />
              : r.status === "confirmed"
              ? <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-sky-500 dark:bg-sky-400" role="img" aria-label={labels.confirmed || "confirmed"} />
              : <span className="shrink-0"><StatusInline status={r.status} label={labels[r.status] || r.status} /></span>}
            {/* A finished party: seated → left with the time at the table.
                Only from the two recorded stamps — a row finished before they
                were kept shows no time, not a guess. */}
            {!isProvider && r.status === "completed" && (() => {
              const stay = stayMinutes(r);
              return (
                <>
                  {stay != null && (
                    <span
                      className="min-w-0 max-w-full truncate"
                      data-stay
                      aria-label={t("rsvpStayAria", "Sat {from} to {to}, {dur}", {
                        from: fmtTime(stampIso(r.seated_at)),
                        to: fmtTime(stampIso(r.completed_at)),
                        dur: stayText(stay, t),
                      })}
                    >
                      {fmtTime(stampIso(r.seated_at))} → {fmtTime(stampIso(r.completed_at))} · {stayText(stay, t)}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
          {/* What the host must know before the party arrives: the allergy in
              words and the note — on the row, not behind a tap. */}
          {/* The allergy in its colour, the note in grey: one red line made
              "barnestol" read like an allergy. */}
          {/* R11 (B8): the allergy in WORDS on its own line — the level
              ("Alvorlig", "Intolerans", "Allergi", "Mulig allergi"), the
              allergens (ticked ones were not on this row at all) and the
              guest's note. The other notes follow in grey, never in the
              allergy's colour. */}
          {r.status !== "cancelled" && <AllergyLine r={r} t={t} className="mt-0.5" />}
          {r.status !== "cancelled" && (r.guest_notes || r.occasion) && (
            <div className="mt-0.5 text-[12px] truncate text-gray-500 dark:text-gray-400">
              {[r.occasion, r.guest_notes].filter(Boolean).map(guestText).join(" · ")}
            </div>
          )}
        </div>
        {primary && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setStatus(r, primary.to);
            }}
            // 36px in a ~60px list row. In dark a raised grey, not the white
            // primary slab: repeated down a list of bookings, white blocks were
            // the loudest thing on the screen.
            // Filled only when it is the next thing to do (due within 30 min,
            // late, seated, or a request): six identical black "Sæt til bords"
            // down a phone list said nothing about which one comes first.
            className={
              "h-9 min-h-0! px-3 shrink-0 rounded-lg text-xs font-semibold disabled:opacity-50 active:scale-95 transition " +
              (primary.to !== "seated" || (r.starts_at && new Date(r.starts_at).getTime() - nowTs <= 30 * 60000)
                ? "bg-gray-900 text-white dark:bg-gray-600 dark:text-white dark:hover:bg-gray-500"
                : "border border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800")
            }
          >
            {primary.label}
          </button>
        )}
      </div>
    );
  };

  /* Is the screen still telling the truth? (R10, rubric B5.) The book on
     screen is never taken away because a refresh failed — it stays, and this
     says how old it is: "Offline · viser bogen fra 19.42". Claimed only when
     it is true, so the line never cries wolf:
       • a reload of THIS day's book failed (after the client's own retries,
         about half a minute), or
       • two polls in a row could not reach BonBox (~35 s), or
       • the browser itself reports no network;
     and only over a book that is actually on screen. A poll that answers —
     or a matching revision — clears it. (Before R10: a 3-minute wait, and a
     failed reload blanked the night instead.) */
  const bookOffline =
    !!data && !standGone && (liveFailed || pollFailures >= 2 || browserOffline);
  // Kept for readers of the old name: the same signal.
  const bookStale = bookOffline;
  /* No book for this day could be read (a restart while the wifi was down).
     The list, the floor and the timeline would each say "nothing booked" —
     the lie R10 removes — so a calm card stands in their place instead. */
  const bookUnavailable = !data && !loading && !!loadError && !standGone;

  // The freed-table nudge floats over the night — until the Venteliste it
  // points to is on screen: then it docks there (it hides, and the
  // Venteliste's own line says it above its rows, never over them). While it
  // floats, the Venteliste's line keeps quiet: one says it, never both at
  // once (judge, frame 14 — fix round 5).
  const nudgeUp = !!(freedNudge && freedNudge.day === day && waitlistCount !== 0 && !bookUnavailable);
  const [waitlistInView, setWaitlistInView] = useState(false);
  useEffect(() => {
    if (!nudgeUp || typeof IntersectionObserver !== "function") return undefined;
    const el = document.getElementById("rsvp-venteliste");
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      setWaitlistInView(!!(e && e.isIntersecting));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [nudgeUp]);
  const nudgeFloats = nudgeUp && !waitlistInView;

  /* A TABLE venue that has not set up a single table. The empty book used to
     promise "Bookings will appear here as they come in" — they cannot: with
     no bookable table the availability engine has nothing to offer, so the
     public page returns no slot a guest could pick. The salon path has had an
     honest first run since day one; the table venue — the ICP — had none.
     Deliberately NOT gated on reservations_enabled: BookSection never fetches
     /reservations/settings, and a claim about a field we did not load is a
     guess. `resourcesLoaded` stops it flashing at an established venue, and
     the host stand is excluded — it has no tabs to send a host to. */
  const noTablesYet =
    !standalone &&
    !isProvider &&
    tableFloor &&
    resourcesLoaded &&
    // This card makes a specific, actionable claim about the owner's own
    // setup — "you have no tables, here is where to add them". A failed fetch
    // knows nothing: without this guard a restaurant with twenty tables that
    // loses wifi is told it has none, directly under the error banner saying
    // we could not load them. That is the defect this page was fixing, one
    // empty state over.
    !resourcesFailed &&
    assignableTables.length === 0;

  // Pop the book out to its own full-screen door screen (no sidebar). Opens
  // /reservations/stand in a new tab — a dedicated host-stand display. Hidden
  // while already inside the pop-out. On a phone it sits after the lens
  // switch, under Refresh — or beside Refresh when there is no lens switch.
  const standPopOut = !__STAND_BUILD__ && !standalone ? (
    <button
      type="button"
      onClick={() =>
        window.open("/reservations/stand", "_blank", "noopener,noreferrer")
      }
      // A salon, a shop or a workshop has no host and no door: the pop-out is
      // the appointment book on its own screen ("Åbn vært-skærm" was the one
      // restaurant word left on a shop's book).
      aria-label={apptWords ? t("rsvpOpenStandAppt", "Open the appointment book in its own window") : t("rsvpOpenStand", "Open host-stand view")}
      title={apptWords ? t("rsvpOpenStandAppt", "Open the appointment book in its own window") : t("rsvpOpenStand", "Open host-stand view")}
      className={
        "inline-flex items-center justify-center h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 " +
        PHONE_TOOL + " " + PHONE_TOOL_SQUARE + " max-lg:order-1"
      }
    >
      <ExternalLink className="w-5 h-5 max-sm:w-[18px] max-sm:h-[18px]" />
    </button>
  ) : null;

  // R10 "Afbryd denne skærm" (paired device only). Asked first — the screen
  // then needs a new code from the owner — and the device lets go of its
  // own link on the server, so a URL left in the history stops opening the
  // book. If BonBox cannot be reached the screen still forgets it here, and
  // says the owner can remove it from Indstillinger.
  async function unpairThisScreen() {
    const ok = await confirm({
      title: t("rsvpStandUnpairTitle", "Disconnect this screen?"),
      message: t(
        "rsvpStandUnpairBody",
        "The book closes on this screen. To use it again, the owner makes a new code under Settings.",
      ),
      confirmLabel: t("rsvpStandUnpairYes", "Disconnect"),
      destructive: true,
    });
    if (ok !== true) return;
    let reached = true;
    try {
      // Rewritten to /stand/<token>/unpair on this device (services/standAuth).
      await api.post("/reservations/unpair", {});
    } catch (e) {
      // The stand's own 404 ({error: "not_found"}): the link is already gone,
      // which is what was asked for. Any other failure — no network, or a
      // server without this route yet — left it alive: say so.
      reached = e?.response?.status === 404 && e?.response?.data?.detail?.error === "not_found";
    }
    clearStandToken();
    unwatchBook(watchIdRef.current);
    if (!reached) {
      toast({
        severity: "notice",
        message: t(
          "rsvpStandUnpairOffline",
          "Disconnected on this screen. BonBox couldn't be reached — the owner can also remove it under Settings.",
        ),
      });
    }
    navigate("/stand", { replace: true, state: { fresh: true } });
  }

  // R10: a paired door screen whose link is dead shows one calm screen —
  // what happened and the one thing to do — and no guests (V10).
  if (standGone) {
    return (
      <StandNotConnected
        t={t}
        apptWords={apptWords}
        busy={loading}
        onRetry={() => fetchBook(day)}
        onNewCode={() => {
          // The dead link is forgotten here, so /stand asks for a code
          // instead of reopening it.
          clearStandToken();
          navigate("/stand", { replace: true, state: { fresh: true } });
        }}
      />
    );
  }

  return (
    <div
      className={
        standalone
          ? "min-h-screen bg-gray-50 dark:bg-gray-950 px-4 sm:px-6 lg:px-8 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] space-y-4 max-sm:space-y-3"
          : "space-y-4 max-sm:space-y-3"
      }
    >
      {/* The "Kommende" list lives in the page's side column (desktop only —
          that column is hidden below xl, so this costs a phone nothing), and
          only beside the floor PLAN: there the host sees the room but not the
          queue. Beside Liste or Tidslinje it repeated what the page already
          shows. A day that is over has nothing coming, so no list at all. */}
      {!__STAND_BUILD__ && railSlot && !loading && view === "plan" && day >= todayIso &&
        createPortal(
          <UpcomingRail
            t={t}
            rows={upcomingRows}
            isToday={isViewingToday}
            nowMs={nowTs}
            tableLabel={(r) => resolveTableLabel(r, labelById)}
            onOpen={openDrawer}
            onShowAll={() => {
              pickView("liste");
              setStatusFilter("all");
            }}
            waitlistCount={waitlistCount}
            onOpenWaitlist={focusWaitlist}
          />,
          railSlot,
        )}
      {/* Host-stand top bar — only in the /reservations/stand pop-out, which
          renders outside the app <Layout />. A slim brand row + a Luk that
          closes the popped tab (or falls back to the full app). */}
      {standalone && (
        // Wraps only below md, for the covers' own row; the title takes what
        // is left of the first line (basis 0) and truncates, so a long venue
        // name never pushes the sound and ⋯ controls onto a row of their own
        // (Push 8 review). From md one line, as before.
        <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-x-3 gap-y-2 pb-3 border-b border-gray-200 dark:border-gray-800" data-stand-header="">
          <div className="flex items-center gap-2.5 min-w-0 max-md:flex-1 max-md:basis-0" data-stand-title="">
            <span className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-gray-900 text-white dark:bg-white dark:text-gray-900 shrink-0">
              <CalendarCheck className="w-5 h-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight truncate">
                {apptWords
                  ? t("rsvpStandTitleProvider", "Aftaler")
                  : t("rsvpStandTitle", "Reservationer")}
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-tight truncate">
                {user?.business_name ? `${user.business_name} · ` : ""}
                {apptWords
                  ? t("rsvpStandModeAppt", "Counter screen")
                  : t("rsvpStandMode", "Vært-skærm")}
              </div>
            </div>
          </div>
          {/* Covers at a glance — guests and parties seated now, still
              expected (confirmed, not yet here) and finished, counted from the
              book on screen. Each opens that slice of the list. Today only:
              "now" means nothing on another day. On a phone a compact row of
              three under the title (guests only, 40 px / 13 px): hidden there,
              the phone stand had no Forventet or Afsluttet count at all. */}
          {showStandNow && (
            <div
              // From md the counts keep their full width and the venue name
              // gives way, as on 7a631c0f from lg — "3 selska…" was cut on
              // the door iPad. At 768–1023 the cells carry the guests alone
              // (the parties ride from lg), so they fit whole beside the sound
              // chip and ⋯; shrinking there cut "10 gæ…" and "Tjekket …" on
              // an iPad in portrait while the title kept the room (Push 8
              // review). min-w-0 is the phone grid's.
              className="order-last basis-full grid grid-cols-3 gap-1 min-w-0 md:order-none md:basis-auto md:flex md:items-stretch md:shrink-0"
              data-stand-covers=""
              role="group"
              aria-label={apptWords ? t("rsvpStandCoversAriaAppt", "Customers today") : t("rsvpStandCoversAria", "Guests today")}
            >
              {/* A shop or a workshop (a salon has no covers row): its
                  customers are checked in, counted as customers and
                  appointments — never "Sidder" or "gæster". */}
              {[
                ["seated", apptWords ? t("rsvpStatusSeatedAppt", "Checked in") : t("rsvpStandSeated", "Seated"), standCovers.seated, "seated"],
                ["expected", t("rsvpStandExpected", "Expected"), standCovers.expected, "confirmed"],
                ["finished", t("rsvpStandFinished", "Finished"), standCovers.finished, "completed"],
              ].map(([k, label, c, st]) => (
                <button
                  key={k}
                  type="button"
                  data-covers={k}
                  onClick={() => focusStatus(st)}
                  className={
                    "min-h-[40px] md:min-h-[44px] min-w-0 px-2 md:px-3 rounded-lg text-left transition hover:bg-gray-100 dark:hover:bg-gray-800 " +
                    (view === "liste" && statusFilter === st ? "bg-gray-100 dark:bg-gray-800" : "")
                  }
                >
                  <span className="flex items-center gap-1.5 text-[11px] leading-tight text-gray-500 dark:text-gray-400">
                    {k === "seated" && c.parties > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500 dark:bg-emerald-400" aria-hidden />
                    )}
                    <span className="truncate">{label}</span>
                  </span>
                  <span className="block text-[13px] md:text-sm leading-tight tabular-nums whitespace-nowrap truncate text-gray-900 dark:text-gray-100">
                    {/* Until the book has arrived there is no count to give:
                        "—", as the drop-in row does — not "0 gæster" under
                        the list's skeletons (Push 8 review). */}
                    {!data ? (
                      <span className="font-semibold" data-covers-unknown="">—</span>
                    ) : (<>
                    <span className="font-semibold">
                      {apptWords
                        ? c.guests === 1
                          ? t("rsvpStandCustomersOne", "{n} customer", { n: c.guests })
                          : t("rsvpStandCustomers", "{n} customers", { n: c.guests })
                        : c.guests === 1
                          ? t("rsvpStandGuestsOne", "{n} guest", { n: c.guests })
                          : t("rsvpStandGuests", "{n} guests", { n: c.guests })}
                    </span>
                    {/* The parties ride along from lg up; a phone cell has room
                        for the guests alone, and so has an iPad in portrait
                        (768–1023): with them the row did not fit there, and
                        it cut them to "13 gæster · 3 …" (Push 8 review). */}
                    <span data-covers-parties="" className="hidden lg:inline text-gray-500 dark:text-gray-400">
                      {" · "}
                      {apptWords
                        ? c.parties === 1
                          ? t("rsvpStandApptsOne", "{n} appointment", { n: c.parties })
                          : t("rsvpStandAppts", "{n} appointments", { n: c.parties })
                        : c.parties === 1
                          ? t("rsvpStandPartiesOne", "{n} party", { n: c.parties })
                          : t("rsvpStandParties", "{n} parties", { n: c.parties })}
                    </span>
                    </>)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* Audibility is the one piece of stand state a host must be able to
              read without touching anything, so the chip is top-level and the
              owner door sits behind the overflow. Reversed from how this used
              to be: the gear was one tap and the sound was invisible. */}
          <div className="flex items-center gap-1 shrink-0">
            <StandSoundChip t={t} />
            <StandMenu
              t={t}
              apptWords={apptWords}
              onLogout={async () => {
                try {
                  await logout();
                } finally {
                  navigate("/login");
                }
              }}
              onUnpair={isStandDevice ? unpairThisScreen : null}
            />
          </div>
        </div>
      )}
      {/* Salon first-run — a provider (salon) venue with no self-chair yet
          gets a calm "confirm your hours → open for booking" card in place of
          the empty, confusing book. One tap seeds the self-chair + enables
          reservations; the live book renders the moment a station exists. */}
      {!__STAND_BUILD__ && salonFirstRun && (
        <SalonFirstRunCard
          t={t}
          hours={salonHours}
          setHourDay={setSalonHourDay}
          applyMonToAll={applySalonMonToAll}
          behandlingerCount={behandlinger.length}
          busy={salonSetupBusy}
          error={salonSetupError}
          onOpen={openSalonForBooking}
          hoursSaved={salonHoursSaved}
          chairName={salonChairName}
          onChairName={setSalonChairName}
        />
      )}

      {/* A salon with bookings but no behandler yet (a café that became a
          salon): the book stays, with one line on what opens online booking. */}
      {!__STAND_BUILD__ && salonNeedsSetup && !salonFirstRun && !standalone && (
        <div
          role="status"
          data-testid="salon-setup-nudge"
          className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100"
        >
          <Scissors className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("rsvpProviderSetupTitle", "Customers can't book a time online yet")}</p>
            <p className="mt-0.5 text-[13px] text-gray-700 dark:text-gray-200">
              {t("rsvpProviderSetupBody", "Add yourself or a stylist — then customers can book online. Your bookings stay below.")}
            </p>
            <Link
              to="/reservations?tab=floor"
              className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2"
            >
              {t("rsvpProviderNoTimesCta", "Add a stylist")}
              <ChevronRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      )}

      {!salonFirstRun && noBookableTimes && (
        <div
          role="status"
          data-testid="salon-no-bookable-times"
          className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("rsvpProviderNoTimesTitle", "Customers can't book yet")}</p>
            {/* Name the likely cause: no saved opening hours (a self-chair
                follows them), else no behandler with time to book. */}
            <p className="mt-0.5 text-[13px] opacity-90">
              {noServiceOnline
                ? t("rsvpProviderNoServiceBody", "Your page is on, but there's no service customers can book. Add one under Services.")
                : publicPage?.hoursDeclared === false
                ? t("rsvpProviderNoTimesNoHoursBody", "Your booking page has no free time in the next 14 days — your opening hours aren't saved yet.")
                : t("rsvpProviderNoTimesBody", "Your booking page has no free time in the next 14 days. Add a stylist — yourself too — or publish their shifts in Vagtplan.")}
            </p>
            <Link
              to={noServiceOnline
                ? "/reservations?tab=behandlinger"
                : publicPage?.hoursDeclared === false ? "/reservations?tab=settings" : "/reservations?tab=floor"}
              data-testid={noServiceOnline ? "salon-no-service-cta" : undefined}
              className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2"
            >
              {noServiceOnline
                ? t("rsvpSalonAddServiceCta", "Add a service")
                : publicPage?.hoursDeclared === false
                ? t("rsvpProviderNoTimesHoursCta", "Save opening hours")
                : t("rsvpProviderNoTimesCta", "Add a stylist")}
              <ChevronRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      )}

      {/* R1b: the plan's monthly cap is reached — what it does now, and the
          upgrade nudge (web only). Not on the stand pop-out. */}
      {!__STAND_BUILD__ && !salonFirstRun && !standalone && (
        <PlanCapBanner monthCap={publicPage?.monthCap} t={t} apptWords={apptWords} />
      )}

      {/* What a salon owner must act on (R6): next week without published
          shifts ("Kopiér sidste uge"), and appointments on a stylist's Ferie
          or Syg day ("Flyt" opens the booking). Owner session only. */}
      {!__STAND_BUILD__ && isProvider && !standalone && !salonFirstRun && !salonNeedsSetup && (
        <SalonAttention t={t} lang={lang} refreshKey={bookTick} onOpenBooking={openOtherDay} />
      )}

      {!salonFirstRun && (
        <>
      {/* Toolbar: day controls (left) + view toggle (right). Every control is
          a ≥44px tap target for the Windows host-stand / tablet.

          ON A PHONE (max-sm: only — from sm: up nothing here changes) it is
          three full-width rows on one grid: the day with Refresh beside it,
          the lens switch with the stand pop-out beside it, then Drop-in and
          New booking as one pair. Before, the same controls sat at their own
          widths on five loose rows and read as unfinished. */}
      {/* From 2xl up the toolbar is one row: both groups stop wrapping, so
          the refresh icon no longer drops onto a line of its own at 1280. */}
      {/* Below xl (tablet portrait, a narrow laptop window) the two actions are
          a row of their own, equal halves — they used to wrap one by one under
          the lens switch into a ragged stack. From xl the three groups share
          one row with the lens switch beside the actions, as before. */}
      <div className={"flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between xl:justify-start gap-3 max-sm:gap-2" + (standalone ? " lg:justify-start" : "")}>
        <div className="flex items-center gap-2 flex-wrap 2xl:flex-nowrap max-sm:items-stretch">
          {/* Date stepper — ◂ step a day ▸, tap the centre to jump via the
              native picker. The relative label ("I dag" / "I morgen") gives
              instant orientation; the numeric date sits quietly beneath. */}
          <div className="relative max-sm:flex-1 max-sm:min-w-0" ref={dayPickerRef}>
          <div className="inline-flex items-stretch rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] overflow-hidden max-sm:flex max-sm:w-full">
            <button
              type="button"
              onClick={() => setDay(shiftDay(day, -1))}
              aria-label={t("rsvpPrevDay", "Previous day")}
              className="w-10 max-sm:w-11 max-sm:shrink-0 max-sm:min-h-0! inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            {standalone ? (
              <button
                type="button"
                onClick={() => setDayPickerOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={dayPickerOpen}
                aria-label={apptWords ? t("rsvpBookDayAppt", "Appointment book date") : t("rsvpBookDay", "Reservation date")}
                className="relative h-11 max-sm:h-10 max-sm:min-h-0! flex flex-col items-center justify-center px-3 cursor-pointer border-x border-gray-200 dark:border-gray-700 min-w-[7.5rem] max-sm:flex-1 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
              >
                <span className="text-[13px] font-semibold leading-none text-gray-900 dark:text-gray-100">
                  {relativeDayLabel(day, t, lang)}
                </span>
                <span className="text-[11px] leading-none text-gray-500 dark:text-gray-400 tabular-nums mt-1">
                  {fmtDkDate(day)}
                </span>
              </button>
            ) : (
            <label className="relative h-11 max-sm:h-10 max-sm:min-h-0! flex flex-col items-center justify-center px-3 cursor-pointer border-x border-gray-200 dark:border-gray-700 min-w-[7.5rem] max-sm:flex-1 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors focus-within:ring-2 focus-within:ring-inset focus-within:ring-gray-900 dark:focus-within:ring-gray-100">
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
                aria-label={apptWords ? t("rsvpBookDayAppt", "Appointment book date") : t("rsvpBookDay", "Reservation date")}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </label>
            )}
            <button
              type="button"
              onClick={() => setDay(shiftDay(day, 1))}
              aria-label={t("rsvpNextDay", "Next day")}
              className="w-10 max-sm:w-11 max-sm:shrink-0 max-sm:min-h-0! inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          {standalone && dayPickerOpen && (
            <div
              role="dialog"
              aria-label={apptWords ? t("rsvpBookDayAppt", "Appointment book date") : t("rsvpBookDay", "Reservation date")}
              className="absolute left-0 top-full z-30 mt-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] bg-white dark:bg-[rgb(var(--surface-raised))] shadow-xl"
            >
              <DayRail
                day={day}
                onPick={(d) => {
                  setDay(d);
                  setDayPickerOpen(false);
                }}
                t={t}
                apptWords={apptWords}
              />
            </div>
          )}
          </div>
          {day !== serviceDayIso() && (
            <button
              type="button"
              onClick={() => setDay(serviceDayIso())}
              className={
                "inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 " +
                PHONE_TOOL
              }
            >
              {t("rsvpToday", "Today")}
            </button>
          )}
          <button
            type="button"
            onClick={() => fetchBook(day)}
            aria-label={t("rsvpRefresh", "Refresh")}
            aria-busy={refreshing || undefined}
            className={
              "inline-flex items-center justify-center h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 " +
              PHONE_TOOL + " " + PHONE_TOOL_SQUARE
            }
          >
            <RefreshCw className={"w-5 h-5 max-sm:w-[18px] max-sm:h-[18px]" + (refreshing ? " animate-spin" : "")} />
          </button>
          {!tableFloor && standPopOut}
          {/* The stand used to go stale in complete silence while the now-line
              kept moving. This names the one fact that matters — WHEN what you
              are reading arrived — and sits next to the refresh that fixes it.
              No spinner, no modal, no red: service does not stop for a
              dialog, and the book on screen is still the last true one. */}
          {bookStale && (
            <span
              role="status"
              data-book-offline=""
              className="inline-flex items-center gap-1.5 min-h-[44px] px-1 text-[12px] leading-snug font-medium text-gray-600 dark:text-gray-300 max-sm:basis-full max-sm:min-h-0"
            >
              <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden />
              <span className="tabular-nums">
                {t("rsvpBookOffline", "Offline · showing the book from {time}", {
                  time: fmtTime(new Date(lastOkAt).toISOString()),
                })}
              </span>
            </span>
          )}
        </div>
        {/* Floor and Timeline lenses only for a TABLE plan — with one lens
            left there is nothing to switch, and the pop-out joins the day
            row instead of standing alone on a row of its own. */}
        {tableFloor && (
        <div className={"flex items-center gap-2 flex-wrap 2xl:flex-nowrap max-sm:items-stretch xl:ml-auto" + (standalone ? " lg:ml-auto" : "")}>
          {standPopOut}
          <TabPills
            tabs={[
              { id: "liste", label: t("rsvpViewListe", "List") },
              { id: "plan", label: t("rsvpViewPlan", "Floor") },
              { id: "tidslinje", label: t("rsvpViewTimeline", "Timeline") },
            ]}
            activeId={view}
            onChange={pickView}
            ariaLabel={apptWords ? t("rsvpViewAriaAppt", "Appointment book views") : t("rsvpViewAria", "Reservation views")}
            phone="segmented"
            className="max-sm:flex-1 max-sm:min-w-0"
          />
        </div>
        )}
          {/* The two actions travel as one pair — a full-width row of equal
              halves on a phone and a tablet; from xl two buttons at the end of
              the one toolbar row. */}
          <div
            className={
              "grid grid-flow-col auto-cols-fr gap-2 sm:basis-full xl:basis-auto xl:flex" +
              // The door screen has no sidebar: from lg the actions join the
              // toolbar's row, and the floor gets that row back.
              (standalone ? " lg:basis-auto lg:flex" : "")
            }
          >
          {/* Seat walk-in — always reachable for TABLE venues, in every day
              lens (List / Timeline / Floor), not only by tapping a free tile
              on the Floor map. Opens SeatNowSheet in table-picker mode.
              A phone shows the short name and a quiet bordered face: the
              white primary slab (its dark-theme colour) beside the green main
              action made two competing blocks of different widths. */}
          {/* Secondary at every width: in dark mode the primary face turned
              into a white slab beside the green main action (sm and up). */}
          {tableFloor && !isProvider && (
            <Button
              variant="secondary"
              size="lg"
              iconLeft={<Armchair className="w-4 h-4" />}
              onClick={openSeatWalkIn}
              aria-label={apptWords ? t("rsvpSeatWalkInAppt", "Check in a drop-in") : t("rsvpSeatWalkIn", "Seat a drop-in")}
              className={PHONE_ACTION}
            >
              <span className="sm:hidden">{t("rsvpSeatWalkInShort", "Drop-in")}</span>
              <span className="hidden sm:inline">
                {apptWords ? t("rsvpSeatWalkInAppt", "Check in a drop-in") : t("rsvpSeatWalkIn", "Seat a drop-in")}
              </span>
            </Button>
          )}
          <Button
            variant="main"
            size="lg"
            iconLeft={<Plus className="w-4 h-4" />}
            onClick={openNewBooking}
            className={PHONE_ACTION}
          >
            {apptWords
              ? t("rsvpNewBookingProvider", "Book an appointment")
              : t("rsvpNewBooking", "New booking")}
          </Button>
          </div>
      </div>

      {/* Host stand: drop-in by party size. One tap seats a party where a
          seating is free for their whole sitting (the smallest table that
          fits, else the tables the booking engine pushes together);
          otherwise the Venteliste form opens with the size filled in.
          Under each size: "Ledigt nu", or the first time such a seating
          opens, worked out from the booked ends and marked "ca." — or
          nothing, when that cannot be known (a party past its end at a table
          that could take them). "—" until the venue's turn times and hours
          have loaded: no claim is made from defaults.
          Not on the Plan lens: the room is fitted to the screen height, and
          this row cost it ~100px — at 1024×768 31/32/33 drew on top of each
          other and the tiles lost their "fri 20.15". There the floor is the
          drop-in tool (tap a free table) and its own bar says when one frees. */}
      {walkIns && view !== "plan" && (
        <section
          aria-labelledby="rsvp-walkin-title"
          className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] px-3 py-2.5"
        >
          {/* Below md (a phone, also a paired device) the six sizes are a 3×2
              grid under the title: in one row of six at 390px every button
              was ~40px wide and "Ledigt nu" clipped to "L…". */}
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
            <div className="shrink-0 flex flex-wrap items-baseline gap-x-2 md:block md:w-24 lg:w-28">
              <div id="rsvp-walkin-title" className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Footprints className="w-4 h-4 text-gray-500 dark:text-gray-400" aria-hidden />
                {t("rsvpSeatWalkInShort", "Drop-in")}
              </div>
              <div className="md:mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                {walkIns.some((o) => !o.freeNow && o.at)
                  ? t("rsvpWalkInAboutHow", "approx. = worked out from the bookings' end times")
                  : apptWords
                    ? t("rsvpWalkInHintAppt", "Tap the number of people")
                    : t("rsvpWalkInHint", "Tap the number of guests")}
              </div>
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 flex-1 min-w-0" data-walkin-grid>
              {walkIns.map((o) => {
                const sizeLabel = o.size === WALK_IN_SIZES[WALK_IN_SIZES.length - 1] ? `${o.size}+` : String(o.size);
                const atText = !o.freeNow && o.at ? fmtTime(new Date(o.at).toISOString()) : null;
                // Rules not loaded yet: no claim either way — the tap opens the
                // seat sheet on this size, and the button says only that.
                // One guest is "1 gæst", never "1 gæster" (a screen reader read
                // the plural on the first button).
                const one = sizeLabel === "1";
                // A shop or a workshop: people, places, "tjek ind" — the
                // buttons were named "1 gæst: intet bord ledigt nu …".
                const aria = apptWords
                  ? o.unknown
                    ? one
                      ? t("rsvpWalkInPickAriaOneAppt", "1 person: choose a space")
                      : t("rsvpWalkInPickAriaAppt", "{n} people: choose a space", { n: sizeLabel })
                    : o.freeNow
                    ? sizeLabel.endsWith("+")
                      ? t("rsvpWalkInSheetAriaAppt", "{n} people: a space is free now — choose the number and space", { n: sizeLabel })
                      : one
                        ? t("rsvpWalkInSeatAriaOneAppt", "1 person: check in now at {table}", { table: o.label || "" })
                        : t("rsvpWalkInSeatAriaAppt", "{n} people: check in now at {table}", { n: sizeLabel, table: o.label || "" })
                    : atText
                      ? one
                        ? t("rsvpWalkInWaitAriaOneAppt", "1 person: no space free now, approx. {time} — add to the waitlist", { time: atText })
                        : t("rsvpWalkInWaitAriaAppt", "{n} people: no space free now, approx. {time} — add to the waitlist", { n: sizeLabel, time: atText })
                      : one
                        ? t("rsvpWalkInWlAriaOneAppt", "1 person: no space free now — add to the waitlist")
                        : t("rsvpWalkInWlAriaAppt", "{n} people: no space free now — add to the waitlist", { n: sizeLabel })
                  : o.unknown
                  ? one
                    ? t("rsvpWalkInPickAriaOne", "1 guest: choose a table")
                    : t("rsvpWalkInPickAria", "{n} guests: choose a table", { n: sizeLabel })
                  : o.freeNow
                  ? sizeLabel.endsWith("+")
                    ? t("rsvpWalkInSheetAria", "{n} guests: a table is free now — choose the size and table", { n: sizeLabel })
                    : one
                      ? t("rsvpWalkInSeatAriaOne", "1 guest: seat now at {table}", { table: o.label || "" })
                      : t("rsvpWalkInSeatAria", "{n} guests: seat now at {table}", { n: sizeLabel, table: o.label || "" })
                  : atText
                    ? one
                      ? t("rsvpWalkInWaitAriaOne", "1 guest: no table free now, approx. {time} — add to the waitlist", { time: atText })
                      : t("rsvpWalkInWaitAria", "{n} guests: no table free now, approx. {time} — add to the waitlist", { n: sizeLabel, time: atText })
                    : one
                      ? t("rsvpWalkInWlAriaOne", "1 guest: no table free now — add to the waitlist")
                      : t("rsvpWalkInWlAria", "{n} guests: no table free now — add to the waitlist", { n: sizeLabel });
                return (
                  <button
                    key={o.size}
                    type="button"
                    data-walkin={o.size}
                    data-walkin-state={o.pending ? "pending" : o.unknown ? "unknown" : o.freeNow ? "free" : atText ? "wait" : "none"}
                    disabled={seating || o.pending}
                    onClick={() => walkInTap(o)}
                    aria-label={aria}
                    title={aria}
                    className="h-14 md:h-16 min-w-0 rounded-lg border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] hover:bg-gray-100 dark:hover:bg-[rgb(var(--surface-raised))] active:scale-[0.98] transition flex flex-col items-center justify-center gap-0.5 disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1 text-lg font-semibold leading-none tabular-nums text-gray-900 dark:text-gray-100">
                      <Users className="w-4 h-4 text-gray-400 dark:text-gray-500" aria-hidden />
                      {sizeLabel}
                    </span>
                    <span
                      className={
                        "text-[11px] font-medium leading-tight tabular-nums truncate max-w-full px-1 " +
                        (o.freeNow ? "text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400")
                      }
                    >
                      {o.unknown
                        ? "—"
                        : o.freeNow
                        ? t("rsvpWalkInFreeNow", "Free now")
                        : atText
                          ? t("rsvpWalkInAbout", "approx. {time}", { time: atText })
                          : "\u00a0"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {walkInDoneLine(false)}
        </section>
      )}
      {/* Where the drop-in row is not on screen — the book page, the stand's
          Plan lens — a seat from the header's sheet still says where the
          party went: the same line, floating over the foot of the page (in
          the flow it would push the fitted room down for its 20 s). */}
      {walkInDone && !(walkIns && view !== "plan") && createPortal(
        <div
          data-walkin-done-float=""
          className="fixed z-50 left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+72px)] md:bottom-5 w-[calc(100%-2rem)] max-w-md rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] bg-white dark:bg-[rgb(var(--surface-raised))] shadow-sm px-3 py-2.5"
        >
          {walkInDoneLine(true)}
        </div>,
        document.body,
      )}

      {/* Cockpit — the day's vitals, as ONE slim strip above the room.
          Covers is the headline (booking count in its helper); Seated and
          Awaiting click through to the filtered list; Next arrival opens that
          booking; On waitlist jumps to the Venteliste. Colour only when a
          number needs attention — otherwise the strip stays calm grey.

          WHY A STRIP AND NOT SIX TILES. These were six StatCards in a row: a
          ~95px band of boxes over the floor plan and timeline, which are what a
          host actually works from — and on most shifts four of the six say
          "0". The room is the product; the numbers support it. StatStrip is one
          card with hairline dividers, ~80px tall.

          ON A PHONE it is three across, and a secondary cell with nothing to
          say hides (hideOnPhone). Measured on a 390px phone, 877px of chrome
          once sat above the floor plan, and this block was the biggest part of
          it. Awaiting, Occupancy and On waitlist each turn amber/red exactly
          when they matter, so they hide only when genuinely quiet — a non-zero
          count, or occupancy at the 85% warn threshold, always renders.
          Covers, Seated now and Next arrival always show: those are the three
          a host reads during service. */}
      {/* A salon's day in one line (R7, rubric S5): "2 kan bookes samtidig
          (dig og Mia)" — who customers can book on the day shown. Owner page
          only; the stand is a service screen. */}
      {!__STAND_BUILD__ && isProvider && !standalone && !salonNeedsSetup && (
        <SalonDayCapacity t={t} lang={lang} day={day} />
      )}
      <StatStrip
        shortBelow="xl"
        items={cockpitWhenUnknown(!!data, [
          {
            key: "covers",
            // A salon, a shop, a workshop: customers and appointments, not
            // covers and reservations (vertical-fit audit, Oct 2026).
            label: apptWords ? t("rsvpCoversProvider", "Customers") : t("rsvpCovers", "Covers"),
            value: summary.covers,
            icon: Users,
            tone: summary.covers > 0 ? "info" : "neutral",
            helper: apptWords
              ? (coverBookings === 1
                ? t("rsvpCoversBookingsOneProvider", "{n} appointment", { n: coverBookings })
                : t("rsvpCoversBookingsProvider", "{n} appointments", { n: coverBookings }))
              : coverBookings === 1
                ? t("rsvpCoversBookingsOne", "{n} booking", { n: coverBookings })
                : t("rsvpCoversBookings", "{n} bookings", { n: coverBookings }),
          },
          {
            key: "seated",
            // The salon's chair; a shop or a workshop has its customer "here".
            label: isProvider
              ? t("rsvpSeatedNowProvider", "In the chair now")
              : apptWords
                ? t("rsvpSeatedNowAppt", "Here now")
                : t("rsvpSeatedNow", "Seated now"),
            value: seatedGuests,
            // The one LIVE number on the page — guests physically in the room
            // right now. Emerald only while that's true; the moment the room is
            // empty it falls back to neutral so the colour always means
            // "something is happening", never decoration.
            accent: seatedCount > 0 ? "success" : "neutral",
            icon: Armchair,
            tone: seatedCount > 0 ? "success" : "neutral",
            helper:
              isProvider
                ? t("rsvpSeatedHelperProvider", "in the salon")
              : apptWords
                // One is one: "Her nu 1 kunde" — it read "1 / kunder" under
                // the header's "Tjekket ind 1 kunde".
                ? seatedGuests === 1
                  ? t("rsvpSeatedHelperApptOne", "customer")
                  : t("rsvpSeatedHelperAppt", "customers")
              : seatedCount === 0
                ? t("rsvpSeatedHelper", "in the room")
                : [
                    seatedTables.tables === 1
                      ? t("rsvpSeatedAtTableOne", "at 1 table")
                      : seatedTables.tables > 1
                        ? t("rsvpSeatedAtTables", "at {n} tables", { n: seatedTables.tables })
                        : null,
                    seatedTables.none > 0 ? t("rsvpSeatedNoTable", "{n} without a table", { n: seatedTables.none }) : null,
                  ].filter(Boolean).join(" · "),
            onClick: () => focusStatus("seated"),
            selected: view === "liste" && statusFilter === "seated",
          },
          {
            key: "next",
            // Another day's first party is its first arrival, not "next".
            label: isViewingToday ? t("rsvpNextArrival", "Next arrival") : t("rsvpFirstArrival", "First arrival"),
            shortLabel: isViewingToday ? t("rsvpNextShort", "Next") : t("rsvpFirstShort", "First"),
            value: nextArrival ? fmtTime(nextArrival.starts_at) : "—",
            icon: Clock,
            tone: !nextArrival ? "neutral" : lateMinutes(nextArrival, nowTs, isViewingToday) ? "late" : "info",
            helper: nextArrivalHelper,
            onClick: nextArrival ? () => openDrawer(nextArrival) : null,
          },
          {
            key: "awaiting",
            label: t("rsvpAwaiting", "Awaiting"),
            value: requestedCount,
            accent: requestedCount > 0 ? "warn" : "neutral",
            icon: Hourglass,
            tone: requestedCount > 0 ? "warn" : "neutral",
            helper: t("rsvpAwaitingHelper", "to confirm"),
            onClick: () => focusStatus("requested"),
            selected: view === "liste" && statusFilter === "requested",
            hideOnPhone: requestedCount === 0,
          },
          // Occupancy is covers against TABLE seats — a salon or a shop has
          // none, and the cell only said "set table seats".
          ...(tableFloor ? [{
            key: "occupancy",
            label: t("rsvpUtilization", "Occupancy"),
            value: peakPct == null ? "—" : `${peakPct}%`,
            // Over 100% means more covers than seats at the peak — a real
            // problem the owner should see before service, not a neutral fact.
            // It was rendering 192% in plain gray. 85%+ is "nearly full" (amber:
            // worth knowing), past 100% is red. Unknown capacity stays neutral —
            // with no seat count there's no honest claim to make.
            // Red past 100% (more covers than seats); amber is the request
            // colour now, so "nearly full" reads in the number, not a tint.
            accent: peakPct != null && peakPct > 100 ? "critical" : "neutral",
            icon: Gauge,
            tone: peakPct == null ? "neutral" : peakPct > 100 ? "critical" : peakPct > 0 ? "success" : "neutral",
            helper:
              totalCapacity <= 0
                ? t("rsvpUtilNoSeats", "set table seats")
                : peakTime
                  ? t("rsvpUtilPeakAt", "peak {time}", { time: peakTime })
                  : t("rsvpUtilHelper", "of {n} seats", { n: totalCapacity }),
            hideOnPhone: !(peakPct != null && peakPct >= 85),
          }] : []),
          {
            key: "waitlist",
            label: t("rsvpWlCockpitToday", "On waitlist"),
            shortLabel: t("rsvpWlShort", "Waitlist"),
            value: waitlistCount,
            // Amber is for requests; a waiting party is counted, not tinted.
            accent: "neutral",
            icon: ListOrdered,
            tone: "neutral",
            helper: t("rsvpWlWaiting", "Waiting"),
            onClick: focusWaitlist,
            hideOnPhone: waitlistCount === 0,
          },
        ])}
      />

      {/* R11 (B10): a table may have opened and someone waiting fits it —
          said where the host is looking, never under the last row: a card
          floating over the foot of the page (it moves nothing — in the page
          it would push the night down mid-service). One tap: the Venteliste,
          the matches ringed, Giv besked / Book. */}
      {nudgeFloats && createPortal(
        <FreedTableNudge
          matches={freedNudge.matches}
          t={t}
          apptWords={apptWords}
          raised={!!walkInDone && !(walkIns && view !== "plan")}
          onShow={() => {
            setSpotMatches([...freedNudge.matches]);
            focusWaitlist();
          }}
          onDismiss={() => setFreedNudge(null)}
        />,
        document.body,
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* R10: no book for this day could be read. Said once, calmly, in
          words — and the page keeps asking by itself — instead of a list,
          a floor and a timeline that would each say "nothing booked". */}
      {bookUnavailable && (
        <BookUnavailable
          t={t}
          message={loadError}
          offline={browserOffline}
          apptWords={apptWords}
          onRetry={() => fetchBook(day)}
        />
      )}

      {/* Honest dead-link note — a deep-link pointed at a booking that's since
          been cancelled or purged. We land on its day, say so plainly, and let
          the owner dismiss it. Never a blank drawer or a 404. */}
      {deepLinkGone && (
        <div className="flex items-start gap-2 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 text-gray-800 dark:text-gray-100 px-4 py-3 rounded-xl text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">
            {t("rsvpDeepLinkGone", "This reservation no longer exists.")}
          </span>
          <button
            type="button"
            onClick={() => setDeepLinkGone(false)}
            aria-label={t("close", "Close")}
            className="shrink-0 -my-0.5 -mr-1 h-7 w-7 inline-flex items-center justify-center rounded-lg hover:bg-gray-200/70 dark:hover:bg-gray-700/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* The tables could not be read (fix round 5): said once, above every
          lens — the list keeps working; the plan and the timeline wait for
          the tables instead of drawing an empty room. */}
      {roomUnknown && !bookUnavailable && (
        <div
          role="status"
          data-room-unknown=""
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-4 py-2.5 text-sm text-gray-800 dark:text-gray-100"
        >
          <WifiOff className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
          <span className="font-medium">
            {apptWords
              ? t("rsvpRoomUnknownAppt", "Couldn't load the spaces — trying again.")
              : t("rsvpRoomUnknown", "Couldn't load the tables — trying again.")}
          </span>
          <button
            type="button"
            onClick={() => fetchResources()}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            {t("tryAgain", "Try again")}
          </button>
        </div>
      )}

      {/* ── Liste (the polished data-table) ── */}
      {view === "liste" && !bookUnavailable && (
        <>
          {/* Phone: the search sits in the open, with Filter beside it — it
              was behind the Filter chip, and the other-day results landed
              under three dropdowns, below the fold. */}
          <div className="sm:hidden flex items-center gap-2">
            <FilterBar.Search
              id="rsvp-search-phone"
              value={q}
              onChange={setQ}
              placeholder={(apptWords ? t("rsvpSearchPhProvider", "Search customer or phone") : t("rsvpSearchPh", "Search guest or phone"))}
              aria-label={(apptWords ? t("rsvpSearchPhProvider", "Search customer or phone") : t("rsvpSearchPh", "Search guest or phone"))}
              className="min-w-0"
            />
            <button
              type="button"
              onClick={() => setMobileFiltersOpen((v) => !v)}
              aria-expanded={mobileFiltersOpen || selectsOn}
              className="shrink-0 inline-flex items-center gap-1.5 h-10 min-h-0! px-3 rounded-lg border border-[rgb(var(--surface-line))] bg-[rgb(var(--surface-card))] text-[13px] font-medium text-gray-600 dark:text-gray-300"
            >
              <SlidersHorizontal className="w-4 h-4" aria-hidden />
              {t("rsvpFilterChip", "Filter")}
              {selectsOn && (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-900 dark:bg-gray-100" aria-hidden />
              )}
            </button>
          </div>
          <div className={mobileFiltersOpen || selectsOn ? "" : "hidden sm:block"}>
          <FilterBar>
            <FilterBar.Search
              value={q}
              onChange={setQ}
              placeholder={(apptWords ? t("rsvpSearchPhProvider", "Search customer or phone") : t("rsvpSearchPh", "Search guest or phone"))}
              className="max-sm:hidden"
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

          {otherDayHits.length > 0 && (
            <section
              aria-label={t("rsvpSearchOtherDays", "On other days")}
              className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))]"
            >
              <h3 className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("rsvpSearchOtherDays", "On other days")}
              </h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {otherDayHits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => openOtherDay(h)}
                      className={"w-full min-h-[44px] px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60 " +
                        (h.status === "cancelled" || h.status === "no_show" ? "opacity-60" : "")}
                    >
                      <span className="min-w-[8.5rem] shrink-0 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 tabular-nums">
                        {shortDayLabel(h.day, t, lang)} · {hm(String(h.starts_at).slice(11, 16))}
                      </span>
                      <span className="flex-1 min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {guestText(h.guest_name) || t("rsvpGuest", "Guest")}
                      </span>
                      <span className="inline-flex items-center gap-1 text-sm tabular-nums text-gray-700 dark:text-gray-300 shrink-0">
                        <Users className="w-3.5 h-3.5 text-gray-400" aria-hidden />{h.party_size}
                      </span>
                      {/* The book's own status colour, not a grey word. */}
                      <span className="hidden sm:inline-flex text-[12px] shrink-0"><StatusInline status={h.status} label={labels[h.status] || h.status} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {searchPending && (
            <p className="text-[12px] text-gray-500 dark:text-gray-400 inline-flex items-center gap-1.5" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
              {t("rsvpSearchingOtherDays", "Searching other days…")}
            </p>
          )}
          {searchLive && found.failed && (
            <p className="text-[12px] text-gray-500 dark:text-gray-400">
              {t("rsvpSearchOtherDaysFailed", "Couldn't search other days just now — this day's list is still right.")}
            </p>
          )}

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey="id"
            loading={loading}
            rowActions={rowActions}
            onRowClick={openDrawer}
            // A cancelled or no-show row reads as history, as it already does
            // on the phone list — at full ink it looked like a live table.
            rowClassName={(r) => (r.status === "cancelled" || r.status === "no_show" ? "opacity-60" : "")}

            // Compact rows up to lg: at 768 (the host stand's tablet) the table
            // was 884px in 718px, with Udeblevet/Aflys off screen.
            // Compact rows below 1360: at 1024–1279 the table was 25–48px
            // wider than its card ("Afslut" cut in half), and at 1280 a late
            // party's extra no-show button pushed every ✕ past the edge.
            mobileBreakpoint="wide"
            mobileRow={compactRow}
            empty={
              // Nothing today, but found on other days (listed above): a
              // line pointing there, not a big "Nothing matches" card.
              filtersOn && otherDayHits.length > 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  {t("rsvpNoMatchTodayOtherDays", "Nothing on this day — see the other days above.")}
                </p>
              ) :
              /* Three honest empty states, not one: filtered-to-nothing, a
                 quiet day, and a venue that has no tables yet — the last used
                 to wear the second one's copy and promise bookings that could
                 never arrive. The phone route is named because it genuinely
                 still works with no floor plan (the 409 room_full path saves
                 the booking unassigned), so this is never a dead end. */
              <Empty
                icon={CalendarCheck}
                title={
                  // Filtered to nothing is not "no reservations yet" — it said
                  // so over a day with three bookings.
                  filtersOn
                    ? t("rsvpNoMatchTitle", "Nothing matches")
                    : cancelledCount > 0 && !showCancelled
                      ? t("rsvpOnlyCancelledTitle", "No active bookings")
                    : noTablesYet
                      ? t("rsvpBookNoTablesTitle", "No tables set up yet")
                      : apptWords
                        ? t("rsvpBookEmptyProvider", "No appointments for {date} yet.", { date: fmtDkDate(day) })
                        : t("rsvpBookEmpty", "No reservations for {date} yet.", { date: fmtDkDate(day) })
                }
                body={
                  filtersOn
                    ? liveCount > 0
                      ? t("rsvpNoMatchBody", "{n} bookings on this day — clear the search or filters to see them.", { n: liveCount })
                      : t("rsvpNoMatchNoneBody", "No active bookings on this day.")
                    : cancelledCount > 0 && !showCancelled
                      ? t("rsvpOnlyCancelledBody", "{n} cancelled — shown under the list.", { n: cancelledCount })
                    : noTablesYet
                      ? t(
                          "rsvpBookNoTablesBody",
                          "Guests can't book online until there's a table to seat them at. You can still take one over the phone with New booking.",
                        )
                      : apptWords
                        // No table plan and no behandler (a shop, a workshop):
                        // the page has nothing to offer online, so the book
                        // fills from "Book en tid" — say that, not "as
                        // customers book".
                        ? (!isProvider && !tableFloor
                          ? t("rsvpBookEmptyBodyManual", "Book a customer's time with “Book an appointment” — it shows here.")
                          : t("rsvpBookEmptyBodyProvider", "Appointments appear here as customers book."))
                        : t("rsvpBookEmptyBody", "Bookings will appear here as they come in.")
                }
                cta={
                  noTablesYet && !filtersOn ? (
                    <Button
                      variant="primary"
                      size="lg"
                      iconLeft={<Armchair className="w-4 h-4" />}
                      onClick={() => navigate("/reservations?tab=floor")}
                    >
                      {t("rsvpBookNoTablesCta", "Set up your tables")}
                    </Button>
                  ) : null
                }
              />
            }
          />

          {statusFilter === "all" && !q.trim() && cancelledCount > 0 && (
            <button type="button" onClick={() => setShowCancelled((v) => !v)}
              className="mt-2 w-full min-h-[44px] rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 hover:bg-gray-50 dark:hover:text-gray-100 dark:hover:bg-gray-800/60">
              {showCancelled
                ? t("rsvpHideCancelled", "Hide cancelled")
                : t("rsvpShowCancelled", "Show {n} cancelled", { n: cancelledCount })}
            </button>
          )}

        </>
      )}

      {/* Venteliste — parties we couldn't seat. A cancel/no-show above hands us
          the fitting matches (spotMatches) to highlight. The id is the scroll
          target for the cockpit's waitlist cell.

          Mounted in EVERY view, hidden outside Liste: this section owns the
          waitlist fetch, and the cockpit's "På venteliste" count and the side
          column's waitlist line both read the count it reports. Mounted only
          inside Liste, both said 0 in Plan and Tidslinje after a fresh load —
          with a party actually waiting. */}
      <div
        id="rsvp-venteliste"
        // R11 (B11): not drawn until the book's first answer — it sat in the
        // viewport under the list's skeleton and was pushed down 615 px when
        // the rows came (desktop CLS 0.218, 20 Oct). Still mounted, so its
        // count reaches the cockpit as before.
        className={"scroll-mt-4" + (view === "liste" && (data || loadError) ? "" : " hidden")}
        data-venteliste-shown={view === "liste" && (data || loadError) ? "" : undefined}
      >
        <WaitlistSection
          day={day}
          spotMatches={spotMatches}
          quietSpot={nudgeFloats}
          refreshTick={bookTick}
          onCountChange={setWaitlistCount}
          onConverted={() => fetchBook(day)}
          openHours={openHours}
          bookingRules={bookingRules}
          tableLabelFor={(r) => resolveTableLabel(r, labelById)}
          // Appointment words (salon, shop, repair trade); with no table plan
          // the waitlist books the time as it is, never "find a table".
          isProvider={apptWords}
          assignTables={tableFloor || isProvider}
          addRequest={wlAddRequest}
        />
      </div>

      {/* ── Plan (visual floor) ── */}
      {/* A party seated with no table can't be drawn on the floor — it read
          "13 ledige nu" with twelve people in the room. Name them, and open
          the booking to give them tables. */}
      {view === "plan" && !loading && (() => {
        const loose = reservations.filter(
          (r) => r.status === "seated" && !r.resource_id && !(Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length),
        );
        if (!loose.length) return null;
        return (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-4 py-2.5 text-sm text-gray-800 dark:text-gray-100 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="font-medium">{t("rsvpSeatedNoTableBanner", "Seated without a table:")}</span>
            {loose.map((r) => (
              <button key={r.id} type="button" onClick={() => openDrawer(r)} className="font-medium underline underline-offset-2 hover:no-underline">
                {(guestText(r.guest_name) || t("rsvpGuest", "Guest")) + " · " + r.party_size}
              </button>
            ))}
          </div>
        );
      })()}
      {view === "plan" && !bookUnavailable && !roomUnknown &&
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
            canArrange={!isStandDevice}
            // The door screen shows the whole room at once — at 1024×768 half
            // the tables sat below the fold.
            fitToScreen={standalone}
            fixtures={fixtures}
          />
        ))}

      {/* ── Tidslinje (service timeline grid) ── */}
      {view === "tidslinje" && !bookUnavailable && !roomUnknown &&
        (loading ? (
          <TimelineSkeleton />
        ) : (
          <TimelineView
            reservations={reservations}
            resources={resources}
            day={day}
            openHours={openHours}
            t={t}
            onSelect={openDrawer}
            onStatus={setStatus}
            checkedInWords={checkedInWords}
          />
        ))}
        </>
      )}

      {/* Shared detail drawer — opened from a Liste row, a Plan tile, or a
          timeline block. Status actions reuse the same optimistic handler. */}
      {selected && (
        <ReservationDrawer
          reservation={selected}
          nowTs={nowTs}
          busyIds={busyForSelected}
          onAssignMany={(r, ids) => assignTable(r, null, ids)}
          isToday={isViewingToday}
          dayLabel={isViewingToday ? null : shortDayLabel(day, t, lang)}
          held={isHeldForCheck(selected, publicPage?.groupThreshold)}
          onSpamDone={isStandDevice ? null : spamDone}
          onStand={isStandDevice}
          tableLabel={resolveTableLabel(selected, labelById)}
          // A salon's leftover table booking opens as the table booking it is.
          isProvider={isProvider && !holdsTable(selected)}
          apptWords={apptWords}
          checkedIn={checkedInWords}
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
          // Close the drawer first: Edit is its own sheet at the same z-level,
          // so leaving the drawer open put the form UNDER its backdrop and the
          // first tap in Edit only closed the drawer.
          onEdit={(r) => { setEditError(""); setEditWarning(null); setSelected(null); setEditRes(r); }}
          onAllergyAction={(action) => actionAllergy(selected, action)}
          allergyActionBusy={allergyBusy}
          allergyActionError={allergyError}
          onStatus={(r, to) => setStatus(r, to, () => setSelected(null))}
          onClose={() => {
            setSelected(null);
            setAssignError("");
            setDeepLinkPulse(false);
          }}
        />
      )}

      {/* R11 (B7): Bekræft on a group, and no table fits — said plainly, with
          what the host can do about it. Nothing changed on the server yet. */}
      {noFit && (
        <NoTableFitsSheet
          r={noFit.r}
          facts={noFit.facts}
          t={t}
          busy={noFitBusy}
          apptWords={apptWords}
          onPickTables={() => {
            const fresh = reservations.find((x) => x.id === noFit.r.id) || noFit.r;
            setNoFit(null);
            openOnTables(fresh);
          }}
          onMoveTo={(hhmm) => moveAndConfirm(noFit.r, hhmm)}
          onConfirmAnyway={() => {
            const r = noFit.r;
            setNoFit(null);
            setStatus(r, "confirmed", null, { ifNoTable: "confirm" });
          }}
          onClose={() => setNoFit(null)}
        />
      )}

      {/* Sheets render at <body>: inside the page they sat under the phone's
          bottom bar, and the sidebar stayed clickable behind them. */}
      {editRes && createPortal(
        <EditBookingSheet
          reservation={editRes}
          openHours={openHours}
          bookingRules={bookingRules}
          isProvider={isProvider && !holdsTable(editRes)}
          apptWords={apptWords}
          noAllergy={checkedInWords}
          t={t}
          busy={editBusy}
          error={editError}
          warning={editWarning}
          onClearWarning={() => setEditWarning(null)}
          onSubmit={submitEdit}
          onClose={() => { setEditRes(null); setEditWarning(null); }}
        />,
        document.body,
      )}

      {/* Seat-now sheet — opened by tapping a FREE tile on the Plan view, OR
          from the header "Seat walk-in" button (SEAT_WALK_IN_PICK sentinel →
          the sheet shows a table picker over the live free/busy list). */}
      {seatTarget && createPortal(
        <SeatNowSheet
          table={seatTarget}
          tables={walkInTables}
          t={t}
          busy={seating}
          onSeat={seatFromSheet}
          onClose={() => { setSeatTarget(null); setSeatParty(null); setSeatError(""); }}
          initialParty={seatParty}
          seatingFor={seatingFor}
          bookedWithin={bookedWithinFor}
          error={seatError}
          onWaitlist={waitlistFromSheet}
          apptWords={apptWords}
          roomUnknown={roomUnknown}
          onRetryRoom={() => fetchResources()}
        />,
        document.body,
      )}

      {/* New booking sheet — the host takes a future (phone) booking. For a
          provider (salon) venue this is a tidsbestilling: behandling →
          behandler → dato → tid. */}
      {newOpen && createPortal(
        <NewBookingSheet
          day={day}
          openHours={openHours}
          bookingRules={bookingRules}
          closures={publicPage?.closures || []}
          t={t}
          busy={creating}
          warning={roomFull}
          onClearWarning={() => setRoomFull(null)}
          error={createError}
          onSubmit={createBooking}
          isProvider={isProvider}
          apptWords={apptWords}
          noAllergy={checkedInWords}
          behandlinger={behandlinger}
          providerStations={providerStations}
          tables={assignableTables}
          onClose={() => {
            setNewOpen(false);
            setRoomFull(null);
            setCreateError("");
          }}
        />,
        document.body,
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

// The phone list's status: a dot and a word on the row's second line, with
// the pill's colour budget — amber pulse for a request, emerald for booked,
// the heaviest ink for seated, red only for a no-show, struck-through grey for
// a cancellation. No filled chip: repeated down a list, the seated pill's
// solid (white in dark) fill was the loudest thing on the screen.
const STATUS_INLINE = {
  requested: {
    dot: "bg-amber-500 dark:bg-amber-400 motion-safe:animate-pulse",
    text: "font-medium text-amber-700 dark:text-amber-300",
  },
  confirmed: { dot: "bg-sky-500 dark:bg-sky-400", text: "text-sky-700 dark:text-sky-400" },
  seated: { dot: "bg-emerald-600 dark:bg-emerald-400", text: "font-semibold text-emerald-700 dark:text-emerald-400" },
  completed: { dot: "bg-gray-400 dark:bg-gray-500", text: "text-gray-500 dark:text-gray-400" },
  no_show: { dot: "bg-red-500 dark:bg-red-400", text: "font-medium text-red-600 dark:text-red-400" },
  overdue: { dot: "bg-red-600 dark:bg-red-400", text: "font-semibold text-red-700 dark:text-red-400" },
  late: { dot: "bg-orange-500 dark:bg-orange-400", text: "font-medium text-orange-700 dark:text-orange-400" },
  cancelled: {
    dot: "bg-gray-300 dark:bg-gray-600",
    text: "text-gray-500 dark:text-gray-400 line-through decoration-gray-400 dark:decoration-gray-600",
  },
};

function StatusInline({ status, label }) {
  const s = STATUS_INLINE[status] || STATUS_INLINE.completed;
  return (
    <span className={"inline-flex items-center gap-1.5 min-w-0 " + s.text}>
      <span className={"w-1.5 h-1.5 rounded-full shrink-0 " + s.dot} aria-hidden="true" />
      <span className="truncate">{label}</span>
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
  const { user } = useAuth();
  // The week card's dates (R7) read in the owner's language.
  const { lang } = useLanguage();
  // Account venue archetype — drives the section's vocabulary (heading,
  // intro, empty state, icon) and the suggested zone-preset chips.
  const profile = venueProfile(businessType);
  const VenueIcon = profile.icon;
  // Provider (salon) venues author STYLIST STATIONS instead of tables: each
  // station is a `kind:"provider"` resource bound to a StaffMember, and its
  // availability comes 100% from that staff member's published shifts.
  const isProvider = bookingModeFor(businessType) === "provider";
  // A shop or a workshop that builds places (a fitting room, a bench, a
  // service bay): "Pladser", counted as people — never tables, guests or
  // parties (Push 8 review: its tab read "Borde", quick setup made "Bord 1").
  const placeWords = speaksAppointments(businessType) && !isProvider;
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

  // The list was READ (not just empty because the read failed) — "Det er mig"
  // is offered only then, so a dropped connection never mints a second chair.
  const [listRead, setListRead] = useState(false);
  const fetchResources = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/reservations/resources");
      setResources(Array.isArray(res.data?.resources) ? res.data.resources : []);
      setListRead(true);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          (placeWords
            ? t("rsvpFloorErrorAppt", "Couldn't load your spaces.")
            : t("rsvpFloorError", "Couldn't load your floor.")),
      );
    } finally {
      setLoading(false);
    }
  }, [t, placeWords]);

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

  // Who customers can book, per day (R7): re-read after every change here.
  const [capTick, setCapTick] = useState(0);
  const bumpCapacity = () => setCapTick((n) => n + 1);

  // People on the Vagtplan roster with no chair yet — the only ones the
  // "from Vagtplan" picker below still offers (R7).
  const rosterUnbound = useMemo(() => {
    const bound = new Set(
      resources.filter((r) => r.kind === "provider" && r.staff_id).map((r) => String(r.staff_id)),
    );
    return staffMembers.filter((s) => !bound.has(String(s.id)));
  }, [resources, staffMembers]);

  // A new stylist starts the way the salon already works: on shifts when a
  // stylist already works Vagtplan shifts, else on the opening hours (R7).
  const salonRunsShifts = resources.some(
    (r) => r.kind === "provider" && r.staff_id && !r.follows_opening_hours && r.is_active !== false,
  );

  // The Free plan's 3-staff lock, read BEFORE the owner types a name (the
  // server refuses the same count — GET /staff/members is that roster).
  // Tri-state on isReady, as Vagtplan's own panel: never a lock that flashes.
  const ent = useEntitlements();
  const atStaffCap =
    isProvider && ent?.isReady && typeof ent?.isAtCap === "function" &&
    ent.isAtCap("staff_members", staffMembers.length);
  const staffCap = atStaffCap
    ? {
        limit: typeof ent.cap === "function" ? ent.cap("staff_members") : null,
        upgradeTo: ent.plan === "free" ? "starter" : ent.plan === "starter" ? "pro" : null,
      }
    : null;

  // "Det er mig" — a solo stylist adds HERSELF as a behandler. Before, the only
  // way in was a staff member with published Vagtplan shifts, so a one-chair
  // salon could not add herself (vertical-fit audit, Oct 2026). This is the
  // owner "self-chair" the Aftaler first-run card makes: a provider row with
  // no staff member whose availability is the saved opening hours
  // (follows_opening_hours — no hours saved = no times, never invented).
  // Any self-chair, active or not — never a second one. A stylist added by
  // name may follow the opening hours too (R7); she has a staff member, so
  // she is not the owner's chair (isOwnChair).
  const selfChair = resources.find((r) => isOwnChair(r));
  const [selfSaving, setSelfSaving] = useState(false);
  // What customers call her — never the business name (R7: the guest page
  // listed "Salon Saks" beside "Mia"). Blank = "Indehaver".
  const [selfName, setSelfName] = useState("");
  const addSelfChair = async () => {
    setSelfSaving(true);
    setError("");
    setCapMsg(null);
    try {
      const res = await api.post("/reservations/resources", {
        kind: "provider",
        label: tidyName(selfName).slice(0, STYLIST_NAME_MAX) || t("rsvpSelfChairDefaultName", "Owner"),
        capacity_seats: 1,
        combinable: false,
        zone: null,
        follows_opening_hours: true,
      });
      // R9: the first chair can switch online booking on — say so.
      const { resource, activated } = takeActivation(res.data);
      setResources((prev) => [...prev, resource]);
      announceActivation(activated, "stylist");
      setSelfName("");
      bumpCapacity();
    } catch (e) {
      if (e?.response?.status === 402) {
        const d = e?.response?.data?.detail || e?.response?.data || {};
        setCapMsg({ cap: d.cap, current: d.current, limit: d.limit, plan: d.plan, upgrade_to: d.upgrade_to });
      } else {
        setError(e?.response?.data?.detail?.error || t("rsvpSelfChairError", "Couldn't add you. Try again."));
      }
    } finally {
      setSelfSaving(false);
    }
  };

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
      const { resource, activated } = takeActivation(res.data);
      setResources((prev) => [...prev, resource]);
      announceActivation(activated, "stylist");
      setStaffId("");
      setLabel("");
      bumpCapacity();
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
      setError(placeWords
        ? t("rsvpTableLabelRequiredAppt", "Give the space a name (e.g. Space 4).")
        : t("rsvpTableLabelRequired", "Give the table a name (e.g. Table 4)."));
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
      const { resource, activated } = takeActivation(res.data);
      setResources((prev) => [...prev, resource]);
      announceActivation(activated, placeWords ? "place" : "table");
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
            (placeWords
              ? t("rsvpTableAddErrorAppt", "Couldn't add the space.")
              : t("rsvpTableAddError", "Couldn't add the table.")),
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
        // A shop's places are numbered "Plads 1, 2 …"; a table venue keeps
        // the server's "Bord" (no prefix sent, as before).
        ...(placeWords ? { label_prefix: t("rsvpBulkPrefixAppt", "Space") } : {}),
      });
      const created = Array.isArray(res.data?.created) ? res.data.created : [];
      setResources((prev) => [...prev, ...created]);
      setBulkDone({
        created: res.data?.created_count ?? created.length,
        capped: res.data?.capped ?? 0,
      });
      setBulkRows((prev) => prev.map((r) => ({ ...r, count: "" })));
      // R9: quick setup's answer already said when it switched online
      // booking on; now the owner hears it.
      announceActivation(takeActivation(res.data).activated, placeWords ? "place" : "table");
      // Partial-cap → reuse the existing upgrade nudge (same payload shape).
      if (res.data?.cap_info) {
        const d = res.data.cap_info;
        setCapMsg({ cap: d.cap, current: d.current, limit: d.limit, plan: d.plan, upgrade_to: d.upgrade_to });
      }
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          (placeWords
            ? t("rsvpBulkErrorAppt", "Couldn't add the spaces.")
            : t("rsvpBulkError", "Couldn't add the tables.")),
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
    // "Remove this table?" read the same on every row on the floor. With Bord
    // 4 and Bord 5 stacked, the only thing between the owner and losing the
    // wrong one was remembering which trash icon their thumb had hit. The
    // dialog now says the name back in the row's own words — seats and zone
    // included — and what the row costs to remove.
    const label = (r.label || "").trim();
    const seats = r.capacity_seats ?? 0;
    const staffName = r.staff_name || staffNameById[String(r.staff_id)] || "";
    const title = label
      ? t("rsvpRemoveNamedTitle", "Remove {label}?", { label })
      : isProvider
        ? t("rsvpProviderDeleteConfirm", "Remove this station?")
        : placeWords
          ? t("rsvpTableDeleteConfirmAppt", "Remove this space?")
          : t("rsvpTableDeleteConfirm", "Remove this table?");
    // A stylist keeps her place on the Vagtplan roster (and her plan seat)
    // when her chair goes — say so, she was added here in one step (R7).
    const staysNote = isProvider && r.staff_id && staffName
      ? " " + t("rsvpStylistDeleteStays", "{name} stays on the staff list in the Schedule.", { name: staffName })
      : "";
    const message = isProvider
      ? (staffName && staffName !== label
        ? t(
            "rsvpProviderDeleteBodyStaff",
            "{staff} works this station. It leaves the floor and the timeline and takes no more appointments — putting it back means setting it up again.",
            { staff: staffName },
          )
        : t(
            "rsvpProviderDeleteBody",
            "The station leaves the floor and the timeline and takes no more appointments — putting it back means setting it up again.",
          )) + staysNote
      : placeWords
        ? r.zone
          ? t(
              "rsvpTableDeleteBodyZoneAppt",
              "Room for {seats}, in {zone}. The space leaves the overview and the timeline and takes no new appointments — putting it back means setting it up again.",
              { seats, zone: r.zone },
            )
          : t(
              "rsvpTableDeleteBodyAppt",
              "Room for {seats}. The space leaves the overview and the timeline and takes no new appointments — putting it back means setting it up again.",
              { seats },
            )
        : r.zone
        ? t(
            "rsvpTableDeleteBodyZone",
            "Room for {seats}, in {zone}. The table leaves the floor plan and the timeline and takes no new bookings — putting it back means setting it up again.",
            { seats, zone: r.zone },
          )
        : t(
            "rsvpTableDeleteBody",
            "Room for {seats}. The table leaves the floor plan and the timeline and takes no new bookings — putting it back means setting it up again.",
            { seats },
          );
    if (!(await confirm({ title, message, destructive: true }))) return;
    setResources((prev) => prev.filter((x) => x.id !== r.id));
    try {
      await api.delete(`/reservations/resources/${r.id}`);
    } catch {
      fetchResources();
    }
    if (isProvider) bumpCapacity();
  };

  // A stylist added by name (R7): her chair joins the list, and a new person
  // joins the roster this tab counts seats from.
  const onStylistAdded = (added) => {
    const row = added?.resource;
    if (row?.id) setResources((prev) => [...prev.filter((x) => x.id !== row.id), row]);
    if (added?.created_staff && added?.staff?.id) {
      setStaffMembers((prev) =>
        prev.some((s) => String(s.id) === String(added.staff.id)) ? prev : [...prev, added.staff],
      );
    }
    setError("");
    setCapMsg(null);
    bumpCapacity();
    // R9: the first stylist can switch online booking on — say so. R7's
    // route reports it as `activation` (takeActivation reads every shape).
    announceActivation(takeActivation(added).activated, "stylist");
  };

  // A chair renamed or switched (R7): the row, and a renamed stylist's name
  // on the roster, so every row and the picker below say the same name.
  const onStylistSaved = (row) => {
    if (!row?.id) return;
    setResources((prev) => prev.map((x) => (x.id === row.id ? { ...x, ...row } : x)));
    if (row.staff_id && row.staff_name) {
      setStaffMembers((prev) =>
        prev.map((s) => (String(s.id) === String(row.staff_id) ? { ...s, name: row.staff_name } : s)),
      );
    }
    bumpCapacity();
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
              "rsvpStylistsIntro",
              "Add the people customers book. Each one can be booked whenever the salon is open, or on their shifts in the Schedule.",
            )}
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {placeWords
            ? t("rsvpFloorIntroAppt", "Add the spaces your customers can be booked into. The number of people a space takes decides how many one time can take.")
            : t(
              profile.floorIntroKey,
              "Add the tables guests can be seated at. Capacity drives which party sizes a slot can take.",
            )}
        </p>
      )}

      {/* Provider venue with leftover tables — offer a one-click clear so the
          owner can switch fully to the stylist view. Dismissible; never touches
          provider stations. */}
      {isProvider && leftoverTables.length > 0 && !tablesNoticeDismissed && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-gray-800 dark:text-gray-100">
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
            className="shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* "Det er mig" — the owner as behandler, offered until she is one. */}
      {isProvider && !loading && listRead && !selfChair && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!selfSaving) addSelfChair();
          }}
          className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 max-sm:p-3 space-y-3"
          data-testid="self-chair-card"
        >
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
              {t("rsvpSelfChairTitle", "Do you take customers yourself?")}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t("rsvpSelfChairBody", "Add yourself as a stylist. Your times follow the opening hours under Settings — no rota needed.")}
            </p>
          </div>
          {/* Her name, as customers will read it in "Vælg behandler" — the
              chair used to take the business name (R7). */}
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="self-chair-name" className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">
                {t("rsvpSelfChairNameLabel", "Your name (customers see it)")}
              </label>
              <input
                id="self-chair-name"
                type="text"
                value={selfName}
                onChange={(e) => setSelfName(e.target.value)}
                placeholder={t("rsvpSelfChairNamePh", "e.g. Anna")}
                maxLength={STYLIST_NAME_MAX}
                autoComplete="given-name"
                className="w-full h-11 max-sm:h-10 max-sm:min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              busy={selfSaving}
              iconLeft={<Check className="w-4 h-4" />}
              className="justify-center max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]"
            >
              {t("rsvpSelfChairCta", "That's me")}
            </Button>
          </div>
        </form>
      )}

      {/* A stylist by name (R7): the staff member and her chair in one step,
          booked on the opening hours or on her shifts. */}
      {isProvider && (
        <StylistAddCard
          t={t}
          defaultFollows={!salonRunsShifts}
          staffCap={staffCap}
          onAdded={onStylistAdded}
        />
      )}

      {/* Someone already on the Vagtplan roster, with no chair yet: the
          picker + optional station name, booked on her published shifts.
          Shown only while there is such a person. */}
      {isProvider && rosterUnbound.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) addProviderStation();
          }}
          data-testid="stylist-from-roster"
          className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 max-sm:p-3 space-y-3"
        >
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpStylistFromRoster", "Or pick someone from the Schedule")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              aria-label={t("rsvpProviderPickStaff", "Choose a stylist")}
              className="h-11 max-sm:h-10 max-sm:min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            >
              <option value="">{t("rsvpProviderPickStaff", "Choose a stylist")}</option>
              {rosterUnbound.map((s) => (
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
              className="h-11 max-sm:h-10 max-sm:min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            />
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {t(
              "rsvpProviderShiftHint",
              "A stylist is bookable only during their published shifts. Add shifts on the Schedule page.",
            )}
          </p>
          <div className="flex sm:justify-end">
            <Button type="submit" variant="secondary" size="lg" busy={saving} iconLeft={<Plus className="w-4 h-4" />}
              className="max-sm:w-full max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px] justify-center">
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
        className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
      >
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpBulkTitle", "Quick setup")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {placeWords
              ? t("rsvpBulkHintAppt", "How many spaces, and for how many people each? They're created and numbered for you.")
              : t("rsvpBulkHint", "How many tables of each size? They're created and numbered for you.")}
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
                  placeholder={placeWords ? t("rsvpTableSeatsPhAppt", "People") : t("rsvpBulkSeatsPh", "Seats")}
                  aria-label={placeWords ? t("rsvpBulkSeatsAriaAppt", "People per space") : t("rsvpBulkSeatsAria", "Seats per table")}
                  className="w-full h-11 pl-3 pr-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
                  {placeWords ? t("rsvpPeopleUnitAppt", "people") : t("rsvpSeatsShort", "pax")}
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
                  className="h-11 w-14 text-center border-x border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100"
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
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
          <label className="flex items-center gap-2.5 cursor-pointer select-none px-1">
            <input
              type="checkbox"
              checked={bulkCombinable}
              onChange={(e) => setBulkCombinable(e.target.checked)}
              className="w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {t("rsvpCombinable", "Can be combined")}
            </span>
          </label>
        </div>
        <ZonePresetChips profile={profile} t={t} value={bulkZone} onPick={setBulkZone} />

        {bulkDone && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {placeWords
              ? bulkDone.created === 1
                ? t("rsvpBulkDoneOneAppt", "Added 1 space.")
                : t("rsvpBulkDoneAppt", "Added {n} spaces.", { n: bulkDone.created })
              : t("rsvpBulkDone", "Added {n} tables.", { n: bulkDone.created })}
            {bulkDone.capped > 0 &&
              " " + t("rsvpBulkCapped", "{n} more need a plan upgrade.", { n: bulkDone.capped })}
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {bulkTotal > 0
              ? placeWords
                ? bulkTotal === 1
                  ? t("rsvpBulkTotalOneAppt", "Adding 1 space")
                  : t("rsvpBulkTotalAppt", "Adding {n} spaces", { n: bulkTotal })
                : t("rsvpBulkTotal", "Adding {n} tables", { n: bulkTotal })
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
            {placeWords ? t("rsvpBulkSubmitAppt", "Add spaces") : t("rsvpBulkSubmit", "Add tables")}
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
        className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
      >
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {placeWords ? t("rsvpAddTableAppt", "Add a space") : t("rsvpAddTable", "Add a table")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={placeWords ? t("rsvpTableLabelPhAppt", "Name (e.g. Space 4)") : t("rsvpTableLabelPh", "Name (e.g. Table 4)")}
            maxLength={120}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              value={seats}
              onChange={(e) => setSeats(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              placeholder={placeWords ? t("rsvpTableSeatsPhAppt", "People") : t("rsvpTableSeatsPh", "Seats")}
              className="w-full h-11 pl-3 pr-12 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              {/* A shop's place holds people, not seats (en: "seats" was
                  QA's last English restaurant word on its Spaces tab). */}
              {placeWords ? t("rsvpPeopleUnitAppt", "people") : t("rsvpSeats", "seats")}
            </span>
          </div>
          <input
            type="text"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder={t("rsvpTableZonePh", "Zone (optional)")}
            maxLength={60}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
        </div>
        <ZonePresetChips profile={profile} t={t} value={zone} onPick={setZone} />
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={combinable}
            onChange={(e) => setCombinable(e.target.checked)}
            className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
            {t("rsvpCombinable", "Can be combined")}
            <span className="block text-xs text-gray-400 dark:text-gray-500">
              {placeWords
                ? t("rsvpCombinableHintAppt", "Use together with other combinable spaces in the same zone for more people at once.")
                : t(
                  "rsvpCombinableHint",
                  "Push together with other combinable tables in the same zone to seat a bigger party.",
                )}
            </span>
          </span>
        </label>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="lg" busy={saving} iconLeft={<Plus className="w-4 h-4" />}>
            {placeWords ? t("rsvpAddTableBtnAppt", "Add space") : t("rsvpAddTableBtn", "Add table")}
          </Button>
        </div>
      </form>
      </>
      )}

      {/* Cap-exceeded message + upgrade nudge */}
      {capMsg && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] p-4 space-y-3">
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
            benefit={placeWords ? t("rsvpTableCapBenefitAppt", "Unlimited spaces") : t("rsvpTableCapBenefit", "Unlimited tables")}
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
        <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] py-10 text-center">
          <VenueIcon className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {isProvider
              ? t("rsvpProvidersEmpty", "No stylists yet — add one to take appointments.")
              : t(profile.floorEmptyKey, "No tables yet — add your first above.")}
          </p>
        </div>
      ) : isProvider ? (
        // One row per chair (R7): the name customers see, how she is booked
        // (the opening hours, or her shifts), rename and switch in place.
        <ul className="space-y-2">
          {resources
            .filter((r) => r.kind === "provider")
            .map((r) => (
              <StylistRow
                key={r.id}
                r={r}
                t={t}
                staffName={r.staff_name || staffNameById[String(r.staff_id)] || ""}
                businessName={user?.business_name || ""}
                onSaved={onStylistSaved}
                onRemove={removeResource}
              />
            ))}
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
              className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] px-4 py-3 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3"
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
                  title={placeWords
                    ? t("rsvpCombinableToggleTitleAppt", "Combine with other combinable spaces in the same zone when more people come at once")
                    : t(
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
                    aria-label={placeWords
                      ? t("rsvpTableSeatsAriaAppt", "People at {label}", { label: r.label })
                      : t("rsvpTableSeatsAria", "Seats at {label}", { label: r.label })}
                    className="w-full h-11 pl-3 pr-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
                    {placeWords ? t("rsvpPeopleUnitAppt", "people") : t("rsvpSeatsShort", "pax")}
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

      {/* Who customers can book, the next 7 days (R7, rubric S5). */}
      {isProvider && !loading && <SalonWeekCapacity t={t} lang={lang} refreshKey={capTick} />}
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
          t("rsvpBehandlingError", "Couldn't load your services."),
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
      setError(t("rsvpBehandlingNameRequired", "Give the service a name."));
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
            t("rsvpBehandlingAddError", "Couldn't add the service."),
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
    // "Remove this behandling?" was true of every line in the katalog, so the
    // wrong trash icon looked exactly like the right one. The dialog now
    // repeats the behandling back with the same varighed and pris the row
    // shows, and says out loud that this one does not come back.
    const name = (b.name || "").trim();
    const ok = await confirm({
      title: name
        ? t("rsvpRemoveNamedTitle", "Remove {label}?", { label: name })
        : t("rsvpBehandlingDeleteConfirm", "Remove this service?"),
      message:
        b.price_kr != null
          ? t(
              "rsvpBehandlingDeleteBodyPrice",
              // No full stop straight after the amount: formatKr already ends
              // in one ("450 kr."), and the sentence would render "kr..".
              "{duration} min, {price} — gone for good. Guests cannot book it any more; appointments already in the book keep the name.",
              { duration: b.duration_min, price: formatKr(b.price_kr, { decimals: 0 }) },
            )
          : t(
              "rsvpBehandlingDeleteBody",
              "{duration} min — gone for good. Guests cannot book it any more; appointments already in the book keep the name.",
              { duration: b.duration_min },
            ),
      destructive: true,
    });
    if (!ok) return;
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
          {t("rsvpBehandlingerTitle", "Services")}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t(
            "rsvpBehandlingerIntro",
            "List the services you offer with a duration and an optional price. The duration sets the booking length when a customer books this service; the price is display-only and never charges.",
          )}
        </p>
      </div>

      {/* Add behandling — a real <form> so Enter submits from any field. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving) addItem();
        }}
        className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
      >
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {t("rsvpBehandlingAddTitle", "Add a service")}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("rsvpBehandlingNamePh", "Name (e.g. Klip dame)")}
            maxLength={120}
            aria-label={t("rsvpBehandlingNameLabel", "Service name")}
            className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              value={duration}
              onChange={(e) => setDuration(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              placeholder={t("rsvpBehandlingDurationLabel", "Duration")}
              aria-label={t("rsvpBehandlingDurationLabel", "Duration")}
              className="w-full h-11 pl-3 pr-12 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
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
              className="w-full h-11 pl-3 pr-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              kr.
            </span>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="lg" busy={saving} iconLeft={<Plus className="w-4 h-4" />}>
            {t("rsvpBehandlingAddBtn", "Add service")}
          </Button>
        </div>
      </form>

      {/* Cap-exceeded message + upgrade nudge — same shape as FloorSection. */}
      {capMsg && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] p-4 space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t(
              "rsvpBehandlingCapHit",
              "You've reached your plan's service limit ({limit}). Upgrade to add more.",
              { limit: capMsg.limit ?? capMsg.current ?? "" },
            )}
          </p>
          <UpgradeNudge
            intent="inline"
            tier={capMsg.upgrade_to === "pro" ? "pro" : "starter"}
            benefit={t("rsvpBehandlingCapBenefit", "More services")}
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
        <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] py-10 text-center">
          <Clock className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("rsvpBehandlingEmpty", "No services yet — add your first above.")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {/* Each row edits in place (R6): Rediger → name, length, price → Gem. */}
          {items.map((b) => (
            <BehandlingRow
              key={b.id}
              b={b}
              t={t}
              onToggle={toggleActive}
              onRemove={removeItem}
              onSaved={(next) => setItems((prev) => prev.map((x) => (x.id === next.id ? { ...x, ...next } : x)))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Settings + share ─────────────────────────────────────────────────
// onlineNotReady (Push 7): the venue has nothing the availability engine can
// book — a shop or a workshop with no table and no behandler (see the parent).
// Online booking is then not offered as working, and nothing says "live".

// The public page books one person on a shop or a workshop, so its request
// rule is on or off: on when the stored threshold is set and at most 1 —
// the server's is_group_request(settings, 1).
function requestsEveryOnline(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n !== 0 && n <= 1;
}

// R9: which cards take a settings answer (SettingsSection.applyData's
// `parts`) — all three on a load, only the saved one after a save.
const ALL_SETTINGS_PARTS = ["form", "hours", "sms"];
const NO_SETTINGS_PARTS = [];
// The rules card as one comparable string — every value as text (a loaded
// 60 and a typed "60" are the same) and the table-time bands — so the card
// knows when it holds changes that are not saved.
function formSnapshot(form, tierDraft) {
  const vals = Object.fromEntries(
    Object.entries(form || {}).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v ?? "")]),
  );
  return JSON.stringify({ vals, tiers: (tierDraft || []).map((tr) => [tr.up_to, String(tr.minutes ?? "")]) });
}

function SettingsSection({ t, user = null, tablePlan = null, onlineNotReady = false }) {
  // SettingsSection only mounts after the parent's `if (!isReady) return null`
  // gate, so entitlements are already settled here — reading hasFeature is
  // flicker-safe (tier-flicker doctrine, useEntitlements.jsx).
  const { hasFeature } = useEntitlements();
  const { lang } = useLanguage();
  // A salon (provider mode) books one customer into a behandler's time: the
  // table rules — table time per party size, max party, group request,
  // covers per slot, combining tables, guests picking a table — do not exist
  // for it and are not shown (vertical-fit audit, Oct 2026). Their stored
  // values are untouched and still saved as loaded.
  const isProvider = bookingModeFor(user?.business_type) === "provider";
  // The words (vertical-fit review, Oct 2026): a salon, a shop and a repair
  // trade book a customer for a time — the provider wording below is theirs.
  const apptWords = speaksAppointments(user?.business_type);
  // The table rules (time per party size, max party, group request, covers per
  // slot, combining, guests picking a table) exist only where there is a
  // table plan: a table venue, or a shop that already built tables. A salon
  // never has them; a shop or a workshop without tables neither. Stored
  // values are untouched and saved as loaded either way.
  const tableRules = !isProvider && (tablePlan ?? usesTableFloor(user?.business_type));
  // A shop or a workshop: its public page books one person, always
  // (ReservationPublicPage: speaksAppointments → party 1, no picker).
  const onlineBooksOne = apptWords && !isProvider;
  // The request rule as loaded. On a one-person page the number can only do
  // one thing: at 1, EVERY online booking is a request the owner approves
  // (reservation_service.is_group_request: threshold and 1 >= threshold).
  // Base offered that number to a shop with tables, and a stored 1 still
  // applies — so the shop keeps a switch for it (Push 8 review, round 5).
  const [loadedRequestFrom, setLoadedRequestFrom] = useState("");
  // A shop without tables never had the number; it gets the switch only to
  // see and undo a stored 1 — and keeps it for the visit once shown, so it
  // does not vanish the moment the owner saves it off.
  const [requestSwitchSeen, setRequestSwitchSeen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingToggle, setSavingToggle] = useState(false);

  // The link (slug) editor lives in BookingLinkCard (R9): the real address,
  // the warning before a change, the old links that still work.

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
  // The per-party-size table times, and the booking length as loaded. Saving
  // ANY setting used to resend the prefilled length and wipe the tiers.
  const [tiers, setTiers] = useState([]);
  // The editable copy: one minutes field per party-size band.
  const [tierDraft, setTierDraft] = useState([]);
  const loadedDurationRef = useRef("");
  // Opening / booking hours, per weekday. Owner-settable so slots come from
  // when they actually open — not a hard-coded default.
  const [hours, setHours] = useState(() => (isProvider ? defaultSalonHours() : defaultBookingHours()));
  // applyData is a stable callback; it reads the venue mode from here.
  const isProviderRef = useRef(isProvider);
  useEffect(() => {
    isProviderRef.current = isProvider;
  }, [isProvider]);
  const [savingHours, setSavingHours] = useState(false);
  const [hoursSaved, setHoursSaved] = useState(false);
  // R8: the hours card's own words when a save cannot happen ("Tirsdag: de
  // to perioder overlapper …"), and the weekday they are about — said on
  // the card, not at the top of a long page.
  const [hoursError, setHoursError] = useState("");
  const [hoursProblemDay, setHoursProblemDay] = useState(null);
  // Starttider for a table venue (R8, rubric R9): 15 / 30 / 60, saved with
  // the hours card's Gem. The same key a salon picks on its rhythm card.
  const [stepDraft, setStepDraft] = useState(15);
  // E-mails to the owner about online bookings (R1 D6): on unless switched off.
  const [savingOwnerEmails, setSavingOwnerEmails] = useState(false);
  // One save per card (R9): what each card held when it was last loaded or
  // saved, so the card can say "Ikke gemt endnu" — and so a save of one
  // card never puts another card's unsaved changes back.
  const [formBase, setFormBase] = useState("");
  const [hoursBase, setHoursBase] = useState("");

  // `parts`: which cards take the server's answer — every card on a load;
  // only the saved card after a save (R9). A switch or a link change takes
  // none: every card keeps what the owner is typing.
  const applyData = useCallback((d, parts = ALL_SETTINGS_PARTS) => {
    setData(d);
    const s = d?.settings || {};
    if (parts.includes("form")) {
      const loadedTiers = (Array.isArray(s.turn_time_tiers) ? s.turn_time_tiers : [])
        .filter((tr) => tr?.up_to && tr?.minutes)
        .sort((a, b) => a.up_to - b.up_to);
      setTiers(loadedTiers);
      setTierDraft(loadedTiers.map((tr) => ({ up_to: tr.up_to, minutes: String(tr.minutes) })));
      // Bigger parties are held at least as long as the last band — the field
      // said 90 for a size actually held 120. Show what applies.
      const lastTier = loadedTiers.length ? Number(loadedTiers[loadedTiers.length - 1].minutes) : 0;
      const effDefault =
        s.default_duration_min != null && lastTier
          ? Math.max(Number(s.default_duration_min) || 0, lastTier)
          : s.default_duration_min;
      loadedDurationRef.current = effDefault ?? "";
      setLoadedRequestFrom(s.group_request_threshold ?? "");
      if (requestsEveryOnline(s.group_request_threshold)) setRequestSwitchSeen(true);
      const nextForm = {
        max_party_size: s.max_party_size ?? "",
        group_request_threshold: s.group_request_threshold ?? "",
        lead_time_min: s.lead_time_min ?? "",
        max_advance_days: s.max_advance_days ?? "",
        pacing_max_per_slot: s.pacing_max_per_slot ?? "",
        default_duration_min: effDefault ?? "",
        // combine_enabled defaults on (matches the backend); only flips off if
        // the owner explicitly disabled combining.
        combine_enabled: s.combine_enabled !== false,
        guest_can_pick_table: !!s.guest_can_pick_table,
        max_combo_size: s.max_combo_size ?? "",
        contact_phone: s.contact_phone ?? "",
      };
      setForm(nextForm);
      setFormBase(formSnapshot(nextForm, loadedTiers.map((tr) => ({ up_to: tr.up_to, minutes: String(tr.minutes) }))));
    }
    if (parts.includes("sms")) {
      setSms({
        enabled: !!s.sms_reminders,
        sender: s.sms_sender ?? "",
      });
    }
    if (parts.includes("hours")) {
      const nextHours = cardBookingHours(s.booking_hours, {
        openHours: d?.open_hours,
        hoursDeclared: d?.hours_declared,
        isProvider: isProviderRef.current,
      });
      setHours(nextHours);
      // The week as loaded, serialized as R8 saves it (periods, and a last
      // booking time on a table venue) — anything else on the card is
      // unsaved. Starttider are saved with this card's Gem (R8), so they
      // are this card's too.
      setHoursBase(JSON.stringify(
        serializeBookingHours(nextHours, { withLast: !isProviderRef.current })));
      setStepDraft(slotStepOf(s));
      setHoursError("");
      setHoursProblemDay(null);
    }
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

  // A re-read that keeps the page on screen (R9): the name row's save used
  // the full load, which blanked Indstillinger to "Loading…" and remounted
  // every card — a half-typed closed date or blocked number was lost.
  const refreshSettings = useCallback(async (parts = NO_SETTINGS_PARTS) => {
    try {
      const res = await api.get("/reservations/settings");
      if (res?.data) applyData(res.data, parts);
    } catch { /* the page keeps what it shows */ }
  }, [applyData]);

  const toggleEnabled = async () => {
    if (!data) return;
    const next = !data.reservations_enabled;
    setSavingToggle(true);
    setError("");
    try {
      const res = await api.put("/reservations/settings", {
        reservations_enabled: next,
      });
      applyData(res.data || null, NO_SETTINGS_PARTS);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpToggleError", "Couldn't update."),
      );
    } finally {
      setSavingToggle(false);
    }
  };

  // A changed link (BookingLinkCard, R9): only the link and its old links
  // change; every card keeps what the owner is typing.
  const onLinkSaved = (ans) =>
    setData((prev) => (prev ? { ...prev, ...ans } : prev));

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
    // Table times — per party-size band when the venue has bands, plus the
    // time for bigger parties (or for every party when it has none). Each is
    // sent only when it changed, and neither ever wipes the other: one new
    // number used to clear all the bands. Clamped 15–360 min.
    const clamp = (v) => Math.max(15, Math.min(360, v));
    const nextTiers = tierDraft
      .filter((tr) => toInt(tr.minutes) !== undefined)
      .map((tr) => ({ up_to: tr.up_to, minutes: clamp(toInt(tr.minutes)) }));
    if (JSON.stringify(nextTiers) !== JSON.stringify(tiers.map((tr) => ({ up_to: tr.up_to, minutes: Number(tr.minutes) })))) {
      settings.turn_time_tiers = nextTiers;
    }
    if (toInt(form.default_duration_min) !== undefined
        && String(form.default_duration_min) !== String(loadedDurationRef.current ?? "")) {
      settings.default_duration_min = clamp(toInt(form.default_duration_min));
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
      applyData(res.data || null, ["form"]);
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
      applyData(res.data || null, ["sms"]);
      setSmsSaved(true);
      setTimeout(() => setSmsSaved(false), 2500);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpSettingsSaveError", "Couldn't save settings."),
      );
      // Re-sync from server on failure so the toggle reflects truth — the
      // SMS card only; the others keep what is typed (R9).
      refreshSettings(["sms"]);
    } finally {
      setSavingSms(false);
    }
  };

  // The owner's e-mails about new online bookings and cancellations (R1 D6).
  // Saved on the tap, through the same settings PUT.
  const toggleOwnerEmails = async () => {
    if (!data || savingOwnerEmails) return;
    const next = data?.settings?.owner_booking_emails === false;
    setSavingOwnerEmails(true);
    setError("");
    try {
      const res = await api.put("/reservations/settings", { settings: { owner_booking_emails: next } });
      applyData(res.data || null, NO_SETTINGS_PARTS);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.error ||
          t("rsvpSettingsSaveError", "Couldn't save settings."),
      );
    } finally {
      setSavingOwnerEmails(false);
    }
  };
  // Closed dates and pauses come back from their own endpoints as the fresh
  // list; the rest of the settings are untouched.
  const setClosures = (closures) =>
    setData((d) => (d ? { ...d, closures: Array.isArray(closures) ? closures : [] } : d));
  // The pause covering today, if any — the online card says so.
  const pausedNow = activePause(data?.closures);

  // Toggle flips state + persists in one go (optimistic, like the
  // accept-online switch). Disabled entirely when the tier lacks the feature.
  const toggleSms = () => {
    const next = { ...sms, enabled: !sms.enabled };
    setSms(next);
    saveSms(next);
  };

  // Patch one weekday's hours (open/close time or closed flag).
  // Any change on the card clears its last "can't save" words.
  const clearHoursProblem = () => {
    setHoursError("");
    setHoursProblemDay(null);
  };
  const setHourDay = (key, patch) => {
    clearHoursProblem();
    setHours((h) => ({ ...h, [key]: { ...h[key], ...patch } }));
  };

  // Convenience: copy Monday's row to every day (the common "same every day"
  // case — set once, fan out). Its periods and last booking times too (R8).
  const applyMonToAll = () => {
    clearHoursProblem();
    setHours((h) => {
      const mon = h.mon;
      const next = {};
      DAY_KEYS.forEach((k) => {
        next[k] = { ...mon };
      });
      return next;
    });
  };

  // Starttider (R8): a chosen last booking time follows the new grid.
  const pickStep = (n) => {
    clearHoursProblem();
    setStepDraft(n);
    setHours((h) => snapLasts(h, n));
  };

  // What the server reads (R8): two periods a day and a last booking time.
  // An older server is never sent a shape it cannot read: the card then
  // offers neither (a stored second period is still shown).
  const hoursV2 = Number(data?.hours_shape) >= HOURS_SHAPE;
  // The last booking time binds the table engine only; a salon's chair ends
  // its service by closing, so a salon's card neither shows nor sends one.
  const lastOn = hoursV2 && !isProvider;
  const storedStep = slotStepOf(data?.settings);
  const stepChanged = !isProvider && stepDraft !== storedStep;
  // One save per card (R9): the hours card holds unsaved changes when its
  // week (two periods and last booking times, R8) or its Starttider differ
  // from what it last loaded or saved — CardSaveBar says so beside its Gem.
  const hoursDirty = !!hoursBase && (
    JSON.stringify(serializeBookingHours(hours, { withLast: !isProvider })) !== hoursBase
    || stepChanged
  );

  // Persist booking hours through the SAME PUT /reservations/settings path —
  // serialized to the {mon: "HH:MM-HH:MM" | "closed" | [periods], …} dict the
  // availability engine reads (reservation_service.day_periods), with the
  // start-time step when it changed. Checked first, the server's own rules
  // (utils/bookingHours.hoursProblem); a 422 bad_hours says the same words.
  const saveHours = async () => {
    const problem = hoursProblem(hours, { withLast: !isProvider });
    if (problem) {
      setHoursProblemDay(problem.day);
      setHoursError(hoursProblemWords(problem, t, lang));
      setHoursSaved(false);
      return;
    }
    setSavingHours(true);
    setHoursSaved(false);
    clearHoursProblem();
    setError("");
    try {
      const settings = { booking_hours: serializeBookingHours(hours, { withLast: !isProvider }) };
      if (stepChanged) settings.slot_granularity_min = stepDraft;
      const res = await api.put("/reservations/settings", { settings, hours_shape: HOURS_SHAPE });
      // Only the hours card takes the answer (R9): every other card keeps
      // what the owner is typing.
      applyData(res.data || null, ["hours"]);
      setHoursSaved(true);
      setTimeout(() => setHoursSaved(false), 2500);
    } catch (e) {
      const detail = e?.response?.data?.detail;
      if (detail?.error === "bad_hours") {
        setHoursProblemDay(detail.day || null);
        setHoursError(hoursProblemWords(detail, t, lang));
      } else {
        setHoursError(t("rsvpHoursSaveError", "Couldn't save opening hours."));
      }
    } finally {
      setSavingHours(false);
    }
  };

  const smsUnlocked = hasFeature("sms_reminders");

  // ?show=website (the page header's "Sæt på hjemmeside" link) lands on the
  // website card, not the top of a long settings page: scroll it into view,
  // move focus to its heading, then drop the param so a later re-render or
  // back-navigation does not yank the page there again.
  const location = useLocation();
  const navigate = useNavigate();
  // R9: ?show=hours (the Profile hours' note) lands on the hours card the
  // same way.
  const showParam = new URLSearchParams(location.search).get("show");
  const showTarget = { website: ["website", "website-title"], hours: ["rsvp-hours", "rsvp-hours-title"] }[showParam] || null;
  useEffect(() => {
    if (loading || !showTarget) return;
    const el = document.getElementById(showTarget[0]);
    if (el) {
      el.scrollIntoView?.({ block: "start", behavior: "smooth" });
      document.getElementById(showTarget[1])?.focus?.({ preventScroll: true });
    }
    const params = new URLSearchParams(location.search);
    params.delete("show");
    const qs = params.toString();
    navigate({ search: qs ? `?${qs}` : "" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, showParam, location.search, navigate]);

  if (loading) {
    return <div className="text-sm text-gray-600 dark:text-gray-500">{t("loading", "Loading…")}</div>;
  }

  const enabled = !!data?.reservations_enabled;
  const publicUrl = data?.public_url || "";
  // Switched on AND there is something to book. A page that is on with
  // nothing the engine can book is not live: no "Din bookingside", and the
  // website kit explains itself instead of handing out the link (Push 7).
  const live = enabled && !onlineNotReady;
  // R9: a card holding changes that are not saved says so beside its Gem.
  const formDirty = !!formBase && formSnapshot(form, tierDraft) !== formBase;
  // hoursDirty: above, beside the hours card's save (R8's rule, R9's base).
  // Where the online times come from (the hours card's line): this card,
  // the Profile hours, both, or — a salon — the chairs read this card only.
  const hoursFrom = hoursSource({
    bookingHours: data?.settings?.booking_hours,
    hoursDeclared: data?.hours_declared,
    isProvider,
  });
  // "Maks. gæster pr. tid" counts guests (R9): the party sizes it leaves
  // with no online time, said under the field.
  const paceGap = tableRules
    ? pacingGap({
        pacing: form.pacing_max_per_slot,
        maxParty: onlineBooksOne ? 1 : form.max_party_size === "" ? 10 : form.max_party_size,
        requestFrom: form.group_request_threshold,
      })
    : null;
  // The day the first table switched online booking on by itself (R9),
  // until the owner flips the switch.
  const autoOnDay = enabled && data?.auto_enabled_at ? data.auto_enabled_at : null;
  // R9: the phone's jump row — the cards a first-week owner looks for.
  const jumpItems = [
    // The link card when the page is live (the address and its old links),
    // else the kit, which says what to switch on first.
    { id: live && publicUrl ? "rsvp-link" : "website", label: t("rsvpJumpLink", "Link & QR") },
    { id: "rsvp-hours", label: t("rsvpJumpHours", "Hours") },
    { id: "rsvp-closures", label: t("rsvpJumpClosures", "Closed dates") },
    { id: "rsvp-rules", label: t("rsvpJumpRules", "Rules") },
    { id: "rsvp-messages", label: t("rsvpJumpMessages", "Messages") },
    { id: "rsvp-devices", label: t("rsvpJumpDevices", "Devices") },
  ];

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* R9: the phone's way through a long page (desktop unchanged). */}
      <SettingsJumpRow t={t} items={jumpItems} />

      {/* The name on the booking page — before the page is live too (R1 C). */}
      <BookingNameRow
        t={t}
        // An older server sends no public_name (the frontend ships first):
        // the trading name it does send is the page's name then — never a
        // false "no name yet".
        publicName={data && "public_name" in data ? data.public_name || null : data?.business_name || null}
        tradingName={data?.business_name || ""}
        // A quiet re-read (R9): the full load blanked the page and every
        // card's half-typed input with it.
        onSaved={() => refreshSettings()}
        apptWords={apptWords}
      />

      {/* The page's logo, next to its name (booking R13): the same logo the
          booking page shows, or its monogram; the logo is changed in Profil. */}
      <BookingLogoRow
        t={t}
        publicName={data && "public_name" in data ? data.public_name || null : data?.business_name || null}
      />

      {/* The page's colour, right under its name (booking R5). */}
      <BookingAccentRow t={t} />

      {/* Guests may join the waitlist on a full night (booking R12) — table
          venues, and only when the server knows the setting. */}
      {!apptWords && tableRules && data?.settings && "public_waitlist" in data.settings && (
        <PublicWaitlistSwitch t={t} settings={data.settings} />
      )}

      {/* On/off toggle (+ the pause, while the page is live) */}
      <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {apptWords
              ? t("rsvpAcceptToggleProvider", "Accept online appointments")
              : t("rsvpAcceptToggle", "Accept online reservations")}
          </h2>
          {onlineNotReady ? (
            // Push 7 — nothing here the engine can book: the public page
            // would show every day closed. Not offered as working, never
            // "live". Still switched on (an earlier tap): say plainly that
            // customers can't book yet, and keep the switch to turn it off.
            // Modelled on the salon's "Kunderne kan ikke booke endnu".
            <div role="status" data-testid="rsvp-online-not-ready" className="mt-0.5 space-y-1 text-xs text-gray-600 dark:text-gray-300">
              {enabled && (
                <p className="font-medium text-gray-800 dark:text-gray-100">
                  {t("rsvpOnlineNotReadyOn", "Customers can't book yet, even though the page is switched on — turn it off here.")}
                </p>
              )}
              <p>
                {apptWords
                  ? t("rsvpOnlineNotReadyProvider", "Online booking isn't ready for shops and workshops yet — you can still add appointments to the book here.")
                  : t("rsvpOnlineNotReady", "Online reservations aren't ready for your type of business yet — you can still add bookings to the book here.")}
              </p>
            </div>
          ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5" data-testid="rsvp-accept-sub">
            {enabled
              ? (data?.hours_declared === false
                  // Live, but with no saved hours the page offers no times at
                  // all — "taking bookings" would be a promise it can't keep.
                  ? (apptWords
                    ? t("rsvpAcceptOnNoHoursProvider", "Your page is live, but customers can't book until you save opening hours below.")
                    : t("rsvpAcceptOnNoHours", "Your page is live, but guests can't book until you save opening hours below."))
                  // Paused (R1 B6): live, but taking no online bookings —
                  // "taking bookings" sat right above the amber pause line.
                  : pausedNow
                  ? ((pausedNow.to || pausedNow.from) === todayIso()
                    ? t("rsvpAcceptOnPausedToday", "Your page is live, but online booking is paused for the rest of today.")
                    : t("rsvpAcceptOnPaused", "Your page is live, but online booking is paused until and including {date}.", {
                        date: fmtClosureRange(pausedNow.to || pausedNow.from, null, lang),
                      }))
                  : t("rsvpAcceptOn", "Your public page is live and taking bookings."))
              : t("rsvpAcceptOff", "Turn on to publish your booking page.")}
          </p>
          )}
          {/* R9: it went on by itself, when the first table (behandler,
              place) was added — said until the owner flips the switch. */}
          {autoOnDay && !onlineNotReady && (
            <p data-testid="rsvp-auto-on" className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              {(isProvider
                ? t("rsvpAutoOnStylist", "Switched on by itself on {date}, when you added your first stylist. Not ready? Turn it off here.", { date: fmtClosureRange(autoOnDay, null, lang) })
                : onlineBooksOne
                  ? t("rsvpAutoOnPlace", "Switched on by itself on {date}, when you added your first space. Not ready? Turn it off here.", { date: fmtClosureRange(autoOnDay, null, lang) })
                  : t("rsvpAutoOnTable", "Switched on by itself on {date}, when you added your first table. Not ready? Turn it off here.", { date: fmtClosureRange(autoOnDay, null, lang) }))}
            </p>
          )}
        </div>
        {/* 44px-tall tap target (host-stand touch), with the visual switch
            track centred inside it. Not ready: only the way off. */}
        {(!onlineNotReady || enabled) && (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={apptWords
            ? t("rsvpAcceptToggleProvider", "Accept online appointments")
            : t("rsvpAcceptToggle", "Accept online reservations")}
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
        )}
      </div>
      {/* Pause online booking for the rest of today / until a date — only
          while the page is live (R1 B6). */}
      {live && (
        <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
          <PauseControl t={t} lang={lang} closures={data?.closures} onChanged={setClosures} />
        </div>
      )}
      </div>

      {/* Din bookingside — the page's own address, renamed here. The link
          (Kopiér + Åbn siden) and the QR (with Hent PNG) live ONCE, in the kit
          right below: this card used to repeat both, so Settings showed two
          QR codes and two copy-link rows one card apart. Only for a page
          that can take a booking (live — Push 7). R9: its own component —
          the real address, a warning before a change, the old links. */}
      {live && publicUrl && (
        <BookingLinkCard
          t={t}
          lang={lang}
          publicUrl={publicUrl}
          slug={data?.reservation_slug || ""}
          // Absent from an older server: then the old link really stops,
          // and the warning says so.
          aliases={Array.isArray(data?.slug_aliases) ? data.slug_aliases : undefined}
          aliasMax={data?.slug_alias_max || 5}
          apptWords={apptWords}
          onSaved={onLinkSaved}
        />
      )}

      {/* Book bord på din hjemmeside — the one place for link, button, QR,
          embed, site-builder steps and the hand-off mail. Always rendered so
          the page header's "Sæt på hjemmeside" link always lands somewhere;
          until the page is live it says what to switch on first. */}
      <WebsiteBookingKit
        publicUrl={publicUrl}
        venueName={data?.business_name}
        // The page's own wording rule (speaksAppointments): a salon, a
        // shop or a workshop gets "Book tid", never "Book bord".
        isProvider={apptWords}
        enabled={live}
        // Nothing to book online yet (Push 7): the kit says so instead of
        // "switch it on at the top" — there is no switch there to find.
        notReady={onlineNotReady}
        t={t}
      />

      {/* Opening / booking hours — the hours each weekday a guest can book.
          These feed the slot generator (reservation_service reads
          booking_hours first, before any fallback), so the times guests see
          come from when the owner actually opens, not a hard-coded default. */}
      <div id="rsvp-hours" className="scroll-mt-24 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3">
        <div className="min-w-0">
          <h2 id="rsvp-hours-title" tabIndex={-1} className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2 focus:outline-none">
            <Clock className="w-4 h-4 text-gray-400" aria-hidden />
            {t("rsvpHoursTitle", "Opening hours (bookings)")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {isProvider
              // A salon: the hours steer the owner's chair and the stylists
              // who follow them; a stylist on Vagtplan is booked in her
              // shifts — "only while you're open" was not true for her (V3).
              ? t("rsvpHoursHintSalon", "These hours steer your own chair and the stylists who follow the opening hours. Stylists on shifts are booked on their shifts.")
              : apptWords
              ? t("rsvpHoursHintProvider", "Customers can only book while you're open. Set the hours for each day.")
              : t(
                "rsvpHoursHint",
                "Guests can only book while you're open. Set the hours for each day.",
              )}
          </p>
        </div>

        {/* No hours saved yet: the editor below shows SUGGESTED hours, and the
            booking page offers no times until real ones are saved. It used to
            show 11–22 every day as if the owner had set them — and the page
            went live on those invented hours. A salon books only on the
            hours saved HERE (never the Profile hours), so for a salon the
            banner stays until these are saved (R7). */}
        {(isProvider
          ? !!data && !hasSavedBookingHours(data?.settings?.booking_hours)
          : data?.hours_declared === false) && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-800 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <span>
              {apptWords
                ? t("rsvpHoursNotSetProvider", "Not saved yet — these are suggestions. Until you save your opening hours, customers see no times to book.")
                : t(
                  "rsvpHoursNotSet",
                  "Not saved yet — these are suggestions. Until you save your opening hours, guests see no times to book.",
                )}
            </span>
          </div>
        )}

        {/* R9: which hours decide online times — one rule, said the same
            way here, on the salon's first-run card and under the Profile
            hours: these decide; the Profile hours only fill a weekday that
            has none here (never for a salon's chair). */}
        {hoursFrom !== "none" && (
          <p data-testid="rsvp-hours-source" data-source={hoursFrom} className="text-[12px] leading-snug text-gray-600 dark:text-gray-300">
            {{
              booking: apptWords
                ? t("rsvpHoursSourceBookingAppt", "Customers book in these hours. The opening hours under Profile don't change them.")
                : t("rsvpHoursSourceBooking", "Guests book in these hours. The opening hours under Profile don't change them."),
              profile: apptWords
                ? t("rsvpHoursSourceProfileAppt", "Right now customers book in your opening hours from Profile (shown here). Save here to make them your booking hours; Profile then no longer changes them.")
                : t("rsvpHoursSourceProfile", "Right now guests book in your opening hours from Profile (shown here). Save here to make them your booking hours; Profile then no longer changes them."),
              mixed: t("rsvpHoursSourceMixed", "Days saved here decide. A day not saved here follows the opening hours under Profile — Save sets every day here."),
              chairs: t("rsvpHoursSourceChairs", "Your chair is booked in these hours only — not in the opening hours under Profile. The first-run card on Appointments sets these same hours."),
            }[hoursFrom]}
          </p>
        )}

        {/* R8: lunch and dinner on one day ("Tilføj periode"), and for a
            table venue the last booking time of each period, in words and
            settable, under the day's times. */}
        <WeekHoursEditor
          t={t}
          lang={lang}
          hours={hours}
          setHourDay={setHourDay}
          onApplyMonToAll={applyMonToAll}
          allowAddPeriod={hoursV2}
          addMode={apptWords ? "day" : "meal"}
          lastBooking={lastOn
            ? { step: stepDraft, sitting: lastBookingSitting(data?.settings, { booksOne: onlineBooksOne }), apptWords }
            : null}
          problemDay={hoursProblemDay}
        />

        {/* Starttider 15 / 30 / 60 (R8, rubric R9) — a salon picks hers on
            "Tider for aftaler" below. Saved with this card's Gem. */}
        {!isProvider && data && (
          <StartTimesChoice
            t={t}
            lang={lang}
            value={stepDraft}
            onPick={pickStep}
            hours={hours}
            apptWords={apptWords}
            busy={savingHours}
          />
        )}

        {/* The rule behind "(auto)", said once (rubric R8). */}
        {lastOn && (
          <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="last-booking-hint">
            {onlineBooksOne
              ? t("rsvpLastBookingHintAppt", "Auto = closing time minus the length of a booking ({min} min). Pick a time and customers can book up to and including it.", {
                min: lastBookingSitting(data?.settings, { booksOne: true }),
              })
              : t("rsvpLastBookingHint", "Auto = closing time minus the table time ({min} min for 2 guests). Pick a time and every party can book up to and including it — even if they stay past closing.", {
                min: lastBookingSitting(data?.settings),
              })}
          </p>
        )}

        {hoursError && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {hoursError}
          </p>
        )}

        {/* One Gem for this card, and it saves this card (R9) — with R8's
            dirty rule (periods, last booking times, Starttider). */}
        <CardSaveBar
          t={t}
          dirty={hoursDirty}
          saved={hoursSaved}
          busy={savingHours}
          onSave={saveHours}
          testId="rsvp-hours-save"
        />
      </div>

      {/* Closed dates and pauses (R1 B5) — right after the hours. */}
      <div id="rsvp-closures" className="scroll-mt-24">
        <ClosuresCard t={t} lang={lang} closures={data?.closures} onChanged={setClosures} apptWords={apptWords} />
      </div>

      {/* A salon's start times and break between customers (R6). */}
      {isProvider && data && (
        // Saved on the tap; the answer refreshes the page's settings but no
        // other card's fields (R9: a save never puts back another card's
        // unsaved changes).
        <SalonRhythmCard t={t} lang={lang} settings={data.settings} onSaved={(d) => applyData(d, NO_SETTINGS_PARTS)} />
      )}

      {/* Availability settings (kept simple — a few numbers). <form> so
          Enter saves from any field on a host-stand keyboard. */}
      <form
        id="rsvp-rules"
        onSubmit={(e) => {
          e.preventDefault();
          if (!savingForm) saveForm();
        }}
        className="scroll-mt-24 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3"
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
            {apptWords
              ? t("rsvpContactPhoneProvider", "Contact phone (shown to customers)")
              : t("rsvpContactPhone", "Contact phone (shown to guests)")}
          </label>
          <input
            id="rsvp-contact-phone"
            type="tel"
            inputMode="tel"
            value={form.contact_phone}
            onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
            placeholder={t("rsvpContactPhonePh", "+45 12 34 56 78")}
            maxLength={40}
            className="w-full sm:max-w-[18rem] h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
            {apptWords
              ? t("rsvpContactPhoneHintProvider", "Customers see a tap-to-call link on your booking page. Leave blank to use your business phone.")
              : t("rsvpContactPhoneHint", "Guests see a tap-to-call link on your booking page. Leave blank to use your business phone.")}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Table time by party size — the engine's own rule (the smallest
              band that fits; bigger parties hold the "bigger" time). This was
              one number that, saved, overwrote every band. */}
          {tableRules && (
          <fieldset className="sm:col-span-2 min-w-0 m-0 p-0 border-0">
            <legend className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              {apptWords
                ? t("rsvpTableTimesAppt", "Time per appointment (minutes)")
                : t("rsvpTableTimes", "Table time (minutes)")}
            </legend>
            {tierDraft.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {tierDraft.map((tr, i) => (
                  <NumberField
                    key={tr.up_to}
                    label={apptWords
                      ? t("rsvpTierBandAppt", "{from}–{to} people", { from: i === 0 ? 1 : tierDraft[i - 1].up_to + 1, to: tr.up_to })
                      : t("rsvpTierBand", "{from}–{to} guests", { from: i === 0 ? 1 : tierDraft[i - 1].up_to + 1, to: tr.up_to })}
                    value={tr.minutes}
                    onChange={(v) => setTierDraft((cur) => cur.map((x, j) => (j === i ? { ...x, minutes: v } : x)))}
                  />
                ))}
                <NumberField
                  label={apptWords
                    ? t("rsvpTierBiggerAppt", "{n}+ people", { n: tierDraft[tierDraft.length - 1].up_to + 1 })
                    : t("rsvpTierBigger", "{n}+ guests", { n: tierDraft[tierDraft.length - 1].up_to + 1 })}
                  value={form.default_duration_min}
                  onChange={(v) => setForm((f) => ({ ...f, default_duration_min: v }))}
                  hint={
                    Number(form.default_duration_min) > 0 &&
                    Number(form.default_duration_min) < Number(tierDraft[tierDraft.length - 1].minutes)
                      ? t("rsvpTierBiggerAtLeast", "Held at least {m} min, like the band before.", { m: tierDraft[tierDraft.length - 1].minutes })
                      : null
                  }
                />
              </div>
            ) : (
              <div className="flex items-end gap-3 flex-wrap">
                <div className="w-40">
                  <NumberField
                    label={apptWords ? t("rsvpTierEveryAppt", "Every appointment") : t("rsvpTierEvery", "Every party")}
                    value={form.default_duration_min}
                    onChange={(v) => setForm((f) => ({ ...f, default_duration_min: v }))}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const d = String(parseInt(form.default_duration_min, 10) || 90);
                    setTierDraft([{ up_to: 2, minutes: d }, { up_to: 4, minutes: d }, { up_to: 8, minutes: d }]);
                  }}
                  className="h-11 px-3 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {apptWords ? t("rsvpTierSplitAppt", "Set by number of people") : t("rsvpTierSplit", "Set by party size")}
                </button>
              </div>
            )}
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
              {apptWords
                ? t("rsvpTableTimesHintAppt", "How long a space is held. New appointments, the time pickers and the overview all use these.")
                : t("rsvpTableTimesHint", "How long a table is held. New bookings, the time pickers and the floor all use these.")}
            </p>
          </fieldset>
          )}
          {/* A shop's or a workshop's public page always books one customer
              (no party picker; ?party is ignored), so the two ONLINE
              party-size rules can never apply there — "Flere personer ser
              'ring til os'" was a dead control with a false hint (Push 8
              review). Their stored values are kept and saved as loaded. */}
          {tableRules && !onlineBooksOne && (
          <NumberField
            label={apptWords ? t("rsvpMaxPartyAppt", "Max people per appointment (online)") : t("rsvpMaxParty", "Max party size (online)")}
            hint={apptWords ? t("rsvpMaxPartyHintAppt", "More people see 'call us'.") : t("rsvpMaxPartyHint", "Bigger groups see 'call us'.")}
            value={form.max_party_size}
            onChange={(v) => setForm((f) => ({ ...f, max_party_size: v }))}
          />
          )}
          {tableRules && !onlineBooksOne && (
          <NumberField
            label={apptWords ? t("rsvpGroupThresholdAppt", "Request from (number of people)") : t("rsvpGroupThreshold", "Group-request from")}
            hint={apptWords
              ? t("rsvpGroupThresholdHintAppt", "At/above this, an appointment becomes a request you approve.")
              : t("rsvpGroupThresholdHint", "At/above this, bookings become a request you approve.")}
            value={form.group_request_threshold}
            onChange={(v) => setForm((f) => ({ ...f, group_request_threshold: v }))}
          />
          )}
          {onlineBooksOne && (tableRules || requestSwitchSeen) && (
          <label data-approve-online="" className="sm:col-span-2 flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={requestsEveryOnline(form.group_request_threshold)}
              onChange={(e) => {
                const on = e.target.checked;
                setForm((f) => ({
                  ...f,
                  // Off: back to the number it had, or the server's default
                  // (8, reservation_service.DEFAULT_SETTINGS) — either way a
                  // one-person booking is confirmed straight away.
                  group_request_threshold: on
                    ? "1"
                    : requestsEveryOnline(loadedRequestFrom) || loadedRequestFrom === ""
                      ? "8"
                      : String(loadedRequestFrom),
                }));
              }}
              className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
              {t("rsvpApproveOnlineAppt", "Approve online appointments yourself")}
              <span className="block text-xs text-gray-400 dark:text-gray-500">
                {t("rsvpApproveOnlineHintAppt", "On: every time booked online arrives as a request, and the time is held only when you confirm it. Off: it is confirmed straight away.")}
              </span>
            </span>
          </label>
          )}
          <NumberField
            label={apptWords
              ? t("rsvpLeadTimeProvider", "Notice (minutes)")
              : t("rsvpLeadTime", "Lead time (minutes)")}
            hint={apptWords
              ? t("rsvpLeadTimeHintProvider", "The shortest notice a customer can book a time with.")
              : t("rsvpLeadTimeHint", "Earliest a guest can book from now.")}
            value={form.lead_time_min}
            onChange={(v) => setForm((f) => ({ ...f, lead_time_min: v }))}
          />
          <NumberField
            label={apptWords
              ? t("rsvpMaxAdvanceProvider", "Customers can book up to (days ahead)")
              : t("rsvpMaxAdvance", "Book up to (days ahead)")}
            value={form.max_advance_days}
            onChange={(v) => setForm((f) => ({ ...f, max_advance_days: v }))}
          />
          {tableRules && (
          <div className="min-w-0">
            {/* R9: it counts GUESTS, as it says — each booking with its
                party, online only. It counted bookings × tables. */}
            <NumberField
              label={apptWords ? t("rsvpPacingAppt", "Max people per time") : t("rsvpPacing", "Max covers per slot")}
              hint={apptWords
                ? t("rsvpPacingGuestsHintAppt", "People booked online for the same quarter of an hour, counted with everyone in each booking. You can still book more in yourself. Blank = no limit.")
                : t("rsvpPacingGuestsHint", "Guests booked online for the same quarter of an hour, counted with everyone in each booking. You can still book more in yourself. Blank = no limit.")}
              value={form.pacing_max_per_slot}
              onChange={(v) => setForm((f) => ({ ...f, pacing_max_per_slot: v }))}
            />
            {paceGap && (
              <p data-testid="rsvp-pacing-gap" className="mt-1 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                {paceGap.to === null
                  ? (apptWords
                    ? t("rsvpPacingGapOpenAppt", "Bookings of {from} or more people can't book online with this limit.", { from: paceGap.from })
                    : t("rsvpPacingGapOpen", "Parties of {from} or more can't book online with this limit.", { from: paceGap.from }))
                  : paceGap.from === paceGap.to
                    ? (apptWords
                      ? t("rsvpPacingGapOneAppt", "Bookings of {n} people can't book online with this limit.", { n: paceGap.from })
                      : t("rsvpPacingGapOne", "Parties of {n} can't book online with this limit.", { n: paceGap.from }))
                    : (apptWords
                      ? t("rsvpPacingGapAppt", "Bookings of {from}–{to} people can't book online with this limit.", { from: paceGap.from, to: paceGap.to })
                      : t("rsvpPacingGap", "Parties of {from}–{to} can't book online with this limit.", { from: paceGap.from, to: paceGap.to }))}
              </p>
            )}
          </div>
          )}
        </div>
        {/* Table combining — flag tables as combinable on the Floor tab; this
            switch governs whether the engine actually combines them. */}
        {tableRules && (<>
        <div className="pt-3 border-t border-gray-100 dark:border-gray-800">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!form.combine_enabled}
              onChange={(e) => setForm((f) => ({ ...f, combine_enabled: e.target.checked }))}
              className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
              {apptWords ? t("rsvpCombineSettingAppt", "Combine spaces") : t("rsvpCombineSetting", "Table combining")}
              <span className="block text-xs text-gray-400 dark:text-gray-500">
                {apptWords
                  ? t("rsvpCombineSettingHintAppt", "Let more people at once use several combinable spaces in the same zone.")
                  : t(
                    "rsvpCombineSettingHint",
                    "Let big parties be seated across multiple combinable tables in the same zone.",
                  )}
              </span>
            </span>
          </label>
          {form.combine_enabled && (
            <div className="mt-3 sm:max-w-[14rem]">
              <NumberField
                label={apptWords ? t("rsvpMaxComboSizeAppt", "Max spaces per appointment") : t("rsvpMaxComboSize", "Max tables per party")}
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
              className="mt-0.5 w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">
              {apptWords ? t("rsvpGuestPickSettingAppt", "Let customers choose their space") : t("rsvpGuestPickSetting", "Let guests choose their table")}
              <span className="block text-xs text-gray-400 dark:text-gray-500">
                {apptWords
                  ? t("rsvpGuestPickSettingHintAppt", "Off: the booking page picks the best free space (you stay in control). On: customers can tap a specific space on the map.")
                  : t("rsvpGuestPickSettingHint", "Off: the booking page auto-assigns the best free table (you keep seating control). On: guests can tap a specific table on the floor map.")}
              </span>
            </span>
          </label>
        </div>
        </>)}
        {/* One Gem for this card, and it saves this card (R9) — on a phone
            it follows the owner down the card while there are changes. */}
        <CardSaveBar
          t={t}
          dirty={formDirty}
          saved={formSaved}
          busy={savingForm}
          submit
          testId="rsvp-rules-save"
        />
      </form>

      {/* E-mails to the owner about online bookings (R1 D6): the switch for
          the one channel that lands without a device. At most 3 an hour,
          then one summary — the same budget as the push. */}
      <div
        id="rsvp-messages"
        data-testid="rsvp-owner-emails"
        className="scroll-mt-24 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 flex items-center justify-between gap-4"
      >
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpOwnerEmailToggle", "Email me about new online bookings and cancellations")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("rsvpOwnerEmailToggleHint", "At most 3 an hour, then one summary. Push notifications follow the same limit.")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={data?.settings?.owner_booking_emails !== false}
          aria-label={t("rsvpOwnerEmailToggle", "Email me about new online bookings and cancellations")}
          disabled={savingOwnerEmails}
          onClick={toggleOwnerEmails}
          className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 disabled:opacity-50"
        >
          <span
            className={
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors " +
              (data?.settings?.owner_booking_emails !== false ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-600")
            }
          >
            <span
              className={
                "inline-block h-5 w-5 transform rounded-full bg-white transition-transform " +
                (data?.settings?.owner_booking_emails !== false ? "translate-x-5" : "translate-x-0.5")
              }
            />
          </span>
        </button>
      </div>

      {/* R2: blocked and spam-marked contacts — masked, with Fjern. */}
      <ContactBlocksCard t={t} lang={lang} apptWords={apptWords} />

      {/* SMS reminders (Pro). Locked surface for non-Pro tiers (disabled
          switch + Pro badge/lock + upsell link to /subscription, the same
          path the rest of the app's Pro gates use). A Pro / Trial owner
          sees it fully enabled. Saves through the SAME PUT
          /reservations/settings as the availability numbers. */}
      <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-3">
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
                className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
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
      <InstallHostStandHint t={t} isProvider={apptWords} />

      {/* Pair a device with a short code — the alternative to typing the
          owner's email and password on a tablet that lives at the door. */}
      <div id="rsvp-devices" className="scroll-mt-24">
        <StandDevices t={t} apptWords={apptWords} />
      </div>
    </div>
  );
}

/**
 * Pair and revoke host-stand devices.
 *
 * The code is the point: read six characters across a counter and that device
 * runs the book, with reservations-only reach and no owner login on it. The
 * list matters as much as the button — a credential you cannot see is one you
 * cannot revoke, so paired devices are always visible with a one-tap Remove.
 */
// `apptWords`: a salon, a shop, a workshop — the paired tablet shows its
// appointments at the counter, not "reservations" at "the door".
function StandDevices({ t, apptWords = false }) {
  const confirm = useConfirm();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [fresh, setFresh] = useState(null); // the code just minted
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.get("/stand/links");
      setDevices(res.data?.devices || []);
    } catch {
      setError(t("rsvpStandDevicesError", "Kunne ikke hente enheder."));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const mint = async () => {
    setMinting(true);
    setError("");
    try {
      const res = await api.post("/stand/links", { label: null });
      setFresh(res.data);
      await load();
    } catch {
      setError(t("rsvpStandMintError", "Kunne ikke lave en kode. Prøv igen."));
    } finally {
      setMinting(false);
    }
  };

  // One line for where a device stands, used by the list AND by the revoke
  // dialog, so the two can never describe the same tablet differently.
  const deviceState = (d) =>
    d.paired
      ? d.last_seen_at
        ? t("rsvpStandDeviceSeen", "Sidst set {when}", {
            // A stand's last_seen_at is naive UTC (utc_now), unlike the
            // bookings' wall-clock starts_at on this page.
            when: parseServerTime(d.last_seen_at)?.toLocaleString() || "—",
          })
        : t("rsvpStandDevicePaired", "Forbundet")
      : t("rsvpStandDeviceWaiting", "Venter på koden");

  const revoke = async (d) => {
    // Two tablets in the list, one dialog: "Fjern denne enhed?" named neither,
    // and the consequence never reached the screen at all — body/confirmText/
    // danger are not useConfirm's props, so it dropped the warning, drew the
    // calm button and let Enter confirm. The dialog now names the device and
    // the state the row shows it in, and carries the warning it always meant.
    const label = (d.label || "").trim();
    const ok = await confirm({
      title: label
        ? t("rsvpRemoveNamedTitle", "Remove {label}?", { label })
        : t("rsvpStandRevokeTitle", "Fjern denne enhed?"),
      // A link that was never paired has no book to lose — telling its owner
      // the tablet goes dark contradicts the "waiting for the code" state the
      // same dialog prints one line above.
      message: d.paired
        ? t(
            "rsvpStandRevokeBodyState",
            "{state}. It loses the book the moment you remove it, and needs a new code before it can show reservations again.",
            { state: deviceState(d) },
          )
        : t(
            "rsvpStandRevokeBodyWaiting",
            "{state}. The code stops working the moment you remove it — mint a new one if you still want to pair a tablet.",
            { state: deviceState(d) },
          ),
      confirmLabel: t("rsvpStandRevokeYes", "Fjern"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/stand/links/${d.id}`);
      if (fresh && fresh.id === d.id) setFresh(null);
      await load();
    } catch {
      setError(t("rsvpStandRevokeError", "Kunne ikke fjerne enheden."));
    }
  };

  const active = devices.filter((d) => d.active);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center shrink-0 text-gray-600 dark:text-gray-300">
          <MonitorSmartphone className="w-4 h-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {apptWords
              ? t("rsvpStandDevicesTitleAppt", "The appointment book on another device")
              : t("rsvpStandDevicesTitle", "Vært-skærm på en anden enhed")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
            {apptWords
              ? t(
                  "rsvpStandDevicesBodyAppt",
                  "Make a code, type it on the tablet at the counter, and it shows only the appointments — never your accounts or payroll.",
                )
              : t(
                  "rsvpStandDevicesBody",
                  "Lav en kode, tast den på tabletten ved døren, og den viser kun reservationer — aldrig regnskab eller løn.",
                )}
          </p>
        </div>
      </div>

      {/* The freshly minted code, big enough to read aloud across a room. */}
      {fresh?.code && (
        <div
          className="rounded-xl px-4 py-3.5 text-center"
          style={{
            background: "linear-gradient(180deg,#ffffff,#f7f9fc)",
            boxShadow:
              "inset 0 1px 0 #fff, 0 1px 2px rgba(15,23,42,.05), 0 8px 18px -14px rgba(15,23,42,.35)",
          }}
        >
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-gray-500">
            {t("rsvpStandCodeEyebrow", "Tast på enheden · bonbox.dk/stand")}
          </p>
          {/* NO dark: variant here on purpose. This card's background is the
              hardcoded light gradient above, which dark mode cannot touch —
              so dark:text-gray-100 painted near-white on near-white and the
              pairing code disappeared entirely for any owner in dark mode.
              The card is light in both themes; the code must be dark in both. */}
          <p className="mt-1 font-mono text-[32px] font-bold tracking-[0.3em] tabular-nums text-gray-900">
            {fresh.code}
          </p>
          <p className="mt-1 text-[12px] text-gray-500">
            {t("rsvpStandCodeTtl", "Udløber om {n} minutter · virker én gang", {
              n: fresh.expires_in_minutes,
            })}
          </p>
        </div>
      )}

      <Button
        variant="secondary"
        size="lg"
        onClick={mint}
        busy={minting}
        iconLeft={<Plus className="w-4 h-4" />}
      >
        {t("rsvpStandMintCta", "Lav en kode")}
      </Button>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {!loading && active.length > 0 && (
        <ul className="space-y-1.5 pt-1">
          {active.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 text-gray-900 dark:text-gray-100"
            >
              <span className="min-w-0 flex-1 text-[13px] text-gray-700 dark:text-gray-200 truncate">
                {d.label || t("rsvpStandDeviceUnnamed", "Enhed")}
                <span className="block text-[11px] text-gray-400">
                  {deviceState(d)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => revoke(d)}
                className="shrink-0 h-9 px-3 rounded-lg text-[13px] font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
              >
                {t("rsvpStandDeviceRemove", "Fjern")}
              </button>
            </li>
          ))}
        </ul>
      )}
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

/** iOS/iPadOS, incl. iPad-as-Macintosh. Prefers the flag the index.html
 *  manifest selector already computed so both layers agree on one answer. */
function _isIOSDevice() {
  if (typeof window === "undefined") return false;
  if (typeof window.__BONBOX_IS_STAND !== "undefined" || typeof window.__BONBOX_IS_IOS !== "undefined") {
    return window.__BONBOX_IS_IOS === true;
  }
  const ua = navigator.userAgent || "";
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua))
  );
}

function InstallHostStandHint({ t, isProvider = false }) {
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
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] p-4 flex items-start gap-3">
      <div className="w-9 h-9 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center shrink-0 text-gray-600 dark:text-gray-300">
        <MonitorSmartphone className="w-4 h-4" aria-hidden />
      </div>
      <div className="min-w-0 space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rsvpInstallTitle", "Open the book as an app")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
            {isProvider
              ? t("rsvpInstallBodyProvider", "Install BonBox on the reception computer or tablet so the appointment book opens as an app.")
              : t(
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
            {/* iPad/iPhone never fire beforeinstallprompt, so this branch is
                ALWAYS what an iPad owner sees — and it used to tell them to
                open Edge or Chrome's ⋯ menu, on the one device this screen is
                designed for. Safari's own Share → Add to Home Screen is the
                real path there. */}
            {_isIOSDevice()
              ? isProvider
                ? t(
                    "rsvpInstallManualIOSProvider",
                    "In Safari: tap Share, then Add to Home Screen. The icon opens straight to the appointment book.",
                  )
                : t(
                    "rsvpInstallManualIOS",
                    "In Safari: tap Share, then Add to Home Screen. The icon opens straight to this screen.",
                  )
              : t(
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
        className="h-11 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
      />
      {hint && <span className="text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>}
    </label>
  );
}
