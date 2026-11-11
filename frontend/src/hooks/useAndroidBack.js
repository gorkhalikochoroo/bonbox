import { useEffect, useRef } from "react";
import { App as CapApp } from "@capacitor/app";
import { platform } from "../utils/platform";

/**
 * Answer Android BACK while this component is mounted (Android shell only;
 * a no-op on iOS and the web). See utils/androidBack.js for the order.
 *
 * Registering ANY backButton listener turns off @capacitor/app's default
 * (WebView history back), so the handler owns BACK completely — it must
 * always do something visible: close, go home, or background the app.
 */
export function useAndroidBack(onBack) {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!platform.isAndroid) return undefined;
    let sub;
    try {
      sub = CapApp.addListener("backButton", (ev) => latest.current?.(ev));
    } catch {
      return undefined; // plugin missing in this shell
    }
    return () => {
      Promise.resolve(sub).then((l) => l?.remove?.()).catch(() => {});
    };
  }, []);
}

/** Background the app (Android's answer to BACK at the root screen). */
export function minimizeApp() {
  return CapApp.minimizeApp();
}
