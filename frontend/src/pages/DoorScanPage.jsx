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
import { Camera as CameraIcon, X, ArrowLeft, AlertTriangle, Check } from "lucide-react";
import jsQR from "jsqr";

import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { platform } from "../utils/platform";
import { haptic } from "../utils/haptics";

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
          icon="📅"
          title={t("scanNoUpcomingTitle", "Ingen arrangementer i dag eller i morgen")}
          body={t(
            "scanNoUpcomingBody",
            "Når du har et arrangement der starter inden for de næste 24 timer, dukker det op her.",
          )}
          cta={
            <Link
              to="/events"
              className="inline-flex h-9 items-center justify-center px-3.5 text-sm font-medium rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
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
export default function DoorScanPage() {
  const { t } = useLanguage();
  const { user } = useAuth(); // eslint-disable-line no-unused-vars

  // ── Event picker state ─────────────────────────────────────────────
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);

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

      const now = Date.now();
      if (lastScanRef.current.text === code.data && now < lastScanRef.current.until) {
        return; // within 3-second debounce — silently drop
      }
      lastScanRef.current = { text: code.data, until: now + SCAN_DEBOUNCE_MS };

      // Client-side wrong-event short-circuit (L4 optimization).
      const parsed = decodeQrPayload(code.data);
      if (parsed?.eid && selectedEvent?.id && String(parsed.eid) !== String(selectedEvent.id)) {
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
  }, [selectedEvent, submitScan, pushHistory, t]);

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
      {selectedEvent && !scanning && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { stopScanner(); setSelectedEvent(null); setHistory([]); }}
          iconLeft={<ArrowLeft size={14} />}
        >
          {t("scanChangeEvent", "Skift arrangement")}
        </Button>
      )}
      {scanning && (
        <Button
          variant="secondary"
          size="sm"
          onClick={stopScanner}
          iconLeft={<X size={14} />}
        >
          {t("scanStop", "Stop scanner")}
        </Button>
      )}
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <PageShell width="default">
      <PageHeader
        eyebrow={t("scanEyebrow", "DØR-SCAN")}
        title={selectedEvent?.name || t("scanTitle", "Vælg arrangement")}
        subtitle={
          selectedEvent
            ? `${selectedEvent.event_date}${selectedEvent.venue ? " · " + selectedEvent.venue : ""}`
            : t("scanTitleSubtitle", "Tjek gæster ind ved døren med en QR-scanning")
        }
        actions={headerActions}
      />

      {/* No event selected → show picker */}
      {!selectedEvent && (
        <>
          <Card>
            <Empty
              icon={<CameraIcon size={32} strokeWidth={1.5} className="text-gray-500 dark:text-gray-400 inline-block" />}
              title={t("scanPickEventTitle", "Vælg det arrangement du står ved døren til")}
              body={t(
                "scanPickEventBody",
                "Kun arrangementer der starter i dag eller i morgen vises her.",
              )}
            />
          </Card>
          <UpcomingEventsList
            events={events}
            loading={eventsLoading}
            onPick={setSelectedEvent}
            t={t}
          />
        </>
      )}

      {/* Event selected, scanner idle → big Start CTA */}
      {selectedEvent && !scanning && (
        <>
          {cameraError && (
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
          )}

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

      {/* Scanner active → camera + flashes */}
      {selectedEvent && scanning && (
        <div className="space-y-4">
          {/* Stats bar */}
          <Card variant="subtle">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 text-center tabular-nums">
              {progressLabel}
            </p>
          </Card>

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
              {t("scanWaitingFirst", "Hold en billet-QR foran kameraet for at starte.")}
            </p>
          )}

          {/* Stop button at bottom — duplicate of header action for thumb reach */}
          <div className="pt-2">
            <Button
              variant="secondary"
              size="lg"
              onClick={stopScanner}
              className="w-full"
              iconLeft={<X size={16} />}
            >
              {t("scanStop", "Stop scanner")}
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
