// A sheet the door screen loads on first use (fix round 27 Oct; MERGE §5
// item 4) — the pattern of stand/standFloorPlan.jsx, for the edit sheet and
// the "no table fits" sheet, which the door screen opens least. In the door
// screen's own build only: ReservationsPage asks for it behind
// __STAND_BUILD__, and the owner app keeps both sheets in its page bundle.
//
// The sheet is fetched quietly once the book has had the screen to itself
// for a while — so a wifi blip later in the evening never meets a sheet that
// was never downloaded — or at the first tap, whichever comes first. If it
// cannot be fetched (offline before it ever arrived), the host is told so
// with "Prøv igen" and can close it — the book behind it stays; never the
// crash screen, and never a tap that silently does nothing.
import { Component, Suspense, lazy } from "react";
import { WifiOff } from "lucide-react";

/** Quietly, once the door screen has been up a while (not on its first paint). */
export const SHEET_PREFETCH_MS = 9000;

export default function standSheet(load) {
  let Real = lazy(load);
  if (typeof window !== "undefined") {
    const later = () => load().catch(() => { /* the first tap tries again */ });
    setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(later, { timeout: 4000 });
      else later();
    }, SHEET_PREFETCH_MS);
  }

  class SheetBoundary extends Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      const props = this.props.sheetProps || {};
      if (!this.state.failed) {
        // Read at render time: "Prøv igen" swaps in a fresh lazy component
        // (a failed one keeps its error), and this re-render must use it.
        const Sheet = Real;
        return (
          <Suspense fallback={null}>
            <Sheet {...props} />
          </Suspense>
        );
      }
      const t = props.t || ((_k, fb) => fb);
      return (
        <div className="fixed inset-0 z-50 m-0 flex items-end sm:items-center justify-center bg-black/40 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            data-stand-sheet-failed=""
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[rgb(var(--surface-card))] p-5 flex flex-col items-center gap-3 text-center"
          >
            <WifiOff className="h-5 w-5 text-gray-400 dark:text-gray-500" strokeWidth={1.75} aria-hidden />
            <p className="text-sm text-gray-700 dark:text-gray-200">
              {t("rsvpErrNoNet", "Couldn't reach BonBox — check the connection and try again.")}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  Real = lazy(load);
                  this.setState({ failed: false });
                }}
                className="h-10 px-4 rounded-lg bg-gray-900 dark:bg-gray-100 text-sm font-medium text-white dark:text-gray-900"
              >
                {t("tryAgain", "Try again")}
              </button>
              <button
                type="button"
                onClick={() => props.onClose?.()}
                className="h-10 px-4 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {t("close", "Close")}
              </button>
            </div>
          </div>
        </div>
      );
    }
  }

  return function StandSheet(props) {
    return <SheetBoundary sheetProps={props} />;
  };
}
