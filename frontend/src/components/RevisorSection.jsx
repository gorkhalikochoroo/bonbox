/**
 * RevisorSection — invite + manage the owner's revisor read-only login.
 *
 * Extracted from ProfilePage.jsx in Task #204 P2.8 so the canonical
 * home for this surface is /team (where the rest of the people-with-
 * access live). ProfilePage now just shows a one-line breadcrumb
 * pointing to /team.
 *
 * Behaviour preserved verbatim from the previous ProfilePage version:
 *   • POST /api/accountants/invite — magic-link flow, no plaintext
 *     password ever surfaces (already migrated in Task #49 + #202).
 *   • DELETE /api/accountants/grants/{id} — revoke.
 *   • Locks behind 402 plan_required → renders an "Upgrade to Starter"
 *     hint (revisor invite is Starter+).
 *
 * DK terminology lock (per Manoj's memory):
 *   `revisor` stays Danish even in EN UI strings — it's the
 *   jurisdiction-locked term for "DK certified accountant". No
 *   "Accountant" translation.
 */
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { Button, Card, Icon } from "./ui";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";
import ClaimQuestionResend from "./ClaimQuestionResend";

const INPUT_CLASS =
  "w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 " +
  "bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 " +
  "placeholder:text-gray-400 dark:placeholder:text-gray-500 " +
  "focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent";

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function Message({ tone, children }) {
  const palette =
    tone === "success"
      ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/50"
      : tone === "notice"
        ? "bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-800/50"
        : "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/50";
  return (
    <div className={`text-xs px-3 py-2 rounded-lg border ${palette}`}>
      {children}
    </div>
  );
}

