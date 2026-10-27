// Every sheet on the book's page (ReservationsPage) and the sheets beside it
// (components/reservations/EditBookingSheet.jsx) follow the same keyboard
// rules — moved here verbatim from the page (fix round 27 Oct) so a sheet in
// its own module keeps them.
import { useEffect, useRef } from "react";

// A sheet is modal for the keyboard too: focus moves into it, Tab stays in
// it, and focus goes back to whatever opened it. Tab + Enter behind an open
// New booking switched the book's status filter.
export const SHEET_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function useSheetFocus() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = document.activeElement;
    // The dialog itself, not its first field: on a phone a focused field
    // throws the keyboard up over the sheet the host is still reading.
    el.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const act = document.activeElement;
      // A confirm opened over the sheet owns the keyboard.
      const top = act && act.closest ? act.closest('[role="dialog"],[role="alertdialog"]') : null;
      if (top && top !== el) return;
      const list = Array.from(el.querySelectorAll(SHEET_FOCUSABLE)).filter((n) => n.getClientRects().length > 0);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      if (!el.contains(act) || act === el) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && act === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && act === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}

// Every sheet on this page closes on Esc — only the new-booking sheet did.
export function useEscToClose(onClose, busy = false) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
}
