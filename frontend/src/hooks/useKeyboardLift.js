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
 */
export function useKeyboardLift() {
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

  if (!platform.isNative) return webInset;
  if (!nativeHeight) return 0;
  return webInset > 0 ? webInset : nativeHeight;
}
