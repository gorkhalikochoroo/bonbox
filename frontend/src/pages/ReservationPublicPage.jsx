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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Calendar,
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
} from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import Button from "../components/ui/Button";
import Chip from "../components/ui/Chip";
import Input from "../components/ui/Input";
import PublicFloorMap from "../components/PublicFloorMap";
import { bookingModeFor, usesTableFloor } from "../config/venueProfiles";

// ── Severity ladder ────────────────────────────────────────────────
// Mirrors backend app/services/allergens.py SEVERITY_LEVELS. Stored as
// the stable key; the human label is resolved through the i18n layer.
const SEVERITY_KEYS = ["preference", "intolerance", "severe"];

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
function DateStrip({ today, dayMap, value, onPick, t }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const fmt = (iso) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("da-DK", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {days.map((iso) => {
        const known = dayMap && iso in dayMap;
        const closed = known && dayMap[iso] === false;
        const active = value === iso;
        return (
          <button
            key={iso}
            type="button"
            disabled={closed}
            onClick={() => !closed && onPick(iso)}
            aria-pressed={active}
            aria-label={closed ? `${fmt(iso)} — ${t("rsvpClosed", "lukket")}` : fmt(iso)}
            className={[
              "shrink-0 rounded-xl px-3 py-2 text-sm border transition text-center min-w-[76px] min-h-[44px] sm:min-h-0 leading-tight",
              active
                ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900"
                : "border-gray-200 text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300",
              closed ? "opacity-40 cursor-not-allowed" : "",
            ].join(" ")}
          >
            <span className="capitalize block">{fmt(iso)}</span>
            {closed && (
              <span className="block text-[10px] text-gray-400">
                {t("rsvpClosed", "lukket")}
              </span>
            )}
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
function fmtDayLabel(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(`${isoStr}T00:00:00`);
    return d.toLocaleDateString("da-DK", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  } catch {
    return isoStr;
  }
}

// ── Venue monogram ─────────────────────────────────────────────────
// Fallback venue identity when the owner hasn't uploaded a brand logo: a
// tasteful 1–2 letter monogram derived from the venue name purely
// typographically — first letters of the first two words, else the first two
// letters. Upper-cased, diacritics preserved (Café → C). Plain text — JSX escapes it.
function venueMonogram(name) {
  const clean = String(name || "").trim();
  if (!clean) return "·";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

// ── Venue identity tile ────────────────────────────────────────────
// The owner's uploaded brand logo (the SAME logo used on their invoices),
// served as a short-lived signed url from the public meta. Falls back to the
// typographic monogram when there's no logo — or if the image fails to load /
// the url has expired — so the header is never empty. The logo sits on a light
// tile (logos often carry transparency and need light contrast).
function VenueBadge({ logoUrl, name }) {
  const [broken, setBroken] = useState(false);
  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt=""
        onError={() => setBroken(true)}
        className="shrink-0 w-12 h-12 rounded-xl object-contain bg-white ring-1 ring-gray-200 dark:ring-gray-700 p-1"
      />
    );
  }
  return (
    <div
      className="shrink-0 w-12 h-12 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-base font-semibold tracking-tight select-none"
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
  const q = [address, city].filter(Boolean).join(", ").trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export default function ReservationPublicPage() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const { t, setLang } = useLanguage();

  // Embedded in an owner's website (iframe, ?embed=1): drop the forced
  // min-h-screen so the widget sizes to its content inside the frame instead
  // of padding out a full viewport of whitespace. Everything else is
  // identical — the flow is the same, just framed.
  const isEmbed = searchParams.get("embed") === "1";
  const rootMinH = isEmbed ? "" : "min-h-screen";

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
  const [groupRequest, setGroupRequest] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");

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
  const [allergySeverity, setAllergySeverity] = useState("preference");
  const [allergyNote, setAllergyNote] = useState("");

  // GDPR — marketing consent default OFF.
  const [consentMarketing, setConsentMarketing] = useState(false);

  // Submit.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(""); // "" | error-key
  const [result, setResult] = useState(null); // {id, status, booking_token}

  // ── Post-booking live status + self-cancel ───────────────────────
  // After a successful booking the success screen polls GET /booking/{id}
  // so a "requested" group booking flips live to confirmed / declined,
  // and offers an "Aflys reservation" self-cancel (POST .../cancel).
  // `liveStatus` is the authoritative status once polling starts; before
  // that we fall back to the create response's status.
  const [liveStatus, setLiveStatus] = useState(null); // null | backend status
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
    if (!bid || !tok) return;
    setResult({ id: bid, booking_token: tok, status: null });
    api
      .get(`/public/reservations/booking/${bid}`, { params: { token: tok } })
      .then((r) => setLiveStatus(r?.data?.status || null))
      .catch(() => setLiveStatus(null)); // bad/expired → inert screen; cancel POST 404s via existing cancelError
  }, [searchParams, result]);

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
    if (qDay && /^\d{4}-\d{2}-\d{2}$/.test(qDay)) {
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
        // Never override a day that actually has slots (a valid ?d= link or a
        // day the diner tapped); only rescue a closed selection.
        setDay((cur) => (cur && map[cur] ? cur : res.data?.next_open_day || cur));
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
  // ("BonBox — The AI manager …"). NOTE (honest limitation): this is a pure SPA,
  // so social/SMS link-unfurl crawlers read the STATIC index.html title before
  // JS runs — the live tab updates, but shared-link previews still show the app
  // default until we add SSR/prerender. Still worth it for the tab + trust.
  useEffect(() => {
    if (!page?.business_name) return;
    const prev = document.title;
    const title = t("rsvpDocTitle", "Book bord · {venue}", { venue: page.business_name });
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
  }, [page, t]);

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
        setGroupRequest(false);
        setSlot("");
        return;
      }
      if (!isProvider && !forParty) return;
      setSlotsLoading(true);
      setSlotsError("");
      setSlot("");
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
          setGroupRequest(false);
        } else {
          const res = await api.get(`/public/reservations/${slug}/availability`, {
            params: { day: forDay, party: forParty },
          });
          setSlots(Array.isArray(res.data?.slots) ? res.data.slots : []);
          setGroupRequest(!!res.data?.group_request);
        }
      } catch (err) {
        setSlots([]);
        setGroupRequest(false);
        setSlotsError(
          err?.response?.data?.detail?.error ||
            t("rsvpSlotsError", "Couldn't load times — please try again."),
        );
      } finally {
        setSlotsLoading(false);
      }
    },
    [slug, t, isProvider],
  );

  useEffect(() => {
    if (!page || !day) return;
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
  // Require at least one contact channel (email OR phone, never both) so we
  // can actually confirm the booking — otherwise a name-only booking is a
  // dead end. Either one is enough.
  const contactValid = !!(guestEmail.trim() || guestPhone.trim());
  // A group request doesn't need a chosen slot (the visitor sends a
  // request for the day; the restaurant confirms a time). A normal
  // booking requires a slot. A provider (salon) tidsbestilling also needs a
  // chosen behandling.
  const canSubmit =
    nameValid &&
    contactValid &&
    (groupRequest || !!slot) &&
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
  // One idempotency key per attempt. After a 409 we generate a fresh
  // key (the conflict was on the slot, not the booking key) — mirrors
  // the BookingCheckoutPage pattern.
  function newIdempotencyKey() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const onSubmit = async () => {
    if (!canSubmit) {
      setNameTouched(true);
      setContactTouched(true);
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    const hasAllergy =
      allergenTags.length > 0 || allergyNote.trim().length > 0;
    const payload = {
      day,
      // For a group request the backend ignores the exact time (it's a
      // day-level request) but the schema still wants HH:MM — send the
      // chosen slot if any, else a neutral opening-ish time.
      time: slot || "18:00",
      party_size: party,
      guest_name: guestName.trim(),
      guest_email: guestEmail.trim() || null,
      guest_phone: guestPhone.trim() || null,
      occasion: occasion.trim() || null,
      guest_notes: guestNotes.trim() || null,
      allergen_tags: hasAllergy ? allergenTags : [],
      allergy_note: hasAllergy ? allergyNote.trim() || null : null,
      allergy_severity: hasAllergy ? allergySeverity : null,
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
        headers: { "X-Idempotency-Key": newIdempotencyKey() },
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
      }
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.detail?.error;
      if (status === 409 || status === 410) {
        // slot_unavailable | stylist_unavailable | party_too_large | not_accepting
        setSubmitError(code || "slot_unavailable");
        // The slot (or the pinned behandler) is gone — refetch availability so
        // the visitor sees a fresh set without manually changing the date, and
        // bounce back to step 1. We NEVER silently rebook a different behandler.
        if (code === "slot_unavailable" || code === "stylist_unavailable") {
          if (isProvider) fetchAvailability(day, party, behandlingId, stylistId);
          else fetchAvailability(day, party);
          setStep(1);
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
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
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
      />
    );
  }

  if (loadError || !page) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-16">
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

  // ── Success screen ─────────────────────────────────────────────────
  if (result) {
    // `liveStatus` is the authoritative status (seeded from the create
    // response, kept fresh by the poll); fall back to the raw result.
    const status = liveStatus || result.status;
    const isRequest = status === "requested";
    const isConfirmed = status === "confirmed" || status === "seated";
    const isCancelled = status === "cancelled" || status === "no_show";
    const isDone = status === "completed";
    // Self-cancel only makes sense while the booking is still live.
    const canCancel = isRequest || isConfirmed;

    // Status-driven hero icon + headline + body. Emerald is reserved for the
    // one confirmed "money moment"; pending/closed states stay gray.
    let HeroIcon = CheckCircle2;
    let heroWrap = "bg-emerald-50 dark:bg-emerald-900/20";
    let heroIconCls = "text-emerald-600 dark:text-emerald-400";
    let title = t("rsvpConfirmedTitle", "Reservation bekræftet");
    let body = t(
      "rsvpConfirmedBody",
      "Vi glæder os til at se dig. Du modtager en bekræftelse hvis du har angivet en email.",
    );
    if (isRequest) {
      HeroIcon = Clock;
      heroWrap = "bg-gray-100 dark:bg-gray-800";
      heroIconCls = "text-gray-500 dark:text-gray-400";
      title = t("rsvpRequestTitle", "Forespørgsel modtaget");
      body = t(
        "rsvpRequestBody",
        "Vi har modtaget din forespørgsel — stedet vender tilbage for at bekræfte.",
      );
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
    // Did the guest leave an email? Drives the honest confirmation line.
    const emailGiven = guestEmail.trim().length > 0;

    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
        <div className="max-w-md mx-auto space-y-6 text-center">
          <div
            className={
              `inline-flex items-center justify-center w-14 h-14 rounded-full mx-auto ${heroWrap} ` +
              // Single brief fade-scale on mount (≤300ms). No confetti.
              "transition-all duration-300 ease-out motion-reduce:transition-none " +
              (heroIn ? "opacity-100 scale-100" : "opacity-0 scale-90")
            }
          >
            <HeroIcon
              size={28}
              strokeWidth={1.75}
              className={heroIconCls}
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1">
            <h1 className="text-[26px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {title}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300">{body}</p>
            {/* Honest email line — confirms where (or that no) email went. */}
            <p className="text-sm text-gray-500 dark:text-gray-400 pt-0.5">
              {emailGiven
                ? t("rsvpEmailedTo", "We've sent a confirmation to {email}.", {
                    email: guestEmail.trim(),
                  })
                : t("rsvpNoEmailSaved", "Save this page — we don't have your email.")}
            </p>
          </div>

          {/* Live status pill — while a group request is pending we poll and
              flip this to "Bekræftet" the moment the restaurant confirms. */}
          {isRequest && (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300"
              role="status"
              aria-live="polite"
            >
              <Loader2
                size={13}
                strokeWidth={2}
                className="animate-spin text-gray-400"
                aria-hidden="true"
              />
              {t("rsvpStatusWaiting", "Afventer bekræftelse fra stedet…")}
            </div>
          )}
          {isConfirmed && status !== result.status && (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
              role="status"
              aria-live="polite"
            >
              <CheckCircle2 size={13} strokeWidth={2} aria-hidden="true" />
              {t("rsvpStatusConfirmed", "Bekræftet")}
            </div>
          )}

          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 text-left space-y-2">
            {refCode && (
              <SummaryRow
                icon={<Hash size={16} strokeWidth={1.75} />}
                label={t("rsvpRefLabel", "Reference")}
                value={refCode}
              />
            )}
            <SummaryRow
              icon={<Calendar size={16} strokeWidth={1.75} />}
              label={t("rsvpDateLabel", "Dato")}
              value={fmtDayLabel(day)}
            />
            {!isRequest && slot && (
              <SummaryRow
                icon={<Clock size={16} strokeWidth={1.75} />}
                label={t("rsvpTimeLabel", "Tidspunkt")}
                value={slot}
              />
            )}
            {/* Provider (salon): behandling + behandler instead of party. */}
            {isProvider ? (
              <>
                {chosenBehandling && (
                  <SummaryRow
                    icon={<Scissors size={16} strokeWidth={1.75} />}
                    label={t("rsvpColBehandling", "Behandling")}
                    value={chosenBehandling.name}
                  />
                )}
                <SummaryRow
                  icon={<Users size={16} strokeWidth={1.75} />}
                  label={t("rsvpColBehandler", "Behandler")}
                  value={chosenStylistName || t("rsvpBookValgfri", "Valgfri behandler")}
                />
              </>
            ) : (
              <SummaryRow
                icon={<Users size={16} strokeWidth={1.75} />}
                label={t("rsvpPartyLabel", "Antal gæster")}
                value={String(party)}
              />
            )}
            <SummaryRow
              icon={<Info size={16} strokeWidth={1.75} />}
              label={t("rsvpGuestLabel", "Navn")}
              value={guestName.trim()}
            />
            {/* Restore the venue's location + a tappable number so the guest
                can find the place and call it from the confirmation. The
                address is a maps link built via encodeURIComponent (safe). */}
            {(page.address || page.city) && (
              <div className="flex items-center gap-3">
                <span className="text-gray-400 dark:text-gray-500 shrink-0" aria-hidden="true">
                  <MapPin size={16} strokeWidth={1.75} />
                </span>
                <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 w-24 shrink-0">
                  {t("rsvpAddressLabel", "Address")}
                </span>
                {mapsHref(page.address, page.city) ? (
                  <a
                    href={mapsHref(page.address, page.city)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    {[page.address, page.city].filter(Boolean).join(", ")}
                  </a>
                ) : (
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {[page.address, page.city].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>
            )}
            {telHref(page.phone) && (
              <div className="flex items-center gap-3">
                <span className="text-gray-400 dark:text-gray-500 shrink-0" aria-hidden="true">
                  <Phone size={16} strokeWidth={1.75} />
                </span>
                <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 w-24 shrink-0">
                  {t("rsvpCallLabel", "Phone")}
                </span>
                <a
                  href={telHref(page.phone)}
                  className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  {page.phone}
                </a>
              </div>
            )}
          </div>

          {/* Self-cancel — frees the table and notifies the restaurant.
              Hidden once the booking is cancelled/done. */}
          {canCancel && (
            <div className="space-y-2">
              <Button
                variant="secondary"
                size="lg"
                onClick={onCancel}
                busy={cancelling}
                disabled={cancelling}
                className="w-full"
              >
                {t("rsvpCancelBtn", "Aflys reservation")}
              </Button>
              {cancelError && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {t(
                    "rsvpCancelError",
                    "Kunne ikke aflyse. Prøv igen, eller kontakt stedet direkte.",
                  )}
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-gray-400 dark:text-gray-500">
            {page.business_name}
            {page.city ? ` · ${page.city}` : ""}
          </p>
        </div>
      </div>
    );
  }

  // ── Main wizard ────────────────────────────────────────────────────
  return (
    <div className={`${rootMinH} bg-white dark:bg-gray-950 pb-32`}>
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-8 sm:pt-10 space-y-6">
        {/* ── Venue identity (brand logo or typographic monogram) ──
            Identity tile + eyebrow + venue name H1 + location row with a
            quiet right-aligned tappable phone. One trust line underneath. */}
        <header className="space-y-3">
          <div className="flex items-start gap-3">
            {/* Identity tile — the owner's uploaded brand logo when they have
                one, else a typographic monogram derived from the name. */}
            <VenueBadge logoUrl={page.logo_url} name={page.business_name} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {isProvider ? t("rsvpBookATime", "Book en tid") : t("rsvpBookATable", "Book a table")}
              </p>
              <h1 className="text-[26px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-[1.1] line-clamp-2">
                {page.business_name}
              </h1>
            </div>
          </div>

          {/* Location row + quiet right-aligned call link on the same line. */}
          {(page.city || page.address || page.phone) && (
            <div className="flex items-center justify-between gap-3">
              {(page.city || page.address) ? (
                <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 min-w-0">
                  <MapPin size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  <span className="line-clamp-2 break-words">{page.address || page.city}</span>
                </div>
              ) : (
                <span />
              )}
              {/* Owner's contact number — tappable "call us" for big groups or
                  questions. tel: built from digits via encodeURIComponent. */}
              {telHref(page.phone) && (
                <a
                  href={telHref(page.phone)}
                  className="shrink-0 inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                >
                  <Phone size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  <span>{page.phone}</span>
                </a>
              )}
            </div>
          )}

          {/* One quiet trust line. */}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("rsvpTrustLine", "No account needed · Free cancellation")}
          </p>
        </header>

        <StepDots step={step} t={t} />

        {/* ── Step 1 — (provider) behandling + behandler, then date + slot;
              (table) date + party + slot ────────────────────────────── */}
        {step === 1 && (
          <section className="space-y-5">
            {/* Provider (salon): behandling → behandler come FIRST. The chosen
                behandling drives slot length (server-resolved); behandler
                defaults to Valgfri behandler. */}
            {isProvider && (
              <>
                <div>
                  <label
                    htmlFor="rsvp-behandling"
                    className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                  >
                    {t("rsvpPublicPickBehandling", "Vælg behandling")}
                  </label>
                  {behandlinger.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        "rsvpBehandlingNoneOnPage",
                        "No behandlinger are bookable online right now.",
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
                    className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
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
                      <option value="">{t("rsvpBookValgfri", "Valgfri behandler")}</option>
                      {providers.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name || p.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300">
                      {t("rsvpBookValgfri", "Valgfri behandler")} ·{" "}
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("rsvpBookValgfriHint", "We'll match you with the first free behandler.")}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
            {/* Date */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t("rsvpPickDate", "Vælg dato")}
                </p>
                {/* Quiet escape hatch for a far-out date, revealed on demand so
                    the native field never clutters the default clean strip. */}
                <button
                  type="button"
                  onClick={() => setShowDateInput((v) => !v)}
                  aria-expanded={showDateInput}
                  className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
                >
                  <Calendar size={13} strokeWidth={1.75} aria-hidden="true" />
                  {t("rsvpOtherDate", "Anden dato")}
                </button>
              </div>
              {/* One-tap date strip (closed days disabled) — the primary picker. */}
              <DateStrip today={today} dayMap={dayMap} value={day} onPick={setDay} t={t} />
              {showDateInput && (
                <div className="mt-2">
                  <Input
                    id="rsvp-day"
                    type="date"
                    size="lg"
                    value={day}
                    min={today}
                    max={latestDay}
                    onChange={(e) => setDay(e.target.value)}
                    aria-label={t("rsvpPickDate", "Vælg dato")}
                    prefix={<Calendar size={16} strokeWidth={1.75} />}
                  />
                </div>
              )}
            </div>

            {/* Party size — TABLE venues only. A salon tidsbestilling is one
                customer; the behandling sets the length, not party size. */}
            {!isProvider && (
              <div>
                <p className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t("rsvpPartySize", "Antal gæster")}
                </p>
                <div className="grid grid-cols-5 gap-1.5">
                  {partyOptions.map((n) => (
                    <Chip
                      key={n}
                      size="md"
                      selected={party === n}
                      onClick={() => setParty(n)}
                      aria-label={t("rsvpPartyN", "{n} guests", { n })}
                      className="w-full h-11"
                    >
                      {n}
                    </Chip>
                  ))}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                  {t(
                    "rsvpPartyHint",
                    "Større selskab? Vælg det højeste antal — vi sender en forespørgsel.",
                  )}
                </p>
              </div>
            )}

            {/* Time — for a normal booking we show the period-grouped slot
                grid. For a group request the grid is REPLACED by a calm
                explainer panel (sets the mental model: no time to pick; the
                place confirms). The sticky CTA flips to "Send forespørgsel"
                in the same render. */}
            {groupRequest ? (
              <div
                className="rounded-xl bg-gray-50 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 p-4 flex items-start gap-3"
                role="status"
              >
                <Users
                  size={18}
                  strokeWidth={1.75}
                  className="text-gray-500 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t("rsvpGroupPanelTitle", "Bigger group")}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {t(
                      "rsvpGroupPanelBody",
                      "Parties of {n} go to the place as a request — no time to pick. They'll confirm a time and get back to you.",
                      { n: party },
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <p className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t("rsvpPickTime", "Vælg tidspunkt")}
                </p>
                {isProvider && !behandlingId ? (
                  // Provider: no behandling chosen yet → don't imply "no times".
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t("rsvpPublicPickBehandling", "Vælg behandling")}
                  </p>
                ) : slotsLoading ? (
                  <div className="grid grid-cols-4 gap-2">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <div
                        key={i}
                        className="animate-pulse h-11 rounded-lg bg-gray-100 dark:bg-gray-800"
                      />
                    ))}
                  </div>
                ) : slotsError ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {slotsError}
                  </p>
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
                          day: fmtDayLabel(nextOpenDay),
                        })}
                      </p>
                      <Button size="lg" onClick={() => setDay(nextOpenDay)}>
                        {t("rsvpJumpNextOpen", "Vis {day}", { day: fmtDayLabel(nextOpenDay) })}
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
                  // Period groups — render a label only when the group has
                  // slots; slots align in a 4-col grid (44px tap height).
                  <div className="space-y-4">
                    {slotGroups.map((group) => (
                      <div key={group.key}>
                        <p className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">
                          {t(group.labelKey)}
                        </p>
                        <div className="grid grid-cols-4 gap-2">
                          {group.slots.map((s) => (
                            <Chip
                              key={s}
                              size="md"
                              selected={slot === s}
                              onClick={() => setSlot(s)}
                              className={"h-11 w-full " + (slot === s ? "font-semibold shadow-sm" : "")}
                            >
                              {s}
                            </Chip>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* ── Pick your table on the 2D floor (matches the owner room) ──
                Honesty gate #1 (+ grandfather): TABLE venues (dining/bar) show the
                floor; a provider (salon) never fetches one so floor stays empty and
                this stays hidden; a no-floor (bakery/retail) venue with zero tables
                likewise shows nothing. A venue that ALREADY has a real table plan
                renders it because free tables actually came back (floor.length > 0).
            */}
            {page.guest_can_pick_table && (usesTableFloor(page.business_type) || floor.length > 0) && !groupRequest && slot && (floorLoading || floor.length > 0) && (
              <div>
                <p className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t("rsvpFloorPickTitle", "Vælg dit bord")}
                </p>
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
          <section className="space-y-5">
            {/* Recap of the picks from step 1. Provider (salon): behandling +
                behandler + duration + dato/tid (e.g. "Klip · Marta · 30 min ·
                lørdag 13. juni 14:00", or "Valgfri behandler"). Table venues
                keep the date · time · party · table line. */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-4 py-3 flex flex-wrap sm:flex-nowrap items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
              <Calendar size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
              {isProvider ? (
                <span className="min-w-0">
                  {chosenBehandling && (
                    <span className="font-medium">{chosenBehandling.name}</span>
                  )}
                  <span aria-hidden="true"> · </span>
                  <span className={chosenStylistName ? "font-medium" : ""}>
                    {chosenStylistName || t("rsvpBookValgfri", "Valgfri behandler")}
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
                  <span>{fmtDayLabel(day)}</span>
                  {slot && (
                    <>
                      <span aria-hidden="true"> </span>
                      <span>{slot}</span>
                    </>
                  )}
                </span>
              ) : (
                <>
                  <span className="font-medium">{fmtDayLabel(day)}</span>
                  {!groupRequest && slot && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{slot}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>
                    {t("rsvpPartyN", "{n} guests", { n: party })}
                  </span>
                  {!groupRequest && selectedTable && (() => {
                    const tb = floor.find((x) => String(x.id) === String(selectedTable));
                    return tb ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium">{tb.label}</span>
                      </>
                    ) : null;
                  })()}
                </>
              )}
            </div>

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
                />
              </div>

              {/* Email + phone — either one is required (the guest needs one
                  reachable channel). Each field is individually optional, so
                  the labels are bare and a single hint states the "one of these"
                  rule honestly (no more "(optional)" on a field that, together,
                  is required). Email gets the "why" helper. */}
              <div className="space-y-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t("rsvpContactHint", "We need one way to reach you — email or phone.")}
                </p>
                <div>
                  <label
                    htmlFor="rsvp-email"
                    className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                  >
                    {t("rsvpContactEmailLabel", "Email")}
                  </label>
                  <Input
                    id="rsvp-email"
                    type="email"
                    size="md"
                    value={guestEmail}
                    onChange={(e) => setGuestEmail(e.target.value)}
                    onBlur={() => setContactTouched(true)}
                    placeholder={t("rsvpEmailPh", "anna@eksempel.dk")}
                    hint={t("rsvpEmailWhy", "So we can send your confirmation.")}
                    autoComplete="email"
                    inputMode="email"
                    maxLength={255}
                  />
                </div>
                <div>
                  <label
                    htmlFor="rsvp-phone"
                    className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                  >
                    {t("rsvpContactPhoneLabel", "Telefon")}
                  </label>
                  <Input
                    id="rsvp-phone"
                    type="tel"
                    size="md"
                    value={guestPhone}
                    onChange={(e) => setGuestPhone(e.target.value)}
                    onBlur={() => setContactTouched(true)}
                    placeholder={t("rsvpPhonePh", "+45 12 34 56 78")}
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={40}
                  />
                </div>
                {contactTouched && !contactValid && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {t(
                      "rsvpContactRequired",
                      "Add an email or phone so we can confirm your booking.",
                    )}
                  </p>
                )}
              </div>
            </div>

            {/* ── ONE optional disclosure: occasion + notes + allergies ──
                Default closed. A single quiet toggle keeps the form short;
                the kitchen-relevant fields are an invite, never a barrier. */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
              {!detailsOpen ? (
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  aria-expanded="false"
                  className="w-full min-h-[44px] sm:min-h-0 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                >
                  {t("rsvpAddNote", "Add a message or special request (optional)")}
                </button>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="rsvp-occasion"
                      className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                    >
                      {t("rsvpOccasion", "Anledning (valgfrit)")}
                    </label>
                    <Input
                      id="rsvp-occasion"
                      size="md"
                      value={occasion}
                      onChange={(e) => setOccasion(e.target.value)}
                      placeholder={t("rsvpOccasionPh", "Fødselsdag, jubilæum…")}
                      maxLength={60}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="rsvp-notes"
                      className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                    >
                      {t("rsvpNotes", "Besked til stedet (valgfrit)")}
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
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3 py-2 text-sm focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500"
                    />
                  </div>

                  {/* Allergy sub-block (invite, not require) — only when the
                      venue type defines an allergen set. */}
                  {allergenSet.length > 0 && (
                    <div className="space-y-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                      <div className="pt-3">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {t("rsvpAllergyTitle", "Allergier eller kost (valgfrit)")}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {t(
                            "rsvpAllergyHint",
                            "Helt valgfrit — det hjælper køkkenet med at tage hensyn.",
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {allergenSet.map((a) => (
                          <Chip
                            key={a.key}
                            size="sm"
                            selected={allergenTags.includes(a.key)}
                            onClick={() => toggleAllergen(a.key)}
                          >
                            {t(`allergen_${a.key}`, a.en)}
                          </Chip>
                        ))}
                      </div>
                      <div>
                        <label
                          htmlFor="rsvp-severity"
                          className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                        >
                          {t("rsvpSeverity", "Hvor alvorligt?")}
                        </label>
                        <select
                          id="rsvp-severity"
                          value={allergySeverity}
                          onChange={(e) => setAllergySeverity(e.target.value)}
                          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 h-10 text-sm focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500"
                        >
                          {SEVERITY_KEYS.map((s) => (
                            <option key={s} value={s}>
                              {t(`rsvpSeverity_${s}`, severityFallback(s))}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="rsvp-allergy-note"
                          className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                        >
                          {t("rsvpAllergyNote", "Uddyb (valgfrit)")}
                        </label>
                        <textarea
                          id="rsvp-allergy-note"
                          value={allergyNote}
                          onChange={(e) => setAllergyNote(e.target.value)}
                          placeholder={t(
                            "rsvpAllergyNotePh",
                            "F.eks. svær nøddeallergi — ingen spor af nødder.",
                          )}
                          rows={2}
                          maxLength={2000}
                          className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3 py-2 text-sm focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Marketing consent — default OFF (GDPR) */}
            <div className="space-y-1.5">
              <Chip
                selected={consentMarketing}
                onClick={() => setConsentMarketing((v) => !v)}
                size="md"
                iconLeft={
                  consentMarketing ? <CheckCircle2 size={14} strokeWidth={2} /> : null
                }
              >
                {t("rsvpMarketing", "Send mig nyheder og tilbud")}
              </Chip>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                {t(
                  "rsvpMarketingHint",
                  "Valgfrit. Du modtager altid din reservationsbekræftelse; dette dækker kun nyhedsbreve.",
                )}
              </p>
            </div>

            {/* GDPR — a calm data-use line right by the submit action. */}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                "rsvpPrivacyLine",
                "We only use your details for this reservation.",
              )}
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
      </div>

      {/* ── Sticky bottom CTA ───────────────────────────────────────── */}
      <div
        className="fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)" }}
      >
        <div className="max-w-md mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          {step === 2 && (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                setStep(1);
                setSubmitError("");
              }}
            >
              {t("rsvpBack", "Tilbage")}
            </Button>
          )}
          {step === 1 ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => setStep(2)}
              disabled={!groupRequest && !slot}
              className="flex-1"
            >
              {groupRequest
                ? // Group request — set the "we'll send a request" mental
                  // model on step 1 already.
                  t("rsvpSendRequest", "Send forespørgsel →")
                : slot
                  ? // CTA echoes the picked time: "Fortsæt · 19:00 →".
                    t("rsvpCtaWithTime", "Continue · {time} →", { time: slot })
                  : // No slot yet → the button is disabled; make its label the
                    // instruction so the greyed CTA guides instead of dead-ending.
                    t("rsvpPickTimeCta", "Vælg et tidspunkt")}
            </Button>
          ) : (
            <Button
              variant="accent"
              size="lg"
              onClick={onSubmit}
              busy={submitting}
              disabled={!canSubmit}
              className="flex-1"
            >
              {groupRequest
                ? t("rsvpSendRequest", "Send forespørgsel →")
                : isProvider
                  ? t("rsvpConfirmTime", "Bekræft tidsbestilling →")
                  : t("rsvpConfirm", "Bekræft reservation →")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
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

function ClosedScreen({ t, name }) {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-16">
      <div className="max-w-md mx-auto text-center">
        <Calendar
          size={40}
          strokeWidth={1.5}
          className="text-gray-400 mx-auto mb-3"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {name
            ? t("rsvpClosedNamed", "{name} tager ikke imod reservationer", { name })
            : t("rsvpClosed", "Tager ikke imod reservationer")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            "rsvpClosedHint",
            "Prøv igen senere, eller kontakt stedet direkte for at booke et bord.",
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
    default:
      return t("rsvpErrGeneric", "Noget gik galt. Prøv igen om et øjeblik.");
  }
}
