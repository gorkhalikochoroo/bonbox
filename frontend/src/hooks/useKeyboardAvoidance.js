import { Keyboard } from "@capacitor/keyboard";
import { platform } from "../utils/platform";
import { useEffect } from "react";

/**
 * Adjusts layout when iOS keyboard opens/closes.
 * Adds bottom padding so inputs aren't hidden behind keyboard.
 * Scrolls the focused input into the center of the visible area.
 * No-op on web — browser handles this natively.
 */
export function useKeyboardAvoidance() {
  useEffect(() => {
    if (!platform.isNative) return;

    const showListener = Keyboard.addListener("keyboardWillShow", (info) => {
      document.body.style.paddingBottom = `${info.keyboardHeight}px`;

      // Scroll focused input into view after keyboard animation starts
      setTimeout(() => {
        const focused = document.activeElement;
        // FIXED: parentheses around OR to prevent null crash
        if (
          focused &&
          (focused.tagName === "INPUT" ||
            focused.tagName === "TEXTAREA" ||
            focused.tagName === "SELECT")
        ) {
          focused.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
    });

    const hideListener = Keyboard.addListener("keyboardWillHide", () => {
      document.body.style.paddingBottom = "0px";
    });

    return () => {
      showListener.then((l) => l.remove());
      hideListener.then((l) => l.remove());
    };
  }, []);
}
