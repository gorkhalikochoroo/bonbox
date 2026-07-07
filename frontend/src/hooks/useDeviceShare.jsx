/**
 * Shared-device ("Delt enhed") reveal PIN — frontend state (#379, Slice 2).
 *
 * On a shared counter device the owner flagged, the crown-jewel FINANCIAL
 * surfaces are curtained until the 4-digit PIN is entered. This provider owns:
 *   • enabled   — this device is in shared mode (server `sd` claim, via /status)
 *   • hasPin    — the account has a reveal PIN set
 *   • locked    — shared AND not currently revealed (curtain up)
 *   • reveal(pin) / relock() / setPin / enableShared / disableShared
 *
 * The real barrier is the backend (member_read_guard-sibling pin_gate). This is
 * the UX layer: the reveal proof (held in services/deviceShare, in-memory) is
 * echoed on requests, and 403 device_pin_required raises the LockScreen.
 *
 * HONEST: this HIDES the owner's numbers from staff on a shared device. It is
 * not "security" — it doesn't protect a stolen device or the session token.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";
import { useAuth } from "./useAuth";
import {
  setRevealProof,
  registerDeviceLockHandler,
} from "../services/deviceShare";

const IDLE_RELOCK_MS = 5 * 60 * 1000; // re-curtain after 5 min of no activity

const DeviceShareContext = createContext({
  ready: false, enabled: false, hasPin: false, locked: false,
  reveal: async () => {}, relock: () => {}, setPin: async () => {},
  enableShared: async () => {}, disableShared: async () => {}, refresh: async () => {},
});

export function DeviceShareProvider({ children }) {
  const { user } = useAuth();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [locked, setLocked] = useState(false);
  const idleTimer = useRef(null);

  // The device PIN is the OWNER's own control. A delegated member/accountant
  // view (owner_id-based) manages nothing here, and a logged-out visitor must
  // never hit the authed /status probe (it would trip the 401 redirect).
  const isOwnerSession = !!user && String(user.role || "owner").toLowerCase() === "owner";

  const refresh = useCallback(async () => {
    if (!isOwnerSession) { setReady(true); return; }
    try {
      const { data } = await api.get("/auth/device-pin/status");
      setEnabled(!!data.shared);
      setHasPin(!!data.has_pin);
      // At load a shared device has no in-memory proof yet → curtain is up.
      setLocked(!!data.locked);
    } catch {
      // Fail-soft: treat as not-shared so we never brick the app on a status
      // hiccup (the backend gate still protects the actual data).
      setEnabled(false); setHasPin(false); setLocked(false);
    } finally {
      setReady(true);
    }
  }, [isOwnerSession]);

  useEffect(() => { refresh(); }, [refresh]);

  const clearIdle = useCallback(() => {
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
  }, []);

  const relock = useCallback(() => {
    // Drop the in-memory proof and raise the curtain. Setting locked=true is
    // inert when the device isn't shared — every curtain surface gates on
    // (enabled && locked), so a non-shared device shows nothing.
    setRevealProof(null);
    clearIdle();
    setLocked(true);
  }, [clearIdle]);

  const armIdle = useCallback(() => {
    clearIdle();
    idleTimer.current = setTimeout(() => { relock(); }, IDLE_RELOCK_MS);
  }, [clearIdle, relock]);

  // The backend answered 403 device_pin_required on a financial read → curtain.
  useEffect(() => {
    registerDeviceLockHandler(() => { setRevealProof(null); setLocked(true); clearIdle(); });
    return () => registerDeviceLockHandler(null);
  }, [clearIdle]);

  // Relock on background (owner walks away) + idle. Only while revealed.
  useEffect(() => {
    if (!enabled || locked) { clearIdle(); return undefined; }
    const onHide = () => { if (document.visibilityState === "hidden") relock(); };
    const onActivity = () => armIdle();
    document.addEventListener("visibilitychange", onHide);
    ["mousedown", "keydown", "touchstart", "pointerdown"].forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true }));
    armIdle();
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      ["mousedown", "keydown", "touchstart", "pointerdown"].forEach((e) =>
        window.removeEventListener(e, onActivity));
      clearIdle();
    };
  }, [enabled, locked, armIdle, relock, clearIdle]);

  const reveal = useCallback(async (pin) => {
    const { data } = await api.post("/auth/device-pin/verify", { pin });
    setRevealProof(data.proof);
    setLocked(false);
    // idle timers re-arm via the effect above (locked flipped false).
  }, []);

  const setPin = useCallback(async (pin) => {
    await api.post("/auth/device-pin/set", { pin });
    setHasPin(true);
  }, []);

  const enableShared = useCallback(async () => {
    const { data } = await api.post("/auth/device-pin/enable-shared");
    // Swap THIS device's stored bearer to the new sd-token — else the request
    // interceptor keeps sending the old non-sd bearer (bearer wins over cookie)
    // and shared mode would never take effect on web.
    if (data.token) { try { localStorage.setItem("token", data.token); } catch { /* no-op */ } }
    setRevealProof(null);
    setEnabled(true);
    setLocked(true);
  }, []);

  const disableShared = useCallback(async (password) => {
    const { data } = await api.post("/auth/device-pin/disable-shared", { password });
    if (data.token) { try { localStorage.setItem("token", data.token); } catch { /* no-op */ } }
    setRevealProof(null);
    setEnabled(false);
    setLocked(false);
    clearIdle();
  }, [clearIdle]);

  const value = useMemo(() => ({
    ready, enabled, hasPin, locked,
    reveal, relock, setPin, enableShared, disableShared, refresh,
  }), [ready, enabled, hasPin, locked, reveal, relock, setPin, enableShared, disableShared, refresh]);

  return <DeviceShareContext.Provider value={value}>{children}</DeviceShareContext.Provider>;
}

export function useDeviceShare() {
  return useContext(DeviceShareContext);
}
