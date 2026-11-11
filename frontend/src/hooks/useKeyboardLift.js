import { useEffect, useState } from "react";
import { Keyboard } from "@capacitor/keyboard";
import { platform } from "../utils/platform";
import { useKeyboardInset } from "./useKeyboardInset";

/**
 * How far a `position: fixed; bottom` bar has to rise to sit on top of the
 * on-screen keyboard — on the web AND inside the Capacitor shells.
 *
 * Why not useKeyboardAvoidance: that hook pads document.body, which moves
 * flowing content but never a fixed element. Why not useKeyboardInset alone:
 * it reads the visual viewport, which is right in a browser, but inside the
 * native shell the Keyboard plugin runs with `resize: "body"` — it only
 * shortens document.body — and the plugin's own event is the one signal that
 * is guaranteed to arrive (and arrives BEFORE the keyboard animates, so the
 * bar moves with it instead of after it).
 *
 * Native: prefer the visual-viewport figure when WebKit reports one (it
 * already subtracts any scroll WebKit did to reveal the field), else the
 * plugin's keyboard height. Web: the visual viewport, as before.
 *
 * Android is different (walk 11 Nov 2026): Capacitor 8's SystemBars plugin
 * pads the window by the keyboard's height, so the WebView itself gets
 * shorter (914 → 578 css px) and every fixed bar already ends at the
 * keyboard's top edge. Lifting by the plugin's height on top of that lifted
 * everything twice — the chat composer jumped over the thread title and the
 * messages vanished. On Android the lift is only what the visual viewport
 * still reports as covered (0 there); `open` says the keyboard is up.
 */
export function useKeyboardState() {
  const webInset = useKeyboardInset();
  const [nativeHeight, setNativeHeight] = useState(0);

  useEffect(() => {
    if (!platform.isNative) return undefined;
    let show;
    let hide;
    try {
      show = Keyboard.addListener("keyboardWillShow", (info) => {
        setNativeHeight(Math.max(0, Math.round(info?.keyboardHeight || 0)));
      });
      hide = Keyboard.addListener("keyboardWillHide", () => setNativeHeight(0));
    } catch {
      return undefined; // plugin missing in this shell — web behaviour applies
    }
    return () => {
      Promise.resolve(show).then((l) => l?.remove?.()).catch(() => {});
      Promise.resolve(hide).then((l) => l?.remove?.()).catch(() => {});
    };
  }, []);

  if (!platform.isNative) return { lift: webInset, open: webInset > 0 };
  if (!nativeHeight) return { lift: 0, open: false };
  if (platform.isAndroid) return { lift: webInset, open: true };
  return { lift: webInset > 0 ? webInset : nativeHeight, open: true };
}

/** px a fixed bottom bar must rise to clear the keyboard (see useKeyboardState). */
export function useKeyboardLift() {
  return useKeyboardState().lift;
}
