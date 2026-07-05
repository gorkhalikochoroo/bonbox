// SelfHealBoundary — auto-repair for RUNTIME FAULTS ONLY.
//
// This is the doctrine-SANCTIONED half of "auto-repair": it silently recovers
// a crashed widget / render error / transient fault by re-mounting the subtree
// once, and only shows a calm "try again" if the second attempt also fails —
// instead of white-screening the whole page.
//
// HARD RED-LINE: this NEVER touches money/MOMS/close/gavekort data. A financial
// discrepancy is NOT a bug to silently "fix" — silently overwriting one number
// with another destroys the audit trail and can mask theft. Money problems are
// DIAGNOSED and resolved by a human one tap at a time (the "Skal ses nu" queue
// + the SuggestionCard's apply-with-undo), never auto-repaired. Wrap UI
// subtrees with this; never wrap it around a money mutation.
import { Component } from "react";
import { RefreshCw } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { reportClientError } from "../utils/reportClientError";

function SelfHealFallback({ onRetry }) {
  const { t } = useLanguage();
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 flex items-center justify-between gap-3">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t("shrFailed", "Something glitched here.")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 px-2.5 py-1.5 rounded-lg"
      >
        <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
        {t("shrRetry", "Try again")}
      </button>
    </div>
  );
}

export default class SelfHealBoundary extends Component {
  state = { failed: false, attempts: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    // Best-effort log; never throw from here. Auto-recover ONCE after a calm
    // beat — most render faults are transient (a late prop, a null in flight).
    try {
      // eslint-disable-next-line no-console
      console.warn("SelfHealBoundary recovered from:", error?.message || error);
    } catch {
      /* ignore */
    }
    if (this.state.attempts < 1) {
      this._timer = setTimeout(
        () => this.setState((s) => ({ failed: false, attempts: s.attempts + 1 })),
        800,
      );
    } else {
      // Survived one silent re-mount and crashed AGAIN — not transient. Phone
      // home so we hear about a component that's genuinely broken in prod
      // (fail-soft; never rethrows, never auto-repairs money — see red-line above).
      try {
        reportClientError({
          kind: "render",
          message: (error && error.message) || "SelfHealBoundary second failure",
        });
      } catch { /* best-effort */ }
    }
  }

  componentWillUnmount() {
    clearTimeout(this._timer);
  }

  retry = () => {
    clearTimeout(this._timer);
    this.setState({ failed: false, attempts: 0 });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    // First failure → silent auto-recovery is scheduled; render the quiet
    // placeholder (or nothing) while it re-mounts.
    if (this.state.attempts < 1) return this.props.quiet ? null : <div className="h-2" />;
    // Recovered and crashed again → stop looping, offer a calm manual retry.
    return this.props.fallback ?? <SelfHealFallback onRetry={this.retry} />;
  }
}
