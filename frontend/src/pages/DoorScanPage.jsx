// DoorScanPage — organizer's PWA camera door-scan surface.
//
// Route: /scan (registered by Claude in App.jsx via a follow-up — this
// file owns ONLY the page implementation).
//
// What the owner sees:
//   1. No event picked → list of upcoming events (today + tomorrow).
//   2. Event picked, scanner idle → big "Start scanner" CTA + scan stats.
//   3. Scanner active → camera preview + last-5 scan results + stop CTA.
//
// Multi-barrier 10-layer hooks live throughout:
//   L1   — Permission denial path explained in DK + iOS settings link.
//   L4   — Wrong-event QR rejected client-side before server hit.
//   L7   — Server is the source of truth for sig verification.
//   L8   — Every server response (200/409/410/4xx) drives a flash card.
//          A 200 is NOT automatically a welcome: the endpoint is idempotent
//          and answers a re-scan with 200 {status:"already"}. Only
//          status "ok" (a FIRST scan) gets the success card, chime and
//          haptic; "already" gets its own amber warning (different sound,
//          warning haptic) so a reused/shared ticket can't pass as new.
//          No exceptions: EVERY "already" is the amber "Allerede scannet kl.
//          {time}" card, even right after this device's own "ok" or after a
//          POST whose answer was lost. Telling "the same guest re-presenting"
//          from "a shared or passed-back ticket" by time windows let reuse
//          through each time it was tried, so the page doesn't guess. Only
//          "ok" moves the scanned count.
//   L10  — Honest copy: "Allerede scannet kl. {time}" / "Refunderet" /
//          "Billetten er ikke bekræftet" (the 409 is booking_not_confirmed,
//          never "already scanned").
//
// Camera strategy (per spec):
//   Capacitor native (iOS/Android) → still use the WebView's getUserMedia
//   because Capacitor 8's @capacitor/camera SDK is a still-photo picker
//   (one-shot), NOT a continuous live preview suitable for QR scanning.
//   The CameraPreview plugin (community) would add a native dep that
//   isn't already in package.json and the brief says "don't add native
//   iOS-only deps that break web builds." So one code path for both web
//   and native: getUserMedia inside the WebView. Capacitor 8 supports
//   this on iOS 14+ and Android 9+ — confirmed against the docs.
//
// jsQR is the scan engine. Imported at module top so the bundle pays the
// ~45 KB gzip cost once on /scan page load (acceptable — this page is
// only opened mid-event, not on every visit).
//
// DK terminology lock honored: "Arrangement" (DK noun), "DØR-SCAN"
// eyebrow, scanner copy stays Danish-first with EN fallbacks via t().

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Camera as CameraIcon, X, ArrowLeft, AlertTriangle, Check, Gift, Calendar, Ticket, QrCode } from "lucide-react";
import jsQR from "jsqr";

import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { useActivation } from "../hooks/useActivation";
import { platform } from "../utils/platform";
import { haptic } from "../utils/haptics";
import { formatKr, parseMoneyInput } from "../utils/currency";
import { parseServerTime } from "../utils/serverTime";

import PageShell from "../components/ui/PageShell";
import PageHeader from "../components/ui/PageHeader";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Empty from "../components/ui/Empty";
import SectionBanner from "../components/ui/SectionBanner";
import MoneyField from "../components/ui/MoneyField";

// ── Constants ────────────────────────────────────────────────────────
// Scan debounce — SLIDING and PER QR. Every repeat read of a QR pushes its
// own window out again, so a guest holding the phone up for 20 s is posted
// once, and two tickets alternating in frame are each posted once; a QR has
// to be out of view for this long before it is submitted again.
const SCAN_DEBOUNCE_MS = 3000;
// How long one scan POST may take. The api instance waits 60 s (sized for
// slow uploads); at the door a hung request would leave the host with no
// card and the ticket locked by the in-flight guard for a minute. After
// this the page says "Ingen forbindelse — scan billetten igen" and the
// ticket can be posted again. A POST is never auto-replayed on a timeout
// (api.js only re-sends a POST on 503), so this can't double-submit.
const SCAN_POST_TIMEOUT_MS = 8000;
// Last-N visible scan history — keeps the flash log readable at the door.
const MAX_HISTORY = 5;
// Camera scan frame interval — using rAF gives us ~60 FPS which is more
// than enough for QR detection; we still throttle the heavy jsQR call to
// every other frame to keep CPU under control on older phones.
const SCAN_THROTTLE_EVERY_N_FRAMES = 2;

// ── Audio helpers ────────────────────────────────────────────────────
// Soft Web Audio note for success / low hum for failure. No extra audio
// dependencies — generated programmatically. Safari iOS requires the
// AudioContext be created on a user-gesture (handled by initing it
// inside the "Start scanner" click handler).
//
// 12 Oct 2026: the old 880 Hz blip and 220 Hz square buzz were part of the
// set Manoj found "a bit high, irritating"; he chose the softest option.
// Success is now a warm 440 Hz note built like the stand's mallet chime
// (utils/sound.js), failure a low 174.61 Hz sine — still unmistakably
// different, neither one a square wave. Pinned by __tests__/soundSet.test.js.
const DOOR_WARM = [[1, 1, 1], [2, 0.1, 0.5], [3, 0.03, 0.3]]; // [mult, amp, ringFactor]
function makeAudioFeedback() {
  let ctx = null;
  const init = () => {
    if (ctx) return ctx;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      return ctx;
    } catch { return null; }
  };
  // One soft note: sine partials each ringing out on `ring * ringFactor`
  // (counted from the strike), a short rise instead of a click, and a 40 ms
  // ease to silence at the end. `type` keeps the scanner's two-note
  // "already scanned" warning (triangle, never like the chime); `delay`
  // schedules a note later on the context clock, so a pattern needs no timers.
  const beep = (freq, duration, volume, ring, { attack = 0.012, partials = [[1, 1, 1]], type = "sine", delay = 0 } = {}) => {
    const c = ctx;
    if (!c) return;
    try {
      const t0 = c.currentTime + delay;
      const fadeAt = t0 + Math.max(attack, duration - 0.04);
      for (const [mult, amp, ringFactor] of partials) {
        const tau = ring * ringFactor;
        const peak = volume * amp;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type;
        osc.frequency.value = freq * mult;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peak * Math.exp(-attack / tau), t0 + attack);
        gain.gain.setTargetAtTime(0, t0 + attack, tau);
        gain.gain.setValueAtTime(peak * Math.exp(-(fadeAt - t0) / tau), fadeAt);
        gain.gain.linearRampToValueAtTime(0, t0 + duration);
        osc.connect(gain).connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + duration + 0.02);
      }
    } catch { /* audio errors should never break the scan loop */ }
  };
  return {
    init,
    success: () => beep(440, 0.5, 0.06, 0.2, { partials: DOOR_WARM }),
    // Already scanned: two short mid tones. Must never sound like the
    // single welcome note — the host may not be looking at the screen.
    warning: () => {
      beep(523, 0.09, 0.07, 0.05, { type: "triangle" });
      beep(523, 0.09, 0.07, 0.05, { type: "triangle", delay: 0.16 });
    },
    failure: () => beep(174.61, 0.25, 0.05, 0.05, { attack: 0.01 }),
  };
}

