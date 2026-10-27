// ReservationPublicPage — the public table-booking widget at /r/{slug}.
//
// Mobile-first (390px reference). PUBLIC route — no auth, no session
// cookie needed. The visitor lands here from the restaurant's link in
// their bio / Google profile / a QR on the table. Target flow is ~15
// seconds: pick a date + party size, tap a time slot, leave a name,
// done.
//
// Doctrine-compliant: gray-* palette only, emerald reserved for the one
// confirm "money moment". rounded-xl cards, 1px gray-200 borders,
// gray-900 text, Lucide outline icons, light-mode default. Matches the
// EventPublicPage / BookingCheckoutPage visitor surface exactly (same
// `api` client, same da-DK date formatting, same sticky-CTA pattern).
//
// Multi-step wizard (one step on screen at a time):
//   Step 1 — pick DATE (today … today+max_advance_days) + PARTY SIZE.
//             On change → GET availability → render time-slot chips.
//   Step 2 — guest details (name required; email/phone/occasion/notes
//             optional) + an OPTIONAL allergy block (invite, not require).
//   Success — "Confirmed" or "Request received" depending on status.
//
// Backend contract (app/routers/public_reservations.py):
//   GET  /public/reservations/{slug}                       → page data
//   GET  /public/reservations/{slug}/availability?day=&party= → slots
//   POST /public/reservations/{slug}  (+ X-Idempotency-Key) → create
//   GET  /public/reservations/booking/{id}?token=          → poll
//   410 → reservations off / feature gone → "not taking bookings".
//   409 → slot_unavailable | party_too_large | not_accepting.
//
// DK terminology lock applies: revisor / MOMS etc. stay Danish in all
// locales. The public copy here defaults to Danish (DK-first market).
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useConfirm } from "../hooks/useConfirm";
import { buildIcs, icsMinutesFor, venueAddress } from "../utils/reservationIcs";
import { saveFile } from "../utils/download";
import {
  Calendar,
  CalendarOff,
  CalendarPlus,
  Users,
  MapPin,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Loader2,
  Info,
  Phone,
  Hash,
  Scissors,
  Check,
  ChevronDown,
  ChevronLeft,
  ArrowRight,
  PauseCircle,
  X,
} from "lucide-react";
import api from "../services/api";
import { slotNote } from "../utils/slotNote";
import { markGuestSurface } from "../lib/guestSurface";
import { forceLightTheme } from "../utils/themeColor";
import { venueMonogram } from "../utils/venueMonogram";
import { contactState } from "../utils/guestContact";
import { rescueDay, seedStep1 } from "../utils/bookingDay";
import { GUEST_REFUSALS, guestRefusalOf } from "../utils/bookingRefusal";
import { answerByWords, capFirst, dateLocale, fmtDayLabel, fmtDayShort } from "../utils/guestLocale";
import { accentStyle, accentTokens } from "../utils/accentColor";
import { isFramed } from "../utils/framed";
import { canonicalPath } from "../utils/bookingLink";
import {
  ariaWord,
  bookAheadText,
  bookingOpensAria,
  calendarLegend,
  chipWord,
  markOfReason,
  maxAdvanceOf,
  noneBookableText,
  partyColsPhone,
  railLength,
  reasonSentence,
} from "../utils/dayState";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useLanguage } from "../hooks/useLanguage";
import { loadLocale, loadedLocales } from "../lib/localeStore";
// Booking R5: the page's own words (~10 KB, Danish + English) instead of the
// ~200 KB full dictionary — registered as this module is evaluated, before the
// first render (lib/pageDict.js, vite.config.js bonbox-booking-dict).
import "../lib/bookingDict";
import { pageDictFor } from "../lib/pageDict";
// Booking R5: the data index.html already asked for (lib/bookingBoot.js).
import { bootOr, markBootPageUsed, peekBootPage } from "../lib/bookingBoot";
import Button from "../components/ui/Button";
import BookingTile from "../components/booking/BookingTile";
import EarnedText from "../components/booking/EarnedText";
import {
  SKELETON_COUNT,
  SKELETON_GRID,
  TILE_CLOSED,
  TILE_HOVER,
  TILE_PICKED,
  TILE_REST,
  dateRailCols,
  skeletonTileClass,
  timeGridCols,
} from "../components/booking/bookingTiles";
import BookingSkeleton from "../components/booking/BookingSkeleton";
import { EMBED_CARD, EMBED_GROUND, EMBED_MAX, ROOT_FINISH, skeletonVariant } from "../components/booking/bookingWait";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { useAutoHeight } from "../hooks/useAutoHeight";
import Input from "../components/ui/Input";
import Sheet from "../components/ui/Sheet";
// The month grid behind "Anden dato" — its own chunk (R12: the page's 30 kB
// budget, rubric G14). Most guests pick from the strip and never open it.
const loadMonthCalendar = () => import("../components/MonthCalendar");
const MonthCalendar = lazy(loadMonthCalendar);
const warmCalendar = () => {
  loadMonthCalendar().catch(() => {});
};
// Booking R5 ("trim what the booking page loads"): the 2D table picker is its
// own chunk. Only a venue that lets guests pick a table ever shows it (and
// only after a time is picked), so the page's first download no longer
// carries it and its table drawings. Fetched as soon as the venue turns out
// to offer it (prefetch below), so by the time a time is picked it is here.
const loadFloorMap = () => import("../components/PublicFloorMap");
const PublicFloorMap = lazy(loadFloorMap);
const FLOOR_WAIT = "animate-pulse h-44 rounded-xl bg-gray-100 dark:bg-gray-800";
// R12: a full night's nearest times and the guest waitlist, their own chunk.
const loadFullNight = () => import("../components/booking/FullNightOffer");
const FullNightOffer = lazy(loadFullNight);
import { VenueHoursList, VenueHoursToggle } from "../components/VenueHours";
import { PHONE_HOURS_ITEM, hasVenueWeek } from "../utils/venueHours";
import { bookingModeFor, usesTableFloor, speaksAppointments } from "../config/venueProfiles";

// What that chunk needs from the page, handed over instead of imported there
// (imported, the bundler moves these out of this chunk; FullNightOffer.jsx).
const FULL_NIGHT_KIT = { api, Button, Input, BookingTile, Clock, Phone, ChevronDown, fmtDayLabel, fmtDayShort };

// ── Severity ladder ────────────────────────────────────────────────
// Mirrors backend app/services/allergens.py SEVERITY_LEVELS. Stored as
// the stable key; the human label is resolved through the i18n layer.
const SEVERITY_KEYS = ["preference", "intolerance", "severe"];

// Occasion chips (design spec: five, single-select). The page holds the KEY,
// so the chip stays selected and reads right when the guest switches DA/EN.
// The booking stores the label in the VENUE's language — it is the owner who
// reads it; a Danish owner got "Birthday" from an English-speaking guest.
const OCCASION_KEYS = ["birthday", "anniversary", "date", "business", "celebration"];
const OCCASION_FALLBACK = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  date: "Date",
  business: "Business",
  celebration: "Celebration",
};

// localStorage key prefix — we stash the signed booking_token per
// reservation id so a returning visitor on the same device can poll
// the live status without re-authenticating.
const TOKEN_STORE_PREFIX = "bonbox_rsvp_token_";

