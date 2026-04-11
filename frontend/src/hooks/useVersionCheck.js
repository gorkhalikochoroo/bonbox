import { App as CapApp } from "@capacitor/app";
import { platform } from "../utils/platform";
import { useState, useEffect } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Checks if the native app version meets the minimum required.
 * Shows a force-update screen if outdated.
 * No-op on web.
 */
export function useVersionCheck() {
  const [forceUpdate, setForceUpdate] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");

  useEffect(() => {
    if (!platform.isNative) return;

    const check = async () => {
      try {
        const appInfo = await CapApp.getInfo();
        const current = appInfo.version;

        const res = await fetch(`${API_BASE}/api/app-version`);
        if (!res.ok) return; // endpoint not deployed yet — don't block

        const data = await res.json();
        const minVersion = platform.isIOS ? data.min_ios : data.min_android;

        if (minVersion && isVersionLower(current, minVersion)) {
          setForceUpdate(true);
          setUpdateMessage(data.update_message || "Please update BonBox");
        }
      } catch {
        // Version check failure should never block the app
      }
    };

    check();
  }, []);

  return { forceUpdate, updateMessage };
}

/** Compare semver strings: returns true if current < minimum */
function isVersionLower(current, minimum) {
  const c = current.split(".").map(Number);
  const m = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((c[i] || 0) < (m[i] || 0)) return true;
    if ((c[i] || 0) > (m[i] || 0)) return false;
  }
  return false;
}
