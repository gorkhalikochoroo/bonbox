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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useConfirm } from "../hooks/useConfirm";
import { buildIcs, venueAddress } from "../utils/reservationIcs";
import { saveFile } from "../utils/download";
import {
  Calendar,
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
  X,
} from "lucide-react";
import api from "../services/api";
import { slotNote } from "../utils/slotNote";
import { markGuestSurface } from "../lib/guestSurface";
import { venueMonogram } from "../utils/venueMonogram";
import { contactState } from "../utils/guestContact";
import { rescueDay } from "../utils/bookingDay";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { useLanguage } from "../hooks/useLanguage";
import { loadLocale, loadedLocales } from "../lib/localeStore";
import Button from "../components/ui/Button";
import Chip from "../components/ui/Chip";
import Input from "../components/ui/Input";
import Sheet from "../components/ui/Sheet";
import MonthCalendar from "../components/MonthCalendar";
import PublicFloorMap from "../components/PublicFloorMap";
import { bookingModeFor, usesTableFloor } from "../config/venueProfiles";

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
// outline — two looks, one of them nearly invisible.
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950";
// The same, for the shared Chip primitive (its own ring is the faint one).
const CHIP_FOCUS = "focus-visible:ring-gray-900! dark:focus-visible:ring-gray-100! focus-visible:ring-offset-2!";