// ── Date helpers ───────────────────────────────────────────────────
// YYYY-MM-DD for <input type="date"> + the API. We build the "today"
// string from local wall-clock (the public widget defaults to the
// restaurant's market = Europe/Copenhagen; the backend re-validates the
// window against its own local clock, so a small client skew is fine).
function isoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(isoStr, n) {
  const d = new Date(`${isoStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// ── Date strip ─────────────────────────────────────────────────────
// One-tap Danish-format day picker (14 days from today). Open days are
// tappable; closed days are visibly disabled — so a diner never guesses-and-
// checks a native date input, and never lands on a dead day. `dayMap` null =
// the open/closed overview hasn't resolved yet → render enabled and let the
// single-day fetch tell the truth (fail-soft, never a false "closed").
// On a phone the rails (days, party size, times) bleed to the screen edge so a
// cut-off chip says "swipe for more". scroll-padding keeps the first chip on
// the page margin when the rail snaps — without it the snap pulled the first
// chip flush against the edge of the phone. From sm up (tablet, desktop) the
// chips WRAP instead: there is room, and a hidden-scrollbar rail is hard to
// move with a mouse.
const RAIL =
  "-mx-4 px-4 scroll-px-4 flex gap-2 overflow-x-auto pb-1 snap-x " +
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
  "sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible";

// Each decision on step 1 (how many, which day, what time) is headed like a
// question the guest is answering — 15px semibold ink, not the 12px grey
// form label it used to be, which read as fine print on a phone.
const SECTION_TITLE = "block text-[15px] font-semibold tracking-tight text-gray-900 dark:text-gray-100";

// One keyboard focus ring for every control on the page. The chips wore a
// faint grey ring (~2.6:1) and the day chips and links the browser's own
// outline — two looks, one of them nearly invisible. The picker tiles
// (BookingTile) wear this one too.
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950";

// "Ring til os: {phone}" where a day can't be booked online (the paused panel,
// a party online can't seat, nothing open). 40px / 13px, the 27 Sep phone
// rule. min-h-0! releases the global (pointer: coarse) 44px floor in
// index.css — that rule sits outside Tailwind's layers, so h-10 alone renders
// 44px on a real phone. A quiet bordered button, its edge on the text's edge:
// as a borderless ghost it sat 16px in from the sentence above and, with no
// hover on a phone, read as indented text, not as the one way on.
const TEL_ACTION =
  "inline-flex items-center justify-center gap-2 h-10 min-h-0! px-4 rounded-lg text-[13px] font-medium " +
  "border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 " +
  "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-200 " + FOCUS;

// ── Finish (booking R3, "Refined, finished", judge 24 Oct 2026) ─────
// ROOT_FINISH: grayscale anti-aliasing on the guest page only — the crisper,
// lighter Inter. Never global: the owner app is pixel-fitted (check by eye on
// a device before merge).
// EMBED_GROUND: the embed's ground from 450 px: transparent (the host's
// colour shows), and padding round the one card so its shadow is never cut by
// the frame.
// EMBED_CARD: the one elevation: white, 16 px corners (the hero rung), a 5 %
// ring and one soft shadow. Light only — the embed forces light.
// EMBED_MAX: how wide the booking may get inside the frame (booking R4). The
// owner picks the frame's width in the kit (utils/bookingEmbed EMBED_WIDTHS:
// 460 or 560) and the snippet centres it in their column; the card follows
// the frame up to 560. At 460 — every snippet before R4 — the card is as
// before (460 less the ground's padding is 428, under the old 448 cap); only
// the flat look (&flat=1, R3) gains 12 px there. Standalone keeps max-w-md.
// R5: the four live in components/booking/bookingWait.js, which the wait
// (index.html's first paint, the route's fallback, this page's own loading
// state) shares with the page, so the wait and the page never disagree.
// A step enters over 220 ms from 4 px on the page's one curve (was 350 ms
// from 8 px on the default ease). No fill mode: at rest there is no
// transform, so nothing fixed inside is re-anchored.
const STEP_ENTER = "motion-safe:animate-[bbStep_220ms_cubic-bezier(0.22,1,0.36,1)]";
// A native select in the page's tile look (G10 item 5, judge 27 Oct): no
// native chrome, the times' own material, and a Lucide chevron on the right
// (SelectChevron). The salon's two selects; the waitlist's time select wears
// the same in FullNightOffer.jsx.
const SELECT_TILE =
  "w-full h-12 appearance-none pl-4 pr-10 rounded-xl border bg-gray-50 border-gray-900/[0.06] " +
  "dark:bg-white/[0.04] dark:border-white/[0.08] text-base font-medium text-gray-900 dark:text-gray-100 ";
function SelectChevron() {
  return (
    <ChevronDown
      size={16}
      strokeWidth={1.75}
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
      aria-hidden="true"
    />
  );
}
// The main action's finish: a 1 px neutral contact shadow (never green) and,
// while CTA_TOP_EDGE is on, an 8 % white top edge — the one concession to
// "glossy", an edge, not a gradient. It stays only if it passes Manoj's look
// on a real phone (judge, call 2); false drops it, nothing depends on it.
// Disabled, neither. The transition lives in index.css (.bb-cta).
// Off (G10 item 6, judge 27 Oct): half of a bevel, invisible under an
// owner's accent colour. The contact shadow stays.
const CTA_TOP_EDGE = false;
// `bb-accent-main` (R5): under the venue's accent colour the main button
// wears it, its text picked by contrast (index.css "BOOKING ACCENT").
const CTA_FINISH =
  "bb-cta bb-accent-main disabled:shadow-none " +
  (CTA_TOP_EDGE
    ? "shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1px_2px_rgb(16_24_40/0.18)]"
    : "shadow-[0_1px_2px_rgb(16_24_40/0.18)]");

// The day's times: a segmented control for the services (Frokost /
// Eftermiddag / Aften) and that service's times four across. As horizontal
// rails a full day (~40 times) showed 13 and hid the rest behind swipes; here
// every time of the chosen service is on screen. Opens on the service holding
// the picked time, else dinner, else the first. A dot marks the service that
// holds the pick when another one is open.
// `apptWords`: a salon, a shop or a workshop — its scarce slot is the last
// TIME, never the last table. (Its groups are the day's parts, not meals:
// groupSlots; with no "dinner" among them the grid opens on the first.)
// A new day or party keeps the old times on screen until the new ones land.
// Taps are blocked at once, but the grid dims (to .6) only when the answer is
// slow: 180 ms (useDelayedFlag), and it comes back over 160 ms. Most answers
// land in ~100 ms, and the grid used to blink on every tap, even when the
// same times came back (judge 24 Oct, f95). Only a time that is NEW arrives
// (3 px over 200 ms); chips are keyed by time, so an unchanged time is the
// same node and never moves. The whole-grid fade on every mount is gone.
// Columns are balanced so no time sits alone on its last row (timeGridCols).
const TIME_ARRIVE = "motion-safe:animate-[bbArrive_200ms_cubic-bezier(0.22,1,0.36,1)]";

function TimeGrid({ groups, slot, onPick, slotRemaining, loading, t, apptWords = false }) {
  const dim = useDelayedFlag(loading, 180);
  const groupOf = (s) => groups.find((g) => g.slots.includes(s))?.key || null;
  const fallback = groupOf(slot) || (groups.some((g) => g.key === "dinner") ? "dinner" : groups[0]?.key);
  const [tab, setTab] = useState(fallback);
  const active = groups.some((g) => g.key === tab) ? tab : fallback;
  const current = groups.find((g) => g.key === active) || groups[0];
  if (!current) return null;
  const pickedIn = groupOf(slot);
  // The scarcity line ("2 left") only when the server says so AND it tells
  // the guest something. For a big party every slot said "3 left" or "Last
  // table" on an empty evening — the count of tables that fit, not how busy
  // it is. A note that is the same everywhere is noise; show none.
  const allCounts = groups.flatMap((g) => g.slots.map((x) => slotRemaining[x])).filter((v) => v != null);
  const uniform = allCounts.length > 0 && allCounts.every((v) => v === allCounts[0]);
  const noteFor = (x) => (uniform ? null : slotNote(slotRemaining[x], t, { apptWords }));
  const withNotes = current.slots.some((x) => noteFor(x));
  return (
    <div
      data-testid="rsvp-time-grid"
      data-dim={dim ? "true" : "false"}
      className={
        "transition-opacity ease-[cubic-bezier(0.22,1,0.36,1)] " +
        (loading ? "pointer-events-none " : "") +
        (dim ? "opacity-60 duration-200" : "opacity-100 duration-[160ms]")
      }
    >
      {groups.length > 1 && (
        <div
          className="mb-3 flex gap-1 p-1 rounded-xl bg-gray-100 dark:bg-gray-800"
          role="group"
          aria-label={t("rsvpPickTime", "Vælg tidspunkt")}
        >
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              aria-pressed={g.key === active}
              onClick={() => setTab(g.key)}
              className={
                "relative flex-1 h-9 rounded-lg text-[13px] font-semibold transition-colors duration-200 ease-out " + FOCUS + " " +
                (g.key === active
                  ? "bg-white text-gray-900 shadow-sm dark:bg-gray-600 dark:text-white"
                  : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200")
              }
            >
              {t(g.labelKey)}
              {pickedIn === g.key && g.key !== active && (
                <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-gray-900 dark:bg-gray-100" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
      <div
        key={current.key}
        role="radiogroup"
        aria-label={t(current.labelKey)}
        onKeyDown={rovingKeyDown}
        className={"grid gap-2 " + timeGridCols(current.slots.length, { notes: withNotes })}
      >
        {current.slots.map((s, idx) => {
          // Scarcity, only when genuinely scarce and only from a real server
          // count. Silence is the default: an invented hint is a lie told to
          // make someone book faster.
          const note = noteFor(s);
          const focusable = slot === s || (!current.slots.includes(slot) && idx === 0);
          return (
            <BookingTile
              key={s}
              selected={slot === s}
              onClick={() => onPick(s)}
              role="radio"
              aria-checked={slot === s}
              tabIndex={focusable ? 0 : -1}
              // A picked time keeps weight 500 (the tile's): 500 → 600 made
              // its digits reflow under the finger.
              className={
                "w-full px-0 tabular-nums text-[15px] flex-col justify-center gap-0 " + FOCUS + " " +
                (withNotes ? "h-[52px] " : "h-11 ") + TIME_ARRIVE
              }
            >
              <span className="leading-none">{s}</span>
              {withNotes && (
                // G10 (judge 27 Oct): 11 px (10 was under the floor) in quiet
                // grey — green no longer says "free" on a page whose green is
                // the main action. The picked tile keeps its white/80.
                <span
                  className={
                    "block text-[11px] leading-none h-3 mt-1 font-medium " +
                    (slot === s ? "bb-pick-quiet text-white/80 dark:text-gray-900/70" : "text-gray-500 dark:text-gray-400")
                  }
                >
                  {note}
                </span>
              )}
            </BookingTile>
          );
        })}
      </div>
    </div>
  );
}

// Weekday / date / month stacked in a compact card. The one-line
// "Man. 28. Sep." chips fit two and a half days on a phone; these fit five.
// Danish short forms carry dots ("man.", "28.", "sep.") — stripped here.
// The strip ends at the booking window (at most 14 days). An unbookable day
// is disabled and its bottom word says why — "lukket" only for a day the
// venue's hours say closed; "fuldt", "kun tlf.", "for sent"; anything the
// page can't name keeps the month name (utils/dayState.js).
function DateStrip({ today, dayMap, reasons, maxAdvance, party, apptWords = false, value, onPick, t, lang, fullTappable = false }) {
  const rail = Array.from({ length: railLength(maxAdvance) }, (_, i) => addDays(today, i));
  // A day picked in the calendar beyond the rail joins it at the end — the
  // row stays in date order, and the effect below scrolls it into view.
  const days = value && value > rail[rail.length - 1] ? [...rail, value] : rail;
  const part = (iso, opts) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(dateLocale(lang), opts).replace(/\.$/, "");
  const full = (iso) => fmtDayLabel(iso, lang);
  const refs = useRef({});
  const railRef = useRef(null);
  const shown = useRef("");
  // A day picked some other way (the calendar, the "next open day" jump)
  // scrolls into view — the rail never hides the day that is selected.
  // The RAIL scrolls, sideways, and nothing else: scrollIntoView also scrolls
  // every scrollable ancestor, and inside the embed <iframe> that jumped the
  // restaurant's own website down to the widget on every load. The first real
  // value (the page seeding today) leaves the rail at its start.
  useEffect(() => {
    const prev = shown.current;
    shown.current = value || "";
    if (!value || prev === value) return;
    // First value (a ?d= link far along the row): jump; later picks glide.
    revealInRail(railRef.current, refs.current[value], prev ? "smooth" : "auto");
  }, [value]);
  return (
    // From 450 px up a grid, not a swipe rail: a window of up to 8 days in ONE
    // row, longer windows in rows of 7 (dateRailCols). The restaurant's
    // website frames this page at 460–520 px, where `sm:` (640) never fired:
    // the rail cut the 6th day at the frame's edge, with no swipe on a mouse.
    <div
      ref={railRef}
      role="radiogroup"
      aria-label={t("rsvpPickDate", "Pick a date")}
      onKeyDown={rovingKeyDown}
      style={{ "--rail-cols": dateRailCols(rail.length) }}
      className={RAIL + " relative " + DATE_GRID}
    >
      {days.map((iso, idx) => {
        const known = dayMap && iso in dayMap;
        const closed = known && dayMap[iso] === false;
        // Why it is closed: null reasons (summary not in, or failed) → no word.
        const reason = reasons ? reasons[iso] : null;
        const word = closed ? chipWord(reason, t) : null;
        // R12: a "fuldt" night stays a button when the venue takes waitlist
        // names — the time area then offers the nearest times and the list.
        const off = closed && !(fullTappable && reason === "full");
        const active = value === iso;
        const quiet = active ? "bb-pick-quiet text-white/75 dark:text-gray-500" : "text-gray-500 dark:text-gray-400";
        return (
          <button
            key={iso}
            ref={(el) => { refs.current[iso] = el; }}
            type="button"
            disabled={off}
            onClick={() => !off && onPick(iso)}
            role="radio"
            aria-checked={active}
            tabIndex={active || (!days.includes(value) && idx === 0) ? 0 : -1}
            aria-label={closed ? `${full(iso)} — ${ariaWord(reason, t, { party, apptWords })}` : full(iso)}
            className={[
              // Width from the screen, like the party chips: 5½ across, so a
              // half day always sits at the edge (at 390 the 6th was cut by
              // 2px — nothing said the row went on). A grid cell from 450 px.
              "shrink-0 snap-start w-[max(3.25rem,calc((100vw-3.5rem)/5.5))] min-[450px]:w-auto h-[68px] rounded-xl " + FOCUS,
              // A day picked beyond the row stands apart from it, so
              // "Lør 10 okt · Tors 15 okt" never reads as consecutive days.
              idx === rail.length ? "ml-4 min-[450px]:ml-0 min-[450px]:col-start-1" : "",
              "flex flex-col items-center justify-center gap-1",
              // The tiles of the other two pickers (bookingTiles.js). A closed
              // day is not a button: no box, its faded day and word say it.
              active ? TILE_PICKED : off ? TILE_CLOSED : TILE_REST + " " + TILE_HOVER,
              off ? "cursor-not-allowed" : "",
            ].join(" ")}
          >
            {/* A disabled day fades its weekday and digit; its state word
                ("fuldt", "kun tlf.") is the message, so it stays at gray-500
                (≈ 4.8:1) — under the chip-wide opacity-45 it read ≈ 1.9:1. */}
            <span className={"text-[11px] font-medium leading-none capitalize " + quiet + (off ? " opacity-45" : "")}>
              {part(iso, { weekday: "short" })}
            </span>
            <span className={"text-lg font-semibold leading-none tabular-nums" + (off ? " opacity-45" : "")}>
              {part(iso, { day: "numeric" })}
            </span>
            {/* One line, always: from 450 px a 1-week window is 8 columns of
                ~44 px, and "kun tlf." / "på pause" must not wrap in the tile. */}
            <span className={"text-[11px] leading-none whitespace-nowrap " + quiet + (closed && !word ? " opacity-45" : "")}>
              {/* The state word (rsvpDayClosed / rsvpDayFull / …, utils/dayState.js),
                  else the month. rsvpClosed is the page <h1>, not this. */}
              {word || part(iso, { month: "short" }).replace(/^Sept$/, "Sep")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// The date strip from 450 px (DateStrip): `--rail-cols` columns, edge to edge
// with the questions above it. Whole class names, so Tailwind sees them.
const DATE_GRID =
  "min-[450px]:mx-0 min-[450px]:px-0 min-[450px]:overflow-visible min-[450px]:grid " +
  "min-[450px]:grid-cols-[repeat(var(--rail-cols),minmax(0,1fr))] min-[450px]:gap-1.5";

// Party sizes 1–10 on a phone: `--party-cols-phone` columns (partyColsPhone),
// from sm up the existing `--party-cols` rows.
const PARTY_GRID =
  "grid gap-1 sm:gap-1.5 grid-cols-[repeat(var(--party-cols-phone),minmax(0,1fr))] " +
  "sm:grid-cols-[repeat(var(--party-cols),minmax(0,1fr))]";

// Owner question Q2, online booking paused (the monthly limit): the default
// hides the pickers and shows ONE calm panel with the phone. The owner's
// alternative — the greyed date strip above the same message — is this one
// constant set to false: step 1 then renders as usual and the time area
// says "paused" with the phone. Either way the trust line, the step dots and
// the bottom button stay hidden while paused (nothing there leads anywhere).
const PAUSED_HIDES_PICKERS = true;

// The longest form_ms the page sends (a day) — the server clamps to the same
// (public_reservations.FORM_MS_MAX).
const FORM_MS_MAX = 86_400_000;

// The phone fold ladder (spec p1 §3.4.10 / owner Q5), measured with touch
// emulation, gate: first time row ≥ 8px above the bottom bar.
// Step 1: two rows of party chips put the first time row 4px above the bar at
// 375×667. Phone only: the step-1 gaps 24 → 20px, the party heading 10 → 8px
// and the chip gap 6 → 4px (PARTY_GRID) give back 12px. To undo: "space-y-6"
// / "mb-2.5".
// Step 2: the live house bistro's header is two rows taller than the first
// fixture (its address "Carl Th. Dreyers Vej 244, 2500 Valby" wraps the phone
// under it, and "Bistro Nørrebro (demo)" takes two lines): −16px at 375×667
// after step 1. So on a SHORT phone screen (≤ 700px tall, below sm) the 1–10
// grid is today's single swipe row instead, at 40px — standalone only (the
// embed frame is content-sized). Taller phones keep the two-row grid. To undo:
// drop PARTY_SHORT_RAIL / PARTY_CHIP_SHORT_RAIL. Never a chip under 40px.
// Booking R4: party chips are 44px on a phone, 40px from sm (PARTY_CHIP_H).
// The cost on this ladder, computed (the test campaign measures it): +8px for
// the two-row grid (390×844 had +177px of room, 402×874 more), +4px for the
// short-screen swipe row (375×667: the 28px it won back become 24px).
const STEP1_SPACING = "space-y-6 max-sm:space-y-5";
const PARTY_TITLE_GAP = "mb-2.5 max-sm:mb-2";
// Party chips: 44px on a phone — Apple's touch minimum, and inside a
// restaurant's page ours measured ~39px beside easyTable's 68px circles
// (comparison.md #5) — and 40px from sm, as before (booking R4). min-h-0!
// still releases the coarse-pointer floor, so the height is exactly this.
const PARTY_CHIP_H = "h-11! sm:h-10!";
// (Whole class names, so Tailwind sees them: the RAIL look, under the query.)
const PARTY_SHORT_RAIL =
  "max-sm:[@media(max-height:700px)]:flex max-sm:[@media(max-height:700px)]:gap-2 " +
  "max-sm:[@media(max-height:700px)]:overflow-x-auto max-sm:[@media(max-height:700px)]:snap-x " +
  "max-sm:[@media(max-height:700px)]:-mx-4 max-sm:[@media(max-height:700px)]:px-4 " +
  "max-sm:[@media(max-height:700px)]:scroll-px-4 max-sm:[@media(max-height:700px)]:pb-1 " +
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const PARTY_CHIP_SHORT_RAIL =
  "max-sm:[@media(max-height:700px)]:shrink-0 max-sm:[@media(max-height:700px)]:snap-start " +
  "max-sm:[@media(max-height:700px)]:w-[max(2.5rem,calc((100vw-4.5rem)/7.5))]";

// The "Other date" month grid — ONE render for the embed's inline copy and the
// phone/desktop sheet, so the two can never drift. It marks only what the
// page already knows (the 14-day summary): struck = closed, a dot = full,
// plain disabled = by phone; the aria says why and the legend names only the
// marks the month shows. No request of its own.
function DateCalendar({ value, min, max, dayMap, reasons, maxAdvance, party, apptWords, t, lang, onPick, onClose }) {
  return (
    // Padding on an inner box: the sheet sets its own side padding inline
    // (safe-area insets), which beats a class.
    <div className="px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-between mb-2">
        <p className={SECTION_TITLE}>{t("rsvpPickDate", "Pick a date")}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close", "Close")}
          className="-mr-2 w-10 h-10 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-200"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <Suspense fallback={<div className="h-[19rem]" aria-hidden="true" />}>
      <MonthCalendar
        value={value}
        min={min}
        max={max}
        isClosed={(iso) => (dayMap && iso in dayMap ? dayMap[iso] === false : undefined)}
        markOf={reasons ? (iso) => markOfReason(reasons[iso]) : undefined}
        onPick={onPick}
        locale={dateLocale(lang)}
        labels={{
          prev: t("rsvpPrevMonth", "Previous month"),
          next: t("rsvpNextMonth", "Next month"),
          stateOf: (iso) => ariaWord(reasons ? reasons[iso] : null, t, { party, apptWords }),
          notYet: (iso) => bookingOpensAria(iso, t, { maxAdvance, lang }),
          legend: calendarLegend(t, maxAdvance),
        }}
      />
      </Suspense>
    </div>
  );
}

// "HH:MM" from a provider-availability slot's ISO start (local time). Used to
// fold the {start,resource_id,...} provider slots into the same time-chip grid
// the table flow uses. Returns "" on a bad value (defensive).
function hhmmOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Date words (dateLocale, fmtDayShort, fmtDayLabel, capFirst) live in
// utils/guestLocale.js.

// "1 gæst" / "2 gæster" — the plural key alone produced "1 gæster". A business
// booked for a time (a salon, a shop, a workshop) counts people: "1 person".
function partyLabel(n, t, appt = false) {
  if (appt) return Number(n) === 1 ? t("rsvpPersonOne", "1 person") : t("rsvpPersonN", "{n} people", { n });
  return Number(n) === 1 ? t("rsvpPartyOne", "1 guest") : t("rsvpPartyN", "{n} guests", { n });
}

// The receipt's two actions (Calendar | Directions): one kind of button.
const RECEIPT_ACTION =
  "inline-flex items-center justify-center gap-2 h-12 px-5 rounded-xl text-sm font-medium " +
  "bg-white text-gray-800 border border-gray-200 hover:bg-gray-50 " +
  "dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors duration-200 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-2";

// The receipt's torn bottom edge: 16 teeth across a strip the card's colour.
const TORN_EDGE = `polygon(0% 0%, 100% 0%, ${Array.from({ length: 31 }, (_, i) => {
  const j = 31 - i;
  return `${(j * 3.125).toFixed(3)}% ${j % 2 ? 100 : 0}%`;
}).join(", ")}, 0% 0%)`;

// ── Venue identity tile ────────────────────────────────────────────
// The owner's uploaded brand logo (the SAME logo used on their invoices),
// served as a short-lived signed url from the public meta. Falls back to the
// typographic monogram when there's no logo — or if the image fails to load /
// the url has expired — so the header is never empty. The logo sits on a light
// tile (logos often carry transparency and need light contrast).
const BADGE_SIZES = {
  sm: { box: "w-8 h-8 rounded-[10px] text-[12px]", px: 32, icon: 14 },
  md: { box: "w-11 h-11 rounded-xl text-[15px]", px: 44, icon: 18 },
  // The desktop venue column.
  lg: { box: "w-16 h-16 rounded-2xl text-[20px]", px: 64, icon: 24 },
};

function VenueBadge({ logoUrl, name, size = "md" }) {
  const [broken, setBroken] = useState(false);
  // Each size reserves its box (CSS and the img's width/height), so a logo
  // that arrives late never moves the header.
  const { box, px, icon } = BADGE_SIZES[size] || BADGE_SIZES.md;
  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt=""
        width={px}
        height={px}
        decoding="async"
        onError={() => setBroken(true)}
        className={`shrink-0 ${box} object-contain bg-white ring-1 ring-gray-200 dark:ring-gray-700 p-1`}
      />
    );
  }
  // No uploaded logo → the monogram, as a soft neutral tile: a black square
  // with two letters read as a missing image, and a green one competed with
  // the green trust strip and the green button — three greens before the
  // guest had chosen anything. It stays the VENUE's monogram, never BonBox's
  // own mark — this is the restaurant's page, and wearing our logo on it
  // would be claiming their identity. A venue with no usable name gets a
  // quiet calendar mark instead of a stray "·".
  const monogram = name ? venueMonogram(name) : "";
  return (
    <div
      className={`shrink-0 ${box} bg-gray-100 text-gray-800 ring-1 ring-inset ring-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 flex items-center justify-center font-semibold tracking-tight select-none`}
      aria-hidden="true"
    >
      {monogram && monogram !== "·" ? monogram : (
        <Calendar size={icon} strokeWidth={1.75} className="text-gray-500 dark:text-gray-400" aria-hidden="true" />
      )}
    </div>
  );
}

// ── Venue header (booking push p3) ─────────────────────────────────
// Who the guest is booking with: the identity tile, the venue's name, where
// it is, how to call, the trust line and the opening hours. Module scope,
// like every subcomponent here, so a tap on a chip never remounts it (the
// badge keeps its broken-image state, the language pill its focus) and the
// hours item keeps its open state.
//   layout "card"   — the phone/tablet card header (and the embed).
//   layout "column" — the desktop venue column (≥ 1024px, never framed).
// A venue with no usable name (business_name null) gets no eyebrow and the
// plain "Book et bord" / "Book en tid" as its heading — never "BonBox",
// never a blank. `paused` hides the trust line in both layouts (C3), and
// the "Book et bord" eyebrow too: nothing can be booked online right now.
// The card's hours item follows PHONE_HOURS_ITEM (utils/venueHours, Q5).
//   `compact` (booking R4, the embed's &compact=1): the restaurant's own
//   website already shows its logo, name and address, so the header is one
//   row — the step dots (`dots`) and the DA/EN switch — over the trust line.
//   The venue's name stays the page's one h1 for a screen reader. On a
//   390×844 phone that puts "Vælg tid" above the fold under a host's sticky
//   header (comparison.md, E3/E7).
function VenueHeader({ page, t, lang, setLang, apptWords = false, step, layout = "card", isEmbed = false, todayIso, paused = false, compact = false, dots = null }) {
  const [hoursOpen, setHoursOpen] = useState(false);
  const name = page.business_name || null;
  const bookWords = apptWords ? t("rsvpBookATime", "Book an appointment") : t("rsvpBookATable", "Book a table");
  const showHours = !isEmbed && hasVenueWeek(page.hours);
  const cardHours = showHours && PHONE_HOURS_ITEM;
  const eyebrow = !!name && !paused;
  const where = page.address || page.city;
  const map = mapsHref(page.address, page.city);
  const tel = telHref(page.phone);
  const linkCls = "hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200";

  // The address: opens the map. min-h-8! (32pt): the global 44pt touch rule
  // sits outside Tailwind's layers, so only the important form beats it.
  // With a long address the number wraps under it, and two 44pt rows left a
  // loose gap. The finger still gets 44 px: an after: box 6 px above and
  // below what is drawn (walk 27 Oct G11; the hours toggle does the same).
  const HIT_44 = "relative after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] ";
  const addressItem = () => {
    if (!where) return null;
    const inner = (
      <>
        <MapPin size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{where}</span>
      </>
    );
    const cls = HIT_44 + "inline-flex items-center gap-1.5 max-w-full min-w-0 min-h-8! rounded-md " + FOCUS;
    return map ? (
      <a href={map} target="_blank" rel="noopener noreferrer" className={cls + " " + linkCls}>{inner}</a>
    ) : (
      <span className={cls}>{inner}</span>
    );
  };
  // Owner's contact number — tappable "call us" for big groups or
  // questions. tel: built from digits via encodeURIComponent.
  const phoneItem = () =>
    tel && (
      <a href={tel} className={HIT_44 + "inline-flex items-center gap-1.5 min-h-8! rounded-md " + linkCls + " " + FOCUS}>
        <Phone size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        <span className="tabular-nums whitespace-nowrap">{page.phone}</span>
      </a>
    );
  const trustText = t("rsvpTrustLine", "No account needed · Free cancellation");
  // The two objections a stranger has before booking — "do I need an
  // account?" and "am I locked in?" — answered before they scroll. As plain
  // grey body text it read as legalese and was skipped; on a quiet strip with
  // a green check it reads as reassurance. The strip itself is neutral: the
  // green is spent on the one main action. (The card and the compact header.)
  const trustStrip = (
    <div className="flex items-center gap-2 rounded-xl bg-gray-50 dark:bg-white/5 px-3.5 py-2">
      <Check className="w-4 h-4 shrink-0 text-bb-green" aria-hidden />
      <p className="text-[13px] font-medium leading-snug text-gray-700 dark:text-gray-300">{trustText}</p>
    </div>
  );

  if (compact && layout === "card") {
    return (
      <header data-testid="rsvp-compact-header" className="space-y-3">
        <h1 className="sr-only">{name || bookWords}</h1>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">{dots}</div>
          <LangPill lang={lang} setLang={setLang} />
        </div>
        {/* Step 1 only, and not while paused — as in the full header. */}
        {step === 1 && !paused && trustStrip}
      </header>
    );
  }

  if (layout === "column") {
    // The desktop venue column: the same facts, given room. The trust line
    // is a plain row here — the card's grey strip would vanish on the grey
    // ground the column stands on. The hours are always open.
    return (
      <div className="space-y-6">
        {/* The language switch is the booking card's, in its top row beside
            the steps (G10 item 2) — the column is the venue's alone. */}
        <div className="flex items-center gap-4">
          <VenueBadge logoUrl={page.logo_url} name={name} size="lg" />
        </div>
        <div className="space-y-1.5">
          {eyebrow && (
            <p className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">{bookWords}</p>
          )}
          <h1 className="text-[30px] leading-[1.1] font-semibold tracking-tight text-gray-900 dark:text-gray-100 break-words">
            {name || bookWords}
          </h1>
        </div>
        {(where || tel || !paused) && (
          <div className="flex flex-col items-start text-[13px] text-gray-500 dark:text-gray-400">
            {addressItem()}
            {phoneItem()}
            {!paused && (
              <p className="inline-flex items-center gap-1.5 min-h-8 font-medium text-gray-700 dark:text-gray-300">
                <Check className="w-3.5 h-3.5 shrink-0 text-bb-green" aria-hidden />
                <span>{trustText}</span>
              </p>
            )}
          </div>
        )}
        {showHours && (
          <VenueHoursList hours={page.hours} todayIso={todayIso} lang={lang} t={t} apptWords={apptWords} variant="panel" id="rsvp-venue-hours-week" />
        )}
      </div>
    );
  }

  return (
    <header className="space-y-3">
      {/* Top-aligned for a name (a two-line name starts at the tile's top);
          centred when the heading is one line with no eyebrow over it (a
          nameless or paused venue), so it doesn't hug the tile's top edge. */}
      <div className={"flex gap-3 " + (eyebrow ? "items-start" : "items-center")}>
        {/* Identity tile — the owner's uploaded brand logo when they have
            one, else a typographic monogram derived from the name. */}
        <VenueBadge logoUrl={page.logo_url} name={name} />
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">{bookWords}</p>
          )}
          {/* 21 px on step 1 — the page's own scale (11 / 13 / 15 / 18 / 21),
              with Inter's optical tracking at that size (was 22 px). */}
          <h1
            className={
              "font-semibold text-gray-900 dark:text-gray-100 leading-[1.1] line-clamp-2 " +
              (step === 1 ? "text-[21px] tracking-[-0.0175em]" : "text-lg tracking-tight")
            }
          >
            {name || bookWords}
          </h1>
        </div>
        {/* The page adopts the venue's own language, which is right for
            the guests who live nearby and wrong for everyone else. A
            tourist booking a Copenhagen table had no way out of Danish:
            the app's language control lives behind the login, and this
            page carries none. Two words, no flags — a flag is a country,
            not a language. Choosing here also clears the auto-pick, so
            the choice survives through to the confirmation. */}
        <LangPill lang={lang} setLang={setLang} />
      </div>

      {/* Where it is, how to reach it and when it is open — one quiet row.
          As two text rows each 44pt touch target left a gap between the
          address and the number; as bordered pills they were the loudest
          thing in the header. Here they keep a 32pt target but read as the
          light detail they are: the address opens the map, the number
          dials, the hours open the week. The phone and the hours share one
          wrapping group, so a long address wraps them together onto ONE
          second line — the row never grows past the two-line shape the
          19 Oct walk measured (fold budget). Step 1 only — on the details
          step the form starts high. Not in the embed: compact as before. */}
      {step === 1 && (where || tel || cardHours) && (
        <div className="flex flex-wrap items-center gap-x-4 text-[13px] text-gray-500 dark:text-gray-400">
          {addressItem()}
          {(tel || cardHours) && (
            <span className="inline-flex flex-wrap items-center gap-x-4">
              {phoneItem()}
              {cardHours && (
                <VenueHoursToggle
                  hours={page.hours}
                  todayIso={todayIso}
                  t={t}
                  apptWords={apptWords}
                  open={hoursOpen}
                  onToggle={() => setHoursOpen((v) => !v)}
                  focusClass={FOCUS}
                />
              )}
            </span>
          )}
        </div>
      )}
      {step === 1 && cardHours && hoursOpen && (
        <VenueHoursList hours={page.hours} todayIso={todayIso} lang={lang} t={t} apptWords={apptWords} variant="inline" id="rsvp-venue-hours" />
      )}

      {/* The trust line (trustStrip). Not while online booking is paused:
          it advertises a booking that isn't possible right now. */}
      {step === 1 && !paused && trustStrip}
    </header>
  );
}

// ── Slot period grouping (biggest UX lever) ────────────────────────
// The backend returns a flat, sorted list of "HH:MM" strings. We bucket
// them CLIENT-SIDE into three named periods by the hour so a long list
// reads as a scannable menu instead of a wall of chips:
//   • Frokost     — before 15:00
//   • Eftermiddag — 15:00 … 16:59
//   • Aften       — 17:00 and later
// Returns an ordered array of { key, slots } — only non-empty groups.
const SLOT_GROUP_DEFS = [
  { key: "lunch", labelKey: "rsvpGroupLunch", test: (h) => h < 15 },
  { key: "afternoon", labelKey: "rsvpGroupAfternoon", test: (h) => h >= 15 && h < 17 },
  { key: "dinner", labelKey: "rsvpGroupDinner", test: (h) => h >= 17 },
];
// A salon, a shop or a workshop books a time, not a meal: the day's parts —
// Formiddag (before 12), Eftermiddag (12–17), Aften (17 and later). Its
// customers met "Frokost" over 02:00–14:45 (QA item 8, Push 8 review).
const APPT_SLOT_GROUP_DEFS = [
  { key: "morning", labelKey: "rsvpGroupMorning", test: (h) => h < 12 },
  { key: "afternoon", labelKey: "rsvpGroupAfternoon", test: (h) => h >= 12 && h < 17 },
  { key: "evening", labelKey: "rsvpGroupEvening", test: (h) => h >= 17 },
];

function groupSlots(slots, apptWords = false) {
  const defs = apptWords ? APPT_SLOT_GROUP_DEFS : SLOT_GROUP_DEFS;
  const buckets = Object.fromEntries(defs.map((g) => [g.key, []]));
  for (const s of slots) {
    // Defensive parse — only well-formed "HH:MM" strings are bucketed.
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
    if (!m) continue;
    const hour = parseInt(m[1], 10);
    if (Number.isNaN(hour)) continue;
    const def = defs.find((g) => g.test(hour));
    if (def) buckets[def.key].push(s);
  }
  return defs.map((g) => ({
    key: g.key,
    labelKey: g.labelKey,
    slots: buckets[g.key],
  })).filter((g) => g.slots.length > 0);
}

// ── Safe outbound links ────────────────────────────────────────────
// SECURITY: build tel:/maps hrefs from venue-supplied strings via
// encodeURIComponent, never raw concatenation. The phone is stripped to
// digits + a leading "+" for the tel: scheme; the maps query is a single
// encoded component. JSX never renders these as HTML.
function telHref(phone) {
  if (!phone) return null;
  // Keep digits and a single leading +. Drop spaces, parens, dashes.
  const cleaned = String(phone).replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  return `tel:${encodeURIComponent(cleaned)}`;
}

function mapsHref(address, city) {
  const q = venueAddress(address, city);
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export default function ReservationPublicPage() {
  const { slug: routeSlug } = useParams();
  // The slug the page ASKS with (walk 27 Oct P3-4). Opened on an old link,
  // the venue's first answer names the current one (R9): from then on the
  // page asks with that, and the address bar moving there is the same venue,
  // so nothing is asked twice (it was 9 requests instead of 3). Any other
  // address is another venue, asked about as before.
  const [asking, setAsking] = useState(() => ({
    route: routeSlug,
    slug: peekBootPage(routeSlug)?.canonical_slug || routeSlug,
  }));
  const sameVenue = routeSlug === asking.route || routeSlug === asking.slug;
  if (!sameVenue) setAsking({ route: routeSlug, slug: routeSlug });
  const slug = sameVenue ? asking.slug : routeSlug;
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, lang, setLang } = useLanguage();
  const confirm = useConfirm();
  // A guest page: no consent banner over the booking form (lib/guestSurface).
  // Layout effect, so the mark is set before CookieConsent's own effect runs.
  useLayoutEffect(() => markGuestSurface(), []);

  // The action bar rides ABOVE the on-screen keyboard. `position: fixed;
  // bottom: 0` pins it to the layout viewport, which iOS does not shrink for
  // the keyboard — so it sat under the keyboard's form strip, half-covered.
  // The visual viewport is the only API that reports the visible box; the
  // inset it yields lifts the bar clear (same measurement as ui/Sheet.jsx).
  // It follows the KEYBOARD, not focus: an Android back-gesture closes the
  // keyboard without blurring the field, and a bar tied to focus stayed
  // hidden with no way to confirm.
  const kbInset = useKeyboardInset();
  // With the keyboard up, the bar rides on it — make sure the field being
  // typed in is not hidden behind the bar (iOS scrolls it into view against
  // the keyboard only).
  const barRef = useRef(null);
  useEffect(() => {
    if (!kbInset) return undefined;
    const keepClear = () => {
      const el = document.activeElement;
      const vv = window.visualViewport;
      if (!el || !vv || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      const barH = barRef.current?.getBoundingClientRect().height || 0;
      const visibleBottom = vv.offsetTop + vv.height - barH - 8;
      const r = el.getBoundingClientRect();
      if (r.bottom > visibleBottom) window.scrollBy({ top: r.bottom - visibleBottom, behavior: "smooth" });
    };
    const t1 = setTimeout(keepClear, 320);
    document.addEventListener("focusin", keepClear);
    return () => {
      clearTimeout(t1);
      document.removeEventListener("focusin", keepClear);
    };
  }, [kbInset]);


  // Embedded in an owner's website (iframe, ?embed=1): drop the forced
  // min-h-screen so the widget sizes to its content inside the frame instead
  // of padding out a full viewport of whitespace. Everything else is
  // identical — the flow is the same, just framed.
  const isEmbed = searchParams.get("embed") === "1";
  const rootMinH = isEmbed ? "" : "min-h-screen";
  // Desktop (≥ 1024px): the venue in a column beside the booking card. Never
  // in the embed or inside someone else's frame (the page can be framed
  // without ?embed=1). Read here, above every early return, so the hook
  // order never changes between the loading and the loaded render.
  const framed = useMemo(() => isFramed(), []);
  const wideQuery = useMediaQuery("(min-width: 1024px)");
  const wide = wideQuery && !isEmbed && !framed;

  // Embedded = always LIGHT, whatever theme this browser stored: the frame
  // sits in the owner's (light) website, and the owner's dark-mode preview of
  // it must show what guests get. Layout effect, so the first paint after a
  // client-side mount is already light. See forceLightTheme (utils/themeColor).
  useLayoutEffect(() => (isEmbed ? forceLightTheme() : undefined), [isEmbed]);

  // ── One elevation in the embed (booking R3, judge change 4) ──────
  // From 450 px the embedded booking is ONE white card on the restaurant's
  // own ground: <html> and <body> go transparent (index.css, .bb-embed-card),
  // `main` gets 16 px corners, a 5 % ring and one soft shadow, and the frame
  // pads it (padding, not margin, so the posted height includes the card and
  // its shadow is never cut). Below 450 px the widget IS the page there, so
  // it stays flat. `&flat=1` (the owner's kit offers it) keeps the flat look
  // for a website that already frames the booking.
  const flat = searchParams.get("flat") === "1";
  const embedCard = isEmbed && !flat;
  // Booking R4: the compact header (&compact=1) — embed only. The owner's kit
  // offers it and a new snippet carries it by default; a snippet pasted
  // before R4 has no such parameter and keeps the full header.
  const compactHead = isEmbed && searchParams.get("compact") === "1";
  useLayoutEffect(() => {
    if (!embedCard || typeof document === "undefined") return undefined;
    const root = document.documentElement;
    root.classList.add("bb-embed-card");
    return () => root.classList.remove("bb-embed-card");
  }, [embedCard]);

  // ── Height morph on the step area (judge change 11) ──────────────
  // A service switch, a closed-day message or the next step eases to its new
  // height instead of jumping — inside a restaurant's website the jump moved
  // their whole page. Callback ref: the step area mounts after the loading
  // screen. Off under reduced motion (useAutoHeight).
  const [stepArea, setStepArea] = useState(null);
  useAutoHeight(stepArea);

  // ── Height contract with the host page ───────────────────────────
  // The embed snippet ships a fixed height="720". That number is wrong
  // for every single site: on a phone the form is cut off mid-way with
  // no inner scrollbar to reveal it, and on a desktop with a short
  // opening list it leaves a few hundred pixels of dead white space in
  // the middle of the owner's page. Neither looks like a bug to the
  // owner — it looks like BonBox is what their site now is.
  //
  // So the frame tells the parent how tall it actually is, and keeps
  // telling it as the guest moves between steps (step 2 is taller than
  // step 1, and the confirmation is shorter than both).
  //
  // targetOrigin is "*" ON PURPOSE and is safe here: we do not know the
  // owner's domain, the payload is a single integer, and it carries
  // nothing private. Never widen this to send booking data.
  useEffect(() => {
    if (!isEmbed || typeof window === "undefined" || window.parent === window) return;
    // Only speak when the number changes. ResizeObserver fires on every
    // layout pass, and re-posting an unchanged height would have the host
    // page reassigning the same style on a loop for as long as the widget
    // is open — on someone else's site, at their expense.
    let last = 0;
    const post = () => {
      const h = Math.ceil(
        document.documentElement?.getBoundingClientRect?.().height || 0,
      );
      if (h > 0 && h !== last) {
        last = h;
        window.parent.postMessage({ type: "bonbox:height", height: h }, "*");
      }
    };
    post();
    // ResizeObserver catches step changes, validation messages appearing,
    // and the slot grid reflowing — a resize listener alone would not.
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(post) : null;
    if (ro && document.body) ro.observe(document.body);
    window.addEventListener("resize", post);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", post);
    };
  }, [isEmbed]);

  // ── Page data (GET /public/reservations/{slug}) ──────────────────
  // Booking R5: index.html asked for it while the code was downloading. When
  // that answer is ALREADY here, the first render is the page itself — no
  // skeleton frame — with step 1 seeded in the same state (seedStep1 below).
  const [bootPage] = useState(() => peekBootPage(routeSlug));
  const bootSeeded = useRef(bootPage ? slug : null);
  // This venue's answer, already in state, that came on its OLD link (P3-4).
  const landed = useRef(null);
  const [page, setPage] = useState(bootPage);
  const [loading, setLoading] = useState(!bootPage);
  const [loadError, setLoadError] = useState(""); // "" | "closed" | "generic"

  // ── The venue's own colour (booking R5) ───────────────────────────
  // business_profile.accent_color, chosen by the owner in settings (never
  // from the link: a ?accent= cannot repaint the page). The picked chips and
  // the main button wear it, with the text picked by contrast
  // (utils/accentColor.js) — a light gold gets the ink, never white. No
  // colour → null → BonBox's own look, exactly as before.
  const accent = useMemo(() => accentTokens(page?.accent_color), [page?.accent_color]);

  // ── Step state ───────────────────────────────────────────────────
  const [step, setStep] = useState(1); // 1 = date+party+slot, 2 = details

  // Step 1 selections. Pre-fill from ?d=YYYY-MM-DD&party=N if present.
  const today = useMemo(() => isoDay(new Date()), []);
  // Seeded with the page when index.html's answer was already here (R5) —
  // the same seed the load effect gives a page that arrives later.
  const [firstSeed] = useState(() =>
    bootPage
      ? seedStep1(bootPage, { d: searchParams.get("d"), party: searchParams.get("party") }, isoDay(new Date()))
      : null,
  );
  const [day, setDay] = useState(firstSeed ? firstSeed.day : "");
  const [party, setParty] = useState(firstSeed ? firstSeed.party : 2);
  const [slot, setSlot] = useState("");
  // The one-tap date strip is the primary picker; the native date field is a
  // quiet escape hatch for a far-out date, revealed on demand so it never
  // clutters the default view (premium via subtraction).
  const [showDateInput, setShowDateInput] = useState(false);
  // Where the embed draws its inline calendar: under the date strip ("header"
  // — the "Anden dato" next to the date heading), or right under the "Anden
  // dato" in the empty time area ("empty"). Opened from down there, a calendar
  // under the strip appeared ~300px above the tap, in a frame that never
  // scrolls, and the button jumped down by its height.
  const [calendarAt, setCalendarAt] = useState("header");

  // Availability for the current day+party.
  const [slots, setSlots] = useState([]);
  // Per-slot scarcity from the server: { "19:00": 2 }. Real counts from the
  // same engine pass that decided the slot was bookable — never a guess. Left
  // empty when the backend does not send them, in which case NO hint is shown
  // rather than an invented one.
  const [slotRemaining, setSlotRemaining] = useState({});
  const [groupRequest, setGroupRequest] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  // "not_accepting" when the venue is at its plan's monthly booking ceiling.
  // Distinct from slotsError (a fetch failure) and from an empty slots array
  // (a closed or fully-booked day) — this one means no date will work, so the
  // date strip must not invite the guest to keep hunting.
  const [closedReason, setClosedReason] = useState("");
  // The .ics hand-off can silently deliver nothing inside a mobile
  // browser, and the guest has no other copy of the booking time.
  const [calError, setCalError] = useState("");

  // 14-day open/closed map for the date strip + next-open-day auto-advance.
  // dayMap === null → the summary hasn't resolved yet (show loading, never a
  // premature "no times"). nextOpenDay drives the "closed today" nudge.
  const [dayMap, setDayMap] = useState(null);
  const [nextOpenDay, setNextOpenDay] = useState(null);
  // The owner's own words for a day they closed for online booking (R1):
  // {date: {note, kind}}, from the summary. Shown verbatim as the reason.
  const [dayClosures, setDayClosures] = useState({});
  // Bumped to ask for the date strip again — after a 409 date_closed the
  // strip must show the day the owner just closed.
  const [summaryNonce, setSummaryNonce] = useState(0);
  // Why each of those days can't be booked, from the same summary, keyed by
  // the party it was asked for: {party, reasons: {iso: reason | null}}. Read
  // through `dayReasons` below, which is null (unknown) while the summary for
  // THIS party is not in — the old party's "kun tlf." never sits under the
  // new party's number during a refetch. null = not in yet, or the summary
  // failed: the page then names nothing and never says "lukket".
  const [reasonsFor, setReasonsFor] = useState(null);
  // The selected day's reason from /availability or /provider-availability,
  // keyed {key: "day|party|behandlingId|stylistId", reason}: a late answer for
  // another day or party can never show its reason here (build plan C5 —
  // p2 and p4 add their fields to this one object).
  const [availMeta, setAvailMeta] = useState(null);
  // R12: the day the guest picked themselves (a tap, the calendar, a ?d=
  // link) — a full one stays picked (utils/bookingDay.rescueDay).
  const pickedDay = useRef(searchParams.get("d") || "");
  // Online booking is paused (the venue can't take online bookings now — the
  // server says "not_accepting" and never why). Set by the summary,
  // /availability, /provider-availability or a 409; it stays for the rest of
  // the visit. Step 1 then shows ONE calm panel with the phone instead of
  // pickers and a "Pick a time" button with nowhere to go (owner Q2).
  const [paused, setPaused] = useState(false);

  // ── Salon (provider) booking state (S3b) ─────────────────────────
  // A provider venue reorders step 1 to behandling → behandler → dato → tid.
  // Slots come from .../provider-availability (keyed by behandling_id +
  // optional stylist_id), so we keep the picked stylist's resource_id (for
  // the submit + the recap) alongside the slot times. Table venues never
  // touch any of this — provider is an additive branch.
  const isProvider = !!page && bookingModeFor(page.business_type) === "provider";
  // The WORDS this page speaks (venueProfiles.speaksAppointments): a salon, a
  // shop or a repair trade is booked for a time — "Book tid", never "Book
  // bord" (vertical-fit review, Oct 2026). Wording only; `isProvider` stays
  // the booking engine switch.
  const apptWords = !!page && speaksAppointments(page.business_type);
  // A shop or a workshop (an appointment business that is not the salon):
  // no kitchen, no occasion — its customers are asked no allergies and no
  // dinner occasion, only a note (Push 8 review: a bike workshop's page
  // offered the 14 EU food allergens "so the kitchen can plan" and
  // "Forretningsmiddag").
  const noteOnly = apptWords && !isProvider;
  // R12: a full night is a choice here (the owner's waitlist switch is on,
  // and guests book tables).
  const waitFull = !!page?.waitlist_on && !isProvider && !apptWords;
  const [behandlinger, setBehandlinger] = useState([]);
  const [behandlingId, setBehandlingId] = useState("");
  const [stylistId, setStylistId] = useState(""); // "" = Valgfri behandler
  // Distinct behandlere (resource_id → display name) the provider-availability
  // response surfaces, for the behandler picker + recap. The public page
  // exposes no separate stylist roster, so names come from the page payload's
  // optional `providers` list when present (forward-compatible); we always
  // offer "Valgfri behandler" as the honest default.
  const providers = useMemo(
    () => (Array.isArray(page?.providers) ? page.providers : []),
    [page],
  );
  const providerNameById = useMemo(() => {
    const m = {};
    providers.forEach((p) => {
      m[String(p.id)] = p.name || p.label || "";
    });
    return m;
  }, [providers]);

  // ── 2D floor map: tables for the chosen slot + the guest's tapped table ──
  // The booker picks a real table on the same room the owner arranges. A pick
  // is a PREFERENCE — the server re-checks and auto-assigns if it's gone.
  const [floor, setFloor] = useState([]); // [{id,label,capacity_seats,zone,shape,pos_x,pos_y,status}]
  const [floorLoading, setFloorLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState(null); // resource_id | null

  // Step 2 — guest details.
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  // Which channel the guest is filling in. The form used to show BOTH fields
  // with a line underneath saying only one was needed — so a stranger read two
  // required-looking boxes and had to work out that they were not. One choice,
  // one field. Both values stay in state, so flipping back and forth never
  // discards what was typed, and submission still sends whatever is filled.
  const [contactMode, setContactMode] = useState("email");
  const [occasion, setOccasion] = useState("");
  const [guestNotes, setGuestNotes] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  // At least one contact channel is required so the guest can actually be
  // confirmed — a name-only booking would leave us unable to reach them.
  const [contactTouched, setContactTouched] = useState(false);

  // Step 2 — ONE optional disclosure collapses occasion + notes + the
  // allergy block. Default closed: only name (+ secondary email/phone) show
  // first, keeping the form short and the required surface minimal.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Optional allergy block (invite, not require) — lives inside the
  // disclosure above. allergenTags etc. carry the user's selections.
  const [allergenTags, setAllergenTags] = useState([]); // array of keys
  // No default. It used to start at "preference", so a guest who ticked
  // peanuts and moved on was recorded as having a preference, not an allergy.
  // Unanswered, nothing is claimed and the kitchen sees the allergen as is.
  const [allergySeverity, setAllergySeverity] = useState("");
  const [allergyNote, setAllergyNote] = useState("");

  // What the collapsed disclosure says it is holding. Without this, folding the
  // block away hides a filled-in allergy behind a generic "add a message"
  // label, and the guest cannot tell whether the kitchen was told.
  const extrasSummary = useMemo(() => {
    const bits = [];
    if (occasion) bits.push(t(`rsvpOccasion_${occasion}`, OCCASION_FALLBACK[occasion]));
    if (allergenTags.length) {
      bits.push(
        allergenTags.length === 1
          ? t("rsvpExtrasOneAllergen", "1 allergi")
          : t("rsvpExtrasNAllergens", "{n} allergier").replace("{n}", allergenTags.length),
      );
    }
    if (allergyNote.trim()) bits.push(t("rsvpExtrasAllergyNote", "allergi-note"));
    if (guestNotes.trim()) bits.push(t("rsvpExtrasNote", "besked"));
    return bits.join(" · ");
  }, [occasion, allergenTags, allergyNote, guestNotes, t]);

  // GDPR — marketing consent default OFF.
  const [consentMarketing, setConsentMarketing] = useState(false);

  // Submit.
  const [submitting, setSubmitting] = useState(false);
  // Focus target for the confirmation headline — see the success screen.
  const resultHeadingRef = useRef(null);
  const [submitError, setSubmitError] = useState(""); // "" | error-key
  // A refusal said UNDER the main button is a tap that changed nothing (walk
  // 27 Oct P3-1: at 390×844 the details step's "For mange forsøg…" drew at
  // 770 px, under the fixed bar at 767, page unscrolled). Whichever box says
  // it (step 1's or the details step's) is brought up clear of the bar.
  const submitErrorBoxRef = useRef(null);
  useEffect(() => {
    const box = submitErrorBoxRef.current;
    if (!submitError || !box) return;
    const vv = window.visualViewport;
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const barTop = barRef.current ? Math.min(barRef.current.getBoundingClientRect().top, viewBottom) : viewBottom;
    const r = box.getBoundingClientRect();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const by = r.bottom > barTop - 8 ? r.bottom - (barTop - 8) : r.top < 0 ? r.top - 16 : 0;
    if (by) window.scrollBy({ top: by, behavior: reduce ? "auto" : "smooth" });
  }, [submitError, step]);
  const [result, setResult] = useState(null); // {id, status, booking_token}
  // The booking a link points at (email self-cancel link, reload, bookmark):
  // {day, time, party, name} from the server, rendered on the receipt instead
  // of the empty form state.
  const [linked, setLinked] = useState(null);
  // A booking the guest has left with "Book again". The address bar is
  // cleared in the same tap, but that lands a render later — without this
  // the link effect saw the old ?booking= once more and re-opened the
  // cancelled receipt.
  const leftBooking = useRef(null);
  // null (booked here) | "loading" | "ok" | "failed" — a link that no
  // longer resolves must never render as "Reservation confirmed".
  const [linkState, setLinkState] = useState(null);

  // The two steps are a real history entry (#details), so the phone's Back
  // gesture returns to the choices instead of leaving the page and every pick
  // with it. The in-page ways back consume that entry, so Back never becomes
  // a dead press.
  const navigate = useNavigate();
  const location = useLocation();
  // "Pick a time" in the bar: bring the times into view and put focus on the
  // first one, so a keyboard or screen-reader user lands in the right place.
  const revealTimes = () => {
    const heading = document.getElementById("rsvp-times");
    if (!heading) return;
    // Focus first, without scrolling: a focus() issued during a smooth scroll
    // cancels it in Chrome.
    heading.parentElement?.querySelector('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    // Scroll only when the times sit low enough that the grid is out of view.
    if (heading.getBoundingClientRect().top > window.innerHeight * 0.4) {
      heading.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
    // When they are already on screen the tap did nothing visible: one small
    // ripple across the times says "these". Skipped under reduced motion.
    if (!reduce) {
      heading.parentElement?.querySelectorAll('[role="radio"]').forEach((chip, i) => {
        chip.animate?.(
          [{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }],
          { duration: 360, delay: Math.min(i, 16) * 16, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      });
    }
  };
  const goToDetails = () => {
    setStep(2);
    if (location.hash !== "#details") {
      navigate({ pathname: location.pathname, search: location.search, hash: "#details" });
    }
  };
  const backToChoices = () => {
    setSubmitError("");
    if (location.hash === "#details") navigate(-1);
    else setStep(1);
  };
  useEffect(() => {
    if (location.hash !== "#details") setStep((s) => (s === 2 ? 1 : s));
  }, [location.hash]);
  // A reload on #details has lost the picks — start clean on the choices.
  useEffect(() => {
    if (location.hash === "#details") {
      navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    }
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each step starts at the top with focus on its heading: Continue used to
  // open step 2 scrolled halfway down (the venue and the recap cut off), with
  // focus left on the bar. preventScroll — in the embed iframe, focus()
  // would otherwise scroll the restaurant's own page.
  const stepFocusRef = useRef(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* noop */
    }
    stepFocusRef.current?.focus?.({ preventScroll: true });
  }, [step]);

  // Move focus to the confirmation once, when the booking first lands.
  // Keyed on the id, not the object: the status poll replaces `result`
  // every few seconds, and re-focusing on each poll would yank the cursor
  // out from under a guest who had tabbed on to the cancel button.
  const resultId = result?.id || null;
  useEffect(() => {
    if (resultId) resultHeadingRef.current?.focus();
  }, [resultId]);

  // ── Post-booking live status + self-cancel ───────────────────────
  // After a successful booking the success screen polls GET /booking/{id}
  // so a "requested" group booking flips live to confirmed / declined,
  // and offers an "Aflys reservation" self-cancel (POST .../cancel).
  // `liveStatus` is the authoritative status once polling starts; before
  // that we fall back to the create response's status.
  const [liveStatus, setLiveStatus] = useState(null); // null | backend status
  // The status a booking had when the guest cancelled it here — tells a
  // withdrawn REQUEST from a cancelled booking, also on a receipt reopened
  // from its link (where the create response is not there to ask).
  const [cancelledFrom, setCancelledFrom] = useState(null);
  // How a cancelled booking ended, as the server tells it: "withdrawn",
  // "declined", "cancelled_by_guest" or "cancelled_by_venue". A request the
  // venue DECLINED used to read "Request withdrawn — thanks for letting us
  // know", and a withdrawal reopened from its link read "cancelled".
  const [liveOutcome, setLiveOutcome] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(false);

  // Success-hero entrance: a single, brief fade-scale on the status icon
  // (≤300ms — no confetti). Starts false; flips true one frame after the
  // success screen mounts so the CSS transition runs once.
  const [heroIn, setHeroIn] = useState(false);
  useEffect(() => {
    if (!result?.id) return;
    const raf = requestAnimationFrame(() => setHeroIn(true));
    return () => cancelAnimationFrame(raf);
  }, [result]);

  // ── Load the page data ───────────────────────────────────────────
  // The link's ?d= and ?party=, as they are when the page data lands (a ref,
  // so a later address change — "Book again" clearing ?booking= — does not
  // refetch the venue).
  const seedParams = useRef(searchParams);
  useEffect(() => {
    seedParams.current = searchParams;
  }, [searchParams]);
  useEffect(() => {
    let alive = true;
    // Already in state from index.html's answer (R5): nothing to fetch for
    // this venue. Said once; a later venue (or a remount) fetches as before.
    if (landed.current === slug) {
      landed.current = null;
      return undefined;
    }
    if (bootSeeded.current === slug) {
      bootSeeded.current = null;
      markBootPageUsed();
      // R9 on the boot path too: a page index.html already fetched on an
      // OLD link still moves the address bar to the current one.
      const to = canonicalPath(location.pathname, bootPage?.canonical_slug);
      if (to) navigate({ pathname: to, search: location.search, hash: location.hash }, { replace: true });
      return undefined;
    }
    // No synchronous setLoading(true) — initial useState(true) covers
    // first mount; the .finally below flips it (keeps the effect free of
    // React 19's set-state-in-effect rule, matching EventPublicPage).
    bootOr("page", { slug }, () => api.get(`/public/reservations/${slug}`))
      .then((r) => {
        if (!alive) return;
        const data = r?.data || null;
        setPage(data);
        setLoadError("");
        // R9: opened on an OLD link (the owner changed it): the server
        // names the current one and the address bar moves there — query
        // and hash kept, /r/ kept for the embed. Nothing else changes.
        const to = canonicalPath(location.pathname, data?.canonical_slug);
        if (to && data.canonical_slug !== slug) {
          // P3-4: this answer IS the current link's venue — the page asks
          // with that link from now on and never asks for the page again.
          landed.current = data.canonical_slug;
          setAsking((a) => ({ route: a.route, slug: data.canonical_slug }));
        }
        if (to) navigate({ pathname: to, search: location.search, hash: location.hash }, { replace: true });
        // Step 1's first answers in the SAME update as the page (booking R3):
        // the date strip's first paint already shows the day chosen. Seeded
        // by an effect after that paint, today's chip faded from white to ink
        // ~650 ms into every load (judge 24 Oct). Seeded once per venue load;
        // the guest's own picks own the state after that.
        if (data) {
          const q = seedParams.current;
          const seed = seedStep1(data, { d: q?.get?.("d") ?? null, party: q?.get?.("party") ?? null }, today);
          setDay(seed.day);
          setParty(seed.party);
        }
      })
      .catch((err) => {
        if (!alive) return;
        if (err?.response?.status === 410) {
          setLoadError("closed");
        } else {
          setLoadError("generic");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Only a new slug loads the page again; the location is read for the
    // old-link move (R9) and must not refetch on a #details hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, today]);

  // ── Deep-link self-cancel from the email ─────────────────────────
  // ?booking=<id>&token=<jwt> seeds `result` so the existing success
  // screen + Aflys button render and the token flows into poll/cancel
  // (bookingToken() prefers result.booking_token). No new route or
  // component — reuses the whole token-cancel flow.
  useEffect(() => {
    if (result?.id) return; // booked in-session — don't clobber
    const bid = searchParams.get("booking");
    const tok = searchParams.get("token");
    if (!bid || !tok || bid === leftBooking.current) return;
    setResult({ id: bid, booking_token: tok, status: null });
    setLinkState("loading");
    api
      .get(`/public/reservations/booking/${bid}`, { params: { token: tok } })
      .then((r) => {
        const b = r?.data || {};
        setLinkState("ok");
        setLiveStatus(b.status || null);
        setLiveOutcome(b.outcome || null);
        const [d, tm] = String(b.starts_at || "").split("T");
        setLinked({
          day: d || "",
          time: tm ? tm.slice(0, 5) : "",
          party: b.party_size || null,
          name: b.guest_name || "",
          occasion: b.occasion || "",
          allergenTags: Array.isArray(b.allergen_tags) ? b.allergen_tags : [],
          allergySeverity: b.allergy_severity || "",
          // The booking's own length, for the calendar file (R2).
          durationMin: b.duration_min || null,
          // F5: a request's "svar senest …" — the server's own deadline.
          answerBy: b.answer_by || null,
        });
      })
      .catch(() => {
        setLiveStatus(null);
        setLinkState("failed"); // expired or mistyped link — say so, offer a way on
      });
  }, [searchParams, result]);

  // ── ?lang= from an email link wins: the guest's own language ─────────
  useEffect(() => {
    const q = searchParams.get("lang");
    if ((q === "da" || q === "en") && setLang) setLang(q);
    // Mount only — a later switch by the guest must not be undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Default the public page to the venue's language ───────────────
  // A DK restaurant should greet any visitor in Danish (da-DK) by default
  // — the backend resolves the venue language (`page.language`) from the
  // owner's country / timezone. We only apply it when the visitor has NOT
  // made an EXPLICIT language choice. "Explicit" = a stored `lang` with the
  // `bonbox_lang_auto_picked` flag CLEARED (setLang() removes that flag on a
  // real pick; the first-visit auto-detect sets it). If the flag is present
  // — or nothing is stored — the current lang is an auto-guess we may refine
  // to the venue default. Tax / receipt / DK-terminology strings stay Danish
  // regardless (terminology lock); this only sets the UI chrome language.
  useEffect(() => {
    const venueLang = page?.language;
    if (!venueLang || !setLang) return;
    let explicitChoice = false;
    try {
      const stored = localStorage.getItem("lang");
      const autoPicked = localStorage.getItem("bonbox_lang_auto_picked");
      // Explicit only when a lang is stored AND it was NOT auto-picked.
      explicitChoice = !!stored && !autoPicked;
    } catch {
      // Private mode / storage blocked → treat as no explicit choice.
      explicitChoice = false;
    }
    if (!explicitChoice) setLang(venueLang);
    // Run once per resolved venue language; a later explicit switch by the
    // visitor persists (setLang clears the auto flag) and is never clobbered
    // because page.language doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.language]);

  // ── Step-1 selections ─────────────────────────────────────────────
  // Seeded with the page data itself (the load effect above, seedStep1 in
  // utils/bookingDay.js): the link's ?d= when it is a real day inside the
  // booking window (the backend's reading: a stored 0 = today only), else
  // today; a salon, a shop or a workshop is booked by one customer — the page
  // does not ask how many (vertical-fit, Push 8) — so a ?party=4 link does not
  // set a party the customer cannot see or change, and the open days (asked
  // for one) agree with the times and the booking.

  // ── 14-day open/closed overview → auto-advance off a closed day ────
  // Table AND provider venues. A salon used to skip it, so on a closed Monday
  // its page said "Ingen ledige tider de næste 14 dage" while Tuesday–Saturday
  // were bookable (vertical-fit audit, Oct 2026). A provider asks for ONE
  // person: an appointment chair seats one, and party 2 would read every day
  // as closed. Fetches the same available_slots() the diner sees, so the
  // strip can't disagree. If the seeded day (today, or a ?d= link) has NO slots
  // but the week does, we jump to the next open day — killing the dead-end where
  // "closed today" showed "No available times" with no way forward. Fail-soft:
  // on error dayMap stays null and the single-day flow + phone fallback still run.
  // One person for a salon, a shop or a workshop — as the page asks.
  const summaryParty = isProvider || apptWords ? 1 : (party || 2);
  // A salon's strip counts the service the customer chose (R6): a 90-minute
  // colour does not fit a day whose only gap is 45 minutes. Before a choice
  // the server counts the shortest service the salon offers.
  const summaryService = isProvider && behandlingId ? String(behandlingId) : "";
  useEffect(() => {
    if (!page) return;
    let alive = true;
    // The strip's question, with the chosen service when there is one (R6).
    const askSummary = () =>
      api.get(`/public/reservations/${slug}/availability-summary`, {
        params: {
          from: today, days: 14, party: summaryParty,
          ...(summaryService ? { behandling_id: summaryService } : {}),
        },
      });
    // R5: index.html may have asked this very question already — always
    // without a service, so a chosen service's question is asked here.
    (summaryService
      ? askSummary()
      : bootOr("summary", { slug, from: today, days: 14, party: summaryParty }, askSummary))
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res.data?.days) ? res.data.days : [];
        const map = Object.fromEntries(list.map((d) => [d.date, !!d.has_slots]));
        setDayMap(map);
        setDayClosures(Object.fromEntries(
          list.filter((d) => d.reason === "closed_date")
            .map((d) => [d.date, { note: d.note || null, kind: d.kind || "closed" }]),
        ));
        setReasonsFor({
          party: summaryParty,
          // A PAUSED day is not a closed one (R1 review): its own reason, so
          // the chip says "pause" and the sentence asks for a call.
          reasons: Object.fromEntries(list.map((d) => [d.date, d.has_slots ? null
            : d.reason === "closed_date" && d.kind === "pause" ? "paused_date" : d.reason || null])),
        });
        setNextOpenDay(res.data?.next_open_day || null);
        // Paused: the explicit top-level flag, or (an older server) every day
        // "not_accepting". A failed summary never pauses the page.
        if (
          res.data?.closed_reason === "not_accepting" ||
          (list.length > 0 && list.every((d) => d.reason === "not_accepting"))
        ) {
          setPaused(true);
        }
        // Only rescue a day the summary KNOWS is closed. A date picked in the
        // calendar (or a ?d= link) beyond the summary's 14 days is not in the
        // map at all — it used to be treated as closed and silently swapped
        // for the next open day the moment the party size changed.
        const keep = waitFull && list.some((d) => d.date === pickedDay.current && d.reason === "full")
          ? pickedDay.current : null;
        setDay((cur) => rescueDay(cur, map, res.data?.next_open_day, keep));
        // R12: fetch the full night's chunk ahead when the strip shows one.
        if (waitFull && list.some((d) => d.reason === "full")) loadFullNight().catch(() => {});
      })
      .catch(() => {
        if (alive) {
          setDayMap(null);
          // Unknown, never {}: a failed summary must not invent a state.
          setReasonsFor(null);
          setNextOpenDay(null);
        }
      });
    return () => {
      alive = false;
    };
    // re-run when party changes (open days depend on party size), and when a
    // refusal says the strip is out of date (summaryNonce)
  }, [page, slug, summaryParty, summaryService, today, summaryNonce, waitFull]);
  const dayReasons = reasonsFor && reasonsFor.party === summaryParty ? reasonsFor.reasons : null;

  // ── Per-venue document title + OG tags ────────────────────────────
  // A diner's browser tab should read the RESTAURANT, not the app default
  // ("BonBox — The back office …"). NOTE (honest limitation): this is a pure SPA,
  // so social/SMS link-unfurl crawlers read the STATIC index.html title before
  // JS runs — the live tab updates, but shared-link previews still show the app
  // default until we add SSR/prerender. Still worth it for the tab + trust.
  const resultStatus = liveStatus || result?.status || null;
  useEffect(() => {
    if (!page) return;
    const prev = document.title;
    // null = the venue has no name a guest may see (never "BonBox"): the
    // same states then read without a venue, so the tab never falls back
    // to the app's own shell title.
    const venue = page.business_name || null;
    // Once booked, the tab says what happened — a guest switching back to it
    // should not read "Book a table" over a finished booking.
    // A link still loading or no longer resolving is not a booking yet.
    const showsBooking = !!result && linkState !== "loading" && linkState !== "failed";
    const withdrawn = resultStatus === "cancelled" && (liveOutcome === "withdrawn" || cancelledFrom === "requested");
    const declined = resultStatus === "cancelled" && liveOutcome === "declined";
    const cancelled = resultStatus === "cancelled" || resultStatus === "no_show";
    // A salon books a time, not a table (vertical-fit audit, Oct 2026).
    const title = venue
      ? (!showsBooking
        ? (apptWords
          ? t("rsvpDocTitleProvider", "Book an appointment · {venue}", { venue })
          : t("rsvpDocTitle", "Book a table · {venue}", { venue }))
        : withdrawn
          ? t("rsvpDocTitleWithdrawn", "Request withdrawn · {venue}", { venue })
          : declined
            ? t("rsvpDocTitleDeclined", "Request not confirmed · {venue}", { venue })
            : cancelled
              // A time, not a reservation, for a salon, a shop or a workshop
              // (Push 8 review: "Reservation aflyst · Cykelværkstedet Amager").
              ? (apptWords
                ? t("rsvpDocTitleCancelledAppt", "Appointment cancelled · {venue}", { venue })
                : t("rsvpDocTitleCancelled", "Booking cancelled · {venue}", { venue }))
              : resultStatus === "requested"
                ? t("rsvpDocTitleRequest", "Request received · {venue}", { venue })
                : apptWords
                  ? t("rsvpDocTitleBookedProvider", "Appointment confirmed · {venue}", { venue })
                  : t("rsvpDocTitleBooked", "Reservation confirmed · {venue}", { venue }))
      : (!showsBooking
        ? (apptWords ? t("rsvpBookATime", "Book an appointment") : t("rsvpBookATable", "Book a table"))
        : withdrawn
          ? t("rsvpWithdrawnTitle", "Request withdrawn")
          : declined
            ? t("rsvpDeclinedTitle", "We couldn't confirm your request")
            : cancelled
              ? (apptWords
                ? t("rsvpCancelledTitleAppt", "Appointment cancelled")
                : t("rsvpCancelledTitle", "Reservation cancelled"))
              : resultStatus === "requested"
                ? t("rsvpRequestTitle", "Request received")
                : apptWords
                  ? t("rsvpConfirmedTitleProvider", "Appointment confirmed")
                  : t("rsvpConfirmedTitle", "Reservation confirmed"));
    document.title = title;
    const setMeta = (prop, val) => {
      let m = document.querySelector(`meta[property="${prop}"]`);
      if (!m) {
        m = document.createElement("meta");
        m.setAttribute("property", prop);
        document.head.appendChild(m);
      }
      m.setAttribute("content", val);
    };
    setMeta("og:title", title);
    setMeta("og:description", !venue
      ? title
      : apptWords
        ? t("rsvpOgDescProvider", "Book an appointment at {venue}.", { venue })
        : t("rsvpOgDesc", "Reserve a table at {venue}.", { venue }));
    try { setMeta("og:url", window.location.href); } catch { /* noop */ }
    return () => { document.title = prev; };
  }, [page, t, result, resultStatus, linkState, cancelledFrom, liveOutcome, isProvider, apptWords]);

  // ── Provider venue: load the active behandlinger catalog (S3b) ────
  // Drives the behandling picker (the FIRST step for a salon). Soft-fail to []
  // → the page shows an honest "nothing bookable online" line. Auto-select the
  // sole behandling so a one-service salon skips a redundant tap.
  useEffect(() => {
    if (!isProvider) return;
    let alive = true;
    api
      .get(`/public/reservations/${slug}/behandlinger`)
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res.data?.behandlinger) ? res.data.behandlinger : [];
        setBehandlinger(list);
        if (list.length === 1) setBehandlingId(String(list[0].id));
      })
      .catch(() => {
        if (alive) setBehandlinger([]);
      });
    return () => {
      alive = false;
    };
  }, [isProvider, slug]);

  // ── Fetch availability whenever the relevant inputs change ────────
  // TABLE venues: GET /availability?day=&party= (unchanged). PROVIDER venues:
  // GET /provider-availability?day=&behandling_id=&stylist_id= — slots are
  // {start, resource_id, staff_id, duration_min}; we fold their distinct HH:MM
  // start times into the same chip grid the table flow uses. The server
  // re-resolves duration + the (pinned or Valgfri) behandler at booking time
  // from behandling_id/stylist_id/time, so the raw slot ids aren't needed here.
  // Only the LATEST /availability request may write the time area. A late
  // answer for the previous party or day used to overwrite the slots, the
  // pick, the scarcity counts and closed_reason: party 2's free 19:00
  // vanished under "Ingen ledige tider denne dag." when party 7's answer
  // came in last (build plan C5). A paused answer still pauses — it is
  // venue-wide, so true whatever selection it was asked for.
  const availSeq = useRef(0);
  const fetchAvailability = useCallback(
    async (forDay, forParty, forBehandling, forStylist) => {
      if (!forDay) return;
      // Provider needs a behandling chosen first; until then, no slots.
      if (isProvider && !forBehandling) {
        availSeq.current += 1;   // any answer still in flight is stale now
        setSlots([]);
        setSlotRemaining({});
        setGroupRequest(false);
        setSlot("");
        setSlotsLoading(false);
        return;
      }
      if (!isProvider && !forParty) return;
      const seq = ++availSeq.current;
      const stale = () => seq !== availSeq.current;
      setSlotsLoading(true);
      setSlotsError("");
      const metaKey = `${forDay}|${forParty}|${forBehandling || ""}|${forStylist || ""}`;
      // The pick survives a party change when that time is still offered
      // (design spec); a new DAY clears it before this runs (effect below).
      const keepIfOffered = (list) => setSlot((cur) => (cur && list.includes(cur) ? cur : ""));
      try {
        if (isProvider) {
          const res = await api.get(
            `/public/reservations/${slug}/provider-availability`,
            {
              params: {
                day: forDay,
                behandling_id: forBehandling,
                ...(forStylist ? { stylist_id: forStylist } : {}),
              },
            },
          );
          if (stale()) {
            if (res.data?.closed_reason === "not_accepting") setPaused(true);
            return;
          }
          const raw = Array.isArray(res.data?.slots) ? res.data.slots : [];
          // The grid shows distinct HH:MM start times across all behandlere
          // (or just the pinned one); the server picks/rechecks the behandler.
          const seen = new Set();
          const times = [];
          for (const s of raw) {
            const hhmm = hhmmOf(s.start);
            if (hhmm && !seen.has(hhmm)) {
              seen.add(hhmm);
              times.push(hhmm);
            }
          }
          setSlots(times);
          keepIfOffered(times);
          // A stylist chair is not a table — "2 left" would be meaningless.
          setSlotRemaining({});
          setGroupRequest(false);
          setAvailMeta({ key: metaKey, reason: res.data?.reason || "", closure: res.data?.closure || null });
          // A capped salon is paused too (it used to be offered times the
          // create path then refused).
          setClosedReason(res.data?.closed_reason || "");
          if (res.data?.closed_reason === "not_accepting") setPaused(true);
        } else {
          // R5: index.html may have asked this very question already.
          const res = await bootOr("avail", { slug, day: forDay, party: forParty }, () =>
            api.get(`/public/reservations/${slug}/availability`, {
              params: { day: forDay, party: forParty },
            }),
          );
          if (stale()) {
            if (res.data?.closed_reason === "not_accepting") setPaused(true);
            return;
          }
          const list = Array.isArray(res.data?.slots) ? res.data.slots : [];
          setSlots(list);
          keepIfOffered(list);
          setSlotRemaining(
            res.data?.slot_remaining && typeof res.data.slot_remaining === "object"
              ? res.data.slot_remaining
              : {},
          );
          setGroupRequest(!!res.data?.group_request);
          setAvailMeta({
            key: metaKey, reason: res.data?.reason || "", closure: res.data?.closure || null,
            full: res.data?.nearest ? res.data : null,
          });
          // The venue is at its monthly booking ceiling — every time we could
          // show would be refused by the create endpoint. Say so HERE, at the
          // top of the flow, instead of letting the guest pick a table and type
          // their name, phone and allergy notes first. `closed_reason` is
          // additive; when the server doesn't send it we clear the state and
          // behave exactly as before.
          setClosedReason(res.data?.closed_reason || "");
          if (res.data?.closed_reason === "not_accepting") setPaused(true);
        }
      } catch {
        if (stale()) return;
        setSlots([]);
        setSlot("");
        setGroupRequest(false);
        setClosedReason("");
        setAvailMeta(null);
        // A flag, translated where it is shown. This callback used to depend
        // on `t` for the message, so switching DA/EN re-created it, re-ran
        // the fetch and wiped the time the guest had picked — on step 2 that
        // left a grey Confirm button with no way to tell why.
        setSlotsError("load_failed");
      } finally {
        // An old request never ends a newer one's loading state.
        if (!stale()) setSlotsLoading(false);
      }
    },
    [slug, isProvider],
  );

  const fetchedDay = useRef("");
  const partyRailRef = useRef(null);
  const partyShown = useRef(0);
  useEffect(() => {
    const first = !partyShown.current;
    partyShown.current = party;
    const rail = partyRailRef.current;
    revealInRail(rail, rail?.querySelector('[aria-checked="true"]'), first ? "auto" : "smooth");
    // Also when the rail is drawn again (back from step 2, "Ændr", a new
    // request): it re-mounted scrolled to the start with a party of 10 off
    // screen.
  }, [party, step, result]);
  useEffect(() => {
    if (!page || !day) return;
    if (fetchedDay.current !== day) {
      fetchedDay.current = day;
      setSlot("");
    }
    if (isProvider) {
      fetchAvailability(day, party, behandlingId, stylistId);
    } else {
      if (!party) return;
      fetchAvailability(day, party);
    }
  }, [page, day, party, behandlingId, stylistId, isProvider, fetchAvailability]);

  // ── Fetch the floor map for the chosen slot ──────────────────────
  // A chosen TIME defines the room snapshot (which tables are free then). Any
  // change to day/party/slot resets the pick. Group requests don't pick a
  // table — the venue assigns on approval — so we skip the floor there.
  // R5: a venue that lets guests pick a table — fetch the picker's code now,
  // while the guest is still choosing a day and a time.
  useEffect(() => {
    if (page?.guest_can_pick_table) loadFloorMap().catch(() => {});
  }, [page?.guest_can_pick_table]);

  useEffect(() => {
    setSelectedTable(null);
    // Honesty gate #1 (+ grandfather). A PROVIDER venue (salon) books people,
    // never tables, so it never probes for a floor. Every other venue fetches:
    // the render below shows the table picker only when free tables actually
    // come back — so a no-floor (bakery/retail) venue with zero tables shows
    // nothing, while a venue that ALREADY has a real table plan (e.g. a legacy /
    // personal-mode account) keeps its floor instead of having it silently pulled.
    if (!page || !day || !party || !slot || groupRequest || bookingModeFor(page.business_type) === "provider") {
      setFloor([]);
      return;
    }
    let alive = true;
    setFloorLoading(true);
    api
      .get(`/public/reservations/${slug}/floor`, { params: { day, party, at: slot } })
      .then((r) => {
        if (alive) setFloor(Array.isArray(r?.data?.tables) ? r.data.tables : []);
      })
      .catch(() => {
        if (alive) setFloor([]); // no map → graceful fall back to auto-assign
      })
      .finally(() => {
        if (alive) setFloorLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, page, day, party, slot, groupRequest]);

  // ── Derived ──────────────────────────────────────────────────────
  const maxParty = Number(page?.max_party_size) || 10;
  // ONE reading of max_advance_days, the backend's: 0 = today only, missing
  // or junk = 60 (utils/dayState.js). The ?d= check above uses the same.
  const maxAdvance = maxAdvanceOf(page?.max_advance_days);
  const latestDay = useMemo(() => addDays(today, maxAdvance), [today, maxAdvance]);
  const rail = railLength(maxAdvance);
  // The selected day's reason: the keyed /availability answer when it is for
  // THIS selection and names one, else the summary's, else unknown.
  const selKey = `${day}|${party}|${behandlingId || ""}|${stylistId || ""}`;
  const dayReason =
    (availMeta && availMeta.key === selKey && availMeta.reason) ||
    (dayReasons ? dayReasons[day] || null : null);
  // R12: the server's offer for this night when it is full (raw answer).
  const fullNight = (availMeta && availMeta.key === selKey && availMeta.full) || null;
  const eveningFull = !!fullNight?.evening_full;
  // The server sends a shop or a workshop no catalogue (allergens.py); an
  // older server still sent the food set — never shown there either.
  const allergenSet = useMemo(
    () => (noteOnly ? [] : Array.isArray(page?.allergen_set) ? page.allergen_set : []),
    [page, noteOnly],
  );
  // Period-grouped slots (Frokost / Eftermiddag / Aften), computed once per
  // availability response. Only non-empty groups survive.
  const slotGroups = useMemo(() => groupSlots(slots, apptWords), [slots, apptWords]);
  // Provider recap pieces: the chosen behandling (name + duration) and the
  // pinned behandler's name (empty = Valgfri behandler).
  const chosenBehandling = useMemo(
    () => behandlinger.find((b) => String(b.id) === String(behandlingId)) || null,
    [behandlinger, behandlingId],
  );
  const chosenStylistName = stylistId ? providerNameById[String(stylistId)] || "" : "";
  const nameValid = guestName.trim().length >= 1 && guestName.trim().length <= 160;
  // One way to reach the guest, checked against the server's own rules
  // (utils/guestContact.js) so a typo is caught here, next to the field.
  const contact = contactState(contactMode, guestEmail, guestPhone);
  const contactValid = contact.ok;
  // A time is required — for a group request too, where it is the guest's
  // PREFERRED time and the venue confirms it. Only when the server offers no
  // times at all (an older backend) does a group request go without one.
  // Always. A request with no offered time went through for a closed day —
  // the server stored an invented 18:00 and the receipt later showed it.
  const needsTime = !slot;
  const canSubmit =
    nameValid &&
    contactValid &&
    !needsTime &&
    (!isProvider || !!behandlingId) &&
    !submitting;

  const partyOptions = useMemo(() => {
    const list = [];
    for (let i = 1; i <= maxParty; i += 1) list.push(i);
    return list;
  }, [maxParty]);
  // 1–10 as a grid on a phone; a ceiling above 10 keeps the swipe row (owner Q3).
  const partyGrid = partyOptions.length <= 10;
  // Step 1 while paused: no bottom bar, no step dots, no trust line; and
  // (owner Q2 default) one panel instead of the pickers.
  const pausedStep1 = paused && step === 1;
  const pausedPanel = pausedStep1 && PAUSED_HIDES_PICKERS;
  // The time grid shows exactly when none of the time area's messages does
  // (the chain in the time area renders those inside its live region).
  const timesShowGrid =
    !(isProvider && !behandlingId) && !slotsError && closedReason !== "not_accepting" && !paused &&
    slotGroups.length > 0;
  // G10 (judge 27 Oct, item 3): while the full night's offer — or the
  // guest's place on its waitlist — is on screen and no time is picked, the
  // bar's "Vælg tid" leads nowhere and is a second main green: no bar then.
  // A nearest time or an earlier time picked brings it back ("Fortsæt").
  const fullNightOnScreen =
    step === 1 && !pausedPanel && !isProvider && !!fullNight && !slot &&
    (dayReason === "full" || (timesShowGrid && eveningFull));

  // The paused panel can replace step 1 after the guest tapped a date or a
  // party (an /availability answer says "not_accepting"): the focused chip
  // unmounts and focus would fall to <body>. Move it to the panel, but only
  // while this document has focus — on an embed's first load the host page
  // keeps it.
  useEffect(() => {
    if (!pausedPanel) return;
    try {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && document.hasFocus()) stepFocusRef.current?.focus?.({ preventScroll: true });
    } catch {
      /* noop */
    }
  }, [pausedPanel]);
  // The owner's note for a day they closed (the keyed answer first, then the
  // summary's) — reasonSentence shows it verbatim.
  const dayClosure =
    (availMeta && availMeta.key === selKey && availMeta.closure) || dayClosures[day] || null;
  const sentenceCtx = { party, apptWords, day, today, maxAdvance, lang, closure: dayClosure };

  function toggleAllergen(key) {
    setAllergenTags((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  // ── Submit ───────────────────────────────────────────────────────
  // ONE key per booking INTENT — not per attempt.
  //
  // The server already de-duplicates on this key, but the key used to be
  // minted fresh inside every onSubmit, so the guard could never fire.
  // When a confirm times out AFTER the server committed, the guest is
  // told to try again (that is what the generic error says) — and the
  // retry booked the same table a second time, or 409'd them against
  // their OWN first booking so they believed they had failed while
  // actually holding a table.
  //
  // Rotated only on a real 409: that conflict is about the slot, so the
  // next attempt is a genuinely new intent.
  const idempotencyKey = useRef(null);
  // Guest-invisible spam guards (backend services/booking_screen.py): how long
  // this page was open before Book was pressed, and a trap field no person
  // fills (it sits off-screen; a form-filling bot finds and fills it). A fast
  // or unsaid fill is held for the venue's OK — never refused.
  const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const mountedAt = useRef(nowMs());
  const [hpWebsite, setHpWebsite] = useState("");

  // ── R12: a full night — the nearest free times and the waitlist ──────
  // FullNightOffer (its own chunk) draws them and keeps the receipt; the page
  // hands it its state, setters and helpers (`host`). The signed link goes in
  // the address bar (?wl=&wt=), so a reload or a bookmark brings it back.
  const wlHost = {
    t, lang, slug, day, party, slot, page, offer: fullNight, confirm, kit: FULL_NIGHT_KIT,
    // A nearest time: that day and that time. The day effect clears a time
    // only for a day it has not seen (fetchedDay), so the time stays picked
    // once that day's times are in.
    pick: (d, x) => {
      pickedDay.current = d;
      fetchedDay.current = d;
      setSubmitError("");
      setSlot(x);
      setDay(d);
    },
    // "A table just opened up": the strip and the times again.
    refresh: () => {
      setSummaryNonce((n) => n + 1);
      fetchAvailability(day, party);
    },
  };
  const fullBlock = (
    <Suspense fallback={null}>
      <FullNightOffer host={wlHost} />
    </Suspense>
  );

  function newIdempotencyKey() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // The occasion as the OWNER will read it: the venue's language when its
  // dictionary is here (the page opens in it, so it nearly always is), else
  // the guest's own — never a raw key.
  const venueOccasionLabel = (k) =>
    pageDictFor(page?.language)?.[`rsvpOccasion_${k}`] ||
    loadedLocales()[page?.language]?.[`rsvpOccasion_${k}`] ||
    t(`rsvpOccasion_${k}`, OCCASION_FALLBACK[k]);

  // A guest who reads the page in another language than the venue's: fetch the
  // venue's dictionary while they fill in details, so the occasion can be
  // stored in it. A returning visitor who picked English before is the only
  // one who has not already loaded it.
  // R5: the page's own words carry Danish and English, so for those this is
  // never needed; another venue language still loads its dictionary.
  useEffect(() => {
    if (step === 2 && page?.language && page.language !== lang && !pageDictFor(page.language)) {
      loadLocale(page.language).catch(() => {});
    }
  }, [step, page?.language, lang]);

  const onSubmit = async () => {
    if (!canSubmit) {
      setNameTouched(true);
      setContactTouched(true);
      const missing = !nameValid
        ? "rsvp-name"
        : !contactValid
          ? contactMode === "phone" ? "rsvp-phone" : "rsvp-email"
          : null;
      if (missing) document.getElementById(missing)?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    // Mint on the first attempt of this intent; a retry reuses it so the
    // server can recognise the replay.
    if (!idempotencyKey.current) idempotencyKey.current = newIdempotencyKey();
    const hasAllergy =
      allergenTags.length > 0 || allergyNote.trim().length > 0;
    const payload = {
      day,
      // A group request has no chosen slot. This used to send a blind
      // "18:00" under a comment claiming the backend ignores it — it does
      // not: the value is stored as starts_at, so an invented time became
      // the booking time, one-tap approval confirmed a guest for a time
      // they never picked, and at a venue opening at 19:00 it landed
      // outside opening hours entirely. The venue's own first opening of
      // that day is at least a real time. The 18:00 tail stays only for
      // the case where availability returned nothing at all.
      time: slot,
      party_size: party,
      guest_name: guestName.trim(),
      ...contact.payload,
      // The page's language, so every email about this booking (confirmation,
      // reminder, a change by the venue) reaches the guest in it.
      lang: lang === "da" || lang === "en" ? lang : null,
      occasion: occasion ? venueOccasionLabel(occasion) : null,
      guest_notes: guestNotes.trim() || null,
      allergen_tags: hasAllergy ? allergenTags : [],
      allergy_note: hasAllergy ? allergyNote.trim() || null : null,
      allergy_severity: hasAllergy && allergySeverity ? allergySeverity : null,
      consent_marketing: !!consentMarketing,
      // The table the guest tapped on the 2D floor map (a preference — the
      // server honors it only if still free, else auto-assigns). Group
      // requests never carry one. Provider venues never pick a table.
      resource_id: isProvider ? null : groupRequest ? null : selectedTable || null,
      // ── Salon tidsbestilling (S3b) ──────────────────────────────────
      // The server resolves duration + service_name from behandling_id and
      // books a PROVIDER. stylist_id pins a behandler and FAILS CLOSED (409)
      // if taken — omitting it = Valgfri behandler (server auto-assigns a free
      // behandler). party_size is ignored server-side for a salon booking.
      ...(isProvider
        ? { behandling_id: behandlingId || null, stylist_id: stylistId || null }
        : {}),
      website: hpWebsite,
      // At most a day: a page left open overnight sent a value the server
      // refused (422) until the guest reloaded (R1 review P2).
      form_ms: Math.min(FORM_MS_MAX, Math.max(0, Math.round(nowMs() - mountedAt.current))),
    };
    try {
      const res = await api.post(`/public/reservations/${slug}`, payload, {
        headers: { "X-Idempotency-Key": idempotencyKey.current },
      });
      const data = res?.data || null;
      setResult(data);
      // Seed the live status from the create response; the poll below keeps
      // it fresh (requested → confirmed/declined) without a manual refresh.
      setLiveStatus(data?.status || null);
      // Stash the booking token so a return visit can poll the status.
      if (data?.id && data?.booking_token) {
        try {
          localStorage.setItem(`${TOKEN_STORE_PREFIX}${data.id}`, data.booking_token);
        } catch {
          /* private mode / storage blocked — non-fatal */
        }
        // …and put the booking in the address bar. "Save this page" (shown
        // when there is no email) used to be advice nobody could follow: a
        // reload or a bookmark brought back an empty form. With the same
        // ?booking=&token= the email link uses, it reopens this receipt.
        setSearchParams(
          (prev) => {
            const n = new URLSearchParams(prev);
            n.set("booking", data.id);
            n.set("token", data.booking_token);
            return n;
          },
          { replace: true },
        );
      }
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.detail?.error;
      // R1 refusals (utils/bookingRefusal.js): every one keeps what the
      // guest typed.
      const refusal = guestRefusalOf(status, code);
      if (refusal && !["slot_unavailable", "stylist_unavailable"].includes(refusal)) {
        const how = GUEST_REFUSALS[refusal];
        if (how.newIntent) idempotencyKey.current = null;
        if (how.refreshSummary) setSummaryNonce((n) => n + 1);
        if (how.refetch) {
          if (isProvider) fetchAvailability(day, party, behandlingId, stylistId);
          else fetchAvailability(day, party);
        }
        if (how.back) backToChoices();
        setSubmitError(refusal);
        return;
      }
      if (status === 409 || status === 410) {
        // slot_unavailable | stylist_unavailable | party_too_large | not_accepting
        const lostRaceCode = code || "slot_unavailable";
        // The slot (or the pinned behandler) is gone — refetch availability so
        // the visitor sees a fresh set without manually changing the date, and
        // bounce back to step 1. We NEVER silently rebook a different behandler.
        if (code === "slot_unavailable" || code === "stylist_unavailable") {
          if (isProvider) fetchAvailability(day, party, behandlingId, stylistId);
          else fetchAvailability(day, party);
          // The slot is genuinely gone, so the next attempt is a NEW
          // intent — rotate the key the retry will carry.
          idempotencyKey.current = null;
          backToChoices();
          setSubmitError(lostRaceCode);
        } else if (code === "not_accepting" && status === 409) {
          // The venue hit its monthly ceiling between loading the page and
          // submitting. Before this, the guest was left on a filled-in form
          // with a red line and no way forward — retrying could only fail
          // again, on every date. Send them back to step 1, where the closed
          // state and the phone fallback now render.
          //
          // 410 is deliberately excluded: that means reservations are switched
          // off entirely, which the page already handles as its own dead state.
          setClosedReason("not_accepting");
          setSlots([]);
          setSlotRemaining({});
          idempotencyKey.current = null;
          backToChoices();
          setSubmitError(lostRaceCode);
          // One panel ("paused while you were booking"), not the amber box on
          // top of a second, near-identical message.
          setPaused(true);
        } else {
          setSubmitError(lostRaceCode);
        }
      } else if (status === 422) {
        // The server's shape check refused a field. Say which, next to it —
        // not "something went wrong", which sent guests round in circles.
        const text = JSON.stringify(err?.response?.data || "");
        if (text.includes("invalid_email")) {
          setContactMode("email");
          setContactTouched(true);
          setSubmitError("invalid_email");
        } else if (text.includes("invalid_phone")) {
          setContactMode("phone");
          setContactTouched(true);
          setSubmitError("invalid_phone");
        } else {
          setSubmitError("generic");
        }
      } else {
        setSubmitError("generic");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Booking token lookup (for poll + cancel) ─────────────────────
  // The signed token comes back on the create response; we also stashed it
  // in localStorage so a return visit on the same device still has it. The
  // backend's poll/cancel endpoints verify this token against the id (IDOR
  // -safe: a wrong/absent token → 404).
  const bookingToken = useCallback(() => {
    if (result?.booking_token) return result.booking_token;
    if (result?.id) {
      try {
        return localStorage.getItem(`${TOKEN_STORE_PREFIX}${result.id}`) || null;
      } catch {
        return null;
      }
    }
    return null;
  }, [result]);

  // A booking is "settled" once it leaves the pending "requested" state —
  // confirmed, seated, or any closed state. We only poll while pending.
  const isPending = liveStatus === "requested";

  // ── Live status poll ─────────────────────────────────────────────
  // GET /public/reservations/booking/{id}?token= — flips a "requested"
  // group booking to confirmed (or a closed state) without a manual
  // refresh. Light touch: every 15s, capped, and immediately on tab
  // focus. Stops the moment the status settles.
  useEffect(() => {
    if (!result?.id || !isPending) return;
    const token = bookingToken();
    if (!token) return; // no token (storage blocked) → can't poll; screen still shows the create-time status

    let alive = true;
    let polls = 0;
    const MAX_POLLS = 8; // ~2 min of 15s polls, then give up quietly

    const checkOnce = async () => {
      if (!alive) return;
      try {
        const res = await api.get(
          `/public/reservations/booking/${result.id}`,
          { params: { token } },
        );
        const next = res?.data?.status;
        if (alive && next) {
          setLiveStatus(next);
          setLiveOutcome(res?.data?.outcome || null);
        }
      } catch {
        /* transient — keep the last known status, try again next tick */
      }
    };

    const id = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(id);
        return;
      }
      checkOnce();
    }, 15000);

    // Re-check the instant the guest returns to the tab (common: they
    // switch away waiting for the restaurant to confirm).
    const onFocus = () => checkOnce();
    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [result, isPending, bookingToken]);

  // ── Self-cancel ──────────────────────────────────────────────────
  // POST /public/reservations/booking/{id}/cancel?token= — guest frees
  // the table; the backend flips status to "cancelled" and notifies the
  // owner. Idempotent server-side (already-cancelled returns the state).
  const onCancel = async () => {
    if (!result?.id || cancelling) return;
    // Ask first. This tap frees the table AND spends the cancel token, so
    // a mis-tap on a phone is not recoverable by the guest — they would
    // have to ring the venue to get their evening back. One confirmation
    // is the right price for an irreversible action; the booking flow
    // itself stays one-tap.
    const isReq = (liveStatus || result?.status) === "requested";
    const sure = await confirm(
      isReq
        ? {
            // A request holds no table — "the table is freed" was untrue.
            title: t("rsvpWithdrawConfirmTitle", "Withdraw your request?"),
            message: t("rsvpWithdrawConfirmBody", "We'll let the venue know. This can't be undone."),
            confirmLabel: t("rsvpWithdrawConfirmYes", "Yes, withdraw"),
            cancelLabel: t("rsvpWithdrawConfirmNo", "Keep request"),
            destructive: true,
          }
        : {
            title: apptWords
              ? t("rsvpCancelConfirmTitleAppt", "Cancel the appointment?")
              : t("rsvpCancelConfirmTitle", "Aflys reservationen?"),
            message: apptWords
              ? t("rsvpCancelConfirmBodyProvider", "The time is freed right away, and this can't be undone. You're welcome to book again.")
              : t(
                "rsvpCancelConfirmBody",
                "Bordet bliver frigivet med det samme, og du kan ikke fortryde. Du er velkommen til at booke igen.",
              ),
            confirmLabel: t("rsvpCancelConfirmYes", "Ja, aflys"),
            cancelLabel: apptWords
              ? t("rsvpCancelConfirmNoAppt", "Keep the appointment")
              : t("rsvpCancelConfirmNo", "Behold reservationen"),
            destructive: true,
          },
    );
    if (!sure) return;
    const token = bookingToken();
    if (!token) {
      setCancelError(true);
      return;
    }
    setCancelling(true);
    setCancelError(false);
    try {
      const res = await api.post(
        `/public/reservations/booking/${result.id}/cancel`,
        null,
        { params: { token } },
      );
      const next = res?.data?.status || "cancelled";
      setCancelledFrom(isReq ? "requested" : "confirmed");
      setLiveStatus(next);
      setLiveOutcome(res?.data?.outcome || null);
      // Token is spent — drop it so a stale return visit can't reuse it.
      try {
        localStorage.removeItem(`${TOKEN_STORE_PREFIX}${result.id}`);
      } catch {
        /* storage blocked — non-fatal */
      }
    } catch {
      setCancelError(true);
    } finally {
      setCancelling(false);
    }
  };

  // ── Renders ───────────────────────────────────────────────────────
  if (loading) {
    // The wait (components/booking/bookingWait.js): on a desktop it
    // stands in the loaded page's own two-column frame (the venue column, the
    // card on the right), so the layout doesn't jump from one centred column
    // to two when the page arrives; in the embed's card mode it already
    // stands in the card (on the host's ground from 450 px), so the frame
    // never shows a white slab that then turns into a card. Booking R5: the
    // SAME markup index.html paints before any code has arrived and the
    // route shows while this page's code downloads — one look from the first
    // paint to the page. Keyed: React must not reuse this node for the
    // loaded page's wrapper (on a desktop that reuse moved it ~290px).
    return (
      <BookingSkeleton
        key="loading"
        variant={skeletonVariant({ embed: isEmbed, flat, wide })}
        word={t("rsvpLoading", "Loading…")}
      />
    );
  }

  if (loadError === "closed") {
    return (
      <ClosedScreen
        t={t}
        name={page?.business_name}
        rootMinH={rootMinH}
      />
    );
  }

  if (loadError || !page) {
    return (
      <div className={`${rootMinH} ${ROOT_FINISH} bg-white dark:bg-gray-950 px-4 py-16`}>
        <div className="max-w-md mx-auto text-center">
          <AlertCircle
            size={40}
            strokeWidth={1.5}
            className="text-gray-400 mx-auto mb-3"
            aria-hidden="true"
          />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t("rsvpNotFound", "Vi kunne ikke finde siden")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t(
              "rsvpNotFoundHint",
              "Linket kan være forkert, eller stedet tager ikke imod reservationer lige nu.",
            )}
          </p>
        </div>
      </div>
    );
  }

  // Leave a finished (or unreachable) booking and start a new one.
  function startOver() {
    leftBooking.current = result?.id || null;
    setResult(null);
    setLiveStatus(null);
    setCancelledFrom(null);
    setLiveOutcome(null);
    setLinked(null);
    setLinkState(null);
    setSlot("");
    setStep(1);
    // Keep name and contact (the same guest is rebooking); drop the details
    // that belong to the old booking — and never carry health data over.
    setOccasion("");
    setGuestNotes("");
    setAllergenTags([]);
    setAllergySeverity("");
    setAllergyNote("");
    idempotencyKey.current = null;
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("booking");
        n.delete("token");
        return n;
      },
      { replace: true },
    );
  }

  // ── A booking link that is still loading, or no longer resolves ─────
  if (result && linkState === "loading") {
    return (
      <div className={`${rootMinH} ${ROOT_FINISH} bg-gray-50 dark:bg-gray-950 flex items-center justify-center`}>
        {/* Grey, and only after 600 ms (.bb-late): a link that opens fast
            goes straight to the receipt. */}
        <div className="bb-late">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" aria-label={t("loading", "Loading…")} />
        </div>
      </div>
    );
  }
  if (result && linkState === "failed") {
    return (
      <div className={`${rootMinH} ${ROOT_FINISH} bg-gray-50 dark:bg-gray-950 px-4 py-16`}>
        <div className="max-w-md mx-auto space-y-5 text-center" role="status">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mx-auto bg-gray-100 dark:bg-gray-800">
            <AlertCircle size={28} strokeWidth={1.75} className="text-gray-500" aria-hidden="true" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            {t("rsvpLinkFailedTitle", "We couldn't open this booking")}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {apptWords
              ? t("rsvpLinkFailedBodyProvider", "The link may have expired. Call us about an existing appointment — or book a new time.")
              : t(
                "rsvpLinkFailedBody",
                "The link may have expired. Call us about an existing booking — or book a new table.",
              )}
          </p>
          <div className="space-y-2">
            <Button variant="main" size="lg" className="w-full" onClick={startOver}>
              {apptWords ? t("rsvpBookATime", "Book an appointment") : t("rsvpBookATable", "Book a table")}
            </Button>
            {telHref(page.phone) && (
              <a
                href={telHref(page.phone)}
                className="inline-flex w-full items-center justify-center gap-2 h-11 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-200"
              >
                <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="tabular-nums">{page.phone}</span>
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Success screen ─────────────────────────────────────────────────
  if (result) {
    // `liveStatus` is the authoritative status (seeded from the create
    // response, kept fresh by the poll); fall back to the raw result.
    const status = liveStatus || result.status;
    const isRequest = status === "requested";
    const isConfirmed = status === "confirmed" || status === "seated";
    const isCancelled = status === "cancelled" || status === "no_show";
    const isDone = status === "completed";
    // How it ended. The server's word first (it survives a reload); the
    // guest's own tap on this page covers a server that has not said yet.
    // A withdrawn request never held a table, so "the table has been
    // released" was untrue — and its time stays "preferred".
    const withdrawn = isCancelled && (liveOutcome === "withdrawn" || cancelledFrom === "requested");
    const declined = isCancelled && !withdrawn && liveOutcome === "declined";
    const venueCancelled = isCancelled && liveOutcome === "cancelled_by_venue";
    // Self-cancel only makes sense while the booking is still live.
    const canCancel = isRequest || isConfirmed;

    // What the receipt shows: the booking the page just made — or, when the
    // guest arrived from the email link / a reload / a bookmark, the booking
    // the server returned for that link. The form state is empty then, and
    // the receipt used to show today's date, no time and a blank name.
    const rDay = linked?.day || day;
    const rTime = linked ? linked.time : slot;
    const rParty = linked?.party || party;
    const rName = linked ? linked.name : guestName.trim();
    // The contact the booking was actually SENT with — not whatever is in the
    // box. A typo left on the Email tab is dropped from the booking, and
    // naming it here promised a confirmation that would never arrive.
    const sentEmail = !linked ? contact.payload.guest_email : null;
    const sentPhone = !linked ? contact.payload.guest_phone : null;
    const emailGiven = !!sentEmail;
    // The server says whether an e-mail is really coming (`guest_mail`,
    // fix round 2): a held request past the venue's mail budget, or a venue
    // past its daily share, gets none — and the page must not promise one
    // ("Vi svarer dig på {email}" over silence). An older server sends no
    // flag: the page then says what it always said. Only for the answer to
    // THIS booking's own status — a request the venue has since confirmed
    // gets the venue's own mail.
    const noMailComing = !linked && emailGiven && result?.guest_mail === false
      && result?.status === status;

    // Status-driven hero icon + headline + body. Emerald is reserved for the
    // one confirmed "money moment"; pending/closed states stay gray.
    let HeroIcon = CheckCircle2;
    let heroWrap = "bg-emerald-50 dark:bg-emerald-900/20";
    let heroIconCls = "text-emerald-600 dark:text-emerald-400";
    let title = apptWords
      ? t("rsvpConfirmedTitleProvider", "Appointment confirmed")
      : t("rsvpConfirmedTitle", "Reservation bekræftet");
    let body = t(
      "rsvpConfirmedBody",
      // The email sentence used to live here too, hedged as "hvis du har
      // angivet en email" — directly under a line that names the address we
      // sent it to. Contradicting yourself about whether the guest will hear
      // from you is the one thing a confirmation screen must not do.
      "Vi glæder os til at se dig.",
    );
    if (isRequest) {
      HeroIcon = Clock;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpRequestTitle", "Forespørgsel modtaget");
      // ONE sentence on what happens next, naming the channel the guest gave.
      // The screen used to say it four times: this line, "save this page",
      // a spinning pill, and a paragraph under it.
      // F5: the server says when the answer comes at the latest (the time
      // an unanswered request is declined) — so the promise names it and is
      // always kept. An older server sends none: the old words.
      const answerBy = linked ? linked.answerBy : result?.answer_by;
      const by = answerBy ? answerByWords(answerBy, today, lang, t) : "";
      body = noMailComing
        ? t("rsvpRequestNextNoMail", "The venue will answer as soon as they can. Keep this page — the answer shows here.")
        : by && sentEmail
          ? t("rsvpRequestNextByEmail", "We'll reply to {email} by {when} at the latest.", { email: sentEmail, when: by })
          : by && !sentPhone
            ? t("rsvpRequestNextBy", "You'll have our answer by {when} at the latest.", { when: by })
            : rDay === today
              ? t("rsvpRequestNextToday", "We'll get back to you shortly.")
              : sentEmail
                ? t("rsvpRequestNextEmail", "We'll reply to {email} before the day.", { email: sentEmail })
                : sentPhone
                  ? t("rsvpRequestNextPhone", "We'll call you on {phone} to confirm.", { phone: sentPhone })
                  : t("rsvpRequestNextLater", "We'll get back to you before the day.");
    } else if (withdrawn) {
      HeroIcon = XCircle;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpWithdrawnTitle", "Request withdrawn");
      body = t("rsvpWithdrawnBody", "We've been told. You're welcome to send a new request.");
    } else if (declined) {
      HeroIcon = XCircle;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpDeclinedTitle", "We couldn't confirm your request");
      body = t(
        "rsvpDeclinedBody",
        "Sorry — we can't take you at that time. Call us and we'll find something, or send a new request.",
      );
    } else if (venueCancelled) {
      HeroIcon = XCircle;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = apptWords
        ? t("rsvpCancelledTitleAppt", "Appointment cancelled")
        : t("rsvpCancelledTitle", "Reservation aflyst");
      body = apptWords
        ? t("rsvpCancelledByVenueBodyAppt", "Sorry — we've had to cancel your appointment. Call us, or book another day.")
        : t(
          "rsvpCancelledByVenueBody",
          "Sorry — we've had to cancel your reservation. Call us, or book another day.",
        );
    } else if (isCancelled) {
      HeroIcon = XCircle;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = apptWords
        ? t("rsvpCancelledTitleAppt", "Appointment cancelled")
        : t("rsvpCancelledTitle", "Reservation aflyst");
      body = apptWords
        ? t("rsvpCancelledBodyProvider", "Your appointment is cancelled and the time is freed. You're welcome to book again.")
        : t(
          "rsvpCancelledBody",
          "Din reservation er aflyst, og bordet er frigivet. Du er velkommen til at booke igen.",
        );
    } else if (isDone) {
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpDoneTitle", "Tak for besøget");
      body = apptWords
        ? t("rsvpDoneBodyAppt", "This appointment is closed.")
        : t("rsvpDoneBody", "Denne reservation er afsluttet.");
    }

    // Human-friendly reference code — first 8 chars of the UUID, upper-cased,
    // prefixed with #. NOT the full id (that stays hidden; the signed token
    // is the only handle to the booking). This is a read-aloud reference only.
    const refCode = result?.id
      ? `#${String(result.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`
      : "";
    // An honest delivery line for a CONFIRMED booking: the email goes out
    // right after this screen appears, so it is "on its way" — never "sent"
    // before it has been. A request says its channel in the body above. From
    // a link we don't know which contact the guest gave, so we say nothing.
    let deliveryLine = null;
    if (!linked && isConfirmed) {
      deliveryLine = noMailComing
        ? t("rsvpNoMailReceipt", "We can't send a confirmation e-mail right now. Keep this page — it's your receipt.")
        : emailGiven
        ? t("rsvpEmailOnItsWay", "A confirmation is on its way to {email}.", {
            email: sentEmail,
          })
        : sentPhone
          ? t("rsvpPhoneOnlyReceipt", "We have your number, {phone}. Keep this page as your receipt.", {
              phone: sentPhone,
            })
          : t("rsvpNoEmailSaved", "Save this page — we don't have your email.");
    }
    // What the kitchen was told, including how serious — the guest's proof
    // that "severe" reached the restaurant.
    // From the booking itself when the receipt was reopened from a link.
    // The booking stores the occasion in the venue's language; reopened in
    // another language, a known chip label is shown in the guest's.
    const occasionAsGuestReads = (stored) => {
      if (!stored) return "";
      const dicts = loadedLocales();
      const k = OCCASION_KEYS.find((key) =>
        [
          pageDictFor("da")?.[`rsvpOccasion_${key}`],
          pageDictFor("en")?.[`rsvpOccasion_${key}`],
          dicts.da?.[`rsvpOccasion_${key}`],
          dicts.en?.[`rsvpOccasion_${key}`],
          OCCASION_FALLBACK[key],
        ].includes(stored),
      );
      return k ? t(`rsvpOccasion_${k}`, OCCASION_FALLBACK[k]) : stored;
    };
    const rOccasion = linked
      ? occasionAsGuestReads(linked.occasion)
      : occasion
        ? t(`rsvpOccasion_${occasion}`, OCCASION_FALLBACK[occasion])
        : "";
    const rTags = linked ? linked.allergenTags : allergenTags;
    const rSeverity = linked ? linked.allergySeverity : allergySeverity;
    const kitchen = [
      rTags.map((k) => t(`allergen_${k}`, k)).join(", ") || null,
      rTags.length && rSeverity ? t(`rsvpSeverity_${rSeverity}`, severityFallback(rSeverity)) : null,
      !linked ? allergyNote.trim() || null : null,
    ].filter(Boolean).join(" · ");
    const rows = [
      { k: "when", label: t("rsvpRowWhen", "When"), value: capFirst(fmtDayLabel(rDay, lang)) },
      rTime
        ? {
            k: "time",
            // A request's time is the one the guest asked for, until the venue
            // confirms it — on a reopened receipt too.
            label: isRequest || withdrawn || declined ? t("rsvpRowWishedTime", "Preferred time") : t("rsvpTimeLabel", "Time"),
            value: rTime,
          }
        : null,
      isProvider
        ? chosenBehandling
          ? { k: "svc", label: t("rsvpColBehandling", "Service"), value: chosenBehandling.name }
          : null
        : apptWords
          // One customer is the booking; more than one is worth a line.
          ? Number(rParty) > 1 ? { k: "party", label: t("rsvpRowPeople", "People"), value: String(rParty) } : null
          : { k: "party", label: t("rsvpRowGuests", "Guests"), value: String(rParty) },
      isProvider
        ? { k: "who", label: t("rsvpColBehandler", "Stylist"), value: chosenStylistName || t("rsvpBookValgfri", "Any stylist") }
        : null,
      rName ? { k: "name", label: t("rsvpGuestLabel", "Name"), value: rName } : null,
      rOccasion ? { k: "occ", label: t("rsvpRowOccasion", "Occasion"), value: rOccasion } : null,
      kitchen ? { k: "kitchen", label: t("rsvpRowKitchen", "Kitchen"), value: kitchen } : null,
      !linked && guestNotes.trim() ? { k: "note", label: t("rsvpRowNote", "Note"), value: guestNotes.trim() } : null,
    ].filter(Boolean);
    const address = venueAddress(page.address, page.city);
    const mapUrl = mapsHref(page.address, page.city);

    return (
      <div className={`${rootMinH} ${ROOT_FINISH} bg-gray-50 dark:bg-gray-950 px-4 py-10`}>
        <div className="max-w-md mx-auto space-y-6 text-center">
          {/* The guest may open this from an email on another device, where
              the page falls back to the venue's language — the switch has to
              be here too, not only on the form. */}
          <div className="flex justify-end -mt-4 -mb-2">
            <LangPill lang={lang} setLang={setLang} />
          </div>
          <div
            data-testid="rsvp-hero-icon"
            className={
              `inline-flex items-center justify-center w-14 h-14 rounded-full mx-auto ${heroWrap} ` +
              // One brief settle on arrival — the page's one ceremonial beat,
              // on the doctrine curve at 450 ms. It used an overshoot curve
              // (0.2,0.9,0.3,1.2) that bounced past its size. No confetti.
              "transition-[opacity,scale] duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none " +
              (heroIn ? "opacity-100 scale-100" : "opacity-0 scale-90")
            }
          >
            <HeroIcon size={28} strokeWidth={1.75} className={heroIconCls} aria-hidden="true" />
          </div>
          {/* The whole outcome, announced as one thing — role="status" reads
              it; the heading takes focus so the next Tab starts here. */}
          <div className="space-y-1" role="status" aria-live="polite">
            <h1
              ref={resultHeadingRef}
              tabIndex={-1}
              className="text-[26px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 outline-none"
            >
              {title}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300">{body}</p>
            {deliveryLine && (
              <p className="text-sm text-gray-500 dark:text-gray-400 pt-0.5 break-words">{deliveryLine}</p>
            )}
          </div>

          {/* The state, once: a still pill. It used to spin — and kept
              spinning after the page had stopped checking (8 polls, ~2 min),
              promising activity that was not happening. The page still
              updates itself if the venue confirms while it is open. */}
          {isRequest && (
            <div className="inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              {t("rsvpStatusPending", "Awaiting confirmation")}
            </div>
          )}
          {/* Only when a request the guest sent HERE flips to confirmed —
              on a reopened receipt the headline already says so. A grey pill
              with a status dot, per the house rules. */}
          {isConfirmed && result.status === "requested" && (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200"
              role="status"
              aria-live="polite"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              {t("rsvpStatusConfirmed", "Bekræftet")}
            </div>
          )}

          {/* The receipt — BonBox's own mark is a receipt, so the proof of a
              booking is one: the venue on top, a dashed tear line, the
              details in even rows, and a torn edge at the bottom. */}
          <div className="text-left motion-safe:animate-[bbRise_0.45s_ease-out]">
            <div className="rounded-t-xl bg-white dark:bg-gray-900 px-5 pt-5 pb-2 shadow-[0_18px_44px_-24px_rgba(15,23,42,0.30)]">
              <div className="flex items-center gap-3">
                <VenueBadge logoUrl={page.logo_url} name={page.business_name} size="sm" />
                <p className="min-w-0 flex-1 text-[17px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 truncate">
                  {/* A nameless venue: the same words the calendar file uses,
                      so the receipt and the calendar agree. */}
                  {page.business_name ||
                    (apptWords
                      ? t("rsvpIcsSummaryNoVenueProvider", "Appointment")
                      : t("rsvpIcsSummaryNoVenue", "Table reservation"))}
                </p>
                {/* A cancelled / withdrawn / declined receipt must not look like a
                    live booking at a glance — it's stamped, and the rows dim. */}
                {isCancelled ? (
                  <p className="shrink-0 rounded-md border border-gray-400 dark:border-gray-500 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-600 dark:text-gray-300">
                    {withdrawn
                      ? t("rsvpStampWithdrawn", "Withdrawn")
                      : declined
                        ? t("rsvpStampDeclined", "Declined")
                        : t("rsvpStampCancelled", "Cancelled")}
                  </p>
                ) : refCode && (
                  <p className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400 tabular-nums">
                    {refCode}
                  </p>
                )}
              </div>
              <div className="my-4 border-t-2 border-dashed border-gray-200 dark:border-gray-700" aria-hidden="true" />
              <dl>
                {rows.map((row) => (
                  <div key={row.k} className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="min-w-[88px] shrink-0 whitespace-nowrap text-[13.5px] text-gray-500 dark:text-gray-400">{row.label}</dt>
                    <dd className="min-w-0 text-right text-[15px] font-medium text-gray-900 dark:text-gray-100 break-words">
                      {row.value}
                    </dd>
                  </div>
                ))}
                {address && (
                  <div className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="min-w-[88px] shrink-0 whitespace-nowrap text-[13.5px] text-gray-500 dark:text-gray-400">
                      {t("rsvpRowWhere", "Where")}
                    </dt>
                    <dd className="min-w-0 text-right text-[15px] font-medium text-gray-900 dark:text-gray-100 break-words">
                      {mapUrl ? (
                        // min-h-0!: a class loses to the global 44pt touch
                        // rule (it is not in a Tailwind layer), so only the
                        // important form keeps this row as tall as the rest.
                        // The Directions button below is the big map target.
                        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="min-h-0! hover:underline">
                          {address}
                        </a>
                      ) : (
                        address
                      )}
                    </dd>
                  </div>
                )}
                {telHref(page.phone) && (
                  <div className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="min-w-[88px] shrink-0 whitespace-nowrap text-[13.5px] text-gray-500 dark:text-gray-400">
                      {t("rsvpCallVenueLabel", "Call us")}
                    </dt>
                    <dd className="min-w-0 text-right text-[15px] font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                      {/* 22 px of text, 44 px to the finger (walk 27 Oct G11). */}
                      <a
                        href={telHref(page.phone)}
                        className="relative after:absolute after:inset-x-0 after:-inset-y-[11px] after:content-[''] min-h-0! hover:underline"
                      >
                        {page.phone}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
            {/* Torn edge: 16 teeth cut into a strip the colour of the card. */}
            <div
              aria-hidden="true"
              className="h-3 bg-white dark:bg-gray-900"
              style={{ clipPath: TORN_EDGE }}
            />
          </div>

          {isCancelled ? (
            // Nothing left to add to a calendar or navigate to — the one
            // useful thing is to book again, which the copy already invites.
            <Button variant="main" size="lg" className="w-full" onClick={startOver}>
              {withdrawn || declined ? t("rsvpNewRequest", "Send a new request") : t("rsvpBookAgain", "Book again")}
            </Button>
          ) : (
            !isDone && (
              <div className="grid grid-cols-2 gap-2 [&>*:only-child]:col-span-2">
                {/* Add to calendar — only for a CONFIRMED booking with a real
                    time. A pending request has no agreed time yet, and writing
                    one into someone's calendar would invent a promise the venue
                    has not made. */}
                {isConfirmed && rTime && rDay && (
                  <button
                    type="button"
                    className={RECEIPT_ACTION}
                    onClick={async () => {
                      const ics = buildIcs({
                        uid: `${result.id}@bonbox.dk`,
                        day: rDay,
                        time: rTime,
                        // The booking's real length (R2, rubric V5).
                        minutes: icsMinutesFor({
                          server: result?.duration_min,
                          linked: linked?.durationMin,
                          service: isProvider ? chosenBehandling?.duration_min : null,
                        }),
                        // business_name, not name — the public payload has no
                        // `name` field at all.
                        summary: apptWords
                          ? (page.business_name
                            ? t("rsvpIcsSummaryProvider", "Appointment at {venue}", { venue: page.business_name })
                            : t("rsvpIcsSummaryNoVenueProvider", "Appointment"))
                          : page.business_name
                            ? t("rsvpIcsSummary", "Bord hos {venue}", { venue: page.business_name })
                            : t("rsvpIcsSummaryNoVenue", "Bordreservation"),
                        location: address,
                        description: [refCode, rName].filter(Boolean).join(" · "),
                      });
                      // On a phone the share sheet is the path that lands this
                      // in a calendar app — and the one that can silently
                      // deliver nothing, so the outcome is read, not dropped.
                      const out = await saveFile(ics, "reservation.ics", {
                        type: "text/calendar;charset=utf-8",
                        title: t("rsvpAddToCalendar", "Føj til kalender"),
                      });
                      setCalError(out.ok ? "" : t("calendarAddFailed"));
                    }}
                  >
                    <CalendarPlus size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t("rsvpAddToCalendarShort", "Calendar")}</span>
                  </button>
                )}
                {mapUrl && (
                  <a
                    href={mapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={RECEIPT_ACTION}
                  >
                    <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t("rsvpDirections", "Directions")}</span>
                  </a>
                )}
              </div>
            )
          )}
          {calError && (
            <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-400">
              {calError}
            </p>
          )}

          {/* Self-cancel — frees the table and tells the restaurant. Quiet on
              purpose: cancelling is the exception. It still asks first. */}
          {canCancel && (
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="lg"
                onClick={onCancel}
                busy={cancelling}
                disabled={cancelling}
                className="w-full text-gray-500! dark:text-gray-400!"
              >
                {isRequest
                  ? t("rsvpWithdrawRequest", "Withdraw request")
                  : apptWords
                    ? t("rsvpCancelOrChangeAppt", "Cancel this appointment")
                    : t("rsvpCancelOrChange", "Cancel this booking")}
              </Button>
              {cancelError && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {t(
                    "rsvpCancelError",
                    "Kunne ikke aflyse. Prøv igen, eller kontakt stedet direkte.",
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // The "Other date" calendar, rendered inline (embed) or in a sheet.
  const calendar = (
    <DateCalendar
      value={day}
      min={today}
      max={latestDay}
      dayMap={dayMap}
      reasons={dayReasons}
      maxAdvance={maxAdvance}
      party={party}
      apptWords={apptWords}
      t={t}
      lang={lang}
      onPick={(iso) => {
        pickedDay.current = iso;
        setDay(iso);
        setShowDateInput(false);
      }}
      onClose={() => setShowDateInput(false)}
    />
  );

  // ── Main wizard ────────────────────────────────────────────────────
  // One wrapper element at every width; only its classes change. Below
  // 1024px (and in a frame, and in the embed) it is `display: contents`, so
  // the card lays out exactly as before; from 1024px it is a two-column grid
  // with the venue column on the left. The card keeps its child slot either
  // way, so it is never remounted when a window or an iPad split view
  // crosses the breakpoint (DateStrip refs, focus and step state survive),
  // and there is exactly one h1 at any width.
  const venueHeader = (layout) => (
    <VenueHeader
      page={page}
      t={t}
      lang={lang}
      setLang={setLang}
      apptWords={apptWords}
      step={step}
      layout={layout}
      isEmbed={isEmbed}
      todayIso={today}
      paused={paused}
      // The compact header carries the step dots in its one row (R4).
      compact={compactHead}
      dots={!pausedStep1 ? <StepDots step={step} t={t} apptWords={apptWords} /> : null}
    />
  );
  return (
    <div
      data-testid="rsvp-root"
      data-bb-accent={accent ? "" : undefined}
      style={accentStyle(accent)}
      className={`${rootMinH} ${ROOT_FINISH} bg-white dark:bg-gray-950 ${
        // Tablet/desktop: the booking sits on a card over a quiet ground,
        // instead of a narrow column floating on a white page. Embedded,
        // the host site is the ground: from 450 px the frame is transparent
        // and pads the one card (EMBED_GROUND); with &flat=1, nothing.
        isEmbed
          ? (embedCard ? EMBED_GROUND : "")
          : (pausedStep1 || fullNightOnScreen ? "pb-12" : "pb-32") + " sm:pt-10 sm:pb-12 sm:bg-gray-50 sm:dark:bg-gray-950"
      }`}
    >
      <div className={wide ? "grid grid-cols-[minmax(0,1fr)_28rem] gap-12 max-w-5xl mx-auto px-8 items-start" : "contents"}>
      {/* The venue column is the page's banner (the phone card's identity
          is a <header> too) and the card is its main region, so a screen
          reader's landmark list reads venue, then booking. */}
      {wide && (
        <header data-testid="rsvp-venue-column" className="sticky top-10 self-start">
          {venueHeader("column")}
        </header>
      )}
      <main
        className={
          (isEmbed ? EMBED_MAX : "max-w-md") + " mx-auto px-4 sm:px-6 pt-5 sm:pt-8 space-y-5 " +
          // In the grid, auto margins would size the card to its content
          // (it widened as the strip and the times arrived: a layout shift).
          (wide ? "w-full " : "") +
          (isEmbed
            ? (embedCard ? EMBED_CARD : "")
            : "sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white sm:shadow-sm dark:sm:border-gray-800 dark:sm:bg-gray-900")
        }
      >
        {/* ── Venue identity (brand logo or typographic monogram) ──
            Identity tile + eyebrow + venue name H1 + location row with a
            quiet tappable phone and the opening hours. One trust line
            underneath. On a wide screen it lives in the column instead. */}
        {!wide && venueHeader("card")}

        {/* No steps to show while paused: there is no flow. The compact
            header (R4) shows them in its own row. On a desktop the card's top
            row carries the language switch beside them (G10 item 2). */}
        {wide ? (
          <div data-testid="rsvp-card-top" className="flex items-center justify-between gap-3">
            <div className="min-w-0">{!pausedStep1 && <StepDots step={step} t={t} apptWords={apptWords} />}</div>
            <LangPill lang={lang} setLang={setLang} />
          </div>
        ) : (
          !pausedStep1 && !compactHead && <StepDots step={step} t={t} apptWords={apptWords} />
        )}

        {/* The step area: exactly one of the paused panel, step 1 or step 2.
            It eases between heights (useAutoHeight) instead of jumping. */}
        <div ref={setStepArea} data-testid="rsvp-step-area">
        {/* ── Step 1 — (provider) behandling + behandler, then date + slot;
              (table) date + party + slot ────────────────────────────── */}
        {pausedPanel && (
          // Online booking is paused (owner Q2): one calm panel, the venue's
          // phone as the only way on. No pickers, no strip, no calendar, no
          // times and no bottom button — nothing that leads nowhere. Never
          // "full", never a plan word. Grey, not amber: nothing went wrong.
          <section
            ref={stepFocusRef}
            tabIndex={-1}
            role="status"
            data-testid="rsvp-paused"
            className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-white/5 px-4 py-4 space-y-3 outline-none"
          >
            <p className="text-[15px] font-medium leading-snug text-gray-700 dark:text-gray-300">
              {submitError === "not_accepting"
                ? t("rsvpErrClosed", "Online booking was paused while you were booking.")
                : t("rsvpNotAcceptingOnline", "Online booking is paused right now.")}
            </p>
            {telHref(page.phone) ? (
              <a href={telHref(page.phone)} className={TEL_ACTION}>
                <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{t("rsvpNoSlotsCall", "Call us: {phone}", { phone: page.phone })}</span>
              </a>
            ) : (
              <p className="text-[13px] text-gray-500 dark:text-gray-400">
                {t("rsvpContactVenueDirect", "Contact the venue directly to book.")}
              </p>
            )}
          </section>
        )}
        {step === 1 && !pausedPanel && (
          <section
            ref={stepFocusRef}
            tabIndex={-1}
            aria-label={apptWords ? t("rsvpBookATime", "Book an appointment") : t("rsvpBookATable", "Book a table")}
            className={STEP1_SPACING + " outline-none " + STEP_ENTER}
          >
            {/* R12: back through the waitlist link — the guest's place first. */}
            {searchParams.get("wt") && (
              <Suspense fallback={null}>
                <FullNightOffer host={wlHost} back />
              </Suspense>
            )}
            {/* Provider (salon): behandling → behandler come FIRST. The chosen
                behandling drives slot length (server-resolved); behandler
                defaults to Valgfri behandler. */}
            {isProvider && (
              <>
                <div>
                  <label
                    htmlFor="rsvp-behandling"
                    className={SECTION_TITLE + " mb-2.5"}
                  >
                    {t("rsvpPublicPickBehandling", "Vælg behandling")}
                  </label>
                  {behandlinger.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        "rsvpBehandlingNoneOnPage",
                        "No services are bookable online right now.",
                      )}
                    </p>
                  ) : (
                    <div className="relative">
                    <select
                      id="rsvp-behandling"
                      value={behandlingId}
                      onChange={(e) => setBehandlingId(e.target.value)}
                      className={SELECT_TILE + FOCUS}
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
                    <SelectChevron />
                    </div>
                  )}
                </div>
                {/* Behandler — Valgfri behandler is the default. Named behandlere
                    appear only when the page exposes a roster; otherwise Valgfri
                    is the honest single option. */}
                <div>
                  <label
                    htmlFor="rsvp-behandler"
                    className={SECTION_TITLE + " mb-2.5"}
                  >
                    {t("rsvpPublicPickBehandler", "Vælg behandler")}
                  </label>
                  {providers.length > 0 ? (
                    <div className="relative">
                    <select
                      id="rsvp-behandler"
                      value={stylistId}
                      onChange={(e) => setStylistId(e.target.value)}
                      className={SELECT_TILE + FOCUS}
                    >
                      <option value="">{t("rsvpBookValgfri", "Any stylist")}</option>
                      {providers.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name || p.label}
                        </option>
                      ))}
                    </select>
                    <SelectChevron />
                    </div>
                  ) : (
                    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300">
                      {t("rsvpBookValgfri", "Any stylist")} ·{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("rsvpBookValgfriHint", "We'll match you with the first free stylist.")}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
            {/* Party size — TABLE venues only. A salon tidsbestilling is one
                customer; the behandling sets the length, not party size. A
                shop or a workshop is booked by one customer too: "Antal
                gæster" 1–10 asked a tøjbutik's customer a restaurant's
                question (Push 8). */}
            {!apptWords && (
              <div>
                <h2 className={SECTION_TITLE + " " + PARTY_TITLE_GAP}>
                  {t("rsvpPartySize", "Party size")}
                </h2>
                {/* Party sizes 1–10 on a phone: a static grid of two rows of
                    five (partyColsPhone: one row up to 7, then 4+4, 5+4, 5+5),
                    so 8–10 — the group sizes — are visible without a swipe.
                    The 1 Aug rail (26ca4e98) existed because the old two-row
                    grid of 44px chips pushed the first time below the fold;
                    these chips were 40px (h-10! + min-h-0!, which releases the
                    coarse-pointer 44px floor) and the fold is measured, not
                    assumed (spec p1 §6: first time row ≥ 8px above the bar at
                    375×667, 390×844, 402×874). Booking R4: 44px on a phone
                    again (PARTY_CHIP_H) — the spacing and the short-screen
                    rail now pay for it. On a short phone screen
                    (≤ 700px tall) the standalone page keeps the single swipe
                    row instead (fold ladder step 2, owner Q5: the live
                    bistro's two-row header left the times 16px under the
                    bar). A ceiling above 10 keeps the single swipe row
                    (owner Q3). Digits stay 15px to match the
                    time digits right below (owner Q6a). From sm up: rows of
                    equal length (5 + 5, not 7 + 3), as before. */}
                <div
                  ref={partyRailRef}
                  role="radiogroup"
                  aria-label={t("rsvpPartySize", "Party size")}
                  onKeyDown={rovingKeyDown}
                  style={{
                    "--party-cols": partyOptions.length <= 8 ? partyOptions.length : Math.ceil(partyOptions.length / 2),
                    "--party-cols-phone": partyColsPhone(partyOptions.length),
                  }}
                  className={
                    partyGrid
                      ? PARTY_GRID + (isEmbed ? "" : " " + PARTY_SHORT_RAIL)
                      : RAIL + " sm:grid sm:grid-cols-[repeat(var(--party-cols),minmax(0,1fr))] sm:gap-1.5"
                  }
                >
                  {partyOptions.map((n) => (
                    <BookingTile
                      key={n}
                      selected={party === n}
                      onClick={() => setParty(n)}
                      aria-label={partyLabel(n, t)}
                      role="radio"
                      aria-checked={party === n}
                      tabIndex={party === n ? 0 : -1}
                      // 44px on a phone, 40px from sm, grid and rail alike
                      // (PARTY_CHIP_H; min-h-0! releases the coarse-pointer
                      // floor). Rail (a ceiling above 10): width from the
                      // screen, 7½ chips across, so a half chip always sits at
                      // the edge and says the row goes on.
                      className={
                        partyGrid
                          ? "w-full px-0 " + PARTY_CHIP_H + " min-h-0! tabular-nums text-[15px] " +
                            (isEmbed ? "" : PARTY_CHIP_SHORT_RAIL + " ") + FOCUS
                          : "shrink-0 w-[max(2.5rem,calc((100vw-4.5rem)/7.5))] sm:w-auto " + PARTY_CHIP_H + " min-h-0! px-3.5 snap-start tabular-nums text-[15px] " + FOCUS
                      }
                    >
                      {n}
                    </BookingTile>
                  ))}
                </div>
                {/* This hint used to read "Større selskab? Vælg det højeste
                    antal — vi sender en forespørgsel" and it was shown at
                    every party size. Following it produced a WRONG BOOKING:
                    the backend rejects party_size above the owner's
                    max_party_size (409 party_too_large), so a party of
                    fourteen could only send "10 personer". The owner laid up
                    for ten, the confirmation said ten, and fourteen people
                    arrived. Nothing in the product ever said otherwise.
                    So: only speak when the guest is actually at the ceiling,
                    and give them a route that ends in the real number
                    reaching the venue. Calling is that route; where there is
                    no number, the note field is, and the owner reads it. */}
                {party >= maxParty && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1.5">
                    {telHref(page.phone) ? (
                      <>
                        {t("rsvpPartyOverMaxCall", "More than {n} of you? Give us a call", {
                          n: maxParty,
                        })}{" "}
                        <a
                          href={telHref(page.phone)}
                          className="font-medium text-gray-700 dark:text-gray-200 underline"
                        >
                          {page.phone}
                        </a>
                      </>
                    ) : (
                      t(
                        "rsvpPartyOverMaxNote",
                        "More than {n} of you? Put the exact number in the message field on the next step.",
                        { n: maxParty },
                      )
                    )}
                  </p>
                )}
              </div>
            )}

            {/* Date */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h2 className={SECTION_TITLE}>
                  {t("rsvpPickDate", "Pick a date")}
                </h2>
                {maxAdvance < 14 ? (
                  // The whole booking window is on the strip (the last
                  // bookable day, today + maxAdvance, is its last chip), so a
                  // calendar would add nothing: say how far ahead instead.
                  // Same row, zero extra height.
                  <span data-testid="rsvp-book-ahead" className="text-[13px] text-gray-500 dark:text-gray-400">
                    {bookAheadText(maxAdvance, t)}
                  </span>
                ) : (
                  // Quiet escape hatch for a far-out date, revealed on demand so
                  // the calendar never clutters the default clean strip.
                  <button
                    type="button"
                    // The month grid's chunk starts on the press (R12).
                    onPointerDown={warmCalendar}
                    onFocus={warmCalendar}
                    onClick={() => {
                      setCalendarAt("header");
                      setShowDateInput((v) => !(v && calendarAt === "header"));
                    }}
                    aria-expanded={showDateInput && (!isEmbed || calendarAt === "header")}
                    // -my-3: keeps its 44pt touch target without making this
                    // header row taller than the other two questions'.
                    className={"-my-3 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors " + FOCUS}
                  >
                    <Calendar size={13} strokeWidth={1.75} aria-hidden="true" />
                    {t("rsvpOtherDate", "Other date")}
                  </button>
                )}
              </div>
              {/* The owner paused online booking (R1): say until when, above
                  the strip — which has already moved to the next open day.
                  "Opens again <the day after>" was untrue when the day after
                  is a weekly closed day (review), so it names the last paused
                  day, and offers the phone. Grey, not amber: nothing broke. */}
              {page?.paused_until && page.paused_until >= today && (
                <div
                  role="status"
                  data-testid="rsvp-paused-reopens"
                  className="mb-2.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-white/5 px-3 py-2 text-[13px] text-gray-700 dark:text-gray-300 space-y-1"
                >
                  <p className="flex items-start gap-2">
                    <PauseCircle size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-gray-500" aria-hidden="true" />
                    <span>{t("rsvpPausedUntil", "Online booking is paused until and including {date}.", { date: fmtDayLabel(page.paused_until, lang) })}</span>
                  </p>
                  {telHref(page.phone) && (
                    <a href={telHref(page.phone)} data-testid="rsvp-paused-call" className="ml-[23px] inline-flex items-center gap-1 font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2">
                      <Phone size={13} strokeWidth={1.75} aria-hidden="true" />
                      {t("rsvpNoSlotsCall", "Call us: {phone}", { phone: page.phone })}
                    </a>
                  )}
                </div>
              )}
              {/* One-tap date strip (unbookable days disabled, with the reason) — the primary picker. */}
              <DateStrip
                today={today}
                dayMap={dayMap}
                reasons={dayReasons}
                maxAdvance={maxAdvance}
                party={party}
                apptWords={apptWords}
                value={day}
                onPick={(iso) => {
                  pickedDay.current = iso;
                  setDay(iso);
                }}
                t={t}
                lang={lang}
                fullTappable={waitFull}
              />
              {/* The owner's words for the days they closed on the strip
                  ("tor 24. dec · Lukket juleaften", R1 B4). The strip only
                  says "lukket"; this says why, in the venue's own words. */}
              {(() => {
                const noted = Object.entries(dayClosures)
                  .filter(([d, c]) => c?.note && d !== day)
                  .sort(([a], [b]) => (a < b ? -1 : 1))
                  .slice(0, 3);
                if (!noted.length) return null;
                return (
                  <ul data-testid="rsvp-closure-notes" className="mt-2 space-y-0.5 text-[13px] text-gray-500 dark:text-gray-400">
                    {noted.map(([d, c]) => (
                      <li key={d} className="flex items-start gap-1.5">
                        <CalendarOff size={13} strokeWidth={1.75} className="mt-[3px] shrink-0" aria-hidden="true" />
                        <span>{capFirst(fmtDayShort(d, lang))} · {c.note}</span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
              {/* A later date: the page's own month grid in a sheet. The
                  native date field looked different on every phone and could
                  not show which days the place is closed. */}
              {showDateInput && isEmbed && calendarAt === "header" && (
                // Embedded on the restaurant's own site: the calendar opens in
                // place. A sheet is fixed to the bottom of the iframe, which is
                // as tall as the widget — far below what the guest can see.
                <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                  {calendar}
                </div>
              )}
              {showDateInput && !isEmbed && (
                <Sheet
                  onClose={() => setShowDateInput(false)}
                  ariaLabel={t("rsvpPickDate", "Pick a date")}
                  panelClassName="bg-white dark:bg-gray-900 sm:max-w-sm"
                >
                  {calendar}
                </Sheet>
              )}
            </div>

            {/* Time. One question, answered from a grid: the day's services
                (Frokost / Eftermiddag / Aften) as a segmented control, and
                that service's times four across — every time visible, no
                sideways scrolling to find 19:30. For a group request the same
                grid asks for a PREFERRED time; the venue confirms it. */}
            <div>
              {/* The lost-the-race message, rendered WHERE THE GUEST LANDS.
                  The 409 handler bounces to step 1; their name and contact
                  stay filled. */}
              {submitError && step === 1 && (
                <div
                  ref={submitErrorBoxRef}
                  role="alert"
                  className="mb-2.5 rounded-xl border border-amber-200 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-900/10 px-3 py-2"
                >
                  <p className="text-sm text-amber-900 dark:text-amber-200">
                    {submitErrorMessage(submitError, t)}
                  </p>
                </div>
              )}
              <h2 id="rsvp-times" className={SECTION_TITLE + " mb-2.5 scroll-mt-6"}>
                {groupRequest
                  ? t("rsvpPickWishedTime", "Preferred time")
                  : t("rsvpPickTime", "Vælg tidspunkt")}
              </h2>
              {groupRequest && slotGroups.length > 0 && (
                <p className="-mt-1 mb-3 text-[13px] leading-snug text-gray-500 dark:text-gray-400">
                  {/* A salon, a shop or a workshop books one person, so a
                      request there means every appointment is one (its owner
                      approves each) — not "Selskaber på 1 … I ønsker". */}
                  {apptWords
                    ? t(
                      "rsvpGroupWishedTimeHintAppt",
                      "Every appointment is sent as a request — pick the time you'd like and we'll confirm it.",
                    )
                    : t(
                      "rsvpGroupWishedTimeHint",
                      "Parties of {n} are sent as a request — pick the time you'd like and we'll confirm it.",
                      { n: party },
                    )}
                </p>
              )}
              {/* The time area's words sit in ONE live region that is always
                  there, so "Vi kan ikke finde et bord til 7 online." is read
                  out when it replaces the times (a region inserted with its
                  text already in it is not reliably announced). The grid of
                  times renders outside it: a new day must not read out 20
                  times. */}
              <div aria-live="polite" data-testid="rsvp-times-status">
              {isProvider && !behandlingId ? (
                // Provider: no behandling chosen yet → don't imply "no times".
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("rsvpPublicPickBehandling", "Vælg behandling")}
                </p>
              ) : slotsLoading && slotGroups.length === 0 ? (
                // The skeleton is the shape of the times that replace it
                // (bookingTiles.js): the tile material, 12 px corners, the
                // grid's own columns and three rows, so nothing jumps.
                <div className={SKELETON_GRID} aria-hidden="true" data-testid="rsvp-times-skeleton">
                    {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                      <div key={i} className={skeletonTileClass(i)} />
                    ))}
                  </div>
              ) : slotsError ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t("rsvpSlotsError", "Couldn't load times — please try again.")}
                  </p>
                  <Button
                    variant="secondary"
                    size="md"
                    className="shrink-0"
                    onClick={() =>
                      isProvider
                        ? fetchAvailability(day, party, behandlingId, stylistId)
                        : fetchAvailability(day, party)
                    }
                  >
                    {t("rsvpRetry", "Try again")}
                  </Button>
                </div>
              ) : closedReason === "not_accepting" || paused ? (
                  // The venue is at its monthly ceiling, so NO date works. This
                  // sits above the slotGroups branch on purpose: the branches
                  // below offer "next open day" and a 14-day hunt, and sending
                  // the guest looking for an evening that cannot exist is worse
                  // than the dead form this replaces. Phone fallback stays — the
                  // venue is open, it just can't take another ONLINE booking.
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      {t(
                        "rsvpNotAcceptingOnline",
                        "Online booking is paused right now.",
                      )}
                    </p>
                    {telHref(page.phone) && (
                      <a
                        href={telHref(page.phone)}
                        className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
                      >
                        <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                        <span>
                          {t("rsvpNoSlotsCall", "Call us: {phone}", {
                            phone: page.phone,
                          })}
                        </span>
                      </a>
                    )}
                  </div>
                ) : slotGroups.length === 0 ? (
                  !isProvider && dayMap === null ? (
                    // Open/closed overview still resolving → don't flash a
                    // premature "no times"; show the same slot skeleton.
                    <div className={SKELETON_GRID} aria-hidden="true" data-testid="rsvp-times-skeleton">
                      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                        <div key={i} className={skeletonTileClass(i)} />
                      ))}
                    </div>
                  ) : isProvider && dayMap === null && dayReason !== "no_fit" ? (
                    // A salon whose 14-day overview is not in (still loading,
                    // or it failed): THIS day has no time, and that is all
                    // the page knows. No "de næste 14 dage", no next day, no
                    // "Anden dato" here — nothing checked the other days.
                    <div className="space-y-3">
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {reasonSentence(dayReason, t, sentenceCtx) || t("rsvpNoSlotsDay", "No available times on this day.")}
                      </p>
                      {telHref(page.phone) && (
                        <a href={telHref(page.phone)} className={TEL_ACTION}>
                          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                          <span>{t("rsvpNoSlotsCall", "Call us: {phone}", { phone: page.phone })}</span>
                        </a>
                      )}
                    </div>
                  ) : dayReason === "no_fit" ? (
                    // Online can't seat THIS party (above the online maximum,
                    // no table or combination seats it, or the sitting is
                    // longer than the day's hours): a call, never "lukket".
                    // The jump only when a later day is open — a party-wide
                    // no_fit has none.
                    <div className="space-y-3">
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        {reasonSentence("no_fit", t, sentenceCtx)}
                      </p>
                      {telHref(page.phone) ? (
                        <div className="space-y-1.5">
                          <p className="text-[13px] text-gray-500 dark:text-gray-400">
                            {t("rsvpNoFitCallHint", "We're happy to sort it out by phone.")}
                          </p>
                          <a href={telHref(page.phone)} className={TEL_ACTION}>
                            <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                            <span>{t("rsvpNoSlotsCall", "Call us: {phone}", { phone: page.phone })}</span>
                          </a>
                        </div>
                      ) : (
                        <p className="text-[13px] text-gray-500 dark:text-gray-400">
                          {t("rsvpContactVenueDirect", "Contact the venue directly to book.")}
                        </p>
                      )}
                      {nextOpenDay && nextOpenDay > day && (
                        <Button size="lg" onClick={() => setDay(nextOpenDay)}>
                          {t("rsvpJumpNextOpen", "Show {day}", { day: fmtDayLabel(nextOpenDay, lang) })}
                        </Button>
                      )}
                    </div>
                  ) : !isProvider && dayReason === "full" && fullNight ? (
                    // R12: the nearest free times and the waitlist for it.
                    fullBlock
                  ) : nextOpenDay && nextOpenDay > day ? (
                    // Not bookable this day but open later — NEVER a dead end.
                    // The real reason ("Fuldt booket til 2 gæster denne dag.")
                    // or the neutral line, then one tap to the next open day.
                    // Only forward: a calendar pick beyond the summary has an
                    // EARLIER next open day, and a jump back would be odd.
                    <div className="space-y-3">
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        {(reasonSentence(dayReason, t, sentenceCtx) || t("rsvpNoSlotsDay", "No available times on this day.")) +
                          " " +
                          t("rsvpNextOpenDay", "Next available day: {day}", { day: fmtDayLabel(nextOpenDay, lang) })}
                      </p>
                      <Button size="lg" onClick={() => setDay(nextOpenDay)}>
                        {t("rsvpJumpNextOpen", "Show {day}", { day: fmtDayLabel(nextOpenDay, lang) })}
                      </Button>
                    </div>
                  ) : (
                    // Nothing open later in the window → the honest line and
                    // the phone (a real <a href="tel:">, dials on tap). The
                    // window line names the header's own number ("Book op til
                    // 7 dage frem" → "… i dag eller de næste 7 dage"), never a
                    // flat 14, and is left out when it would only repeat the
                    // reason ("for sent … i dag" on a today-only window).
                    <div className="space-y-3">
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {nextOpenDay
                          ? reasonSentence(dayReason, t, sentenceCtx) || t("rsvpNoSlotsDay", "No available times on this day.")
                          : (() => {
                              const why = ["closed", "closed_date", "paused_date", "full", "too_late"].includes(dayReason)
                                ? reasonSentence(dayReason, t, sentenceCtx)
                                : null;
                              const window = why && maxAdvance <= 0 ? null : noneBookableText(maxAdvance, t);
                              return [why, window].filter(Boolean).join(" ");
                            })()}
                      </p>
                      {telHref(page.phone) && (
                        <a href={telHref(page.phone)} className={TEL_ACTION}>
                          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                          <span>{t("rsvpNoSlotsCall", "Call us: {phone}", { phone: page.phone })}</span>
                        </a>
                      )}
                      {/* Later days may exist past the strip: the calendar,
                          as a quiet text button (inline in the embed, where
                          nothing scrolls the host page). */}
                      {!nextOpenDay && rail === 14 && maxAdvance >= 14 && (
                        <div>
                          <button
                            type="button"
                            onPointerDown={warmCalendar}
                            onFocus={warmCalendar}
                            onClick={() => {
                              setCalendarAt("empty");
                              setShowDateInput(true);
                            }}
                            aria-expanded={showDateInput && (!isEmbed || calendarAt === "empty")}
                            className={"inline-flex items-center gap-1.5 h-10 min-h-0! rounded-md text-[13px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors " + FOCUS}
                          >
                            <Calendar size={13} strokeWidth={1.75} aria-hidden="true" />
                            {t("rsvpOtherDate", "Other date")}
                          </button>
                          {/* The embed draws the calendar HERE, under the tap
                              (the frame never scrolls to the strip). */}
                          {showDateInput && isEmbed && calendarAt === "empty" && (
                            <div
                              data-testid="rsvp-calendar-at-empty"
                              className="mt-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                            >
                              {calendar}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                ) : null}
              </div>
              {timesShowGrid && (
                  <TimeGrid
                    groups={slotGroups}
                    slot={slot}
                    onPick={(s) => {
                      setSlot(s);
                      setSubmitError("");
                    }}
                    slotRemaining={slotRemaining}
                    // A day change keeps the old times on screen, dimmed, until
                    // the new ones arrive — no flash of placeholders, no jump.
                    loading={slotsLoading}
                    t={t}
                    apptWords={apptWords}
                  />
              )}
              {/* R12: the evening is full while earlier times are free. */}
              {timesShowGrid && eveningFull && fullBlock}
            </div>
            {/* ── Pick your table on the 2D floor (matches the owner room) ──
                Honesty gate #1 (+ grandfather): TABLE venues (dining/bar) show the
                floor; a provider (salon) never fetches one so floor stays empty and
                this stays hidden; a no-floor (bakery/retail) venue with zero tables
                likewise shows nothing. A venue that ALREADY has a real table plan
                renders it because free tables actually came back (floor.length > 0).
            */}
            {page.guest_can_pick_table && (usesTableFloor(page.business_type) || floor.length > 0) && !groupRequest && slot && (floorLoading || floor.length > 0) && (
              <div>
                <h2 className={SECTION_TITLE + " mb-2.5"}>
                  {t("rsvpFloorPickTitle", "Vælg dit bord")}
                </h2>
                {floorLoading ? (
                  <div className={FLOOR_WAIT} />
                ) : floor.some((tb) => tb.status === "free") ? (
                  <>
                    <Suspense fallback={<div className={FLOOR_WAIT} />}>
                      <PublicFloorMap
                        tables={floor}
                        selectedId={selectedTable}
                        onSelect={setSelectedTable}
                        t={t}
                        bookingMode={usesTableFloor(page.business_type) ? bookingModeFor(page.business_type) : "table"}
                      />
                    </Suspense>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      {selectedTable
                        ? t("rsvpFloorPicked", "Fint valg — bordet er jeres, hvis det stadig er ledigt, når du booker.")
                        : t("rsvpFloorOptional", "Tryk på et ledigt bord — eller spring over, så finder vi det bedste ledige.")}
                    </p>
                  </>
                ) : (
                  <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-3 text-sm text-gray-600 dark:text-gray-300">
                    {t("rsvpFloorAllTaken", "Bordene til {n} er fyldt på dette tidspunkt — vi sætter jer ved det bedste ledige bord.", { n: party })}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── Step 2 — guest details ────────────────────────────────── */}
        {step === 2 && (
          <section className={"space-y-5 " + STEP_ENTER}>
            <h2
              ref={stepFocusRef}
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100 outline-none"
            >
              {t("rsvpYourDetails", "Your details")}
            </h2>
            {/* Recap of the picks from step 1. Provider (salon): behandling +
                behandler + duration + dato/tid (e.g. "Klip · Marta · 30 min ·
                lørdag 13. juni 14:00", or "Valgfri behandler"). Table venues
                keep the date · time · party · table line. */}
            {/* The recap is also the way back: tapping it returns to step 1
                with every pick intact ("Change" says so), instead of leaving
                the guest to find the Back button in the bar below. */}
            <button
              type="button"
              onClick={backToChoices}
              className={"w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 hover:border-gray-300 dark:hover:border-gray-600 transition-colors px-4 py-3 flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300 " + FOCUS}
            >
              <Calendar size={18} strokeWidth={1.75} className="text-gray-400 dark:text-gray-500 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {isProvider ? (
                <span className="min-w-0">
                  {chosenBehandling && (
                    <span className="font-medium">{chosenBehandling.name}</span>
                  )}
                  <span aria-hidden="true"> · </span>
                  <span className={chosenStylistName ? "font-medium" : ""}>
                    {chosenStylistName || t("rsvpBookValgfri", "Any stylist")}
                  </span>
                  {chosenBehandling && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span>
                        {t("rsvpBehandlingMinutes", "{n} min", {
                          n: chosenBehandling.duration_min,
                        })}
                      </span>
                    </>
                  )}
                  <span aria-hidden="true"> · </span>
                  <span>{fmtDayLabel(day, lang)}</span>
                  {slot && (
                    <>
                      <span aria-hidden="true"> </span>
                      <span>{slot}</span>
                    </>
                  )}
                </span>
              ) : (
                // Two lines on purpose: the day, then time · party · table.
                // As one wrapping line it broke wherever the width ran out,
                // leaving a stray "·" at the end of a row.
                <span className="min-w-0">
                  <span className="block font-medium text-gray-900 dark:text-gray-100 first-letter:uppercase">
                    {fmtDayLabel(day, lang)}
                  </span>
                  <span className="block text-gray-500 dark:text-gray-400">
                    {[
                      slot || null,
                      partyLabel(party, t, apptWords),
                      !groupRequest && selectedTable
                        ? floor.find((x) => String(x.id) === String(selectedTable))?.label || null
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              )}
              </span>
              <span className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                {t("rsvpEditPicks", "Change")}
              </span>
            </button>

            {/* Field discipline: NAME is the one first-class field (lg).
                Email + phone are secondary; email carries a calm "why"
                helper. Everything else hides behind ONE disclosure. */}
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="rsvp-name"
                  className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1.5"
                >
                  {t("rsvpName", "Navn")}
                </label>
                <Input
                  id="rsvp-name"
                  size="lg"
                  className="rounded-xl!"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  placeholder={t("rsvpNamePh", "Anna Hansen")}
                  invalid={nameTouched && !nameValid}
                  error={
                    nameTouched && !nameValid
                      ? t("rsvpNameRequired", "Indtast dit navn.")
                      : null
                  }
                  autoComplete="name"
                  maxLength={160}
                  required
                  enterKeyHint="next"
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    document.getElementById(contactMode === "phone" ? "rsvp-phone" : "rsvp-email")?.focus();
                  }}
                />
              </div>

              {/* Email + phone — either one is required (the guest needs one
                  reachable channel). Each field is individually optional, so
                  the labels are bare and a single hint states the "one of these"
                  rule honestly (no more "(optional)" on a field that, together,
                  is required). Email gets the "why" helper. */}
              <div className="space-y-3">
                <p className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t("rsvpContactHow", "How should we reach you?")}
                </p>
                {/* One choice, then one field. Two always-visible boxes under a
                    line saying "only one is needed" made the guest do the
                    reasoning; a segment answers it before they start typing. */}
                <div
                  role="radiogroup"
                  aria-label={t("rsvpContactHow", "How should we reach you?")}
                  onKeyDown={rovingKeyDown}
                  className="flex gap-1 p-1 rounded-xl bg-gray-100 dark:bg-gray-800"
                >
                  {[
                    { k: "email", label: t("rsvpContactEmailLabel", "Email") },
                    { k: "phone", label: t("rsvpContactPhoneLabel", "Telefon") },
                  ].map((m) => (
                    <button
                      key={m.k}
                      type="button"
                      role="radio"
                      aria-checked={contactMode === m.k}
                      tabIndex={contactMode === m.k ? 0 : -1}
                      // Straight into the field that just appeared: render it
                      // now, then focus inside the same tap, so a phone's
                      // keyboard opens (iOS only honours focus from a gesture).
                      onClick={() => {
                        flushSync(() => setContactMode(m.k));
                        document.getElementById(m.k === "phone" ? "rsvp-phone" : "rsvp-email")?.focus();
                      }}
                      className={
                        "flex-1 h-10 rounded-lg text-sm font-semibold transition-colors duration-200 ease-out " + FOCUS + " " +
                        (contactMode === m.k
                          ? "bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm"
                          : "text-gray-600 dark:text-gray-400")
                      }
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                {contactMode === "email" ? (
                  <Input
                    id="rsvp-email"
                    type="email"
                    size="lg"
                    className="rounded-xl!"
                    aria-label={t("rsvpContactEmailLabel", "Email")}
                    value={guestEmail}
                    onChange={(e) => {
                      setGuestEmail(e.target.value);
                      if (submitError === "invalid_email") setSubmitError("");
                    }}
                    onBlur={() => setContactTouched(true)}
                    placeholder={t("rsvpEmailPh", "anna@eksempel.dk")}
                    invalid={contactTouched && contact.activeInvalid}
                    error={
                      contactTouched && contact.activeInvalid
                        ? t("rsvpEmailCheck", "Check your email — e.g. anna@example.com")
                        : null
                    }
                    hint={t("rsvpEmailWhy", "So we can send your confirmation.")}
                    autoComplete="email"
                    inputMode="email"
                    maxLength={255}
                    enterKeyHint="done"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <Input
                    id="rsvp-phone"
                    type="tel"
                    size="lg"
                    className="rounded-xl!"
                    aria-label={t("rsvpContactPhoneLabel", "Phone")}
                    value={guestPhone}
                    onChange={(e) => {
                      setGuestPhone(e.target.value);
                      if (submitError === "invalid_phone") setSubmitError("");
                    }}
                    onBlur={() => setContactTouched(true)}
                    placeholder={t("rsvpPhonePh", "+45 12 34 56 78")}
                    invalid={contactTouched && contact.activeInvalid}
                    error={
                      contactTouched && contact.activeInvalid
                        ? t("rsvpPhoneCheck", "Check your phone number — e.g. +45 12 34 56 78")
                        : null
                    }
                    // A request is confirmed by a call; "we only call if
                    // something changes" contradicted the receipt after it.
                    hint={
                      groupRequest
                        ? t("rsvpPhoneWhyRequest", "We'll call you to confirm your request.")
                        : t("rsvpPhoneWhy", "We only call if something changes.")
                    }
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={40}
                    enterKeyHint="done"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                )}
                {contactTouched && !contactValid && !contact.activeInvalid && (
                  <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                    {t(
                      "rsvpContactRequired",
                      "Add an email or phone so we can confirm your booking.",
                    )}
                  </p>
                )}
              </div>
            </div>

            {/* ── ONE optional disclosure: allergies, occasion, a note ──
                Default closed. Its title names what is inside — allergies
                first, because the kitchen needs them and a guest scanning
                for "allergy" must find it without opening anything. */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden scroll-mb-32 sm:scroll-mb-4">
              <button
                type="button"
                onClick={(e) => {
                  const opening = !detailsOpen;
                  const box = e.currentTarget.parentElement;
                  flushSync(() => setDetailsOpen(opening));
                  // At 375 the allergies opened under the bottom bar, out of
                  // sight: bring the opened section up, above the bar.
                  if (opening) box?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }}
                aria-expanded={detailsOpen}
                className={"w-full min-h-[56px] px-4 py-3 flex items-center gap-3 text-left rounded-xl " + FOCUS}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-semibold text-gray-900 dark:text-gray-100">
                    {noteOnly
                      ? t("rsvpExtrasTitleNote", "A note for us?")
                      : t("rsvpExtrasTitle", "Allergies, occasion or a note?")}
                  </span>
                  <span className="block text-[12.5px] text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5">
                    {extrasSummary || (noteOnly
                      ? t("rsvpExtrasHintNote", "Optional — e.g. what it is about")
                      : isProvider
                        ? t("rsvpExtrasHintProvider", "Optional — so we can take care of you")
                        : t("rsvpExtrasHint", "Optional — so the kitchen can plan for you"))}
                  </span>
                </span>
                <ChevronDown
                  className={
                    "w-[18px] h-[18px] shrink-0 text-gray-400 transition-transform duration-200 ease-out " +
                    (detailsOpen ? "rotate-180" : "")
                  }
                  aria-hidden
                />
              </button>
              {detailsOpen && (
                <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 px-4 pt-4 pb-5 space-y-5 motion-safe:animate-[fadeIn_0.25s_ease-out]">
                  {/* Allergies — invite, never require; only when the venue
                      type defines an allergen set. Selection is GREEN here, the
                      one place it isn't ink: it marks kitchen-critical data. */}
                  {allergenSet.length > 0 && (
                    <div className="space-y-2.5">
                      <div>
                        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {t("rsvpXAllergies", "Allergies or diet")}
                        </p>
                        <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {/* A venue with no name reads "the venue" — never "null". */}
                          {!page.business_name
                            ? (isProvider
                              ? t("rsvpAllergySharedProviderUnnamed", "Shared only with the venue, so they can take care of you.")
                              : t("rsvpAllergySharedUnnamed", "Shared only with the venue, so the kitchen can plan."))
                            : isProvider
                              ? t("rsvpAllergySharedProvider", "Shared only with {venue}, so they can take care of you.", {
                                  venue: page.business_name,
                                })
                              : t("rsvpAllergyShared", "Shared only with {venue}, so the kitchen can plan.", {
                                  venue: page.business_name,
                                })}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {allergenSet.map((a) => {
                          const on = allergenTags.includes(a.key);
                          return (
                            <button
                              key={a.key}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleAllergen(a.key)}
                              className={
                                "h-9 px-3.5 rounded-xl border text-[13px] transition-colors duration-200 ease-out " + FOCUS + " " +
                                (on
                                  ? "bb-pick bg-bb-green-dark border-bb-green-dark text-white font-medium"
                                  : "bg-white border-gray-200 text-gray-800 hover:border-gray-400 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200")
                              }
                            >
                              {t(`allergen_${a.key}`, a.en)}
                            </button>
                          );
                        })}
                      </div>
                      {/* How serious — asked only once there is something to
                          be serious about, and never pre-answered. */}
                      {allergenTags.length > 0 && (
                        <div className="pt-1 space-y-2 motion-safe:animate-[fadeIn_0.25s_ease-out]">
                          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">
                            {t("rsvpSeverity", "Hvor alvorligt?")}
                          </p>
                          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t("rsvpSeverity", "Hvor alvorligt?")}>
                            {SEVERITY_KEYS.map((k) => (
                              <button
                                key={k}
                                type="button"
                                role="radio"
                                aria-checked={allergySeverity === k}
                                onClick={() => setAllergySeverity((cur) => (cur === k ? "" : k))}
                                className={
                                  "h-10 rounded-xl border text-[13px] transition-colors duration-200 ease-out " + FOCUS + " " +
                                  (allergySeverity === k
                                    ? "bb-pick bg-gray-900 border-gray-900 text-white font-semibold dark:bg-white dark:border-white dark:text-gray-900"
                                    : "bg-white border-gray-200 text-gray-800 hover:border-gray-400 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200")
                                }
                              >
                                {t(`rsvpSeverity_${k}`, severityFallback(k))}
                              </button>
                            ))}
                          </div>
                          <textarea
                            id="rsvp-allergy-note"
                            aria-label={isProvider
                              ? t("rsvpXAllergyDetailProvider", "Tell us more")
                              : t("rsvpXAllergyDetail", "Tell the kitchen more")}
                            value={allergyNote}
                            onChange={(e) => setAllergyNote(e.target.value)}
                            placeholder={t(
                              "rsvpAllergyNotePh",
                              "F.eks. svær nøddeallergi — ingen spor af nødder.",
                            )}
                            rows={2}
                            maxLength={2000}
                            className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3.5 py-2.5 text-[15px] leading-snug resize-none focus:outline-none focus:border-gray-900 dark:focus:border-gray-300"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Occasion — five taps instead of a text box; tap again to
                      clear. Dinner occasions: not on a shop's or a workshop's
                      page. */}
                  {!noteOnly && (
                  <div className="space-y-2.5">
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t("rsvpXOccasion", "Occasion")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {OCCASION_KEYS.map((k) => {
                        const label = t(`rsvpOccasion_${k}`, OCCASION_FALLBACK[k]);
                        const on = occasion === k;
                        return (
                          <button
                            key={k}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setOccasion(on ? "" : k)}
                            className={
                              "h-9 px-3.5 rounded-xl border text-[13.5px] transition-colors duration-200 ease-out " + FOCUS + " " +
                              (on
                                ? "bb-pick bg-gray-900 border-gray-900 text-white font-medium dark:bg-white dark:border-white dark:text-gray-900"
                                : "bg-white border-gray-200 text-gray-800 hover:border-gray-400 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200")
                            }
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  )}

                  <div className="space-y-2">
                    <label htmlFor="rsvp-notes" className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t("rsvpXNote", "A note for us")}
                    </label>
                    <textarea
                      id="rsvp-notes"
                      value={guestNotes}
                      onChange={(e) => setGuestNotes(e.target.value)}
                      placeholder={apptWords
                        ? t("rsvpNotesPhProvider", "Anything we should know before you come?")
                        : t(
                          "rsvpNotesPh",
                          "Ønsker du et bestemt bord, en barnestol, eller andet?",
                        )}
                      rows={3}
                      maxLength={2000}
                      className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3.5 py-3 text-[15px] leading-snug resize-none focus:outline-none focus:border-gray-900 dark:focus:border-gray-300"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Marketing consent — default OFF (GDPR). A switch row, not a
                chip: on/off is what a switch says at a glance, and the whole
                row is the tap target. */}
            <button
              type="button"
              role="switch"
              aria-checked={consentMarketing}
              onClick={() => setConsentMarketing((v) => !v)}
              className={"w-full flex items-center gap-4 text-left rounded-lg " + FOCUS}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t("rsvpMarketing", "Send mig nyheder og tilbud")}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 leading-relaxed mt-0.5">
                  {apptWords
                    ? t("rsvpMarketingHintAppt", "Optional — this only covers newsletters, not the confirmation of your appointment.")
                    : t(
                      "rsvpMarketingHint",
                      "Valgfrit. Du modtager altid din reservationsbekræftelse; dette dækker kun nyhedsbreve.",
                    )}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={
                  "relative shrink-0 w-12 h-7 rounded-full transition-colors " +
                  (consentMarketing ? "bg-bb-green-dark" : "bg-gray-200 dark:bg-gray-700")
                }
              >
                <span
                  className={
                    "absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow-sm transition-transform " +
                    (consentMarketing ? "translate-x-5" : "")
                  }
                />
              </span>
            </button>

            {/* GDPR — a calm data-use line right by the submit action. */}
            {/* True whether or not the newsletter switch above is on — the old
                "only for this reservation" stopped being true the moment it
                was. The venue is the data controller; the policy explains. */}
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              {/* The data controller by name — or "the venue" when it has
                  none, never "null". */}
              {!page.business_name
                ? (apptWords
                  ? t(
                    "rsvpPrivacyVenueApptUnnamed",
                    "Your details go to the venue for this appointment — and for news only if you switch it on.",
                  )
                  : t(
                    "rsvpPrivacyVenueUnnamed",
                    "Your details go to the venue for this booking — and for news only if you switch it on.",
                  ))
                : apptWords
                  ? t(
                    "rsvpPrivacyVenueAppt",
                    "Your details go to {venue} for this appointment — and for news only if you switch it on.",
                    { venue: page.business_name },
                  )
                  : t(
                    "rsvpPrivacyVenue",
                    "Your details go to {venue} for this booking — and for news only if you switch it on.",
                    { venue: page.business_name },
                  )}{" "}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className={"min-h-0! underline rounded-sm hover:text-gray-900 dark:hover:text-gray-100 " + FOCUS}
              >
                {t("rsvpPrivacyLink", "Privacy policy")}
              </a>
            </p>

            {/* The trap field (backend booking_screen): off-screen, out of
                the tab order and hidden from screen readers, so no person
                ever fills it; a form-filling bot does. Named so no browser
                or password manager maps it to anything it would fill (it was
                name="website" — identity autofill can fill that), and told
                to stay out by the managers' own opt-outs. If something fills
                it anyway at a person's pace, the server holds the booking
                for the owner — it is never lost. */}
            <div
              aria-hidden="true"
              data-testid="rsvp-hp"
              className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden"
            >
              <label htmlFor="rsvp-bbt">{t("rsvpHpLabel", "Leave this field empty")}</label>
              <input
                id="rsvp-bbt"
                type="text"
                name="bb_trap_7"
                value={hpWebsite}
                onChange={(e) => setHpWebsite(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
              />
            </div>

            {/* Submit-error surfaces */}
            {submitError && (
              <div ref={submitErrorBoxRef} role="alert" className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 flex items-start gap-2">
                <AlertCircle
                  size={16}
                  strokeWidth={1.75}
                  className="text-red-600 dark:text-red-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-2">
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {submitErrorMessage(submitError, t)}
                  </p>
                  {GUEST_REFUSALS[submitError]?.call && telHref(page.phone) && (
                    <a href={telHref(page.phone)} className={TEL_ACTION} data-testid="rsvp-refusal-call">
                      <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span>{t("rsvpNoSlotsCall", "Call us: {phone}", { phone: page.phone })}</span>
                    </a>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
        </div>
        {/* ── Sticky bottom CTA ─────────────────────────────────────────
            Standalone page: `fixed` to the viewport (root reserves pb-32).
            Embedded (?embed=1): `sticky` so it flows with the content-sized
            widget — it settles under the form in a short frame and pins to the
            frame bottom while scrolling a tall one, never detaching. */}
        {!pausedStep1 && !fullNightOnScreen && (
        <div
          ref={barRef}
          data-testid="rsvp-cta-bar"
          className={
            (isEmbed
              ? "sticky glass-static bottom-0 -mx-4 sm:-mx-6" + (embedCard ? " min-[450px]:rounded-b-[16px]" : "")
              : // Phone: fixed to the screen, edge to edge (negative margins
                  // pushed it 16px past both edges). Tablet/desktop: the booking
                // card's own sticky footer — a full-width bar cut across the
                // card at 1280 and floated 190px below it at 768.
                "fixed glass bottom-0 inset-x-0 sm:sticky sm:inset-x-auto sm:-mx-6 sm:rounded-b-xl sm:transform-none!") +
            // It rests on a hairline, white at .92; its shadow comes only
            // while it floats over content (.bb-cta-bar, index.css). As a
            // frosted .85 bar with a gray-200 rule it read as a plain line.
            " bb-cta-bar z-40 border-t border-gray-900/[0.07] dark:border-white/[0.08] bg-white/92! dark:bg-gray-950/90!"
          }
          style={
            isEmbed
              ? { paddingBottom: "env(safe-area-inset-bottom, 0px)" }
              : { bottom: kbInset, paddingBottom: kbInset ? 0 : "env(safe-area-inset-bottom, 0px)" }
          }
        >
          {/* Standalone, the bar spans the screen and its row is capped to
              the card's column. In the embed it already sits inside the card
              (R4: up to EMBED_MAX), so the row is the card's own width. */}
          <div className={(isEmbed ? "" : "max-w-md mx-auto ") + "px-4 sm:px-6 py-3 flex items-center gap-3"}>
            {step === 1 ? (
              <>
                {/* The whole selection stays in view — date, time and party —
                    so the guest never has to scroll back up to check what the
                    button is about to continue with. */}
                {/* On the page's type scale (15 / 13, were 14.5 / 12.5). Each
                    line fades up 3 px when its words actually change
                    (EarnedText) — never on first paint. */}
                <div className="min-w-0 flex-1" aria-live="polite">
                  <EarnedText
                    as="p"
                    className="text-[15px] font-semibold tracking-[-0.009em] text-gray-900 dark:text-gray-100 truncate first-letter:uppercase"
                    text={[fmtDayShort(day, lang), slot || null].filter(Boolean).join(" · ")}
                  />
                  <EarnedText
                    as="p"
                    className="text-[13px] text-gray-500 dark:text-gray-400 truncate"
                    text={groupRequest
                        ? t("rsvpGroupTimeNote", "{party} · request", {
                            party: partyLabel(party, t, apptWords),
                          })
                        : isProvider && chosenBehandling
                          ? chosenBehandling.name
                          : partyLabel(party, t, apptWords)}
                  />
                </div>
                {/* Never a dead grey block: until a time is picked the button
                    says so, and a tap scrolls to the times. Grey here, then
                    green, then grey again on step 2 read as "something broke". */}
                <Button
                  variant="main"
                  size="lg"
                  onClick={needsTime ? revealTimes : goToDetails}
                  className={"shrink-0 min-w-[9.5rem] px-6 h-[52px]! rounded-xl! text-[15px]! font-semibold! tracking-[-0.009em] " + CTA_FINISH}
                  iconRight={needsTime ? null : <ArrowRight className="w-[18px] h-[18px]" aria-hidden="true" />}
                >
                  <EarnedText text={needsTime ? t("rsvpPickTimeShort", "Pick a time") : t("rsvpContinue", "Continue")} />
                </Button>
              </>
            ) : (
              <>
                {/* Back as a square chevron: beside a disabled Confirm, a grey
                    "Tilbage" read as a second button of the same weight. The
                    recap card above ("Change") is the other way back. */}
                <Button
                  variant="secondary"
                  size="lg"
                  aria-label={t("rsvpBack", "Tilbage")}
                  className="w-[52px]! h-[52px]! rounded-xl! px-0 shrink-0 dark:bg-white/10! dark:hover:bg-white/15!"
                  onClick={backToChoices}
                >
                  <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                </Button>
                <Button
                  variant="main"
                  size="lg"
                  // A missing time is not fixable here, so that one case turns
                  // the button into the way back instead of a dead grey block.
                  onClick={needsTime ? backToChoices : onSubmit}
                  busy={submitting}
                  className={"flex-1 h-[52px]! rounded-xl! text-[15px]! font-semibold! tracking-[-0.009em] " + CTA_FINISH}
                  iconRight={
                    needsTime || !canSubmit ? null : <ArrowRight className="w-[18px] h-[18px]" aria-hidden="true" />
                  }
                >
                  {/* A disabled button reading "Confirm reservation" tells the
                      guest nothing about why it will not press. Say what is
                      missing — the label becomes the instruction. When the
                      instruction changes, the new words fade up (EarnedText). */}
                  <EarnedText text={needsTime
                    ? t("rsvpPickTimeCta", "Vælg et tidspunkt")
                    : !nameValid
                      ? t("rsvpCtaNeedName", "Tilføj dit navn")
                      : contact.activeInvalid && contactTouched
                        ? contactMode === "phone"
                          ? t("rsvpCtaCheckPhone", "Check your phone number")
                          : t("rsvpCtaCheckEmail", "Check your email")
                        : !contactValid
                          ? contactMode === "phone"
                            ? t("rsvpCtaNeedPhone", "Tilføj dit telefonnummer")
                            : t("rsvpCtaNeedEmail", "Tilføj din email")
                          : noArrow(
                              groupRequest
                                ? t("rsvpSendRequest", "Send forespørgsel")
                                : apptWords
                                  ? t("rsvpConfirmTime", "Confirm appointment")
                                  : t("rsvpConfirm", "Bekræft reservation"),
                            )} />
                </Button>
              </>
            )}
          </div>
        </div>
        )}
      </main>
      </div>
    </div>
  );
}

// DA / EN as a segmented pill, so the current language reads as SELECTED.
// Each segment is 40×32 (44pt with the global touch rule): this is the
// control a guest reaches for when the page opened in a language they do not
// read — on the booking form and on the receipt alike.
// Each language is named in itself ("Dansk", "English") for a screen reader —
// it read the bare codes "da" / "en" — and marked with its own `lang`, so the
// name is pronounced in that language. The group is named in both.
const LANG_NAMES = { da: "Dansk", en: "English" };

// G10 (judge 27 Oct, item 2): a segmented switch in the page's own shapes —
// a 12 px track and 8 px segments, not a capsule. 32 px drawn (min-h-0!
// releases the touch floor), 44 px to the finger: the after: box.
function LangPill({ lang, setLang }) {
  return (
    <div
      role="group"
      aria-label="Sprog · Language"
      className="shrink-0 flex items-center p-0.5 rounded-xl bg-gray-100 dark:bg-gray-800"
    >
      {["da", "en"].map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          aria-label={LANG_NAMES[code]}
          title={LANG_NAMES[code]}
          className={
            "relative after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] " +
            "h-8 min-h-0! min-w-[40px] px-2.5 rounded-lg text-[11px] font-semibold uppercase tracking-wide transition-colors duration-200 ease-out " + FOCUS + " " +
            (lang === code
              ? "bg-white text-gray-900 shadow-sm dark:bg-gray-600 dark:text-white"
              : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200")
          }
        >
          {code}
        </button>
      ))}
    </div>
  );
}

// Scroll a horizontal rail — and nothing else: scrollIntoView also scrolls
// every scrollable ancestor, which in the embed iframe moved the restaurant's
// own page — so that the chip is fully visible.
function revealInRail(railEl, chip, behavior = "smooth") {
  if (!railEl || !chip || railEl.scrollWidth <= railEl.clientWidth) return;
  const left = chip.offsetLeft;
  const right = left + chip.offsetWidth;
  if (left >= railEl.scrollLeft && right <= railEl.scrollLeft + railEl.clientWidth) return;
  railEl.scrollTo?.({ left: Math.max(0, left - 16), behavior });
}

// Button labels carry their arrow as an icon; strip a typed "→" some language
// packs still have in the text, so there is never a double arrow.
function noArrow(label) {
  return String(label || "").replace(/\s*→\s*$/, "");
}

// Arrow keys move through a group of radios (party size, day, time) the way
// native radio buttons do — one Tab stop per question instead of forty.
function rovingKeyDown(e) {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const radios = [...e.currentTarget.querySelectorAll('[role="radio"]:not([disabled])')];
  const i = radios.indexOf(document.activeElement);
  if (i < 0 || !radios.length) return;
  e.preventDefault();
  const n = radios.length;
  const next =
    e.key === "Home" ? 0
    : e.key === "End" ? n - 1
    : e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
    : (i - 1 + n) % n;
  radios[next].focus();
  radios[next].click();
}

// ── Small presentational helpers ─────────────────────────────────────

function StepDots({ step, t, apptWords = false }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={2}
      aria-valuenow={step}
      // Read as "Step 1 of 2", not as a bare number.
      aria-valuetext={t("rsvpStepOf", "Step {n} of {total}", { n: step, total: 2 })}
      aria-label={apptWords ? t("rsvpStepAriaAppt", "Booking step") : t("rsvpStepAria", "Reservation step")}
    >
      {/* 6 px dots, the current one 20 px wide, easing over 220 ms on the
          page's one curve (were 8 px / 24 px on a 150 ms default ease —
          a third curve on the page). */}
      {[1, 2].map((n) => (
        <span
          key={n}
          data-current={n === step ? "true" : undefined}
          className={
            "inline-block rounded-full h-1.5 transition-[width,background-color] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] " +
            (n === step
              ? "bg-gray-900 dark:bg-gray-100 w-5"
              : n < step
                ? "bg-gray-400 dark:bg-gray-500 w-1.5"
                : "bg-gray-200 dark:bg-gray-700 w-1.5")
          }
        />
      ))}
    </div>
  );
}

function ClosedScreen({ t, name, rootMinH = "min-h-screen" }) {
  return (
    <div className={`${rootMinH} ${ROOT_FINISH} bg-white dark:bg-gray-950 px-4 py-16`}>
      <div className="max-w-md mx-auto text-center">
        <Calendar
          size={40}
          strokeWidth={1.5}
          className="text-gray-400 mx-auto mb-3"
          aria-hidden="true"
        />
        {/* The server answers 410 not_accepting for a slug that does not
            exist AND for a venue that has bookings switched off — the same
            body, on purpose, so nobody can enumerate which businesses use
            BonBox. This screen therefore cannot know which case it is in,
            and must not claim to. It used to say "Not taking reservations",
            which told a guest who mistyped the link that the restaurant was
            closed: they stop trying instead of checking the link, and the
            owner never hears about the booking they lost.
            `name` is only ever set when a page HAD loaded and a later fetch
            410'd; on the cold path it is undefined, so the unnamed line is
            the one guests actually read. */}
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {name
            ? t("rsvpClosedNamed", "{name} tager ikke imod reservationer", { name })
            : t("rsvpClosed", "Dette link er ikke åbent for booking")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            "rsvpClosedHint",
            "Tjek lige linket, eller kontakt stedet direkte for at booke.",
          )}
        </p>
      </div>
    </div>
  );
}

// English fallback for the severity <option> labels — keeps the select
// readable even before the i18n entries land (defence in depth; real
// keys live in useLanguage.jsx).
function severityFallback(key) {
  if (key === "preference") return "Preference";
  if (key === "intolerance") return "Intolerance";
  if (key === "severe") return "Severe";
  return key;
}

// Map a submit-error code to a friendly localized message.
function submitErrorMessage(code, t) {
  switch (code) {
    case "slot_unavailable":
      return t(
        "rsvpErrSlot",
        "Beklager — tidspunktet blev lige optaget. Vælg venligst en anden tid.",
      );
    case "stylist_unavailable":
      // Named-behandler race-loss — fail closed, never silently rebook.
      return t(
        "rsvpErrStylist",
        "Den behandler blev lige booket på det tidspunkt. Vælg et andet tidspunkt, eller vælg Valgfri behandler.",
      );
    case "party_too_large":
      return t(
        "rsvpErrParty",
        "Selskabet er større end vi kan booke online — kontakt stedet direkte.",
      );
    case "not_accepting":
      return t(
        "rsvpErrClosed",
        "Online booking was paused while you were booking.",
      );
    case "date_closed":
      return t("rsvpErrDateClosed", "We're not taking online bookings that day. Please pick another day.");
    case "requests_full":
      return t("rsvpErrRequestsFull", "We can't take more requests online today. Call us and we'll sort it out.");
    case "request_too_late":
      return t("rsvpErrRequestTooLate", "It's too close to that time to send a request online. Call us and we'll sort it out.");
    case "too_many_tries":
      return t("rsvpErrTooManyTries", "Too many tries in a short time. Wait a minute and try again. Your details are kept.");
    case "invalid_email":
      return t("rsvpEmailCheck", "Check your email — e.g. anna@example.com");
    case "invalid_phone":
      return t("rsvpPhoneCheck", "Check your phone number — e.g. +45 12 34 56 78");
    default:
      return t("rsvpErrGeneric", "Noget gik galt. Prøv igen om et øjeblik.");
  }
}
