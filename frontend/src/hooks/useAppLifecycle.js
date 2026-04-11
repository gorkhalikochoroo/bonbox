import { App as CapApp } from "@capacitor/app";
import { useEffect, useRef } from "react";
import { useAuth } from "./useAuth";
import { syncOfflineQueue } from "./useOffline";
import { platform } from "../utils/platform";

const LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Manages iOS/Android app lifecycle:
 * - Checks JWT expiry on resume (no refresh token in BonBox — redirect to login)
 * - Syncs offline queue on resume
 * - Handles deep link URL opens
 *
 * SECURITY: Token is checked by decoding JWT exp claim — never logged.
 */
export function useAppLifecycle() {
  const { logout } = useAuth();
  const lastActiveRef = useRef(Date.now());

  useEffect(() => {
    if (!platform.isNative) return;

    const listener = CapApp.addListener("appStateChange", async ({ isActive }) => {
      if (isActive) {
        lastActiveRef.current = Date.now();

        // Check if JWT is expired — BonBox has no refresh token endpoint
        const token = localStorage.getItem("token");
        if (token) {
          try {
            const payload = JSON.parse(atob(token.split(".")[1]));
            if (payload.exp * 1000 < Date.now()) {
              logout();
              return;
            }
          } catch {
            logout();
            return;
          }
        }

        // Sync any queued offline actions
        await syncOfflineQueue();
      }
    });

    // Deep link handling — sanitize URL before navigating
    const urlListener = CapApp.addListener("appUrlOpen", ({ url }) => {
      try {
        const parsed = new URL(url);
        // Only navigate to paths on our own domain
        if (parsed.hostname === "bonbox.dk" || parsed.hostname === "localhost") {
          window.location.href = parsed.pathname;
        }
      } catch {
        // Malformed URL — ignore
      }
    });

    return () => {
      listener.then((l) => l.remove());
      urlListener.then((l) => l.remove());
    };
  }, [logout]);

  return { lastActiveRef, LOCK_TIMEOUT };
}
