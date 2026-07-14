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
//   L10  — Honest copy: "Allerede scannet kl. {time}" / "Refunderet".
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
import { platform } from "../utils/platform";
import { haptic } from "../utils/haptics";
import { formatKr } from "../utils/currency";

import PageShell from "../components/ui/PageShell";
import PageHeader from "../components/ui/PageHeader";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Empty from "../components/ui/Empty";
import SectionBanner from "../components/ui/SectionBanner";

// ── Constants ────────────────────────────────────────────────────────
// Scan debounce — same QR within this window is silently dropped so a
// user holding the phone steady doesn't double-POST the scan endpoint.
const SCAN_DEBOUNCE_MS = 3000;
// Last-N visible scan history — keeps the flash log readable at the door.
const MAX_HISTORY = 5;
// Camera scan frame interval — using rAF gives us ~60 FPS which is more
// than enough for QR detection; we still throttle the heavy jsQR call to
// every other frame to keep CPU under control on older phones.
const SCAN_THROTTLE_EVERY_N_FRAMES = 2;

// ── Audio helpers ────────────────────────────────────────────────────
// Tiny Web Audio beep for success / buzz for failure. No extra audio
// dependencies — generated programmatically. Safari iOS requires the
// AudioContext be created on a user-gesture (handled by initing it
// inside the "Start scanner" click handler).
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
  const beep = (freq, duration, type = "sine", volume = 0.08) => {
    const c = ctx;
    if (!c) return;
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = volume;
      osc.connect(gain).connect(c.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.00001, c.currentTime + duration);
      osc.stop(c.currentTime + duration + 0.02);
    } catch { /* audio errors should never break the scan loop */ }
  };
  return {
    init,
    success: () => beep(880, 0.12, "sine", 0.06),
    failure: () => beep(220, 0.22, "square", 0.05),
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

// Format a timestamp into HH:mm for the "Already scanned kl. 19:48" copy.
function formatTimeShort(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
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
  // gray-50/gray-200 neutral surface — same recipe as Card primitive.
  // Doctrine line: "context callouts neutral block + colored icon prefix".
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0" aria-hidden="true">
          {ok ? (
            <Check size={18} strokeWidth={2.25} className="text-gray-700 dark:text-gray-200" />
          ) : (
            <AlertTriangle size={18} strokeWidth={2.25} className="text-gray-700 dark:text-gray-200" />
          )}
        </div>
        {/* Status dot is the only colored pixel — green for success, red
            for error. Tracks the doctrine "● Paid" status-pill pattern. */}
        <span
          className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-emerald-500" : "bg-red-500"}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
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

function gkMinorFromInput(value) {
  if (value === "" || value == null) return null;
  const n = parseFloat(String(value).trim().replace(/\s/g, "").replace(",", "."));
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
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-lg tabular-nums text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100"
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

  // ── Event picker state ─────────────────────────────────────────────
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);
  // Scan mode: 'ticket' (default event-ticket flow) or 'gavekort' (redeem a
  // gift-card QR with NO event — reachable from the no-event landing so a
  // salon/café that sells gavekort but runs no ticketed events can still scan).
  const [scanMode, setScanMode] = useState("ticket");
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
  // Debounce: { text, until } — repeated reads of the same QR ignored
  const lastScanRef = useRef({ text: null, until: 0 });
  const audioRef = useRef(null);

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
    try {
      const res = await api.post(`/tickets/${tid}/scan`, { qr: qrText });
      const data = res.data || {};
      pushHistory({
        kind: "success",
        title: data.customer_name || t("scanSuccess", "Velkommen"),
        subtitle: [data.tier_label, data.booking_id ? `#${String(data.booking_id).slice(0, 8)}` : null]
          .filter(Boolean).join(" · ") || t("scanAccepted", "Billet bekræftet"),
        at: new Date().toISOString(),
      });
      setStats((s) => ({ ...s, scanned: (s.scanned || 0) + 1 }));
      if (audioRef.current) audioRef.current.success();
      haptic.success();
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail || err?.response?.data?.message;
      let title;
      let subtitle = null;
      if (status === 409) {
        const when = formatTimeShort(err?.response?.data?.scanned_at);
        title = when
          ? t("scanAlreadyScannedAt", "Allerede scannet kl. {time}", { time: when })
          : t("scanAlreadyScanned", "Allerede scannet");
      } else if (status === 410) {
        title = t("scanRefunded", "Billet ugyldig — refunderet");
      } else if (status === 404) {
        title = t("scanNotFound", "Billet findes ikke");
      } else if (status === 403) {
        title = t("scanWrongEvent", "Forkert arrangement");
      } else if (typeof detail === "string" && detail.trim()) {
        title = detail;
      } else {
        title = t("scanGenericError", "Scan mislykkedes — prøv igen");
        subtitle = status ? `HTTP ${status}` : null;
      }
      pushHistory({
        kind: "error",
        title,
        subtitle,
        at: new Date().toISOString(),
      });
      if (audioRef.current) audioRef.current.failure();
      haptic.error();
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
      if (lastScanRef.current.text === code.data && now < lastScanRef.current.until) {
        return; // within 3-second debounce — silently drop
      }
      lastScanRef.current = { text: code.data, until: now + SCAN_DEBOUNCE_MS };

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
  const startScanner = useCallback(async () => {
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
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play().catch(() => { /* autoplay may need user gesture */ });
      }
      setScanning(true);
      lockPortrait();
      // Kick off the scan loop on next tick to ensure videoRef is ready.
      rafRef.current = requestAnimationFrame(() => {
        if (tickRef.current) tickRef.current();
      });
    } catch (err) {
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
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((tr) => tr.stop());
      } catch { /* ignore */ }
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try { video.srcObject = null; } catch { /* ignore */ }
    }
    setScanning(false);
    unlockPortrait();
    lastScanRef.current = { text: null, until: 0 };
    frameCountRef.current = 0;
  }, []);

  // ── Gavekort scan entry ────────────────────────────────────────────
  // Opened from the no-event landing tile. No event needed — flip into
  // gavekort mode and open the SAME camera loop; submitScan routes a gavekort
  // QR straight to the redeem sheet (the scan only reads; the debit is the
  // deliberate second tap inside the sheet).
  const startGavekortScan = useCallback(() => {
    setCameraError(null);
    setHistory([]);
    setScanMode("gavekort");
    startScanner();
  }, [startScanner]);

  // Leave gavekort mode back to the ticket landing (idle "back" action).
  const exitGavekort = useCallback(() => {
    setScanMode("ticket");
    setCameraError(null);
  }, []);

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
  return (
    <PageShell width="default">
      <PageHeader
        eyebrow={t("scanEyebrow", "DØR-SCAN")}
        title={
          scanMode === "gavekort"
            ? t("gkScanEyebrow", "Indløs gavekort")
            : selectedEvent?.name || t("scanTitle", "Vælg arrangement")
        }
        subtitle={
          scanMode === "gavekort"
            ? t("scanGavekortTileSub", "Scan et gavekort-QR")
            : selectedEvent
              ? `${selectedEvent.event_date}${selectedEvent.venue ? " · " + selectedEvent.venue : ""}`
              : t("scanTitleSubtitle", "Tjek gæster ind ved døren med en QR-scanning")
        }
        actions={headerActions}
      />

      {/* No event selected, ticket mode → landing with two entry tiles */}
      {scanMode === "ticket" && !selectedEvent && !scanning && (
        <div className="space-y-3">
          {/* Tile 1 — Scan billetter → reveal the event picker below. */}
          <Card onClick={() => setTicketPickerOpen(true)}>
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
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

          {/* Tile 2 — Indløs gavekort → open the camera in gavekort mode with
              NO event required. This is the fix: always reachable. */}
          <Card onClick={startGavekortScan}>
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
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
              until it taps "Scan billetter". */}
          {(ticketPickerOpen || events?.length > 0) && (
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
              <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
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
              <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
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
            <p className="text-center text-sm text-gray-500 dark:text-gray-400 py-3">
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
