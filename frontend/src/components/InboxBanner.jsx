/**
 * InboxBanner — receipt-forwarding inbox surface for /expenses (v0.1).
 *
 * Why this exists:
 *   Sudip-style owners want to keep their phone-mail muscle memory:
 *   receipt lands → tap Forward → done. Their accountant already gives
 *   them a `<name>@receipts.accountant.dk` address; we match that with
 *   a personal `<short>-<rnd>@in.bonbox.dk` alias. Backend ingests the
 *   email, OCRs the PDF, drafts an Expense (status='draft', source='inbox')
 *   which lands in the existing Review path on /expenses.
 *
 * Honesty (Multi-barrier L10 — honest UI):
 *   If the backend's INBOX_ENABLED env var is false, /api/inbox/me returns
 *   `infra_enabled: false`. We render a "Coming soon" variant with NO
 *   copy button, NO test-email button — pure transparency that we're
 *   still wiring up the inbound provider. No fake state, no auto-confirm.
 *
 * Tier discipline:
 *   `messages_this_month` + `cap` come from the backend. Free = 5/month,
 *   Starter+ = -1 (unlimited). We surface "{n} of {cap} this month" so
 *   the owner knows what's left. Past-cap quarantine logic lives backend-
 *   side; the frontend just shows the count + a soft upgrade hint if the
 *   counter is approaching cap. Allowlist + rotate UIs are out of scope
 *   for v0.1 — they ship in v0.2.
 *
 * DK terminology lock:
 *   The alias is in English (it's an email) but helper copy keeps
 *   `revisor` and `Bogføringsloven §10` as the trust anchors — those are
 *   the audit-trail terms our DK owners share with their accountant.
 *
 * Multi-barrier on the test-email button:
 *   • Backend POST /api/inbox/test is owner-only + rate-limited 5/day.
 *   • Frontend disables the button for non-owner sessions (UI hint;
 *     backend re-checks).
 *   • Disabled at infra_enabled=false (no provider to send through).
 *   • Loading state during the round-trip so users don't double-click.
 *   • Toast surfaces both success and the backend's `reason` on failure.
 *
 * Mobile-first:
 *   The alias is the focal point. On <sm screens the address breaks to
 *   its own line and the [Copy] sits beneath it on a button row — no
 *   horizontal scroll even at 360px wide. Touch targets are min-44px.
 */
import { useEffect, useState } from "react";
import { Mail, Copy, Check, AlertCircle, Send, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

const DISMISS_KEY = "bonbox_inbox_banner_dismissed_v1";
const EXPANDED_KEY = "bonbox_inbox_banner_expanded_v1";

function _isDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function _dismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode — best effort */
  }
}

