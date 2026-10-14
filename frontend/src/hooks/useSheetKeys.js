import { useEffect, useRef } from "react";

/**
 * useSheetKeys — the keyboard half of a sheet or dialog in the staff portal.
 *
 * An iPad with a Magic Keyboard (and a laptop at /s/<token>) used the portal's
 * sheets like a Mac, and none of them answered the keyboard: Esc closed
 * nothing, and opening a sheet left focus on the button that opened it, so Tab
 * walked the page BEHIND the dim (Eksportér CSV → the sidebar → Nyt) and never
 * reached the sheet. useConfirm already behaves; the portal's own sheets did
 * not. While `open`:
 *
 *   • focus moves into the sheet (the panel itself, so the next Tab is its
 *     first control and a screen reader starts at the dialog);
 *   • Tab and Shift+Tab stay inside it;
 *   • Esc calls onClose — only the TOPMOST sheet answers (the photo menu
 *     opens over Rediger profil), and not while a useConfirm dialog is up
 *     (it owns Esc in the capture phase and stops it there);
 *   • on close, focus goes back to what opened it, if that is still on the
 *     page and nothing else has taken focus. Never into a text field: that
 *     would pop the on-screen keyboard on a touch screen.
 *
 * Nothing here draws anything, so a phone without a keyboard renders and
 * behaves exactly as before.
 *
 * @param {boolean} open      whether the sheet is on screen
 * @param {{current: HTMLElement|null}} panelRef  the sheet's panel
 * @param {() => void} onClose  what Esc does (the sheet's own close)
 */
const stack = [];

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbables(root) {
  const all = [...root.querySelectorAll(TABBABLE)].filter((el) => el.getAttribute("tabindex") !== "-1");
  // Drawn controls only (a pad:-only close is display:none on a phone). A
  // DOM without layout (tests) draws nothing — then every control counts.
  const drawn = all.filter((el) => el.getClientRects().length > 0);
  return drawn.length ? drawn : all;
}

export function useSheetKeys(open, panelRef, onClose) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef?.current;
    if (!panel) return undefined;
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    stack.push(panel);
    if (!panel.contains(document.activeElement)) {
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      // The panel is a container, not a control: no focus ring around it.
      if (!panel.style.outline) panel.style.setProperty("outline", "none");
      try { panel.focus({ preventScroll: true }); } catch { panel.focus(); }
    }

    const onKey = (e) => {
      if (stack[stack.length - 1] !== panel) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = tabbables(panel);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const at = document.activeElement;
      if (!panel.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (at === first || at === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      const i = stack.lastIndexOf(panel);
      if (i >= 0) stack.splice(i, 1);
      const now = document.activeElement;
      const free = !now || now === document.body || !now.isConnected || panel.contains(now);
      if (
        free &&
        opener &&
        opener !== document.body &&
        opener.isConnected &&
        typeof opener.focus === "function" &&
        !opener.matches?.("input, textarea, select, [contenteditable]")
      ) {
        try { opener.focus({ preventScroll: true }); } catch { /* noop */ }
      }
    };
  }, [open, panelRef]);
}

export default useSheetKeys;
