/**
 * useLiveAlerts — the host-stand "pop + sound" live-alert system.
 *
 * While BonBox is open on a screen (front-of-house host stand, back office),
 * this polls GET /api/reservations/changes every ~20s and, on a NEW booking /
 * cancellation / change (incl. a dietary/allergy note added), shows a toast and
 * plays a chime. A SEVERE allergy gets a louder, distinct beep + red toast.
 *
 * Design choices (and why):
 *   • POLL, not push. This is the app-is-open case — a 20s poll is simple,
 *     needs no OS permission, and works on every browser. (Closed-app phone
 *     push already exists separately for new bookings.) Supabase Realtime is
 *     the later "instant" upgrade.
 *   • NEVER replay history on open. lastSeen starts at "now" so opening the app
 *     can't machine-gun you with this morning's bookings — you only hear what
 *     happens NEXT.
 *   • Anti-spam (Manoj's rule): polls only while the tab is VISIBLE; beeps at
 *     most ONCE per poll even if five bookings land together; >3 fresh changes
 *     collapse into a single "N new changes" toast. One-tap mute (sound off) +
 *     master off, both persisted per-device — the host stand beeps, the owner's
 *     personal phone stays silent.
 *   • Per-DEVICE settings (localStorage), not per-account.
 *   • Privacy: the feed shows guest first name + severity flag only; the full
 *     allergy note (Art. 9 health data) is never pulled into the toast.
 *
 * Accountant-view / logged-out → inert (no polling, no UI).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "./useAuth";
import { useLanguage } from "./useLanguage";
import { playChime, playUrgent, unlockSound } from "../utils/sound";

const POLL_MS = 20000;
const FEED_CAP = 25;
const TOAST_MS = 9000;

const LS_ENABLED = "bonbox_alerts_enabled";
const LS_SOUND = "bonbox_alerts_sound";

const LiveAlertsContext = createContext(null);

const readBool = (key, dflt) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
};
const writeBool = (key, val) => {
  try {
    localStorage.setItem(key, val ? "1" : "0");
  } catch {
    /* ignore */
  }
};

let _toastSeq = 0;

