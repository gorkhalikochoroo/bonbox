/**
 * ConnectionsPage — the friction-killer hub.
 *
 * One page that surfaces ALL integrations BonBox supports with their
 * current connection status. Each card has a clear one-tap action:
 * "Connect" → wires up the relevant flow (no multi-step setup wizard,
 * no buried settings page). Owners see what's connected, what's not,
 * and can act in under 30 seconds per integration.
 *
 * Status-driven UI:
 *   • emerald dot + "Connected" → green, with a "Manage" link
 *   • amber dot + "Action needed" → mid-state (e.g. invite sent, awaiting
 *     accountant to accept)
 *   • gray dot + "Not connected" → CTA primary button
 *   • locked "Coming soon" → for features still in the spec stage
 *     (Aiia direct bank, MobilePay) so owners can see the roadmap
 *
 * No backend changes — pulls from existing endpoints:
 *   /business           — accountant_email, bank/MobilePay/IBAN fields
 *   /accountants/grants — revisor invites + their status
 *   /bank-import/...    — bank CSV upload history (existence = "connected")
 *   /email-preferences  — for the brief email toggle
 *
 * Mobile-first. Stone palette. Each card is a self-contained widget
 * so owners can scan vertically and tap whatever is most relevant.
 */
import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Card, Icon } from "../components/ui";

/**
 * Single connection card primitive. Shared layout so the page reads as
 * a consistent grid no matter how many integrations land here over
 * time. Status: "connected" | "pending" | "disconnected" | "soon".
 */