// The day's times: a segmented control for the services (Frokost /
// Eftermiddag / Aften) and that service's times four across. As horizontal
// rails a full day (~40 times) showed 13 and hid the rest behind swipes; here
// every time of the chosen service is on screen. Opens on the service holding
// the picked time, else dinner, else the first. A dot marks the service that
// holds the pick when another one is open.
function TimeGrid({ groups, slot, onPick, slotRemaining, loading, t }) {
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
  const noteFor = (x) => (uniform ? null : slotNote(slotRemaining[x], t));
  const withNotes = current.slots.some((x) => noteFor(x));
  return (
    <div className={loading ? "opacity-50 pointer-events-none transition-opacity duration-200" : "transition-opacity duration-200"}>
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
                  : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200")
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
        className="grid grid-cols-4 sm:grid-cols-5 gap-2 motion-safe:animate-[fadeIn_0.25s_ease-out]"
      >
        {current.slots.map((s, idx) => {
          // Scarcity, only when genuinely scarce and only from a real server
          // count. Silence is the default: an invented hint is a lie told to
          // make someone book faster.
          const note = noteFor(s);
          const focusable = slot === s || (!current.slots.includes(slot) && idx === 0);
          return (
            <Chip
              key={s}
              size="md"
              selected={slot === s}
              onClick={() => onPick(s)}
              role="radio"
              aria-checked={slot === s}
              aria-pressed={undefined}
              tabIndex={focusable ? 0 : -1}
              className={
                "w-full px-0 tabular-nums text-[15px] flex-col justify-center gap-0 duration-200 ease-out rounded-xl! " + CHIP_FOCUS + " " +
                (withNotes ? "h-[52px] " : "h-11 ") +
                (slot === s ? "font-semibold shadow-sm" : "")
              }
            >
              <span className="leading-none">{s}</span>
              {withNotes && (
                <span
                  className={
                    "block text-[10px] leading-none h-3 mt-1 font-medium " +
                    (slot === s ? "text-white/80 dark:text-gray-900/70" : "text-bb-green-dark dark:text-emerald-400")
                  }
                >
                  {note}
                </span>
              )}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

// Weekday / date / month stacked in a compact card. The one-line
// "Man. 28. Sep." chips fit two and a half days on a phone; these fit five.
// Danish short forms carry dots ("man.", "28.", "sep.") — stripped here.
function DateStrip({ today, dayMap, value, onPick, t, lang }) {
  const rail = Array.from({ length: 14 }, (_, i) => addDays(today, i));
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
    // From sm up: two neat weeks of seven instead of a ragged wrap.
    <div
      ref={railRef}
      role="radiogroup"
      aria-label={t("rsvpPickDate", "Vælg dato")}
      onKeyDown={rovingKeyDown}
      className={RAIL + " relative sm:grid sm:grid-cols-7 sm:gap-1.5"}
    >
      {days.map((iso, idx) => {
        const known = dayMap && iso in dayMap;
        const closed = known && dayMap[iso] === false;
        const active = value === iso;
        const quiet = active ? "text-white/75 dark:text-gray-500" : "text-gray-500 dark:text-gray-400";
        return (
          <button
            key={iso}
            ref={(el) => { refs.current[iso] = el; }}
            type="button"
            disabled={closed}
            onClick={() => !closed && onPick(iso)}
            role="radio"
            aria-checked={active}
            tabIndex={active || (!days.includes(value) && idx === 0) ? 0 : -1}
            aria-label={closed ? `${full(iso)} — ${t("rsvpDayClosed", "lukket")}` : full(iso)}
            className={[
              "shrink-0 snap-start w-14 sm:w-auto h-[68px] rounded-xl border " + FOCUS,
              // A day picked beyond the 14-day row stands apart from it, so
              // "Lør 10 okt · Tors 15 okt" never reads as consecutive days.
              idx === 14 ? "ml-4 sm:ml-0 sm:col-start-1" : "",
              "transition-[background-color,border-color,color] duration-200 ease-out",
              "flex flex-col items-center justify-center gap-1",
              active
                ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900"
                : "border-gray-200 bg-white text-gray-900 hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100",
              closed ? "opacity-45 cursor-not-allowed" : "",
            ].join(" ")}
          >
            <span className={"text-[11px] font-medium leading-none capitalize " + quiet}>
              {part(iso, { weekday: "short" })}
            </span>
            <span className="text-lg font-semibold leading-none tabular-nums">
              {part(iso, { day: "numeric" })}
            </span>
            <span className={"text-[11px] leading-none " + quiet}>
              {/* rsvpDayClosed — the chip word. rsvpClosed is the page <h1>. */}
              {closed ? t("rsvpDayClosed", "lukket") : part(iso, { month: "short" }).replace(/^Sept$/, "Sep")}
            </span>
          </button>
        );
      })}
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

// Pretty DK date for the header / success screen: "lørdag 13. juni".
// Dates followed the venue's language even after the guest switched to
// English: the page read "Pick a date" over a strip of "Søn. 26. Jul.".
// Weekday and month names are UI chrome, so they translate — unlike the
// DK terminology lock (MOMS, revisor, kasserapport), which never does.
//
// en-GB, not en-US: day-before-month matches how the rest of this page
// and every Danish guest reads a date.
const DATE_LOCALES = { da: "da-DK", en: "en-GB" };

function dateLocale(lang) {
  return DATE_LOCALES[lang] || "da-DK";
}

// "Fre. 2. okt." / "Fri 2 Oct" — the bottom bar's compact date. en-GB writes
// September as "Sept" while every other month is three letters; "Sep" keeps
// the rhythm.
function fmtDayShort(isoStr, lang) {
  if (!isoStr) return "";
  try {
    return new Date(`${isoStr}T00:00:00`)
      .toLocaleDateString(dateLocale(lang), { weekday: "short", day: "numeric", month: "short" })
      .replace(/\bSept\b/, "Sep");
  } catch {
    return isoStr;
  }
}

function capFirst(text) {
  const v = String(text || "");
  return v ? v[0].toLocaleUpperCase() + v.slice(1) : v;
}

// "1 gæst" / "2 gæster" — the plural key alone produced "1 gæster".
function partyLabel(n, t) {
  return Number(n) === 1 ? t("rsvpPartyOne", "1 guest") : t("rsvpPartyN", "{n} guests", { n });
}

// The receipt's two actions (Calendar | Directions): one kind of button.
const RECEIPT_ACTION =
  "inline-flex items-center justify-center gap-2 h-12 px-5 rounded-xl text-sm font-medium " +
  "bg-white text-gray-800 border border-gray-200 hover:bg-gray-50 " +
  "dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors duration-200";

// The receipt's torn bottom edge: 16 teeth across a strip the card's colour.
const TORN_EDGE = `polygon(0% 0%, 100% 0%, ${Array.from({ length: 31 }, (_, i) => {
  const j = 31 - i;
  return `${(j * 3.125).toFixed(3)}% ${j % 2 ? 100 : 0}%`;
}).join(", ")}, 0% 0%)`;

function fmtDayLabel(isoStr, lang) {
  if (!isoStr) return "";
  try {
    const d = new Date(`${isoStr}T00:00:00`);
    return d.toLocaleDateString(dateLocale(lang), {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  } catch {
    return isoStr;
  }
}

// ── Venue identity tile ────────────────────────────────────────────
// The owner's uploaded brand logo (the SAME logo used on their invoices),
// served as a short-lived signed url from the public meta. Falls back to the
// typographic monogram when there's no logo — or if the image fails to load /
// the url has expired — so the header is never empty. The logo sits on a light
// tile (logos often carry transparency and need light contrast).
function VenueBadge({ logoUrl, name, size = "md" }) {
  const [broken, setBroken] = useState(false);
  const box = size === "sm" ? "w-8 h-8 rounded-[10px] text-[12px]" : "w-11 h-11 rounded-xl text-[15px]";
  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt=""
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
  // would be claiming their identity.
  return (
    <div
      className={`shrink-0 ${box} bg-gray-100 text-gray-800 ring-1 ring-inset ring-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 flex items-center justify-center font-semibold tracking-tight select-none`}
      aria-hidden="true"
    >
      {venueMonogram(name)}
    </div>
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

function groupSlots(slots) {
  const buckets = { lunch: [], afternoon: [], dinner: [] };
  for (const s of slots) {
    // Defensive parse — only well-formed "HH:MM" strings are bucketed.
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
    if (!m) continue;
    const hour = parseInt(m[1], 10);
    if (Number.isNaN(hour)) continue;
    const def = SLOT_GROUP_DEFS.find((g) => g.test(hour));
    if (def) buckets[def.key].push(s);
  }
  return SLOT_GROUP_DEFS.map((g) => ({
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
  const { slug } = useParams();
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
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(""); // "" | "closed" | "generic"

  // ── Step state ───────────────────────────────────────────────────
  const [step, setStep] = useState(1); // 1 = date+party+slot, 2 = details

  // Step 1 selections. Pre-fill from ?d=YYYY-MM-DD&party=N if present.
  const today = useMemo(() => isoDay(new Date()), []);
  const [day, setDay] = useState("");
  const [party, setParty] = useState(2);
  const [slot, setSlot] = useState("");
  // The one-tap date strip is the primary picker; the native date field is a
  // quiet escape hatch for a far-out date, revealed on demand so it never
  // clutters the default view (premium via subtraction).
  const [showDateInput, setShowDateInput] = useState(false);

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

  // ── Salon (provider) booking state (S3b) ─────────────────────────
  // A provider venue reorders step 1 to behandling → behandler → dato → tid.
  // Slots come from .../provider-availability (keyed by behandling_id +
  // optional stylist_id), so we keep the picked stylist's resource_id (for
  // the submit + the recap) alongside the slot times. Table venues never
  // touch any of this — provider is an additive branch.
  const isProvider = !!page && bookingModeFor(page.business_type) === "provider";
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
    // Scroll only when the times sit low enough that the grid is out of view.
    if (heading.getBoundingClientRect().top > window.innerHeight * 0.4) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      heading.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
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
  useEffect(() => {
    let alive = true;
    // No synchronous setLoading(true) — initial useState(true) covers
    // first mount; the .finally below flips it (keeps the effect free of
    // React 19's set-state-in-effect rule, matching EventPublicPage).
    api
      .get(`/public/reservations/${slug}`)
      .then((r) => {
        if (!alive) return;
        setPage(r?.data || null);
        setLoadError("");
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
  }, [slug]);

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
        const [d, tm] = String(b.starts_at || "").split("T");
        setLinked({
          day: d || "",
          time: tm ? tm.slice(0, 5) : "",
          party: b.party_size || null,
          name: b.guest_name || "",
          occasion: b.occasion || "",
          allergenTags: Array.isArray(b.allergen_tags) ? b.allergen_tags : [],
          allergySeverity: b.allergy_severity || "",
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

  // ── Seed step-1 selections once the page + query params resolve ───
  useEffect(() => {
    if (!page) return;
    const qDay = searchParams.get("d");
    const qParty = parseInt(searchParams.get("party") || "", 10);
    const maxAdvance = Number(page.max_advance_days) || 60;
    const maxParty = Number(page.max_party_size) || 10;

    // Validate the query day is within [today, today+maxAdvance].
    let initialDay = today;
    if (qDay && /^\d{4}-\d{2}-\d{2}$/.test(qDay) && isoDay(new Date(`${qDay}T00:00:00`)) === qDay) {
      const latest = addDays(today, maxAdvance);
      if (qDay >= today && qDay <= latest) initialDay = qDay;
    }
    setDay(initialDay);

    if (Number.isFinite(qParty) && qParty >= 1) {
      setParty(Math.min(qParty, maxParty));
    } else {
      setParty(Math.min(2, maxParty));
    }
    // Only seed once, when the page first loads. Subsequent user edits
    // own the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // ── 14-day open/closed overview → auto-advance off a closed day ────
  // TABLE venues only. Fetches the same available_slots() the diner sees, so the
  // strip can't disagree. If the seeded day (today, or a ?d= link) has NO slots
  // but the week does, we jump to the next open day — killing the dead-end where
  // "closed today" showed "No available times" with no way forward. Fail-soft:
  // on error dayMap stays null and the single-day flow + phone fallback still run.
  useEffect(() => {
    if (!page || isProvider) return;
    let alive = true;
    api
      .get(`/public/reservations/${slug}/availability-summary`, {
        params: { from: today, days: 14, party: party || 2 },
      })
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res.data?.days) ? res.data.days : [];
        const map = Object.fromEntries(list.map((d) => [d.date, !!d.has_slots]));
        setDayMap(map);
        setNextOpenDay(res.data?.next_open_day || null);
        // Only rescue a day the summary KNOWS is closed. A date picked in the
        // calendar (or a ?d= link) beyond the summary's 14 days is not in the
        // map at all — it used to be treated as closed and silently swapped
        // for the next open day the moment the party size changed.
        setDay((cur) => rescueDay(cur, map, res.data?.next_open_day));
      })
      .catch(() => {
        if (alive) {
          setDayMap(null);
          setNextOpenDay(null);
        }
      });
    return () => {
      alive = false;
    };
    // re-run when party changes (open days depend on party size)
  }, [page, slug, isProvider, party, today]);

  // ── Per-venue document title + OG tags ────────────────────────────
  // A diner's browser tab should read the RESTAURANT, not the app default
  // ("BonBox — The back office …"). NOTE (honest limitation): this is a pure SPA,
  // so social/SMS link-unfurl crawlers read the STATIC index.html title before
  // JS runs — the live tab updates, but shared-link previews still show the app
  // default until we add SSR/prerender. Still worth it for the tab + trust.
  const resultStatus = liveStatus || result?.status || null;
  useEffect(() => {
    if (!page?.business_name) return;
    const prev = document.title;
    const venue = page.business_name;
    // Once booked, the tab says what happened — a guest switching back to it
    // should not read "Book a table" over a finished booking.
    // A link still loading or no longer resolving is not a booking yet.
    const showsBooking = !!result && linkState !== "loading" && linkState !== "failed";
    const title = !showsBooking
      ? t("rsvpDocTitle", "Book bord · {venue}", { venue })
      : resultStatus === "cancelled" && (cancelledFrom === "requested" || result?.status === "requested")
        ? t("rsvpDocTitleWithdrawn", "Request withdrawn · {venue}", { venue })
        : resultStatus === "cancelled" || resultStatus === "no_show"
        ? t("rsvpDocTitleCancelled", "Booking cancelled · {venue}", { venue })
        : resultStatus === "requested"
          ? t("rsvpDocTitleRequest", "Request sent · {venue}", { venue })
          : t("rsvpDocTitleBooked", "Table booked · {venue}", { venue });
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
    setMeta("og:description",
      t("rsvpOgDesc", "Reservér bord hos {venue}.", { venue: page.business_name }));
    try { setMeta("og:url", window.location.href); } catch { /* noop */ }
    return () => { document.title = prev; };
  }, [page, t, result, resultStatus, linkState, cancelledFrom]);

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
  const fetchAvailability = useCallback(
    async (forDay, forParty, forBehandling, forStylist) => {
      if (!forDay) return;
      // Provider needs a behandling chosen first; until then, no slots.
      if (isProvider && !forBehandling) {
        setSlots([]);
        setSlotRemaining({});
        setGroupRequest(false);
        setSlot("");
        return;
      }
      if (!isProvider && !forParty) return;
      setSlotsLoading(true);
      setSlotsError("");
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
        } else {
          const res = await api.get(`/public/reservations/${slug}/availability`, {
            params: { day: forDay, party: forParty },
          });
          const list = Array.isArray(res.data?.slots) ? res.data.slots : [];
          setSlots(list);
          keepIfOffered(list);
          setSlotRemaining(
            res.data?.slot_remaining && typeof res.data.slot_remaining === "object"
              ? res.data.slot_remaining
              : {},
          );
          setGroupRequest(!!res.data?.group_request);
          // The venue is at its monthly booking ceiling — every time we could
          // show would be refused by the create endpoint. Say so HERE, at the
          // top of the flow, instead of letting the guest pick a table and type
          // their name, phone and allergy notes first. `closed_reason` is
          // additive; when the server doesn't send it we clear the state and
          // behave exactly as before.
          setClosedReason(res.data?.closed_reason || "");
        }
      } catch {
        setSlots([]);
        setSlot("");
        setGroupRequest(false);
        setClosedReason("");
        // A flag, translated where it is shown. This callback used to depend
        // on `t` for the message, so switching DA/EN re-created it, re-ran
        // the fetch and wiped the time the guest had picked — on step 2 that
        // left a grey Confirm button with no way to tell why.
        setSlotsError("load_failed");
      } finally {
        setSlotsLoading(false);
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
  }, [party]);
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
  const maxAdvance = Number(page?.max_advance_days) || 60;
  const latestDay = useMemo(() => addDays(today, maxAdvance), [today, maxAdvance]);
  const allergenSet = useMemo(
    () => (Array.isArray(page?.allergen_set) ? page.allergen_set : []),
    [page],
  );
  // Period-grouped slots (Frokost / Eftermiddag / Aften), computed once per
  // availability response. Only non-empty groups survive.
  const slotGroups = useMemo(() => groupSlots(slots), [slots]);
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
  const needsTime = !slot && !(groupRequest && slots.length === 0);
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
    loadedLocales()[page?.language]?.[`rsvpOccasion_${k}`] ||
    t(`rsvpOccasion_${k}`, OCCASION_FALLBACK[k]);

  // A guest who reads the page in another language than the venue's: fetch the
  // venue's dictionary while they fill in details, so the occasion can be
  // stored in it. A returning visitor who picked English before is the only
  // one who has not already loaded it.
  useEffect(() => {
    if (step === 2 && page?.language && page.language !== lang) {
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
      time: slot || slots[0] || "18:00",
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
        if (alive && next) setLiveStatus(next);
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
            title: t("rsvpCancelConfirmTitle", "Aflys reservationen?"),
            message: t(
              "rsvpCancelConfirmBody",
              "Bordet bliver frigivet med det samme, og du kan ikke fortryde. Du er velkommen til at booke igen.",
            ),
            confirmLabel: t("rsvpCancelConfirmYes", "Ja, aflys"),
            cancelLabel: t("rsvpCancelConfirmNo", "Behold reservationen"),
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
    return (
      <div className={`${rootMinH} bg-white dark:bg-gray-950 px-4 py-12`}>
        <div className="max-w-md mx-auto space-y-4">
          <div className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-8 w-2/3" />
          <div className="animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800 h-32" />
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center pt-4">
            {t("rsvpLoading", "Henter…")}
          </p>
        </div>
      </div>
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
      <div className={`${rootMinH} bg-white dark:bg-gray-950 px-4 py-16`}>
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
      <div className={`${rootMinH} bg-gray-50 dark:bg-gray-950 flex items-center justify-center`}>
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" aria-label={t("loading", "Loading…")} />
      </div>
    );
  }
  if (result && linkState === "failed") {
    return (
      <div className={`${rootMinH} bg-gray-50 dark:bg-gray-950 px-4 py-16`}>
        <div className="max-w-md mx-auto space-y-5 text-center" role="status">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mx-auto bg-gray-100 dark:bg-gray-800">
            <AlertCircle size={28} strokeWidth={1.75} className="text-gray-500" aria-hidden="true" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            {t("rsvpLinkFailedTitle", "We couldn't open this booking")}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t(
              "rsvpLinkFailedBody",
              "The link may have expired. Call us about an existing booking — or book a new table.",
            )}
          </p>
          <div className="space-y-2">
            <Button variant="main" size="lg" className="w-full" onClick={startOver}>
              {t("rsvpBookATable", "Book a table")}
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
    // A request the guest withdrew here. It never held a table, so "the
    // table has been released" was untrue — and its time stays "preferred".
    const withdrawn =
      isCancelled && (cancelledFrom === "requested" || result.status === "requested");
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

    // Status-driven hero icon + headline + body. Emerald is reserved for the
    // one confirmed "money moment"; pending/closed states stay gray.
    let HeroIcon = CheckCircle2;
    let heroWrap = "bg-emerald-50 dark:bg-emerald-900/20";
    let heroIconCls = "text-emerald-600 dark:text-emerald-400";
    let title = t("rsvpConfirmedTitle", "Reservation bekræftet");
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
      body =
        rDay === today
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
    } else if (isCancelled) {
      HeroIcon = XCircle;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpCancelledTitle", "Reservation aflyst");
      body = t(
        "rsvpCancelledBody",
        "Din reservation er aflyst, og bordet er frigivet. Du er velkommen til at booke igen.",
      );
    } else if (isDone) {
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpDoneTitle", "Tak for besøget");
      body = t("rsvpDoneBody", "Denne reservation er afsluttet.");
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
      deliveryLine = emailGiven
        ? t("rsvpEmailOnItsWay", "A confirmation is on its way to {email}.", {
            email: sentEmail,
          })
        : t("rsvpNoEmailSaved", "Save this page — we don't have your email.");
    }
    // What the kitchen was told, including how serious — the guest's proof
    // that "severe" reached the restaurant.
    // From the booking itself when the receipt was reopened from a link.
    const rOccasion = linked
      ? linked.occasion
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
            label: isRequest || withdrawn ? t("rsvpRowWishedTime", "Preferred time") : t("rsvpTimeLabel", "Time"),
            value: rTime,
          }
        : null,
      isProvider
        ? chosenBehandling
          ? { k: "svc", label: t("rsvpColBehandling", "Service"), value: chosenBehandling.name }
          : null
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
      <div className={`${rootMinH} bg-gray-50 dark:bg-gray-950 px-4 py-10`}>
        <div className="max-w-md mx-auto space-y-6 text-center">
          {/* The guest may open this from an email on another device, where
              the page falls back to the venue's language — the switch has to
              be here too, not only on the form. */}
          <div className="flex justify-end -mt-4 -mb-2">
            <LangPill lang={lang} setLang={setLang} />
          </div>
          <div
            className={
              `inline-flex items-center justify-center w-14 h-14 rounded-full mx-auto ${heroWrap} ` +
              // One brief pop on arrival (a small overshoot). No confetti.
              "transition-all duration-500 ease-[cubic-bezier(0.2,0.9,0.3,1.2)] motion-reduce:transition-none " +
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
          {isRequest && telHref(page?.phone) && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("rsvpRequestHurry", "In a hurry? Call")}{" "}
              <a href={telHref(page.phone)} className="min-h-0! font-medium text-gray-700 dark:text-gray-200 underline tabular-nums">
                {page.phone}
              </a>
            </p>
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
                  {page.business_name}
                </p>
                {refCode && (
                  <p className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400 tabular-nums">
                    {refCode}
                  </p>
                )}
              </div>
              <div className="my-4 border-t-2 border-dashed border-gray-200 dark:border-gray-700" aria-hidden="true" />
              <dl className={isCancelled ? "opacity-60" : ""}>
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
                      {t("rsvpCallLabel", "Phone")}
                    </dt>
                    <dd className="min-w-0 text-right text-[15px] font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                      <a href={telHref(page.phone)} className="min-h-0! hover:underline">
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
              {t("rsvpBookAgain", "Book again")}
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
                        minutes: isProvider ? chosenBehandling?.duration_min : 120,
                        // business_name, not name — the public payload has no
                        // `name` field at all.
                        summary: page.business_name
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

  // ── Main wizard ────────────────────────────────────────────────────
  return (
    <div
      className={`${rootMinH} bg-white dark:bg-gray-950 ${
        // Tablet/desktop: the booking sits on a card over a quiet ground,
        // instead of a narrow column floating on a white page. Not when
        // embedded — the host site is the ground there.
        isEmbed ? "" : "pb-32 sm:pt-10 sm:pb-12 sm:bg-gray-50 sm:dark:bg-gray-950"
      }`}
    >
      <div
        className={
          "max-w-md mx-auto px-4 sm:px-6 pt-5 sm:pt-8 space-y-5 " +
          (isEmbed
            ? ""
            : "sm:rounded-xl sm:border sm:border-gray-200 sm:bg-white sm:shadow-sm dark:sm:border-gray-800 dark:sm:bg-gray-900")
        }
      >
        {/* ── Venue identity (brand logo or typographic monogram) ──
            Identity tile + eyebrow + venue name H1 + location row with a
            quiet right-aligned tappable phone. One trust line underneath. */}
        <header className="space-y-3">
          <div className="flex items-start gap-3">
            {/* Identity tile — the owner's uploaded brand logo when they have
                one, else a typographic monogram derived from the name. */}
            <VenueBadge logoUrl={page.logo_url} name={page.business_name} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {isProvider ? t("rsvpBookATime", "Book an appointment") : t("rsvpBookATable", "Book a table")}
              </p>
              <h1
                className={
                  "font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-[1.1] line-clamp-2 " +
                  (step === 1 ? "text-[22px]" : "text-lg")
                }
              >
                {page.business_name}
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

          {/* Where it is and how to reach it — one quiet line of two links.
              As two text rows each 44pt touch target left a gap between the
              address and the number; as bordered pills they were the loudest
              thing in the header. Here they keep the 44pt target (global
              touch rule) but read as the light detail they are: the address
              opens the map, the number dials. A long address wraps the number
              under it. Step 1 only — on the details step the form starts high. */}
          {step === 1 && (page.city || page.address || telHref(page.phone)) && (
            <div className="flex flex-wrap items-center gap-x-4 text-[13px] text-gray-500 dark:text-gray-400">
              {(page.address || page.city) && (() => {
                const where = page.address || page.city;
                const map = mapsHref(page.address, page.city);
                const inner = (
                  <>
                    <MapPin size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{where}</span>
                  </>
                );
                // min-h-8! (32pt): the global 44pt touch rule sits outside
                // Tailwind's layers, so only the important form beats it. With
                // a long address the number wraps under it, and two 44pt rows
                // left a loose gap.
                const cls = "inline-flex items-center gap-1.5 max-w-full min-w-0 min-h-8! rounded-md " + FOCUS;
                return map ? (
                  <a
                    href={map}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cls + " hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200"}
                  >
                    {inner}
                  </a>
                ) : (
                  <span className={cls}>{inner}</span>
                );
              })()}
              {/* Owner's contact number — tappable "call us" for big groups or
                  questions. tel: built from digits via encodeURIComponent. */}
              {telHref(page.phone) && (
                <a
                  href={telHref(page.phone)}
                  className={"inline-flex items-center gap-1.5 min-h-8! rounded-md hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200 " + FOCUS}
                >
                  <Phone size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  <span className="tabular-nums whitespace-nowrap">{page.phone}</span>
                </a>
              )}
            </div>
          )}

          {/* The two objections a stranger has before booking — "do I need an
              account?" and "am I locked in?" — answered before they scroll.
              As plain grey body text it read as legalese and was skipped; on a
              quiet strip with a green check it reads as reassurance. The strip
              itself is neutral: the green is spent on the one main action. */}
          {step === 1 && (
            <div className="flex items-center gap-2 rounded-xl bg-gray-50 dark:bg-gray-900 px-3.5 py-2">
              <Check className="w-4 h-4 shrink-0 text-bb-green" aria-hidden />
              <p className="text-[13px] font-medium leading-snug text-gray-700 dark:text-gray-300">
                {t("rsvpTrustLine", "No account needed · Free cancellation")}
              </p>
            </div>
          )}
        </header>

        <StepDots step={step} t={t} />

        {/* ── Step 1 — (provider) behandling + behandler, then date + slot;
              (table) date + party + slot ────────────────────────────── */}
        {step === 1 && (
          <section
            ref={stepFocusRef}
            tabIndex={-1}
            aria-label={t("rsvpBookATable", "Book a table")}
            className="space-y-6 outline-none motion-safe:animate-[fadeIn_0.35s_ease-out]"
          >
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
                    <select
                      id="rsvp-behandling"
                      value={behandlingId}
                      onChange={(e) => setBehandlingId(e.target.value)}
                      className="w-full h-12 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-base text-gray-900 dark:text-gray-100"
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
                    <select
                      id="rsvp-behandler"
                      value={stylistId}
                      onChange={(e) => setStylistId(e.target.value)}
                      className="w-full h-12 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-base text-gray-900 dark:text-gray-100"
                    >
                      <option value="">{t("rsvpBookValgfri", "Any stylist")}</option>
                      {providers.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name || p.label}
                        </option>
                      ))}
                    </select>
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
                customer; the behandling sets the length, not party size. */}
            {!isProvider && (
              <div>
                <h2 className={SECTION_TITLE + " mb-2.5"}>
                  {t("rsvpPartySize", "Antal gæster")}
                </h2>
                {/* HORIZONTAL RAIL, not a grid. As a 5-across grid this was two
                    stacked rows that pushed the time slots — the thing the guest
                    actually came to choose — below the fold on a phone. A rail
                    keeps party size to one line, and the common answers (1–4)
                    are visible without scrolling it at all.
                    -mx-4 px-4 lets the row bleed to the screen edge so the last
                    chip is visibly cut off, which is what tells a thumb there is
                    more to swipe. */}
                <div
                  ref={partyRailRef}
                  role="radiogroup"
                  aria-label={t("rsvpPartySize", "Antal gæster")}
                  onKeyDown={rovingKeyDown}
                  // From sm up: rows of equal length (5 + 5, not 7 + 3).
                  style={{ "--party-cols": partyOptions.length <= 8 ? partyOptions.length : Math.ceil(partyOptions.length / 2) }}
                  className={RAIL + " sm:grid sm:grid-cols-[repeat(var(--party-cols),minmax(0,1fr))] sm:gap-1.5"}
                >
                  {partyOptions.map((n) => (
                    <Chip
                      key={n}
                      size="md"
                      selected={party === n}
                      onClick={() => setParty(n)}
                      aria-label={partyLabel(n, t)}
                      role="radio"
                      aria-checked={party === n}
                      aria-pressed={undefined}
                      tabIndex={party === n ? 0 : -1}
                      // Width from the screen: 7½ chips across, so a half chip
                      // always sits at the edge. At 44px a 375px phone showed
                      // exactly 1–7 and hid 8–10 — the group sizes — with
                      // nothing to say the row went on.
                      className={"shrink-0 w-[max(2.5rem,calc((100vw-4.5rem)/7.5))] sm:w-auto h-11 snap-start tabular-nums text-[15px] duration-200 ease-out rounded-xl! " + CHIP_FOCUS}
                    >
                      {n}
                    </Chip>
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
                        {t("rsvpPartyOverMaxCall", "Er I mere end {n}? Ring til os", {
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
                        "Er I mere end {n}? Skriv det præcise antal i beskedfeltet på næste trin.",
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
                  {t("rsvpPickDate", "Vælg dato")}
                </h2>
                {/* Quiet escape hatch for a far-out date, revealed on demand so
                    the native field never clutters the default clean strip. */}
                <button
                  type="button"
                  onClick={() => setShowDateInput((v) => !v)}
                  aria-expanded={showDateInput}
                  // -my-3: keeps its 44pt touch target without making this
                  // header row taller than the other two questions'.
                  className="-my-3 inline-flex items-center gap-1 text-[13px] font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
                >
                  <Calendar size={13} strokeWidth={1.75} aria-hidden="true" />
                  {t("rsvpOtherDate", "Anden dato")}
                </button>
              </div>
              {/* One-tap date strip (closed days disabled) — the primary picker. */}
              <DateStrip today={today} dayMap={dayMap} value={day} onPick={setDay} t={t} lang={lang} />
              {/* A later date: the page's own month grid in a sheet. The
                  native date field looked different on every phone and could
                  not show which days the place is closed. */}
              {showDateInput && isEmbed && (
                // Embedded on the restaurant's own site: the calendar opens in
                // place. A sheet is fixed to the bottom of the iframe, which is
                // as tall as the widget — far below what the guest can see.
                <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                  {/* Padding on an inner box: the sheet sets its own side
                      padding inline (safe-area insets), which beats a class. */}
                  <div className="px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                  <div className="flex items-center justify-between mb-2">
                    <p className={SECTION_TITLE}>{t("rsvpPickDate", "Vælg dato")}</p>
                    <button
                      type="button"
                      onClick={() => setShowDateInput(false)}
                      aria-label={t("close", "Close")}
                      className="-mr-2 w-10 h-10 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-200"
                    >
                      <X className="w-5 h-5" aria-hidden="true" />
                    </button>
                  </div>
                  <MonthCalendar
                    value={day}
                    min={today}
                    max={latestDay}
                    isClosed={(iso) => (dayMap && iso in dayMap ? dayMap[iso] === false : undefined)}
                    onPick={(iso) => {
                      setDay(iso);
                      setShowDateInput(false);
                    }}
                    locale={dateLocale(lang)}
                    labels={{
                      prev: t("rsvpPrevMonth", "Previous month"),
                      next: t("rsvpNextMonth", "Next month"),
                      closed: t("rsvpDayClosed", "lukket"),
                    }}
                  />
                  </div>
                </div>
              )}
              {showDateInput && !isEmbed && (
                <Sheet
                  onClose={() => setShowDateInput(false)}
                  ariaLabel={t("rsvpPickDate", "Vælg dato")}
                  panelClassName="bg-white dark:bg-gray-900 sm:max-w-sm"
                >
                  {/* Padding on an inner box: the sheet sets its own side
                      padding inline (safe-area insets), which beats a class. */}
                  <div className="px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                  <div className="flex items-center justify-between mb-2">
                    <p className={SECTION_TITLE}>{t("rsvpPickDate", "Vælg dato")}</p>
                    <button
                      type="button"
                      onClick={() => setShowDateInput(false)}
                      aria-label={t("close", "Close")}
                      className="-mr-2 w-10 h-10 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-200"
                    >
                      <X className="w-5 h-5" aria-hidden="true" />
                    </button>
                  </div>
                  <MonthCalendar
                    value={day}
                    min={today}
                    max={latestDay}
                    isClosed={(iso) => (dayMap && iso in dayMap ? dayMap[iso] === false : undefined)}
                    onPick={(iso) => {
                      setDay(iso);
                      setShowDateInput(false);
                    }}
                    locale={dateLocale(lang)}
                    labels={{
                      prev: t("rsvpPrevMonth", "Previous month"),
                      next: t("rsvpNextMonth", "Next month"),
                      closed: t("rsvpDayClosed", "lukket"),
                    }}
                  />
                  </div>
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
                  {t(
                    "rsvpGroupWishedTimeHint",
                    "Parties of {n} are sent as a request — pick the time you'd like and we'll confirm it.",
                    { n: party },
                  )}
                </p>
              )}
              {isProvider && !behandlingId ? (
                // Provider: no behandling chosen yet → don't imply "no times".
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("rsvpPublicPickBehandling", "Vælg behandling")}
                </p>
              ) : slotsLoading && slotGroups.length === 0 ? (
                <div className="grid grid-cols-4 gap-2" aria-hidden="true">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div
                        key={i}
                        className="animate-pulse h-11 rounded-lg bg-gray-100 dark:bg-gray-800"
                      />
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
              ) : closedReason === "not_accepting" ? (
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
                        "Stedet tager ikke imod flere online reservationer lige nu.",
                      )}
                    </p>
                    {telHref(page.phone) && (
                      <a
                        href={telHref(page.phone)}
                        className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
                      >
                        <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                        <span>
                          {t("rsvpNoSlotsCall", "Ring til os: {phone}", {
                            phone: page.phone,
                          })}
                        </span>
                      </a>
                    )}
                  </div>
                ) : slotGroups.length === 0 && groupRequest ? (
                  // An older server offers no preferred times for a group:
                  // keep the calm explainer — the venue picks the time.
                  <div
                    className="rounded-xl bg-gray-50 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 p-4 flex items-start gap-3"
                    role="status"
                  >
                    <Users size={18} strokeWidth={1.75} className="text-gray-500 shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      {t(
                        "rsvpGroupPanelBody",
                        "Parties of {n} are sent as a request — we'll confirm a time and get back to you.",
                        { n: party },
                      )}
                    </p>
                  </div>
                ) : slotGroups.length === 0 ? (
                  !isProvider && dayMap === null ? (
                    // Open/closed overview still resolving → don't flash a
                    // premature "no times"; show the same slot skeleton.
                    <div className="grid grid-cols-4 gap-2">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div
                          key={i}
                          className="animate-pulse h-11 rounded-lg bg-gray-100 dark:bg-gray-800"
                        />
                      ))}
                    </div>
                  ) : nextOpenDay && nextOpenDay !== day ? (
                    // Closed this day but open later — NEVER a dead-end. One tap
                    // to the next open day (fixes the "closed today" bounce).
                    <div className="space-y-3">
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        {t("rsvpClosedTodayOpenSoon", "Lukket denne dag. Næste ledige: {day}", {
                          day: fmtDayLabel(nextOpenDay, lang),
                        })}
                      </p>
                      <Button size="lg" onClick={() => setDay(nextOpenDay)}>
                        {t("rsvpJumpNextOpen", "Vis {day}", { day: fmtDayLabel(nextOpenDay, lang) })}
                      </Button>
                    </div>
                  ) : (
                    // Genuinely nothing bookable in the window → honest phone
                    // fallback (a real <a href="tel:">, dials on tap).
                    <div className="space-y-3">
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {nextOpenDay
                          ? t("rsvpNoSlotsDay", "Ingen ledige tider denne dag.")
                          : t("rsvpFullOrClosedWeek", "Ingen ledige tider de næste 14 dage.")}
                      </p>
                      {telHref(page.phone) && (
                        <a
                          href={telHref(page.phone)}
                          className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
                        >
                          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
                          <span>
                            {t("rsvpNoSlotsCall", "Ring til os: {phone}", {
                              phone: page.phone,
                            })}
                          </span>
                        </a>
                      )}
                    </div>
                  )
                ) : (
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
                  />
                )}
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
                  <div className="animate-pulse h-44 rounded-xl bg-gray-100 dark:bg-gray-800" />
                ) : floor.some((tb) => tb.status === "free") ? (
                  <>
                    <PublicFloorMap
                      tables={floor}
                      selectedId={selectedTable}
                      onSelect={setSelectedTable}
                      t={t}
                      bookingMode={usesTableFloor(page.business_type) ? bookingModeFor(page.business_type) : "table"}
                    />
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      {selectedTable
                        ? t("rsvpFloorPicked", "Fint valg — vi holder bordet til dig.")
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
          <section className="space-y-5 motion-safe:animate-[fadeIn_0.35s_ease-out]">
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
              className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 hover:border-gray-300 dark:hover:border-gray-600 transition-colors px-4 py-3 flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300"
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
                      partyLabel(party, t),
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
                          : "text-gray-500 dark:text-gray-400")
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
                  <p className="text-xs text-red-600 dark:text-red-400">
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
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
              <button
                type="button"
                onClick={() => setDetailsOpen((v) => !v)}
                aria-expanded={detailsOpen}
                className="w-full min-h-[56px] px-4 py-3 flex items-center gap-3 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-semibold text-gray-900 dark:text-gray-100">
                    {t("rsvpExtrasTitle", "Allergies, occasion or a note?")}
                  </span>
                  <span className="block text-[12.5px] text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5">
                    {extrasSummary || t("rsvpExtrasHint", "Optional — so the kitchen can plan for you")}
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
                          {t("rsvpAllergyShared", "Shared only with {venue}, so the kitchen can plan.", {
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
                                  ? "bg-bb-green-dark border-bb-green-dark text-white font-medium"
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
                                    ? "bg-gray-900 border-gray-900 text-white font-semibold dark:bg-white dark:border-white dark:text-gray-900"
                                    : "bg-white border-gray-200 text-gray-800 hover:border-gray-400 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200")
                                }
                              >
                                {t(`rsvpSeverity_${k}`, severityFallback(k))}
                              </button>
                            ))}
                          </div>
                          <textarea
                            id="rsvp-allergy-note"
                            aria-label={t("rsvpXAllergyDetail", "Tell the kitchen more")}
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
                      clear. */}
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
                                ? "bg-gray-900 border-gray-900 text-white font-medium dark:bg-white dark:border-white dark:text-gray-900"
                                : "bg-white border-gray-200 text-gray-800 hover:border-gray-400 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-200")
                            }
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="rsvp-notes" className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t("rsvpXNote", "A note for us")}
                    </label>
                    <textarea
                      id="rsvp-notes"
                      value={guestNotes}
                      onChange={(e) => setGuestNotes(e.target.value)}
                      placeholder={t(
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
              className="w-full flex items-center gap-4 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t("rsvpMarketing", "Send mig nyheder og tilbud")}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 leading-relaxed mt-0.5">
                  {t(
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
              {t(
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

            {/* Submit-error surfaces */}
            {submitError && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 flex items-start gap-2">
                <AlertCircle
                  size={16}
                  strokeWidth={1.75}
                  className="text-red-600 dark:text-red-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {submitErrorMessage(submitError, t)}
                </p>
              </div>
            )}
          </section>
        )}
        {/* ── Sticky bottom CTA ─────────────────────────────────────────
            Standalone page: `fixed` to the viewport (root reserves pb-32).
            Embedded (?embed=1): `sticky` so it flows with the content-sized
            widget — it settles under the form in a short frame and pins to the
            frame bottom while scrolling a tall one, never detaching. */}
        <div
          ref={barRef}
          className={
            (isEmbed
              ? "sticky glass-static bottom-0 -mx-4 sm:-mx-6"
              : // Phone: fixed to the screen, edge to edge (negative margins
                  // pushed it 16px past both edges). Tablet/desktop: the booking
                // card's own sticky footer — a full-width bar cut across the
                // card at 1280 and floated 190px below it at 768.
                "fixed glass bottom-0 inset-x-0 sm:sticky sm:inset-x-auto sm:-mx-6 sm:rounded-b-xl sm:transform-none!") +
            " z-40 border-t border-gray-200/80 dark:border-gray-800 dark:bg-gray-950/90!"
          }
          style={
            isEmbed
              ? { paddingBottom: "env(safe-area-inset-bottom, 0px)" }
              : { bottom: kbInset, paddingBottom: kbInset ? 0 : "env(safe-area-inset-bottom, 0px)" }
          }
        >
          <div className="max-w-md mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
            {step === 1 ? (
              <>
                {/* The whole selection stays in view — date, time and party —
                    so the guest never has to scroll back up to check what the
                    button is about to continue with. */}
                <div className="min-w-0 flex-1" aria-live="polite">
                  <p className="text-[14.5px] font-semibold text-gray-900 dark:text-gray-100 truncate first-letter:uppercase">
                    {[fmtDayShort(day, lang), slot || null].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-[12.5px] text-gray-500 dark:text-gray-400 truncate">
                    {groupRequest
                        ? t("rsvpGroupTimeNote", "{party} · request", {
                            party: partyLabel(party, t),
                          })
                        : isProvider && chosenBehandling
                          ? chosenBehandling.name
                          : partyLabel(party, t)}
                  </p>
                </div>
                {/* Never a dead grey block: until a time is picked the button
                    says so, and a tap scrolls to the times. Grey here, then
                    green, then grey again on step 2 read as "something broke". */}
                <Button
                  variant="main"
                  size="lg"
                  onClick={needsTime ? revealTimes : goToDetails}
                  className="shrink-0 px-6 h-[52px]! rounded-xl! text-[15.5px]! font-semibold!"
                  iconRight={needsTime ? null : <ArrowRight className="w-[18px] h-[18px]" aria-hidden="true" />}
                >
                  {needsTime ? t("rsvpPickTimeCta", "Vælg et tidspunkt") : t("rsvpContinue", "Continue")}
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
                  className="flex-1 h-[52px]! rounded-xl! text-[15.5px]! font-semibold!"
                  iconRight={
                    needsTime || !canSubmit ? null : <ArrowRight className="w-[18px] h-[18px]" aria-hidden="true" />
                  }
                >
                  {/* A disabled button reading "Confirm reservation" tells the
                      guest nothing about why it will not press. Say what is
                      missing — the label becomes the instruction. */}
                  {needsTime
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
                                : isProvider
                                  ? t("rsvpConfirmTime", "Confirm appointment")
                                  : t("rsvpConfirm", "Bekræft reservation"),
                            )}
                </Button>
              </>
            )}
          </div>
        </div>
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

function LangPill({ lang, setLang }) {
  return (
    <div
      role="group"
      aria-label="Sprog · Language"
      className="shrink-0 flex items-center p-0.5 rounded-full bg-gray-100 dark:bg-gray-800"
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
            "h-8 min-w-[40px] px-2.5 rounded-full text-[11px] font-semibold uppercase tracking-wide transition-colors duration-200 ease-out " + FOCUS + " " +
            (lang === code
              ? "bg-white text-gray-900 shadow-sm dark:bg-gray-600 dark:text-white"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200")
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

function StepDots({ step, t }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={2}
      aria-valuenow={step}
      // Read as "Step 1 of 2", not as a bare number.
      aria-valuetext={t("rsvpStepOf", "Step {n} of {total}", { n: step, total: 2 })}
      aria-label={t("rsvpStepAria", "Reservation step")}
    >
      {[1, 2].map((n) => (
        <span
          key={n}
          className={
            "inline-block rounded-full transition-all h-2 " +
            (n === step
              ? "bg-gray-900 dark:bg-gray-100 w-6"
              : n < step
                ? "bg-gray-400 dark:bg-gray-500 w-2"
                : "bg-gray-200 dark:bg-gray-700 w-2")
          }
        />
      ))}
    </div>
  );
}

function SummaryRow({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-gray-400 dark:text-gray-500 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 w-24 shrink-0">
        {label}
      </span>
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {value}
      </span>
    </div>
  );
}

function ClosedScreen({ t, name, rootMinH = "min-h-screen" }) {
  return (
    <div className={`${rootMinH} bg-white dark:bg-gray-950 px-4 py-16`}>
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
        "Stedet tager ikke imod flere reservationer lige nu.",
      );
    case "invalid_email":
      return t("rsvpEmailCheck", "Check your email — e.g. anna@example.com");
    case "invalid_phone":
      return t("rsvpPhoneCheck", "Check your phone number — e.g. +45 12 34 56 78");
    default:
      return t("rsvpErrGeneric", "Noget gik galt. Prøv igen om et øjeblik.");
  }
}