export function LiveAlertsProvider({ children }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const isAccountant = (user?.role || "").toLowerCase() === "accountant";
  const active = !!user && !isAccountant;

  const [enabled, setEnabledState] = useState(() => readBool(LS_ENABLED, true));
  const [sound, setSoundState] = useState(() => readBool(LS_SOUND, true));
  const [feed, setFeed] = useState([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState([]);

  // Refs the polling loop reads without re-subscribing the interval.
  const lastSeenRef = useRef(null); // ISO server_time; null = not initialised
  const seenRef = useRef(new Set()); // `${id}:${updated_at}` dedupe
  const enabledRef = useRef(enabled);
  const soundRef = useRef(sound);
  const activeRef = useRef(active);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => { activeRef.current = active; }, [active]);

  const setEnabled = useCallback((v) => {
    setEnabledState(v);
    writeBool(LS_ENABLED, v);
  }, []);
  const setSound = useCallback((v) => {
    setSoundState(v);
    writeBool(LS_SOUND, v);
    if (v) unlockSound(); // toggling sound on is a gesture — unlock audio now
  }, []);

  const markAllRead = useCallback(() => setUnread(0), []);
  const dismissToast = useCallback(
    (id) => setToasts((cur) => cur.filter((tt) => tt.id !== id)),
    [],
  );

  // Unlock the AudioContext on the first real interaction anywhere — without
  // this, browsers drop a poll-triggered beep (no preceding user gesture).
  useEffect(() => {
    if (!active) return undefined;
    // Re-arm on EVERY gesture, NOT once — a wall-mounted iPad suspends its
    // AudioContext when the screen locks, so a one-shot unlock would leave the
    // chime silently dead for the rest of the shift after the first lull.
    const onGesture = () => unlockSound();
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [active]);

  // Build a toast + feed entry from a change row.
  const describe = useCallback(
    (c) => {
      const who = c.guest_name || t("liveAlertGuest", "Guest");
      const bits = [];
      if (c.table_label) bits.push(c.table_label);
      if (c.starts_at) {
        try {
          bits.push(
            new Date(c.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          );
        } catch {
          /* ignore */
        }
      }
      if (c.party_size) bits.push(`${c.party_size}p`);
      const severe = c.allergy_severity === "severe";
      let title;
      if (c.kind === "cancelled") title = t("liveAlertCancelled", "Booking cancelled");
      else if (c.kind === "new") title = t("liveAlertNew", "New booking");
      else title = t("liveAlertChanged", "Booking updated");
      // The booking's local day — lets the tap deep-link straight to the exact
      // reservation on the right day, not the generic list. Local date parts
      // mirror ReservationsPage's isoDay(); soft-fail to no date.
      let bookingDate = "";
      if (c.starts_at) {
        try {
          const d = new Date(c.starts_at);
          const pad = (n) => String(n).padStart(2, "0");
          bookingDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        } catch {
          /* ignore */
        }
      }
      return {
        id: `t${++_toastSeq}`,
        changeId: c.id,
        bookingId: c.id,
        bookingDate,
        kind: c.kind,
        title,
        who,
        sub: bits.join(" · "),
        hasAllergy: !!c.has_allergy,
        severe,
      };
    },
    [t],
  );

  // ── The poll loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (!enabledRef.current || !activeRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return; // visible-only
      const since = lastSeenRef.current;
      try {
        const res = await api.get("/reservations/changes", {
          params: since ? { since } : {},
          _noRetry: true,
        });
        if (cancelled) return;
        const serverTime = res?.data?.server_time;
        const changes = Array.isArray(res?.data?.changes) ? res.data.changes : [];
        // First successful poll just anchors lastSeen — never alerts on history.
        if (!since) {
          lastSeenRef.current = serverTime || new Date().toISOString();
          return;
        }
        lastSeenRef.current = serverTime || lastSeenRef.current;

        const fresh = changes.filter((c) => {
          const key = `${c.id}:${c.updated_at || ""}`;
          if (seenRef.current.has(key)) return false;
          seenRef.current.add(key);
          return true;
        });
        if (!fresh.length) return;

        const items = fresh.map(describe);
        const anySevere = items.some((i) => i.severe);

        // Feed (newest first, capped) + unread badge.
        setFeed((cur) => [...items, ...cur].slice(0, FEED_CAP));
        setUnread((n) => n + items.length);

        // Toasts. SEVERE allergies ALWAYS get their own dedicated toast — they
        // are never collapsed into a "N changes" summary (the one alert that
        // matters can't be buried). Only the non-severe rest gets summarized
        // when a burst lands.
        setToasts((cur) => {
          const severe = items.filter((i) => i.severe);
          const rest = items.filter((i) => !i.severe);
          let toShow;
          if (rest.length <= 3) {
            toShow = [...severe, ...rest];
          } else {
            toShow = [
              ...severe,
              {
                id: `t${++_toastSeq}`,
                kind: "summary",
                title: t("liveAlertManyTitle", "{n} new changes", { n: rest.length }),
                who: "",
                sub: t("liveAlertManySub", "Open Reservations to review"),
                hasAllergy: rest.some((i) => i.hasAllergy),
                severe: false,
              },
            ];
          }
          return [...toShow, ...cur].slice(0, 8);
        });

        // Beep ONCE per poll (urgent wins).
        if (soundRef.current) {
          if (anySevere) playUrgent();
          else playChime();
        }
      } catch {
        // Network blip / 401 mid-session — stay silent, try again next tick.
      }
    };

    // Prime lastSeen immediately so the first real tick has an anchor, but
    // don't alert on the priming call.
    tick();
    const id = setInterval(tick, POLL_MS);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, describe, t]);

  // Auto-dismiss — but NEVER a severe-allergy toast. A severe allergy is a
  // safety event: it stays on screen until a staff member deliberately taps
  // "Got it — sent to kitchen" (Manoj's locked decision: tap-to-acknowledge).
  useEffect(() => {
    if (!toasts.length) return undefined;
    const timers = toasts
      .filter((tt) => !tt.severe)
      .map((tt) => setTimeout(() => dismissToast(tt.id), TOAST_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  // Tapping a toast lands the owner on the EXACT booking (drawer opens, one
  // calm ring) instead of the generic list. A collapsed "N changes" summary —
  // or any item without a booking id — falls back to the list. The id is the
  // only thing we carry; ReservationsPage re-derives the row from a fresh fetch.
  const openReservations = useCallback(
    (target) => {
      setToasts([]);
      markAllRead();
      const id = target && typeof target === "object" ? target.bookingId : null;
      if (id) {
        const date = target.bookingDate;
        const qs = new URLSearchParams({ booking: String(id) });
        if (date) qs.set("date", date);
        navigate(`/reservations?${qs.toString()}`);
      } else {
        navigate("/reservations");
      }
    },
    [navigate, markAllRead],
  );

  const value = useMemo(
    () => ({
      active,
      enabled,
      setEnabled,
      sound,
      setSound,
      feed,
      unread,
      markAllRead,
      clearFeed: () => setFeed([]),
      openReservations,
    }),
    [active, enabled, setEnabled, sound, setSound, feed, unread, markAllRead, openReservations],
  );

  return (
    <LiveAlertsContext.Provider value={value}>
      {children}
      {active && toasts.length > 0 && (
        <div
          className="fixed top-3 right-3 z-[70] flex flex-col gap-2 w-[min(92vw,340px)] pointer-events-none"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
          aria-live="polite"
        >
          {toasts.map((tt) => (
            <div
              key={tt.id}
              className={`pointer-events-auto w-full rounded-xl border px-4 py-3 shadow-lg backdrop-blur
                bg-white/95 dark:bg-gray-800/95
                ${tt.severe
                  ? "border-red-400 dark:border-red-600 ring-2 ring-red-300 dark:ring-red-800"
                  : tt.hasAllergy
                    ? "border-amber-300 dark:border-amber-700"
                    : "border-gray-200 dark:border-gray-700"}`}
            >
              <button type="button" onClick={() => openReservations(tt)} className="w-full text-left active:scale-[0.99] transition">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      tt.kind === "cancelled"
                        ? "bg-gray-400"
                        : tt.severe
                          ? "bg-red-500"
                          : tt.hasAllergy
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                    }`}
                  />
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    {tt.title}
                  </span>
                </div>
                {(tt.who || tt.sub) && (
                  <div className="mt-0.5 text-[12.5px] text-gray-600 dark:text-gray-300 truncate">
                    {tt.who}
                    {tt.who && tt.sub ? " · " : ""}
                    {tt.sub}
                  </div>
                )}
                {tt.hasAllergy && (
                  <div
                    className={`mt-1 text-[11.5px] font-semibold ${
                      tt.severe ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {tt.severe
                      ? t("liveAlertSevereAllergy", "⚠ Severe allergy noted")
                      : t("liveAlertAllergy", "Allergy / dietary note")}
                  </div>
                )}
              </button>
              {/* Severe allergy = a safety event: it does NOT auto-dismiss; a
                  staff member must deliberately acknowledge (Manoj's locked
                  "tap to acknowledge" decision). */}
              {tt.severe && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); dismissToast(tt.id); }}
                  className="mt-2 w-full rounded-lg bg-red-600 hover:bg-red-700 text-white text-[12px] font-semibold py-1.5 transition"
                >
                  {t("liveAlertAck", "✓ Got it — sent to kitchen")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </LiveAlertsContext.Provider>
  );
}

export function useLiveAlerts() {
  const ctx = useContext(LiveAlertsContext);
  if (ctx) return ctx;
  // Outside the provider (public pages / tests) → inert shape.
  return {
    active: false,
    enabled: false,
    setEnabled: () => {},
    sound: false,
    setSound: () => {},
    feed: [],
    unread: 0,
    markAllRead: () => {},
    clearFeed: () => {},
    openReservations: () => {},
  };
}
