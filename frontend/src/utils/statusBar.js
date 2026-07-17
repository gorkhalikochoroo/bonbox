import { StatusBar, Style } from "@capacitor/status-bar";
import { platform } from "./platform";

/** Sync the native status bar to the app theme. No-op on web; fail-soft on
 * platforms without the plugin. Style.Dark = dark bg/light text. */
export async function syncStatusBar(isDark) {
  if (!platform.isNative) return;
  try {
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    // Android only (iOS bar bg follows the webview); harmless elsewhere.
    await StatusBar.setBackgroundColor({ color: isDark ? "#111827" : "#F8FAFC" }).catch(() => {});
  } catch {
    /* plugin unavailable */
  }
}