function ConnectionCard({
  icon = "Link2",
  title,
  description,
  status,             // see above
  statusLabel,        // override the dot label when needed
  primaryAction,      // { label, onClick, to, disabled }
  secondaryAction,    // optional { label, onClick, to }
  badge,              // optional small badge (e.g. "Pro feature")
  comingSoonNote,     // shown for status==="soon"
}) {
  const dot = {
    connected: "bg-emerald-500",
    pending: "bg-amber-500",
    disconnected: "bg-stone-400",
    soon: "bg-stone-300",
  }[status] || "bg-stone-300";

  const label = statusLabel || (
    status === "connected" ? "Connected"
    : status === "pending" ? "Action needed"
    : status === "soon" ? "Coming soon"
    : "Not connected"
  );

  return (
    <Card className="flex flex-col h-full">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-stone-100 dark:bg-stone-800 flex items-center justify-center shrink-0 text-stone-700 dark:text-stone-300">
          <Icon name={icon} size={18} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-stone-900 dark:text-stone-100 tracking-tight">
              {title}
            </h3>
            {badge && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium">
                {badge}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
            <span className="text-[11.5px] text-stone-500 dark:text-stone-400">{label}</span>
          </div>
        </div>
      </div>
      <p className="text-[13px] text-stone-600 dark:text-stone-300 leading-relaxed mb-4">
        {description}
      </p>
      {comingSoonNote && (
        <p className="text-[11.5px] text-stone-400 dark:text-stone-500 italic mb-3">
          {comingSoonNote}
        </p>
      )}
      <div className="mt-auto flex items-center gap-2">
        {primaryAction && (
          primaryAction.to ? (
            <Link
              to={primaryAction.to}
              className={`inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                status === "connected"
                  ? "bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700"
                  : "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-200"
              }`}
            >
              {primaryAction.label}
            </Link>
          ) : (
            <Button
              size="sm"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {primaryAction.label}
            </Button>
          )
        )}
        {secondaryAction && (
          secondaryAction.to ? (
            <Link
              to={secondaryAction.to}
              className="text-[12px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 transition"
            >
              {secondaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="text-[12px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 transition"
            >
              {secondaryAction.label}
            </button>
          )
        )}
      </div>
    </Card>
  );
}

export default function ConnectionsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [profile, setProfile] = useState(null);
  const [grants, setGrants] = useState([]);
  const [emailPrefs, setEmailPrefs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/business").then(r => r.data).catch(() => null),
      api.get("/accountants/grants").then(r => r.data || []).catch(() => []),
      api.get("/email-settings/preferences").then(r => r.data).catch(() => null),
    ]).then(([p, g, e]) => {
      if (!alive) return;
      setProfile(p);
      setGrants(g);
      setEmailPrefs(e);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // Derive status for each integration from the data we just fetched.
  // Pure derivation — no extra requests. If a derivation needs more
  // data later, it lives next to the card definition, not inside the
  // card primitive.
  const derived = useMemo(() => {
    const accountantEmail = profile?.accountant_email || "";
    const bankInfo = profile?.bank_account_number || profile?.iban || "";
    const mobilepay = profile?.mobilepay_number || "";

    // Revisor: counts pending + active grants. Active wins display-wise.
    const activeGrants = grants.filter(g => g.status === "active");
    const pendingGrants = grants.filter(g => g.status === "pending");
    let revisorStatus = "disconnected";
    let revisorLabel = "Not invited yet";
    if (activeGrants.length > 0) {
      revisorStatus = "connected";
      revisorLabel = activeGrants.length === 1
        ? "Connected · 1 revisor"
        : `Connected · ${activeGrants.length} revisorer`;
    } else if (pendingGrants.length > 0) {
      revisorStatus = "pending";
      revisorLabel = `Invite sent · awaiting response`;
    }

    return {
      bank: {
        // We don't store "is the bank connected?" anywhere yet, so the
        // best signal is "has the owner ever uploaded a CSV?" Until we
        // add a real connections registry, surface bank account info
        // existence as the proxy.
        status: bankInfo ? "connected" : "disconnected",
        label: bankInfo ? "Bank details saved" : "Not connected",
      },
      mobilepay: {
        status: mobilepay ? "connected" : "disconnected",
        label: mobilepay ? "MobilePay number saved" : "Not connected",
      },
      revisor: { status: revisorStatus, label: revisorLabel },
      accountantEmail: {
        status: accountantEmail ? "connected" : "disconnected",
        label: accountantEmail ? `Sending to ${accountantEmail}` : "No accountant email",
      },
      briefEmail: {
        status: emailPrefs?.daily_brief_email_enabled ? "connected" : "disconnected",
        label: emailPrefs?.daily_brief_email_enabled ? "Arrives 8am Copenhagen" : "Not subscribed",
      },
    };
  }, [profile, grants, emailPrefs]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-5 sm:p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-6 w-48 bg-stone-200 dark:bg-stone-700 rounded" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-44 bg-stone-100 dark:bg-stone-800 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-5 sm:p-6 pb-32 md:pb-12">
      {/* Header */}
      <div className="mb-7">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {t("connectionsTitle") || "Connections"}
        </h1>
        <p className="mt-2 text-[15px] text-stone-600 dark:text-stone-400 leading-relaxed max-w-2xl">
          {t("connectionsSubtitle") ||
            "Connect once, never again. Your bank, your MobilePay, your revisor, your accountant — all in one place. Each one is one tap and under 60 seconds."}
        </p>
      </div>

      {/* Grid of integration cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Bank */}
        <ConnectionCard
          icon="Landmark"
          title={t("connBankTitle") || "Bank reconciliation"}
          description={
            t("connBankDesc") ||
            "Upload your netbank CSV (Danske, Nordea, Jyske, Spar Nord, Lunar) — BonBox auto-matches payments to your fakturaer within ±2 kr."
          }
          status={derived.bank.status}
          statusLabel={derived.bank.label}
          primaryAction={{
            label: derived.bank.status === "connected"
              ? (t("connOpen") || "Open")
              : (t("connConnect") || "Connect"),
            to: "/bank-import",
          }}
          comingSoonNote={
            t("connBankAiiaSoon") ||
            "Aiia direct connection (no CSV) coming in the next release."
          }
        />

        {/* MobilePay — coming soon */}
        <ConnectionCard
          icon="CreditCard"
          title={t("connMobilePayTitle") || "MobilePay business"}
          description={
            t("connMobilePayDesc") ||
            "Direct settlement import — 30-50% of café revenue, auto-matched daily. No more typing MobilePay totals into your daily close."
          }
          status="soon"
          comingSoonNote={
            t("connMobilePaySoon") ||
            "Vipps MobilePay partner application in progress. Save your MobilePay number under Profile for now."
          }
          primaryAction={{
            label: t("connSetNumber") || "Set MobilePay number",
            to: "/profile#billing",
          }}
          secondaryAction={
            derived.mobilepay.status === "connected"
              ? { label: t("connEdit") || "Edit", to: "/profile#billing" }
              : null
          }
        />

        {/* Revisor (accountant login) */}
        <ConnectionCard
          icon="UserCog"
          title={t("connRevisorTitle") || "Your revisor"}
          description={
            t("connRevisorDesc") ||
            "Free read-only login for your accountant. They see fakturaer, daily closes, expenses, MOMS overview — can't change a single thing. No more password sharing or GDPR risk."
          }
          status={derived.revisor.status}
          statusLabel={derived.revisor.label}
          badge={t("connStarterBadge") || "Starter+"}
          primaryAction={{
            label: derived.revisor.status === "disconnected"
              ? (t("connInviteRevisor") || "Invite revisor")
              : (t("connManage") || "Manage"),
            to: "/profile#billing",
          }}
        />

        {/* Accountant email (for kasserapport sending) */}
        <ConnectionCard
          icon="Mail"
          title={t("connAccountantEmailTitle") || "Accountant email"}
          description={
            t("connAccountantEmailDesc") ||
            "Where your daily close PDFs and MOMS filings get sent. One-tap 'Email to my revisor' on every export. Separate from the revisor login above."
          }
          status={derived.accountantEmail.status}
          statusLabel={derived.accountantEmail.label}
          primaryAction={{
            label: derived.accountantEmail.status === "disconnected"
              ? (t("connSetEmail") || "Set email")
              : (t("connEdit") || "Edit"),
            to: "/profile#billing",
          }}
        />

        {/* Brief email */}
        <ConnectionCard
          icon="Sparkles"
          title={t("connBriefEmailTitle") || "Morning brief email"}
          description={
            t("connBriefEmailDesc") ||
            "Get the 9am brief in your inbox — revenue, MOMS countdown, regulars-at-risk, weather + recurring bills. Forward to your partner with one tap."
          }
          status={derived.briefEmail.status}
          statusLabel={derived.briefEmail.label}
          primaryAction={{
            label: derived.briefEmail.status === "connected"
              ? (t("connManage") || "Manage")
              : (t("connEnable") || "Enable"),
            to: "/profile#notifications",
          }}
        />

        {/* Sales channels — multi-select */}
        <ConnectionCard
          icon="Bike"
          title={t("connSalesChannelsTitle") || "Sales channels"}
          description={
            t("connSalesChannelsDesc") ||
            "Wolt, Uber Eats, Foodora, in-store, phone, catering. Tag every sale by source so the daily breakdown shows where revenue came from."
          }
          status="connected"
          statusLabel={t("connSalesChannelsAvail") || "Available — tag in /sales"}
          primaryAction={{
            label: t("connCustomize") || "Customize channels",
            to: "/channel-settings",
          }}
        />

        {/* Accountant bookkeeping export bridge */}
        <ConnectionCard
          icon="FileSpreadsheet"
          title={t("connBookkeepingTitle") || "Bookkeeping export"}
          description={
            t("connBookkeepingDesc") ||
            "Export your books in Dinero / Billy / e-conomic / Generic CSV format. Your revisor drops it straight into their accounting tool — no copy-paste."
          }
          status="connected"
          statusLabel={t("connBookkeepingReady") || "Ready to export"}
          primaryAction={{
            label: t("connExportNow") || "Export now",
            to: "/bookkeeping-export",
          }}
          secondaryAction={{
            label: t("connSendNow") || "Send to revisor",
            to: "/bookkeeping-export",
          }}
        />

        {/* Faktura — Stripe-like "we accept fakturas, you don't have to" */}
        <ConnectionCard
          icon="FileText"
          title={t("connFakturaTitle") || "Faktura sending"}
          description={
            t("connFakturaDesc") ||
            "Direct customer email with the PDF attached. Gap-free fakturanummer, kreditnota on void, bank auto-match when the payment arrives."
          }
          status="connected"
          statusLabel={t("connFakturaReady") || "Ready"}
          badge={t("connStarterBadge") || "Starter+"}
          primaryAction={{
            label: t("connOpenFaktura") || "Open Faktura",
            to: "/faktura",
          }}
        />
      </div>

      {/* Footer — sets the right expectation about what's NOT here */}
      <p className="mt-10 text-center text-[12px] text-stone-500 dark:text-stone-400 leading-relaxed max-w-2xl mx-auto">
        {t("connectionsFooter") ||
          "We deliberately don't connect to your POS — Lightspeed, Toast, Square keep that role. BonBox sits beside them and reads your sales register via daily sync. Same with payment terminals: keep your Dankort + iZettle, BonBox imports the daily totals."}
      </p>
    </div>
  );
}