// ── JWT payload sniffer ──────────────────────────────────────────────
// QR text is a signed JWT (header.payload.sig). We parse the payload's
// `eid` early so a wrong-event scan can be rejected without a server
// round-trip. The server still does the real sig verification — this is
// L4 optimization only, never a security claim.
function decodeQrPayload(qrText) {
  if (typeof qrText !== "string") return null;
  const parts = qrText.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64 → atob
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, "=");
    const json = atob(b64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Format a timestamp into HH:mm (device-local) for the
// "Allerede scannet kl. 19.48" copy and the flash-card clock.
// The server's scanned_at is naive UTC (utils/serverTime.js); the history's
// own `at` stamps carry a Z and pass through unchanged.
function formatTimeShort(iso) {
  const d = parseServerTime(iso);
  if (!d) return "";
  try {
    return d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Today/tomorrow window in the user's local timezone. We accept any
// event whose date string equals today's or tomorrow's YYYY-MM-DD.
function isTodayOrTomorrow(eventDateStr) {
  if (!eventDateStr) return false;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return eventDateStr === fmt(today) || eventDateStr === fmt(tomorrow);
}

// ── Orientation lock ─────────────────────────────────────────────────
// Best-effort portrait lock while scanner is active. Wrapped in try/catch
// because the API is not universally supported (Safari iOS as of 17 still
// rejects this). Quiet failure: scanner still works in landscape, just
// looks worse.
async function lockPortrait() {
  try {
    if (typeof screen !== "undefined" && screen.orientation?.lock) {
      await screen.orientation.lock("portrait");
    }
  } catch { /* unsupported / not in fullscreen → quiet */ }
}
function unlockPortrait() {
  try {
    if (typeof screen !== "undefined" && screen.orientation?.unlock) {
      screen.orientation.unlock();
    }
  } catch { /* ignore */ }
}

// Switch a camera stream off (the camera light goes out). Never throws.
function stopTracks(stream) {
  try {
    stream?.getTracks().forEach((tr) => tr.stop());
  } catch { /* ignore */ }
}

// ── Camera availability detection ────────────────────────────────────
// If the device has zero video inputs (desktop without webcam), the
// brief says to hide the start button entirely. We probe via
// enumerateDevices, which returns empty labels until permission is
// granted but still tells us the kind=videoinput.
async function hasCameraInput() {
  try {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return false;
    const devices = await md.enumerateDevices();
    return devices.some((d) => d.kind === "videoinput");
  } catch { return false; }
}

// ── UpcomingEventsList — picker when no event selected ───────────────
function UpcomingEventsList({ events, loading, onPick, t }) {
  const upcoming = useMemo(
    () => (events || []).filter((e) => isTodayOrTomorrow(e.event_date)),
    [events],
  );
  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-20 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (upcoming.length === 0) {
    return (
      <Card variant="subtle">
        <Empty
          icon={Calendar}
          title={t("scanNoUpcomingTitle", "Ingen arrangementer i dag eller i morgen")}
          body={t(
            "scanNoUpcomingBody",
            "Når du har et arrangement der starter inden for de næste 24 timer, dukker det op her.",
          )}
          cta={
            <Link
              to="/events"
              className="inline-flex h-9 min-h-[44px] sm:min-h-0 items-center justify-center px-3.5 text-sm font-medium rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {t("openEvents", "Åbn arrangementer")}
            </Link>
          }
        />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {upcoming.map((ev) => (
        <Card key={ev.id} onClick={() => onPick(ev)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {ev.name}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block" />
                  {ev.event_date}
                </span>
                {ev.venue && <span className="ml-2">· {ev.venue}</span>}
              </p>
            </div>
            <span className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
              {t("scanPick", "Vælg")} →
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── ScanFlashCard — one row in the last-5 result log ────────────────
// Doctrine: neutral card surface + colored icon carries the success /
// failure signal. SectionBanner is the canonical primitive for this
// shape, but we want a denser layout (timestamp on the right) so we
// hand-roll the markup using the *neutral* doctrine palette. The icon
// is the only colored pixel per the doctrine "color is signal" rule.
function ScanFlashCard({ entry }) {
  const ok = entry.kind === "success";
  // "warning" = ticket already scanned. Not a welcome and not a broken QR:
  // the host has to look at the guest. The one entry kind that tints its
  // border + icon amber, so it can't be mistaken for either neighbour.
  const warn = entry.kind === "warning";
  // gray-50/gray-200 neutral surface — same recipe as Card primitive.
  // Doctrine line: "context callouts neutral block + colored icon prefix".
  return (
    <div
      data-scan-kind={entry.kind}
      className={`rounded-xl border bg-white dark:bg-gray-900 p-3 ${
        warn
          ? "border-amber-400 dark:border-amber-500/70"
          : "border-gray-200 dark:border-gray-800"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0" aria-hidden="true">
          {ok ? (
            <Check size={18} strokeWidth={2.25} className="text-gray-700 dark:text-gray-200" />
          ) : warn ? (
            <AlertTriangle size={18} strokeWidth={2.25} className="text-amber-600 dark:text-amber-400" />
          ) : (
            <AlertTriangle size={18} strokeWidth={2.25} className="text-gray-700 dark:text-gray-200" />
          )}
        </div>
        {/* Status dot — green for success, amber for already-scanned, red
            for error. Tracks the doctrine "● Paid" status-pill pattern. */}
        <span
          className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${
            ok ? "bg-emerald-500" : warn ? "bg-amber-500" : "bg-red-500"
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {/* Two lines, not one: at 375 px a one-line title cut its own
              instruction off ("Ingen forbindelse — scan billette…",
              "Siden er udløbet — genindlæs si…"). */}
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2 break-words">
            {entry.title}
          </p>
          {entry.subtitle && (
            <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5 truncate">
              {entry.subtitle}
            </p>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
          {formatTimeShort(entry.at)}
        </span>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────
// ── Gavekort scan helpers ──────────────────────────────────────────────
// A gavekort QR encodes the public URL ".../g/BB1.G.<jwt>". Pull the bare
// envelope out of whatever the camera read (URL, raw envelope) so the door
// scanner can route it to redeem instead of the ticket path. Tolerant — the
// server re-verifies; this is just a client-side family hint.
function extractGavekortToken(qrText) {
  if (typeof qrText !== "string") return null;
  const s = qrText.trim();
  if (s.includes("/g/")) {
    const tail = s.split("/g/").pop().split("?")[0].split("#")[0];
    try {
      const dec = decodeURIComponent(tail);
      if (dec.startsWith("BB1.G.")) return dec;
    } catch {
      /* fall through */
    }
    if (tail.startsWith("BB1.G.")) return tail;
  }
  if (s.startsWith("BB1.G.")) return s;
  return null;
}

function gkKr(minor) {
  if (minor == null || Number.isNaN(minor)) return "—";
  return formatKr(minor / 100);
}

// da-DK, not the account currency: this is the Danish gavekort door scanner
// end to end — every amount it prints goes through formatKr.
const GK_SCAN_LOCALE = "da-DK";

function gkMinorFromInput(value) {
  if (value === "" || value == null) return null;
  // parseMoneyInput, not `.replace(",", ".")` + parseFloat. That swap turned
  // "1.234,56" into "1.234.56", which parseFloat reads as 1.234 — so a
  // 1.234,56 kr redemption debited 1,23 kr and told the host it had worked.
  const n = parseMoneyInput(value, GK_SCAN_LOCALE);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function gkIdemKey() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `gkscan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// The redeem sheet — opens when a gavekort QR is scanned. Honesty lock: the
// scan READ the balance; this is the separate, deliberate REDEEM tap. Owner
// enters/confirms the amount → one debit. Reuses the redeem-by-id endpoint.
function GavekortRedeemSheet({ t, card, onClose, onRedeemed }) {
  const balance = card?.balance_minor ?? 0;
  const [amount, setAmount] = useState(String((balance / 100).toFixed(2)).replace(/\.00$/, ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idemRef = useRef(gkIdemKey());

  const minor = gkMinorFromInput(amount);
  const canSubmit = !busy && minor != null && minor <= balance;

  const redeem = async () => {
    setError("");
    const amt = gkMinorFromInput(amount);
    if (amt == null) {
      setError(t("gkScanAmountRequired", "Indtast et beløb større end 0."));
      return;
    }
    if (amt > balance) {
      setError(t("gkScanTooMuch", "Beløbet overstiger saldoen ({saldo}).", { saldo: gkKr(balance) }));
      return;
    }
    setBusy(true);
    try {
      const res = await api.post(
        `/gavekort/${card.id}/redeem`,
        { amount_minor: amt, idempotency_key: idemRef.current },
        { headers: { "Idempotency-Key": idemRef.current } },
      );
      const newBalance = res?.data?.balance_minor;
      onRedeemed({
        kind: "success",
        title: t("gkScanRedeemed", "Indløst {amount}", { amount: gkKr(amt) }),
        subtitle:
          newBalance != null
            ? t("gkScanNewBalance", "Ny saldo {saldo}", { saldo: gkKr(newBalance) })
            : null,
        at: new Date().toISOString(),
      });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) setError(t("gkScanInsufficient", "Ikke nok saldo. Indløsning afvist."));
      else if (status === 410) setError(t("gkScanGone", "Gavekortet kan ikke indløses."));
      else setError(t("gkScanRedeemFailed", "Kunne ikke indløse. Prøv igen."));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full sm:max-w-sm bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl p-5 space-y-4"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-900 dark:bg-gray-800 text-white">
            <Gift className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {t("gkScanEyebrow", "Indløs gavekort")}
            </p>
            <p className="text-2xl font-bold tabular-nums leading-tight text-gray-900 dark:text-gray-100">
              {gkKr(balance)}
            </p>
          </div>
        </div>

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("gkScanAmountLabel", "Beløb at indløse")}
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            {/* TEXT: a number input on an English-locale browser takes
                "1.500,50" and hands back "1.50050" with no error at all. */}
            <MoneyField
              locale={GK_SCAN_LOCALE}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              wrapperClassName="flex-1"
              className="w-full rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-lg tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100"
              aria-label={t("gkScanAmountLabel", "Beløb at indløse")}
            />
            <button
              type="button"
              onClick={() => setAmount(String((balance / 100).toFixed(2)).replace(/\.00$/, ""))}
              className="text-sm font-medium text-gray-600 dark:text-gray-300 underline underline-offset-2"
            >
              {t("gkScanAll", "Hele saldoen")}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="ghost" size="lg" onClick={onClose} className="flex-1">
            {t("gkScanCancel", "Annullér")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            busy={busy}
            disabled={!canSubmit}
            onClick={redeem}
            className="flex-1 justify-center"
          >
            {minor != null
              ? `${t("gkScanRedeemCta", "Indløs")} ${gkKr(minor)}`
              : t("gkScanRedeemCta", "Indløs")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function DoorScanPage() {
  const { t } = useLanguage();
  const { user } = useAuth(); // eslint-disable-line no-unused-vars
  // USAGE GATE — an owner who has never created an event doesn't have Events
  // in their nav, so the ticket-scanning tile here would be the one remaining
  // door into it. usageKnownDormant (not usageDormantPillars) on purpose: the
  // tile must never vanish from under a finger while /activation is loading.
  const { usageKnownDormant } = useActivation();
  const eventsUsageHidden = usageKnownDormant.has("events");

  // ── Event picker state ─────────────────────────────────────────────
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);
  // Scan mode: 'ticket' (default event-ticket flow) or 'gavekort' (redeem a
  // gift-card QR with NO event — reachable from the no-event landing so a
  // salon/café that sells gavekort but runs no ticketed events can still scan).
  // Deep-link: /scan?mode=gavekort lands straight in gavekort mode (the
  // "Indløs gavekort" button on the Gavekort page uses it) — so a gavekort-
  // only venue arrives on the "ready to redeem" screen, one tap from the
  // camera, instead of the two-tile chooser. We land on the idle screen (not
  // auto-firing the camera) because getUserMedia needs a real tap gesture,
  // which the "Start scanner" button on that screen provides.
  const [scanMode, setScanMode] = useState(() =>
    new URLSearchParams(window.location.search).get("mode") === "gavekort"
      ? "gavekort"
      : "ticket",
  );
  // Reveal for the event-picker on the no-event landing (behind "Scan billetter").
  const [ticketPickerOpen, setTicketPickerOpen] = useState(false);

  // ── Camera + scanner state ─────────────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [cameraSupported, setCameraSupported] = useState(true);
  const [history, setHistory] = useState([]); // last MAX_HISTORY scan results
  const [stats, setStats] = useState({ scanned: 0, capacity: null });

  // ── Refs for the scan loop ─────────────────────────────────────────
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const frameCountRef = useRef(0);
  // Debounce: QR text → { until, slide }. Repeated reads of a QR are ignored
  // and (while slide) push its `until` out; see SCAN_DEBOUNCE_MS.
  const recentReadsRef = useRef(new Map());
  // Ticket ids with a scan POST still waiting for its answer (at most
  // SCAN_POST_TIMEOUT_MS). A second read of the same ticket is dropped until
  // that answer — or the timeout — is in.
  const inFlightRef = useRef(new Set());
  const audioRef = useRef(null);
  // The camera start answers long after the tap that began it, so it reads
  // the mode and the chosen event from these mirrors (what the page shows
  // NOW), not from the values its closure captured at the tap.
  const scanModeRef = useRef(scanMode);
  const selectedEventRef = useRef(selectedEvent);
  useEffect(() => { scanModeRef.current = scanMode; }, [scanMode]);
  useEffect(() => { selectedEventRef.current = selectedEvent; }, [selectedEvent]);

  // ── Gavekort redeem sheet ──────────────────────────────────────────
  // When a gavekort QR is scanned we open a redeem sheet (show-then-redeem).
  // gkOpenRef pauses the scan tick while it's up so the same code isn't
  // re-resolved behind the modal.
  const [gkSheet, setGkSheet] = useState(null);
  const gkOpenRef = useRef(false);
  const closeGkSheet = useCallback(() => {
    gkOpenRef.current = false;
    setGkSheet(null);
  }, []);

  // ── Fetch organizer events on mount ────────────────────────────────
  useEffect(() => {
    let alive = true;
    setEventsLoading(true);
    api
      .get("/events", { params: { sort: "date_desc" } })
      .then((r) => {
        if (alive) setEvents(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {
        if (alive) setEvents([]);
      })
      .finally(() => {
        if (alive) setEventsLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // ── Probe for camera input once on mount ───────────────────────────
  useEffect(() => {
    let alive = true;
    hasCameraInput().then((has) => {
      if (alive) setCameraSupported(has);
    });
    return () => { alive = false; };
  }, []);

  // ── When an event is picked, fetch its current scan stats ──────────
  useEffect(() => {
    if (!selectedEvent?.id) {
      setStats({ scanned: 0, capacity: null });
      return;
    }
    let alive = true;
    api
      .get(`/events/${selectedEvent.id}/summary`)
      .then((r) => {
        if (!alive) return;
        const data = r.data || {};
        setStats({
          scanned: Number(data.scanned_count || data.attended_count || 0),
          capacity: data.capacity_total ?? selectedEvent.capacity_total ?? null,
        });
      })
      .catch(() => { /* leave defaults — scan endpoint will still work */ });
    return () => { alive = false; };
  }, [selectedEvent]);

  // ── Push a flash entry to the last-N list ──────────────────────────
  const pushHistory = useCallback((entry) => {
    setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY));
  }, []);

  // ── Server scan handler ────────────────────────────────────────────
  // tid = ticket id parsed from JWT payload. We send the full QR text so
  // the backend can re-verify the signature; client-side parse is purely
  // a UX optimization for the wrong-event short-circuit.
  const submitScan = useCallback(async (qrText, parsed) => {
    // ── Gavekort QR? Resolve the card + open the redeem sheet. The scan only
    // READS the balance — the actual debit is the deliberate tap in the sheet.
    if (extractGavekortToken(qrText)) {
      try {
        const res = await api.post("/gavekort/scan-resolve", { token: qrText });
        gkOpenRef.current = true; // pause the loop while the sheet is up
        setGkSheet(res.data);
        if (audioRef.current) audioRef.current.success();
        haptic.success();
      } catch (err) {
        const status = err?.response?.status;
        let title;
        if (status === 410) title = t("gkScanGone", "Gavekortet kan ikke indløses");
        else if (status === 404) title = t("gkScanNotYours", "Ukendt gavekort");
        else if (status === 503) title = t("gkScanUnconfigured", "Gavekort er midlertidigt utilgængeligt");
        else title = t("gkScanFailed", "Kunne ikke læse gavekortet");
        pushHistory({ kind: "error", title, at: new Date().toISOString() });
        if (audioRef.current) audioRef.current.failure();
        haptic.error();
      }
      return;
    }

    const tid = parsed?.tid || parsed?.sub;
    if (!tid) {
      pushHistory({
        kind: "error",
        title: t("scanInvalidQr", "Ugyldig QR-kode"),
        at: new Date().toISOString(),
      });
      if (audioRef.current) audioRef.current.failure();
      haptic.error();
      return;
    }
    const whoLine = (data) => [
      data?.customer_name,
      data?.tier_label,
      data?.booking_id ? `#${String(data.booking_id).slice(0, 8)}` : null,
    ].filter(Boolean).join(" · ");
    // Already scanned → amber warning: own sound, warning haptic, and the
    // scanned count does NOT move (the guest was counted the first time).
    // Always, whoever let the ticket in and however recently: the server's
    // time is on the card, and the host decides at the door.
    const flagAlreadyScanned = (scannedAt, data) => {
      const when = formatTimeShort(scannedAt);
      const who = whoLine(data);
      pushHistory({
        kind: "warning",
        title: when
          ? t("scanAlreadyScannedAt", "Allerede scannet kl. {time}", { time: when })
          : t("scanAlreadyScanned", "Allerede scannet"),
        subtitle: who || t("scanAlreadyScannedBody", "Billetten er brugt før — tjek gæsten"),
        at: new Date().toISOString(),
      });
      if (audioRef.current) audioRef.current.warning();
      haptic.warning();
    };
    const flagError = (title, subtitle = null) => {
      pushHistory({ kind: "error", title, subtitle, at: new Date().toISOString() });
      if (audioRef.current) audioRef.current.failure();
      haptic.error();
    };
    // The error card asks for another try. If the guest keeps holding the
    // QR up, let that retry fire once the debounce window runs out instead
    // of waiting for the QR to leave the frame (the sliding window would
    // otherwise hold it for as long as it stays in view).
    const allowRetryWhileHeld = () => {
      const read = recentReadsRef.current.get(qrText);
      if (read) read.slide = false;
    };

    // One POST per ticket at a time: while this ticket's answer is pending,
    // another read of it (the QR left the frame and came back) sends nothing.
    if (inFlightRef.current.has(tid)) return;
    inFlightRef.current.add(tid);
    try {
      const res = await api.post(
        `/tickets/${tid}/scan`,
        { qr: qrText },
        // _noRetry: api.js would otherwise re-send a timed-out or 5xx POST
        // up to 4 times (~26 s+), holding this ticket's in-flight guard with
        // no card on screen. The page retries by itself while the QR is
        // still held (allowRetryWhileHeld), so one attempt is enough.
        { timeout: SCAN_POST_TIMEOUT_MS, _noRetry: true },
      );
      const data = res?.data || {};
      // The endpoint is idempotent: a re-scan is a 200 too, with
      // status "already". Only "ok" — a first scan — is a welcome.
      if (data.status === "already") {
        flagAlreadyScanned(data.scanned_at, data);
        return;
      }
      if (data.status !== "ok") {
        // Fail closed: an outcome this page doesn't know is never a welcome.
        if (data.status === "void") flagError(t("scanRefunded", "Billet ugyldig — refunderet"));
        else if (data.status === "wrong_event") flagError(t("scanWrongEvent", "Forkert arrangement"));
        else flagError(t("scanGenericError", "Scan mislykkedes — prøv igen"));
        return;
      }
      pushHistory({
        kind: "success",
        title: data.customer_name || t("scanSuccess", "Velkommen"),
        subtitle: [data.tier_label, data.booking_id ? `#${String(data.booking_id).slice(0, 8)}` : null]
          .filter(Boolean).join(" · ") || t("scanAccepted", "Billet bekræftet"),
        at: new Date().toISOString(),
      });
      // The only place a TICKET scan raises the count (a gavekort redeemed
      // at the door also adds one, in GavekortRedeemSheet's onRedeemed).
      setStats((s) => ({ ...s, scanned: (s.scanned || 0) + 1 }));
      if (audioRef.current) audioRef.current.success();
      haptic.success();
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const rawDetail = body?.detail;
      const detail = rawDetail || body?.message;
      let title;
      let subtitle = null;
      if (!err?.response && (err?.isAxiosError || err?.request)) {
        // No HTTP answer at all (offline, DNS, or SCAN_POST_TIMEOUT_MS ran
        // out). We can't know if the scan landed, so say what to do — not
        // what happened. If it did land, the next scan answers "already"
        // and gets the amber card like any other re-scan.
        title = t("scanNetworkError", "Ingen forbindelse — scan billetten igen");
        allowRetryWhileHeld();
      } else if (status === 409 && rawDetail?.error === "booking_not_confirmed") {
        // The 409 this endpoint sends is an unconfirmed BOOKING (pending /
        // cancelled / expired), not a repeat scan.
        title = t("scanNotConfirmed", "Billetten er ikke bekræftet");
        subtitle = rawDetail?.current_status === "pending"
          ? t("scanNotConfirmedPending", "Betalingen er ikke registreret endnu")
          : null;
      } else if (status === 409 && (body?.scanned_at || rawDetail?.scanned_at)) {
        // Tolerated shape: a 409 that does carry a prior stamp IS a re-scan.
        flagAlreadyScanned(body?.scanned_at || rawDetail?.scanned_at, rawDetail || body);
        return;
      } else if (status === 410) {
        title = t("scanRefunded", "Billet ugyldig — refunderet");
      } else if (status === 404) {
        title = t("scanNotFound", "Billet findes ikke");
      } else if (status === 403) {
        // Not "wrong event": this endpoint answers another tenant's ticket
        // with 404 and the wrong-event check happens on the device before
        // any POST. A 403 comes from the session. Only the write guard's
        // code "read_only" (an accountant / team-member login: main.py
        // accountant_write_guard) means "this login can't scan". Every other
        // 403 here — the CSRF check's "Session expired", the origin guard —
        // is fixed by reloading, so say that instead of blaming the login.
        title = rawDetail?.code === "read_only"
          ? t("scanNoAccess", "Ingen adgang til scanning")
          : t("scanSessionExpired", "Siden er udløbet — genindlæs siden");
      } else if (typeof detail === "string" && detail.trim()) {
        title = detail;
      } else {
        title = t("scanGenericError", "Scan mislykkedes — prøv igen");
        subtitle = status ? `HTTP ${status}` : null;
      }
      // 429 / 5xx (a 503 has already been retried by api.js) are passing
      // trouble, and the card asks for another try — same as a network
      // error, the held QR retries by itself. A 4xx is the server's final
      // answer for this ticket: re-posting it while held would only repeat
      // the error tone every 3 s.
      if (status === 429 || status >= 500) allowRetryWhileHeld();
      flagError(title, subtitle);
    } finally {
      inFlightRef.current.delete(tid);
    }
  }, [pushHistory, t]);

  // ── jsQR scan tick (runs each rAF while scanner is active) ─────────
  // The tick function is stored in a ref so rAF can self-recurse without
  // capturing stale closures. We refresh that ref via useEffect so the
  // ref always points at the freshest closure (selectedEvent / submitScan
  // / etc.) without forcing a re-create of the stream-loop machinery.
  const tickRef = useRef(null);
  useEffect(() => {
    tickRef.current = () => {
      rafRef.current = requestAnimationFrame(() => {
        if (tickRef.current) tickRef.current();
      });
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

      // Throttle the actual jsQR call — runs every Nth frame so we
      // budget CPU on older devices.
      frameCountRef.current += 1;
      if (frameCountRef.current % SCAN_THROTTLE_EVERY_N_FRAMES !== 0) return;

      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      let imgData;
      try {
        imgData = ctx.getImageData(0, 0, w, h);
      } catch {
        // Tainted canvas — shouldn't happen with local stream but bail.
        return;
      }
      const code = jsQR(imgData.data, imgData.width, imgData.height, {
        inversionAttempts: "dontInvert",
      });
      if (!code?.data) return;

      // Gavekort redeem sheet is up → don't re-process scans behind it.
      if (gkOpenRef.current) return;

      const now = Date.now();
      const reads = recentReadsRef.current;
      const seen = reads.get(code.data);
      if (seen && now < seen.until) {
        // This QR is still in view: drop it, and slide its window so it only
        // reopens once the QR has been out of view for SCAN_DEBOUNCE_MS.
        if (seen.slide) seen.until = now + SCAN_DEBOUNCE_MS;
        return;
      }
      // Per-QR, so two tickets alternating in frame don't keep evicting each
      // other. Expired entries go now; the map holds only what's in view.
      for (const [text, r] of reads) if (now >= r.until) reads.delete(text);
      reads.set(code.data, { until: now + SCAN_DEBOUNCE_MS, slide: true });

      // Gavekort mode: only gavekort QRs are valid here. Reject anything else
      // (e.g. an event ticket) instead of falling through to the ticket path —
      // avoids an accidental door check-in while redeeming a gift card.
      if (scanMode === "gavekort" && !extractGavekortToken(code.data)) {
        pushHistory({
          kind: "error",
          title: t("gkScanNotGavekort", "Ikke et gavekort-QR"),
          at: new Date().toISOString(),
        });
        if (audioRef.current) audioRef.current.failure();
        haptic.error();
        return;
      }

      // A ticket scan needs the event at the door. startScanner never opens a
      // ticket scanner without one; this is the last line before the POST, so
      // no path can check in a ticket for "any event" (the server does not
      // check the event yet).
      if (scanMode !== "gavekort" && !selectedEvent?.id) return;

      // Client-side wrong-event short-circuit (L4 optimization). Never fires in
      // gavekort mode — a gift-card scan carries no event id to match against.
      const parsed = decodeQrPayload(code.data);
      if (scanMode !== "gavekort" && parsed?.eid && selectedEvent?.id && String(parsed.eid) !== String(selectedEvent.id)) {
        pushHistory({
          kind: "error",
          title: t("scanWrongEvent", "Forkert arrangement"),
          subtitle: t("scanWrongEventBody", "Denne billet er til et andet arrangement."),
          at: new Date().toISOString(),
        });
        if (audioRef.current) audioRef.current.failure();
        haptic.error();
        return;
      }

      submitScan(code.data, parsed);
    };
  }, [selectedEvent, submitScan, pushHistory, t, scanMode]);

  // ── Camera lifecycle ───────────────────────────────────────────────
  // Every start takes a number; every stop (unmount included) invalidates it.
  // getUserMedia can wait seconds on the permission prompt, and meanwhile
  // "Start scanner", "Tilbage" and "Skift arrangement" are all still live. A
  // start that answers after a stop or after a newer start switches its own
  // camera off and never opens the scanner. Otherwise the camera stays on
  // after Stop or after leaving the page, a double-tapped Start leaves a
  // second camera and frame loop running, or a ticket scanner comes up with
  // no event chosen and checks in tickets from any of the owner's events.
  const startGenRef = useRef(0);
  const startScanner = useCallback(async () => {
    const gen = ++startGenRef.current;
    setCameraError(null);
    // Audio context must be created on user gesture — this click counts.
    if (!audioRef.current) audioRef.current = makeAudioFeedback();
    audioRef.current?.init();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      // A stop or a newer start came first → this camera is not wanted.
      // Second, independent guard: a ticket scanner needs an event. If the
      // page is in ticket mode with none chosen by the time the camera
      // answers, whatever path led there, switch off instead of scanning.
      const cancelled = gen !== startGenRef.current;
      const ticketWithoutEvent = scanModeRef.current !== "gavekort" && !selectedEventRef.current;
      if (cancelled || ticketWithoutEvent) {
        stopTracks(stream);
        return;
      }
      // Never two cameras: end one still held (every start button sits
      // behind !scanning, so this is only a safety net; no test covers it).
      if (streamRef.current && streamRef.current !== stream) stopTracks(streamRef.current);
      streamRef.current = stream;
      // Normally null here: the preview <video> only mounts once scanning is
      // true, and the effect below attaches the stream then.
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play().catch(() => { /* autoplay may need user gesture */ });
        if (gen !== startGenRef.current) return; // stopped while play() was pending; stopScanner already ended the tracks
      }
      setScanning(true);
      lockPortrait();
      // One frame loop only: drop a frame still scheduled before starting.
      // Safety net like the one above: no button reaches it today, and no
      // test covers it.
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (tickRef.current) tickRef.current();
      });
    } catch (err) {
      if (gen !== startGenRef.current) return; // a cancelled start has nothing to report
      const name = err?.name || "";
      let key = "scanCameraGenericError";
      let fallback = "Kunne ikke åbne kameraet.";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        key = "scanCameraDenied";
        fallback = "Kamera-adgang nægtet. Åbn enhedens indstillinger og tillad kamera for BonBox.";
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        key = "scanNoCamera";
        fallback = "Ingen kamera fundet på denne enhed.";
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        key = "scanCameraBusy";
        fallback = "Kameraet er optaget af en anden app. Luk den og prøv igen.";
      }
      setCameraError({ key, fallback });
    }
  }, []);

  const stopScanner = useCallback(() => {
    startGenRef.current += 1; // cancels a start that is still waiting for the camera
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      stopTracks(streamRef.current);
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try { video.srcObject = null; } catch { /* ignore */ }
    }
    setScanning(false);
    unlockPortrait();
    recentReadsRef.current.clear();
    frameCountRef.current = 0;
  }, []);

  // ── Attach the stream AFTER the <video> exists ─────────────────────
  // The preview element is rendered behind `{scanning && …}`, so while
  // startScanner runs (scanning still false) videoRef.current is null. Before
  // this effect the element then mounted with no srcObject, readyState never
  // reached HAVE_ENOUGH_DATA and the jsQR tick returned on every frame: black
  // preview, no scans, no error. This runs in the commit where the node exists.
  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || video.srcObject === stream) return;
    video.srcObject = stream;
    video.setAttribute("playsinline", "true");
    video.play().catch(() => { /* autoplay may need a user gesture */ });
  }, [scanning]);

  // ── Gavekort scan entry ────────────────────────────────────────────
  // Opened from the no-event landing tile. No event needed — flip into
  // gavekort mode and open the SAME camera loop; submitScan routes a gavekort
  // QR straight to the redeem sheet (the scan only reads; the debit is the
  // deliberate second tap inside the sheet).
  const startGavekortScan = useCallback(() => {
    setCameraError(null);
    setHistory([]);
    setScanMode("gavekort");
    scanModeRef.current = "gavekort"; // the start below must already see gavekort mode
    startScanner();
  }, [startScanner]);

  // Leave gavekort mode back to the ticket landing (idle "back" action).
  // "Tilbage" is tappable while the camera is still starting: stopScanner
  // cancels that start, so it can't open a ticket scanner with no event.
  const exitGavekort = useCallback(() => {
    stopScanner();
    setScanMode("ticket");
    setCameraError(null);
  }, [stopScanner]);

  // Stop the camera and always return to the ticket landing.
  const handleStop = useCallback(() => {
    stopScanner();
    setScanMode("ticket");
  }, [stopScanner]);

  // Cleanup on unmount — never leave a hot camera behind.
  useEffect(() => () => stopScanner(), [stopScanner]);

  // ── Stats helpers ──────────────────────────────────────────────────
  const remaining = stats.capacity != null
    ? Math.max(0, stats.capacity - stats.scanned)
    : null;
  const progressLabel = stats.capacity != null
    ? t("scanProgress", "{scanned} / {capacity} scannet · {remaining} tilbage", {
        scanned: stats.scanned,
        capacity: stats.capacity,
        remaining,
      })
    : t("scanProgressNoCap", "{scanned} scannet", { scanned: stats.scanned });

  // ── Page header actions ────────────────────────────────────────────
  const headerActions = (
    <>
      {scanMode === "ticket" && selectedEvent && !scanning && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { stopScanner(); setSelectedEvent(null); setHistory([]); }}
          iconLeft={<ArrowLeft size={14} />}
        >
          {t("scanChangeEvent", "Skift arrangement")}
        </Button>
      )}
      {scanMode === "gavekort" && !scanning && (
        <Button
          variant="secondary"
          size="sm"
          onClick={exitGavekort}
          iconLeft={<ArrowLeft size={14} />}
        >
          {t("scanBack", "Tilbage")}
        </Button>
      )}
      {scanning && (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleStop}
          iconLeft={<X size={14} />}
        >
          {t("scanStop", "Stop scanner")}
        </Button>
      )}
    </>
  );

  // Camera-error banner — shared by the ticket-idle and gavekort-idle screens.
  const cameraErrorBanner = cameraError ? (
    <SectionBanner
      severity="critical"
      icon="AlertTriangle"
      title={
        cameraError.key === "scanCameraDenied"
          ? t("scanCameraDeniedTitle", "Kamera-adgang nægtet")
          : cameraError.key === "scanNoCamera"
            ? t("scanNoCameraTitle", "Ingen kamera fundet")
            : t("scanCameraErrorTitle", "Kunne ikke starte kameraet")
      }
    >
      <p>{t(cameraError.key, cameraError.fallback)}</p>
      {cameraError.key === "scanCameraDenied" && platform.isIOS && (
        <p className="mt-2 text-[12px] text-gray-600 dark:text-gray-400">
          {t(
            "scanCameraDeniedIosHint",
            "Gå til Indstillinger → BonBox → Kamera og slå adgang til.",
          )}
        </p>
      )}
    </SectionBanner>
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────
  // USAGE GATE, second half — the FRAMING has to follow the tiles.
  //
  // The ticket tile and the event picker are both suppressed below for an
  // events-hidden owner, which leaves the ticket-mode landing as nothing but
  // the gavekort tile. The header still said "Vælg arrangement" / "Tjek gæster
  // ind ved døren" — instructing an action the page no longer offers, on a
  // screen that is ONE tap away: every in-app door into /scan is
  // ?mode=gavekort (QuickAdd, GavekortPage — /scan is in neither the nav
  // manifest nor ⌘K), and both exitGavekort ("Tilbage") and handleStop ("Stop
  // scanner", fired after every gavekort scan) drop back into ticket mode.
  // So for that owner the landing wears the gavekort framing it actually has.
  // Reuses the two strings the gavekort mode already shows — no new key, and
  // the back/stop path now returns to a screen that reads the same as the one
  // it left. `selectedEvent` still wins: the gate never hides a chosen event.
  const gavekortOnlyLanding = eventsUsageHidden && !selectedEvent;
  const showGavekortFraming = scanMode === "gavekort" || gavekortOnlyLanding;
  return (
    <PageShell width="default">
      <PageHeader
        eyebrow={t("scanEyebrow", "DØR-SCAN")}
        title={
          showGavekortFraming
            ? t("gkScanEyebrow", "Indløs gavekort")
            : selectedEvent?.name || t("scanTitle", "Vælg arrangement")
        }
        subtitle={
          showGavekortFraming
            ? t("scanGavekortTileSub", "Scan et gavekort-QR")
            : selectedEvent
              ? `${selectedEvent.event_date}${selectedEvent.venue ? " · " + selectedEvent.venue : ""}`
              : t("scanTitleSubtitle", "Tjek gæster ind ved døren med en QR-scanning")
        }
        actions={headerActions}
      />

      {/* No event selected, ticket mode → landing with the entry tiles. The
          ticket tile is dropped for an owner the usage gate hides Events from
          (it leads to the event picker, whose empty state links to /events —
          a door back into a pillar we just took out of the nav). Gavekort
          redeem stays: it needs no event. */}
      {scanMode === "ticket" && !selectedEvent && !scanning && (
        <div className="space-y-3">
          {/* Tile 1 — Scan billetter → reveal the event picker below. */}
          {!eventsUsageHidden && (
            <Card onClick={() => setTicketPickerOpen(true)}>
              <div className="flex items-center gap-3">
                {/* Icon chips on this page are WELLS inside a <Card>. Their
                    dark value used to be gray-800, which is now the Card's own
                    colour (see the SURFACE LADDER block in index.css), so they
                    disappeared. The half-rung reads against a card AND against
                    the bare page. Light is unchanged. */}
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-100 dark:bg-[rgb(var(--surface-subtle))] text-gray-700 dark:text-gray-300">
                  <Ticket size={20} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t("scanTicketTileTitle", "Scan billetter")}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t("scanTicketTileSub", "Vælg et arrangement")}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Tile 2 — Indløs gavekort → open the camera in gavekort mode with
              NO event required. This is the fix: always reachable. */}
          <Card onClick={startGavekortScan}>
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-100 dark:bg-[rgb(var(--surface-subtle))] text-gray-700 dark:text-gray-300">
                <QrCode size={20} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {t("gkScanEyebrow", "Indløs gavekort")}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t("scanGavekortTileSub", "Scan et gavekort-QR")}
                </p>
              </div>
            </div>
          </Card>

          {/* Event picker: auto-revealed when events exist so a ticket
              organizer keeps the one-tap flow (list already showing under the
              tiles); a gavekort-only venue with no events sees just the tiles
              until it taps "Scan billetter". Suppressed entirely when the
              usage gate hides Events — its empty state is a /events link. */}
          {!eventsUsageHidden && (ticketPickerOpen || events?.length > 0) && (
            <UpcomingEventsList
              events={events}
              loading={eventsLoading}
              onPick={setSelectedEvent}
              t={t}
            />
          )}
        </div>
      )}

      {/* Event selected, scanner idle → big Start CTA */}
      {scanMode === "ticket" && selectedEvent && !scanning && (
        <>
          {cameraErrorBanner}

          <Card>
            <div className="flex flex-col items-center text-center py-4 sm:py-6">
              <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-[rgb(var(--surface-subtle))] flex items-center justify-center mb-4">
                <CameraIcon size={28} strokeWidth={1.75} className="text-gray-700 dark:text-gray-300" />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">{progressLabel}</p>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-5">
                {t("scanReadyTitle", "Klar til at scanne billetter")}
              </h2>
              {cameraSupported ? (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={startScanner}
                  iconLeft={<CameraIcon size={16} />}
                >
                  {t("scanStart", "Start scanner")}
                </Button>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("scanNoCamera", "Ingen kamera fundet på denne enhed.")}
                </p>
              )}
            </div>
          </Card>
        </>
      )}

      {/* Gavekort mode, scanner idle → start / retry / camera-error fallback.
          The tile auto-opens the camera; this screen is the retry surface if
          the camera failed to start (or isn't present on this device). */}
      {scanMode === "gavekort" && !scanning && (
        <>
          {cameraErrorBanner}

          <Card>
            <div className="flex flex-col items-center text-center py-4 sm:py-6">
              <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-[rgb(var(--surface-subtle))] flex items-center justify-center mb-4">
                <QrCode size={28} strokeWidth={1.75} className="text-gray-700 dark:text-gray-300" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t("scanGavekortReadyTitle", "Klar til at indløse gavekort")}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                {t("scanGavekortTileSub", "Scan et gavekort-QR")}
              </p>
              {cameraSupported ? (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={startScanner}
                  iconLeft={<CameraIcon size={16} />}
                >
                  {t("scanStart", "Start scanner")}
                </Button>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("scanNoCamera", "Ingen kamera fundet på denne enhed.")}
                </p>
              )}
            </div>
          </Card>
        </>
      )}

      {/* Scanner active → camera + flashes */}
      {scanning && (
        <div className="space-y-4">
          {/* Stats bar — ticket mode only (gavekort has no event capacity). */}
          {scanMode !== "gavekort" && (
            <Card variant="subtle">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 text-center tabular-nums">
                {progressLabel}
              </p>
            </Card>
          )}

          {/* Camera preview — the ONE place a dark surface is allowed (per doctrine spec) */}
          <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-black">
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              muted
              playsInline
              autoPlay
            />
            {/* Scan target overlay — just a rounded border, no gimmicks */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-3/5 h-3/5 rounded-xl border-2 border-white/70" />
            </div>
            {/* Hidden scratch canvas — jsQR reads pixels off this */}
            <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
          </div>

          {/* Last 5 scan results */}
          {history.length > 0 && (
            <div className="space-y-2" aria-live="polite" aria-atomic="false">
              {history.map((entry, i) => (
                <ScanFlashCard key={`${entry.at}-${i}`} entry={entry} />
              ))}
            </div>
          )}
          {history.length === 0 && (
            <p className="text-center text-sm text-gray-600 dark:text-gray-400 py-3">
              {scanMode === "gavekort"
                ? t("scanGavekortWaiting", "Hold et gavekort-QR foran kameraet.")
                : t("scanWaitingFirst", "Hold en billet-QR foran kameraet for at starte.")}
            </p>
          )}

          {/* Stop button at bottom — duplicate of header action for thumb reach */}
          <div className="pt-2">
            <Button
              variant="secondary"
              size="lg"
              onClick={handleStop}
              className="w-full"
              iconLeft={<X size={16} />}
            >
              {t("scanStop", "Stop scanner")}
            </Button>
          </div>
        </div>
      )}

      {gkSheet && (
        <GavekortRedeemSheet
          t={t}
          card={gkSheet}
          onClose={closeGkSheet}
          onRedeemed={(entry) => {
            pushHistory(entry);
            setStats((s) => ({ ...s, scanned: (s.scanned || 0) + 1 }));
            if (audioRef.current) audioRef.current.success();
            haptic.success();
            closeGkSheet();
          }}
        />
      )}
    </PageShell>
  );
}