export default function RevisorSection() {
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const confirm = useConfirm();
  const [revisorEmail, setRevisorEmail] = useState("");
  const [revisorName, setRevisorName] = useState("");
  const [grants, setGrants] = useState([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [revisorSaving, setRevisorSaving] = useState(false);
  const [revisorMsg, setRevisorMsg] = useState("");
  const [revisorError, setRevisorError] = useState("");
  const [revisorLocked, setRevisorLocked] = useState(false);
  // Copyable fallback link — the invite email can silently fail (spam filter,
  // RESEND_API_KEY unset), so the owner always gets a link they can share by
  // hand. Persists until the next invite (not auto-cleared like the message).
  const [inviteLink, setInviteLink] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  // The last invite was saved but not e-mailed because the owner's own
  // address is unconfirmed (BonBox e-mails the invitation only once it is).
  const [inviteHeld, setInviteHeld] = useState(false);
  // Whether the last invite response said the e-mail did not leave.
  const [inviteUnsent, setInviteUnsent] = useState(false);
  // The last re-send was not mailed because the same link went out by mail
  // less than 24 hours ago (server: email_not_sent_reason "recently_sent").
  const [inviteRecent, setInviteRecent] = useState(false);
  // The pending row whose "Send invitation" is in flight.
  const [resendingId, setResendingId] = useState(null);
  // "Confirmed" for sending means: the address is confirmed AND no "did you
  // create this account?" question waits for an answer (the server holds
  // the invite either way — release gate, 9 Oct).
  const claimOpen = user?.email_verified === true && user?.claim_question_open === true;
  const ownerConfirmed = user?.email_verified === true && !claimOpen;
  // The last invite was held because the question is open (reason
  // "claim_question_open"): said in those words, with "Send spørgsmålet igen".
  const [inviteHeldClaim, setInviteHeldClaim] = useState(false);

  const refreshGrants = () => {
    setGrantsLoading(true);
    api
      .get("/accountants/grants")
      .then((res) => setGrants(res.data || []))
      .catch(() => setGrants([]))
      .finally(() => setGrantsLoading(false));
  };

  useEffect(() => {
    refreshGrants();
  }, []);

  const inviteRevisor = async (e) => {
    e.preventDefault();
    setRevisorError("");
    setRevisorMsg("");
    const email = revisorEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setRevisorError(
        t("revisorEmailInvalid", "Enter a valid email address."),
      );
      return;
    }
    setRevisorSaving(true);
    setLinkCopied(false);
    try {
      const res = await api.post("/accountants/invite", {
        email,
        name: revisorName.trim() || null,
      });
      showInviteResult(res);
      setRevisorEmail("");
      setRevisorName("");
      refreshGrants();
    } catch (err) {
      showInviteError(err);
    } finally {
      setRevisorSaving(false);
    }
  };

  /** What the server said about one invite, in the owner's words. */
  const showInviteResult = (res) => {
    setInviteLink(res.data?.accept_url || "");
    const reason = res.data?.email_not_sent_reason;
    const notNow = res.data?.email_sent === false;
    const heldClaim = notNow && reason === "claim_question_open";
    const held = notNow && (reason === "email_unverified" || heldClaim);
    setInviteHeldClaim(heldClaim);
    // The same link already went out by mail less than 24 hours ago: nothing
    // was sent now, but a mail DID leave — so "Didn't arrive?" stays true.
    const recent = notNow && reason === "recently_sent";
    const unsent = notNow && !recent;
    setInviteUnsent(unsent);
    setInviteHeld(held);
    setInviteRecent(recent);
    // Only claim a sent e-mail when the server says it left; otherwise the
    // copy-link below is the way to reach the revisor.
    const msg = heldClaim
      ? t("revisorInviteHeldClaimOpen", "Invite saved, but not e-mailed yet: BonBox is waiting for your answer to the question we e-mailed you (did you create this account yourself?). Once you've answered, tap Send invitation next to your revisor below.")
      : held
      ? t("revisorInviteHeldUnverified", "Invite saved, but not e-mailed yet: BonBox e-mails your revisor the invitation only once your own e-mail is confirmed. Confirm it, then tap Send invitation next to your revisor below.")
      : recent
        ? t("revisorInviteRecentlySent", "This invite was e-mailed less than 24 hours ago, so BonBox didn't send it again.")
        : unsent
          ? t("revisorInviteNotEmailed", "The invite is ready, but the e-mail could not be sent. Copy the link below and send it to your accountant. It works for 7 days.")
          : t("revisorInviteSent", "Invite sent. They have 7 days to accept.");
    setRevisorMsg(msg);
    // A "could not e-mail" / "not again" notice stays until the owner acts on
    // it; a "sent" one fades — without wiping a later notice that replaced it.
    if (!notNow) setTimeout(() => setRevisorMsg((m) => (m === msg ? "" : m)), 5000);
  };

  /** "Send invitation" on a pending row whose link was never e-mailed (held
   *  while the owner was unconfirmed, or the mail server refused it). Same
   *  endpoint and gates as the form: the server re-arms the SAME grant with
   *  the SAME link (one the owner already handed over keeps working, now for
   *  7 more days) and mails it — once; a second tap within 24 hours sends
   *  nothing. */
  const sendInvitation = async (g) => {
    setRevisorError("");
    setRevisorMsg("");
    setLinkCopied(false);
    setResendingId(g.id);
    try {
      const res = await api.post("/accountants/invite", {
        email: g.accountant_email,
        name: g.accountant_name || null,
      });
      showInviteResult(res);
      refreshGrants();
    } catch (err) {
      showInviteError(err);
    } finally {
      setResendingId(null);
    }
  };

  const showInviteError = (err) => {
    const detail = err?.response?.data?.detail;
    if (err?.response?.status === 402 && detail?.code === "plan_required") {
      setRevisorLocked(true);
      // App Store compliance (Apple 3.1.1): neutral message on native (no
      // tier name / "upgrade"). Web keeps the conversion copy.
      setRevisorError(
        isNativeApp()
          ? t("revisorPlanRequiredNative", "Inviting a revisor isn't part of your current plan.")
          : t("revisorPlanRequired", "Inviting a revisor is on Starter. Upgrade to unlock read-only revisor access."),
      );
    } else if (detail?.code === "already_active_grant") {
      setRevisorError(
        t("revisorAlreadyActive", "This revisor already has active access."),
      );
    } else if (detail?.code === "demo_recipient") {
      // The demo seeder's sample revisor: no invite mail goes there.
      setRevisorError(
        t("dcRevisorIsDemo", "The revisor is sample data — save your own revisor's name and e-mail on Profile."),
      );
    } else if (detail?.code === "demo_identity") {
      // The business is still the demo's sample company: the invite would
      // introduce "Mirabelle ApS" to a real revisor.
      setRevisorError(
        t("identityIsDemoNotice", "Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor."),
      );
    } else {
      setRevisorError(
        errText(err, t("revisorInviteFailed", "Could not send the invite. Try again.")),
      );
    }
  };

  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions) — the input stays
      // selectable so the owner can still copy manually. No error surfaced.
    }
  };

  const revokeRevisor = async (g) => {
    // "Revoke this revisor's access?" read the same for every row in the list.
    // With a bookkeeper and their stand-in both invited, the owner had only
    // their memory of which Revoke they tapped — and revoke also burns the
    // invite, so the wrong tap costs that revisor a fresh invitation. The
    // dialog now repeats the person back in the same words the row shows.
    const who = g.accountant_name
      ? `${g.accountant_name} · ${g.accountant_email}`
      : g.accountant_email;
    const ok = await confirm({
      title: t("revisorRevokeTitleNamed", "Revoke revisor access for {who}?", { who }),
      // Two different truths behind one button: an accepted grant has a login
      // to lose, a pending invite does not. The same sentence for both told
      // the owner that revoking an invitation nobody ever opened cuts off an
      // access that never existed.
      message: g.status === "pending"
        ? t(
            "revisorRevokeBodyPending",
            "{who} has not accepted yet, so there is no login to cut off — but the invite link stops working the moment you confirm. Letting them in later means sending a new invitation.",
            { who: g.accountant_name || g.accountant_email },
          )
        : t(
            "revisorRevokeBodyConsequence",
            "The revisor loses their read-only login the moment you confirm, and their invite link stops working — letting them back in means sending a new invite.",
          ),
      confirmLabel: t("revoke", "Revoke"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/accountants/grants/${g.id}`);
      refreshGrants();
    } catch (err) {
      setRevisorError(
        err?.response?.data?.detail?.message ||
          t("revisorRevokeFailed", "Could not revoke. Try again."),
      );
    }
  };

  return (
    <Card>
      <Card.Header
        title={t("teamRevisorSectionTitle", "Revisor")}
        subtitle={t(
          "teamRevisorSectionSubtitle",
          "Free read-only login for your accountant. They see fakturaer, daily closes, expenses, MOMS overview — they can't change a single thing.",
        )}
        icon={<Icon name="KeyRound" size={18} />}
      />
      <form onSubmit={inviteRevisor} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t("revisorEmailLabel", "Revisor email")}>
            <input
              type="email"
              value={revisorEmail}
              onChange={(e) => setRevisorEmail(e.target.value)}
              placeholder="anna@revisor.dk"
              maxLength={254}
              className={INPUT_CLASS}
              autoComplete="off"
            />
          </Field>
          <Field label={t("revisorNameLabel", "Name (optional)")}>
            <input
              type="text"
              value={revisorName}
              onChange={(e) => setRevisorName(e.target.value)}
              placeholder="Anna Hansen"
              maxLength={255}
              className={INPUT_CLASS}
              autoComplete="off"
            />
          </Field>
        </div>
        {revisorMsg && (
          <Message tone={inviteHeld || inviteRecent ? "notice" : "success"}>
            <span data-testid={inviteHeld ? "revisor-invite-held" : undefined}>{revisorMsg}</span>
            {/* Held while the question is open: "Send spørgsmålet igen". */}
            {inviteHeld && inviteHeldClaim && claimOpen && (
              <ClaimQuestionResend className="ml-2" testId="revisor-invite-claim-resend" />
            )}
            {/* Held for an unconfirmed account: the one tap that fixes it. */}
            {inviteHeld && !inviteHeldClaim && user?.email_verified !== true && (
              <Link
                to="/verify-email?now=1"
                className="ml-2 inline-flex items-center font-semibold underline underline-offset-2"
              >
                {t("verifyEmailNowCta", "Confirm now")}
              </Link>
            )}
          </Message>
        )}
        {inviteLink && (
          <div className="text-xs px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-2">
            <div className="text-gray-600 dark:text-gray-400">
              {/* "Didn't arrive?" only when a mail actually left. */}
              {inviteUnsent
                ? t("revisorCopyLinkHintUnsent", "Or send your revisor this link yourself — it works for 7 days.")
                : t("revisorCopyLinkHint", "Didn't arrive? Send your revisor this link yourself — it works for 7 days.")}
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteLink}
                onFocus={(e) => e.target.select()}
                className={INPUT_CLASS + " flex-1 font-mono text-[11px]"}
              />
              <Button type="button" variant="secondary" size="sm" onClick={copyInviteLink}>
                {linkCopied ? t("copied", "Copied") : t("copyLink", "Copy link")}
              </Button>
            </div>
          </div>
        )}
        {revisorError && <Message tone="error">{revisorError}</Message>}
        {revisorLocked && (
          <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {/* App Store compliance (Apple 3.1.1): neutral hint on native (no
                tier name / "upgrade"); the "See plans" link is web-only. */}
            {isNativeApp()
              ? t("revisorUpgradeHintNative", "Inviting a revisor isn't part of your current plan.")
              : t("revisorUpgradeHint", "Upgrade to Starter to invite revisors.")}{" "}
            {canPurchaseInApp() && (
              <Link to="/subscription" className="underline font-medium">
                {t("seePlans", "See plans")}
              </Link>
            )}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button type="submit" variant="primary" busy={revisorSaving}>
            {revisorSaving
              ? t("sending", "Sending…")
              : t("revisorSendInvite", "Send invite")}
          </Button>
        </div>
      </form>

      {/* Existing grants list */}
      <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
        <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t("revisorListTitle", "Active and recent invites")}
        </div>
        {grantsLoading && grants.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 py-2">
            {t("loading", "Loading…")}
          </div>
        ) : grants.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 py-2">
            {t(
              "revisorEmptyState",
              "No revisor invites yet. Send one above to give your revisor their own login.",
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {grants.map((g) => {
              const isActive = g.status === "active";
              const isPending = g.status === "pending";
              // The server says this pending invite's link was never e-mailed
              // (held while the owner was unconfirmed, or the mail server
              // refused it) — true after a reload too. Older rows carry no
              // mark and read as before.
              const notMailed = isPending && !!g.mail_held;
              const sinceDate = g.invited_at
                ? new Date(g.invited_at).toLocaleDateString()
                : "";
              return (
                <li
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {g.accountant_name ? `${g.accountant_name} · ` : ""}
                      {g.accountant_email}
                    </div>
                    {/* Distinct chip per Task #204 P2.8 — "Revisor — read-only · since {date}" */}
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                      <span
                        className={
                          "inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mr-2 " +
                          (isActive
                            ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            : isPending
                              ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
                              : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300")
                        }
                      >
                        {isActive
                          ? t("teamRevisorChipActive", "Revisor — read-only · since {date}", {
                              date: sinceDate,
                            })
                          : notMailed
                            ? t("teamRevisorChipNotMailed", "Revisor — saved · not e-mailed yet")
                            : isPending
                              ? t("teamRevisorChipPending", "Revisor — invited · awaiting accept")
                              : t("revisorStatusRevoked", "Revoked")}
                      </span>
                      {g.last_used_at && (
                        <>
                          {t("revisorLastLogin", "Last seen")}{" "}
                          {new Date(g.last_used_at).toLocaleDateString()}
                        </>
                      )}
                    </div>
                  </div>
                  {g.status !== "revoked" && (
                    <div className="flex items-center gap-1">
                      {/* A never-mailed invite of an unconfirmed owner: the
                          one tap that lets BonBox send it. */}
                      {/* …or, while "did you create this account?" is
                          open, the question mailed again — never "Bekræft
                          nu" to a confirmed address. */}
                      {notMailed && claimOpen && (
                        <ClaimQuestionResend className="text-xs text-amber-800 dark:text-amber-200 px-1.5" testId={`revisor-grant-claim-resend-${g.id}`} />
                      )}
                      {notMailed && !ownerConfirmed && !claimOpen && (
                        <Link
                          to="/verify-email?now=1"
                          className="text-xs font-semibold underline underline-offset-2 text-amber-800 dark:text-amber-200 px-1.5"
                        >
                          {t("verifyEmailNowCta", "Confirm now")}
                        </Link>
                      )}
                      {/* Mails a never-mailed invite — once the owner's own
                          e-mail is confirmed (before that the server would
                          hold it again). An invite that already went out by
                          mail has no button: a second mail is not one tap. */}
                      {notMailed && ownerConfirmed && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          busy={resendingId === g.id}
                          disabled={resendingId !== null}
                          onClick={() => sendInvitation(g)}
                        >
                          {resendingId === g.id
                            ? t("sending", "Sending…")
                            : t("revisorSendInvitation", "Send invitation")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => revokeRevisor(g)}
                      >
                        {t("revoke", "Revoke")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