// Collapsed by default — most owners forward receipts weekly at most,
// so the full card with description + send-test was hogging real estate
// on every /expenses visit. The slim row keeps the alias + copy + status
// visible at a glance; the chevron reveals the full context on demand
// and the choice persists across reloads via localStorage.
function _isExpanded() {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function _setExpanded(v) {
  try {
    localStorage.setItem(EXPANDED_KEY, v ? "1" : "0");
  } catch {
    /* private mode — best effort */
  }
}

/**
 * Reusable InboxBanner — used by /expenses today; the ConnectionsPage
 * card uses InboxConnectionCard (below) for visual rhythm with the
 * other integration cards on that page.
 *
 * Props:
 *   • variant — "banner" (full-width on /expenses) | "card" (passed
 *               from ConnectionsPage to render inside its grid)
 *   • dismissable — banner only; the card form lives permanently on
 *                   /connections so dismiss makes no sense there
 *   • onState — optional callback so the parent (ConnectionsPage) can
 *               share the fetched payload without double-fetching
 */
export default function InboxBanner({
  dismissable = true,
  onState,
}) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const isOwner = (user?.role || "owner").toLowerCase() === "owner";

  const [state, setState] = useState(null);   // null = loading, {} = loaded
  const [error, setError] = useState("");
  // Dismiss-button was removed (2026-05-25) — users were mis-tapping it
  // and losing the alias entirely with no clear path back. The collapse
  // chevron now does all the de-clutter work via a slim ~70px row.
  // Hard-wired to false: any leftover localStorage flag from before is
  // safely ignored.
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toast, setToast] = useState(null);   // { kind, msg }
  // This component is the BANNER variant only (the /connections page
  // uses a separate `InboxConnectionCard` defined below). So it's
  // always collapsible — no variant check needed. Default state is
  // collapsed because most owners forward receipts weekly at most;
  // the full card was hogging real estate on every /expenses visit.
  const [expanded, setExpandedState] = useState(_isExpanded);
  const toggleExpanded = () => {
    setExpandedState((prev) => {
      const next = !prev;
      _setExpanded(next);
      return next;
    });
  };

  useEffect(() => {
    if (hidden) return;
    let alive = true;
    api.get("/inbox/me")
      .then((r) => {
        if (!alive) return;
        setState(r.data || {});
        if (onState) {
          try { onState(r.data || {}); } catch { /* parent fn shape mismatch — silent */ }
        }
      })
      .catch((err) => {
        if (!alive) return;
        // Endpoint not deployed yet → fail closed to "Coming soon".
        // 404 / 501 both map to the honest fallback; the user still
        // gets useful copy explaining what's coming.
        const status = err?.response?.status;
        if (status === 404 || status === 501) {
          setState({ infra_enabled: false, alias: null });
        } else {
          // Any other transport error → log + hide rather than render
          // half-broken state. Defensive: a half-rendered banner with
          // "null@in.bonbox.dk" would be worse than no banner at all.
          setError("api_error");
        }
      });
    return () => { alive = false; };
  }, [hidden, onState]);

  const onDismiss = () => {
    _dismiss();
    setHidden(true);
  };

  const onCopy = async () => {
    if (!state?.alias) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.alias);
      } else {
        // Legacy fallback for embedded webviews (older iOS) — same
        // textarea trick DailyBriefCard uses.
        const ta = document.createElement("textarea");
        ta.value = state.alias;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setToast({
        kind: "error",
        msg: t("inboxCopyFailed", "Couldn't copy — long-press the address to select."),
      });
      setTimeout(() => setToast(null), 3500);
    }
  };

  const onSendTest = async () => {
    if (!isOwner || testing) return;
    setTesting(true);
    try {
      const r = await api.post("/inbox/test");
      const ok = r?.data?.ok !== false;
      if (ok) {
        setToast({
          kind: "success",
          msg: t(
            "inboxTestSent",
            "Test receipt queued — it'll appear as a draft in a moment.",
          ),
        });
      } else {
        // Backend returned { ok: false, reason: "..." } — surface the
        // human-readable reason (rate-limit hit, infra paused, etc.)
        setToast({
          kind: "error",
          msg: r?.data?.reason || t("inboxTestFailedGeneric", "Couldn't send a test receipt."),
        });
      }
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.response?.data?.reason;
      setToast({
        kind: "error",
        msg: detail || t("inboxTestFailedGeneric", "Couldn't send a test receipt."),
      });
    } finally {
      setTesting(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  if (hidden) return null;
  if (state === null && !error) return null;   // pre-load — render nothing (prevents flicker)
  if (error) return null;                       // hard transport error — see effect comment

  const infraEnabled = !!state?.infra_enabled;
  const alias = state?.alias || "";
  const count = Number(state?.messages_this_month || 0);
  const cap = Number(state?.cap);
  const isUnlimited = cap < 0;
  // Free-tier owners approaching 5/5 should know they're close.
  const isNearCap = !isUnlimited && cap > 0 && count >= cap - 1;
  const isAtCap = !isUnlimited && cap > 0 && count >= cap;

  return (
    <div
      className="relative rounded-2xl border bg-white dark:bg-gray-800
                 border-gray-200 dark:border-gray-700 p-4 sm:p-5 shadow-sm"
      role="region"
      aria-label={t("inboxBannerAria", "Receipt-forwarding email inbox")}
    >
      {/* Collapse/expand toggle — the ONLY control on the banner now.
          The previous dismiss × was removed (2026-05-25) because users
          mis-tapped it sitting next to this chevron and lost the alias
          entirely with no obvious way back. With the slim collapsed
          row at ~70px, dismiss was never load-bearing — collapse already
          de-clutters the page. */}
      <button
        type="button"
        onClick={toggleExpanded}
        aria-label={expanded
          ? t("inboxCollapse", "Hide receipt inbox details")
          : t("inboxExpand", "Show receipt inbox details")}
        aria-expanded={expanded}
        className="absolute top-3 right-3 w-8 h-8 rounded-full inline-flex items-center justify-center
                   hover:bg-black/5 dark:hover:bg-white/10 transition
                   text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      >
        {expanded
          ? <ChevronUp className="w-4 h-4" aria-hidden="true" />
          : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      <div className="flex items-start gap-3 pr-8 sm:pr-10">
        <div className="shrink-0 p-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
          <Mail className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
                strokeWidth={1.75} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
            {infraEnabled
              ? t("inboxBannerTitle", "Your receipt inbox")
              : t("inboxBannerTitleSoon", "Receipt inbox · Coming soon")}
          </h3>

          {/* Alias row — focal element when infra is on; replaced by an
              honest preview when infra is off. Mobile breakpoint stacks
              the [Copy] button below the address. */}
          {infraEnabled && alias ? (
            <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
              <code className="flex-1 min-w-0 truncate font-mono text-[13.5px] sm:text-sm
                               px-3 py-2.5 rounded-lg bg-gray-100 dark:bg-gray-900
                               border border-gray-200 dark:border-gray-700
                               text-gray-900 dark:text-gray-100 select-all">
                {alias}
              </code>
              <button
                type="button"
                onClick={onCopy}
                aria-label={copied
                  ? t("inboxCopied", "Copied!")
                  : t("inboxCopyAria", "Copy receipt inbox address")}
                className="inline-flex items-center justify-center gap-1.5 min-h-[44px]
                           px-3.5 py-2 rounded-lg text-[13px] font-semibold
                           bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900
                           hover:bg-gray-700 dark:hover:bg-gray-200 transition
                           focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-emerald-500 focus-visible:ring-offset-2
                           focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800"
              >
                {copied
                  ? <><Check className="w-4 h-4" aria-hidden="true" /> {t("inboxCopied", "Copied!")}</>
                  : <><Copy className="w-4 h-4" aria-hidden="true" /> {t("inboxCopy", "Copy")}</>}
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <code className="inline-block font-mono text-[13px] sm:text-sm px-3 py-2 rounded-lg
                               bg-gray-100/70 dark:bg-gray-900/60 border border-dashed
                               border-gray-300 dark:border-gray-700
                               text-gray-500 dark:text-gray-400 italic">
                {t("inboxAliasPreview", "sudip-xyz@in.bonbox.dk")}
              </code>
            </div>
          )}

          {/* Description — hidden in collapsed mode to keep the page un-
              cluttered. The alias + status row above remain visible so the
              owner can copy + check count at a glance; the explanation
              shows when they actually want to learn the flow. */}
          {expanded && (
            <p className="mt-3 text-[13.5px] text-gray-700 dark:text-gray-300 leading-relaxed">
              {infraEnabled
                ? t(
                    "inboxBannerBody",
                    "Forward any receipt to this address. We'll OCR it, draft an Expense, and notify you. Stored for 5 years per Bogføringsloven §10 — your revisor sees a complete audit trail.",
                  )
                : t(
                    "inboxBannerBodySoon",
                    "We're wiring up our inbound email provider. You'll get a personal inbox like the preview above — forward any receipt and BonBox drafts the Expense for you. Stored for 5 years per Bogføringsloven §10 so your revisor has a complete audit trail.",
                  )}
            </p>
          )}

          {/* Status row — dot + label, optional CTA on the right. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 justify-between">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span
                className={`w-2 h-2 rounded-full ${
                  infraEnabled
                    ? (isAtCap ? "bg-amber-500" : "bg-emerald-500")
                    : "bg-amber-500"
                }`}
                aria-hidden="true"
              />
              <span className={`font-medium ${
                infraEnabled
                  ? (isAtCap
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-emerald-700 dark:text-emerald-300")
                  : "text-amber-700 dark:text-amber-300"
              }`}>
                {infraEnabled
                  ? t("inboxStatusActive", "Active")
                  : t("inboxStatusPending", "Pending setup · estimated <2 weeks")}
              </span>
              {infraEnabled && (
                <span className="text-gray-500 dark:text-gray-400">
                  ·{" "}
                  {isUnlimited
                    ? t("inboxCountUnlimited", "{n} this month", { n: count })
                    : t("inboxCountOfCap", "{n} of {cap} this month", { n: count, cap })}
                </span>
              )}
            </div>

            {/* Send-test button — only meaningful when the owner has
                actively expanded the card to engage with the feature.
                In collapsed mode the status dot + count is enough; the
                test button would just add visual weight to a row most
                owners glance past. */}
            {infraEnabled && expanded && (
              <button
                type="button"
                onClick={onSendTest}
                disabled={!isOwner || testing}
                title={!isOwner
                  ? t("inboxTestOwnerOnly", "Owner-only — ask the account owner to send a test.")
                  : undefined}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5
                           rounded-lg text-[12.5px] font-semibold
                           bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800
                           text-white shadow-sm transition
                           disabled:opacity-50 disabled:cursor-not-allowed
                           focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-emerald-500 focus-visible:ring-offset-2
                           focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800"
              >
                {testing
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> {t("inboxSendingTest", "Sending…")}</>
                  : <><Send className="w-3.5 h-3.5" aria-hidden="true" /> {t("inboxSendTest", "Send test email")}</>}
              </button>
            )}
          </div>

          {/* Honest near-cap nudge (Free tier only — Starter+ is unlimited). */}
          {infraEnabled && isNearCap && (
            <div className="mt-3 flex items-start gap-2 text-[12.5px]
                            text-amber-800 dark:text-amber-300
                            bg-amber-50 dark:bg-amber-900/20
                            border border-amber-200 dark:border-amber-800/40
                            rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {isAtCap
                  ? t(
                      "inboxAtCapHint",
                      "You've used all {cap} inbox receipts this month — extra mails are held safely for 30 days; upgrade to Starter to release them.",
                      { cap },
                    )
                  : t(
                      "inboxNearCapHint",
                      "Only {left} of {cap} inbox receipts left this month — upgrade to Starter for unlimited forwarding.",
                      { left: cap - count, cap },
                    )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Inline toast — keep it inside the banner so it doesn't compete
          with the global toast tray on /connections. Auto-dismisses via
          the setTimeout chain in onSendTest / onCopy. */}
      {toast && (
        <div
          role="status"
          className={`mt-3 text-[12.5px] rounded-lg px-3 py-2 ${
            toast.kind === "success"
              ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800/40"
              : "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/40"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
