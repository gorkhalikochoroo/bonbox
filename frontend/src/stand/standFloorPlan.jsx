// The floor plan, on first use (R11, rubric B11) — what components/FloorPlan.jsx
// is, in the door screen's own build only (scripts/standBuild.mjs swaps it in;
// this module's own import reaches the real plan).
//
// The door screen always opens on the list, so the plan (~15 kB gzip with its
// table shapes) is not on the path to tonight's book. It is fetched quietly
// once the book has had the screen to itself for a while — so a wifi blip
// later in the evening never meets a plan that was never downloaded — or at
// the first tap on the Plan lens, whichever comes first. ReservationsPage's
// FloorView shows the plan's own skeleton meanwhile (Suspense). If the plan
// cannot be fetched (offline before it ever arrived), the lens says so with
// Try again — the book around it stays; never the crash screen.
//
// The owner app keeps the plan in its page, as before.
import { Component, lazy } from "react";
import { WifiOff } from "lucide-react";

const load = () => import("../components/FloorPlan.jsx");
let RealPlan = lazy(load);

/** Quietly, once the door screen has been up a while (not on its first paint). */
const PLAN_PREFETCH_MS = 8000;
if (typeof window !== "undefined") {
  const later = () => load().catch(() => { /* the first tap tries again */ });
  setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(later, { timeout: 4000 });
    else later();
  }, PLAN_PREFETCH_MS);
}

class PlanBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const t = this.props.t || ((_k, fb) => fb);
    return (
      <div
        role="status"
        data-stand-plan-failed=""
        className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] px-4 py-6 flex flex-col items-center gap-3 text-center"
      >
        <WifiOff className="h-5 w-5 text-gray-400 dark:text-gray-500" strokeWidth={1.75} aria-hidden />
        <p className="text-sm text-gray-700 dark:text-gray-200">
          {t("rsvpErrNoNet", "Couldn't reach BonBox — check the connection and try again.")}
        </p>
        <button
          type="button"
          onClick={() => {
            RealPlan = lazy(load);
            this.setState({ failed: false });
          }}
          className="h-10 px-4 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {t("tryAgain", "Try again")}
        </button>
      </div>
    );
  }
}

export default function StandFloorPlan(props) {
  const Plan = RealPlan;
  return (
    <PlanBoundary t={props.t}>
      <Plan {...props} />
    </PlanBoundary>
  );
}
