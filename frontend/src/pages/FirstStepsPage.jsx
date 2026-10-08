/**
 * FirstStepsPage — "Du er klar": the one obvious next step after onboarding.
 *
 * A Danish café owner says "ja" at the door, signs up on their own phone,
 * finishes the four-step wizard — and then? They used to land on a page
 * chosen for them with nothing saying what to do first. This page answers it
 * in two cards:
 *
 *   1. "Lav din første kasserapport" — the primary. One tap opens the Daily
 *      close wizard, which starts on today's business day (the server's day
 *      cutoff). The one-line hint says the two ways in: snap the Z-bon, or
 *      type the totals.
 *   2. "Inviter dit personale" — type a first name and BonBox makes that
 *      person's invite with the EXISTING staff-link machinery (POST
 *      /staff/members, then /staff/members/{id}/link): their personal link
 *      (as a QR code to scan off this screen and as a share link) and their
 *      6-character join code for /join. BonBox sends no SMS and no e-mail
 *      here — the owner shares through the phone's own share sheet, or copies.
 *
 * Reached from the wizard's finish (food / bar archetypes, whose first win is
 * the daily close) at /getting-started; a normal protected route, so a reload
 * or a later visit works. "Gå til oversigten" leaves for the dashboard.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Icon } from "../components/ui";
import { errText } from "../utils/errText";
import { publicUrl } from "../utils/publicUrl";

const FIELD =
  "w-full min-h-[44px] px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400";

export default function FirstStepsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const isOwner = String(user?.role || "owner").toLowerCase() === "owner";

  // Invite card state: the name being typed, the invite once made.
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invite, setInvite] = useState(null); // { name, url, code }
  const [copied, setCopied] = useState(false);

  const makeInvite = async (e) => {
    e?.preventDefault?.();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.post("/staff/members", { name: clean });
      const memberId = created?.data?.id;
      if (!memberId) throw new Error("no member id");
      const link = await api.post(`/staff/members/${memberId}/link`);
      setInvite({
        name: clean,
        url: publicUrl(link.data.portal_url),
        code: link.data.join_code || "",
      });
      setName("");
    } catch (err) {
      setError(errText(err, t("firstStepsInviteFailed", "Couldn't make the invite — try again.")));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!invite?.url) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("firstStepsCopyFailed", "Couldn't copy — share the link instead."));
    }
  };

  const shareLink = async () => {
    if (!invite?.url) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      const restaurant = user?.business_name || "BonBox";
      try {
        await navigator.share({
          title: t("scheduleShareLinkTitle", "Your schedule · {restaurant}", { restaurant }),
          text: t(
            "firstStepsShareText",
            "Hi {name}, here's your link to your shifts at {restaurant}. Or type the code {code} at bonbox.dk/join.",
            { name: invite.name.split(/\s+/)[0], restaurant, code: invite.code },
          ),
          url: invite.url,
        });
      } catch {
        // The owner closed the share sheet — nothing failed, nothing to say.
        return;
      }
    } else {
      copyLink();
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="sticky top-0 z-10 bg-gray-50/80 dark:bg-gray-950/80 backdrop-blur-md border-b border-gray-200/70 dark:border-gray-800/70">
        <div className="max-w-xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gray-900 dark:bg-gray-100 grid place-items-center text-white dark:text-gray-900 font-semibold text-[13px]">
              B
            </div>
            <span className="text-sm font-semibold tracking-tight">BonBox</span>
          </div>
          <Link
            to="/dashboard"
            className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:underline underline-offset-2"
          >
            {t("firstStepsToDashboard", "Go to the overview")}
          </Link>
        </div>
      </header>

      <main className="flex-1 w-full flex justify-center px-4 sm:px-6 py-8 sm:py-12">
        <div className="w-full max-w-xl animate-fadeIn">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("firstStepsEyebrow", "Next step")}
          </p>
          <h1 className="mt-1 text-2xl sm:text-[28px] font-bold tracking-[-0.025em] text-gray-900 dark:text-gray-100">
            {t("firstStepsTitle", "You're ready")}
          </h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t("firstStepsLede", "Start with today's figures — the rest can wait.")}
          </p>

          {/* 1 — the primary: today's kasserapport, one tap. */}
          <button
            type="button"
            onClick={() => navigate("/daily-close")}
            data-testid="first-steps-close"
            className="mt-6 w-full text-left flex items-center gap-4 rounded-2xl border border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-900 p-4 sm:p-5 shadow-sm hover:shadow transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <span className="shrink-0 w-11 h-11 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 grid place-items-center" aria-hidden="true">
              <Icon name="ClipboardList" size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("firstStepsCloseTitle", "Make your first kasserapport")}
              </span>
              <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                {t("firstStepsCloseHint", "Snap the Z-report, or type in the day's totals yourself.")}
              </span>
            </span>
            <Icon name="ChevronRight" size={18} className="shrink-0 text-gray-400" />
          </button>

          {/* 2 — invite the staff: the existing link + join code, shared by
              the owner's own phone. Owner only (minting a staff link is). */}
          {isOwner && (
            <section
              className="mt-4 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 sm:p-5"
              aria-labelledby="first-steps-invite-title"
              data-testid="first-steps-invite"
            >
              <div className="flex items-start gap-4">
                <span className="shrink-0 w-11 h-11 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 grid place-items-center" aria-hidden="true">
                  <Icon name="Users" size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id="first-steps-invite-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
                    {t("firstStepsInviteTitle", "Invite your staff")}
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                    {t("firstStepsInviteBody", "Type a name and you get their own link and code — they open it on their own phone and see their shifts.")}
                  </p>
                </div>
              </div>

              {!invite && (
                <form onSubmit={makeInvite} className="mt-4 flex flex-col sm:flex-row gap-2">
                  <label htmlFor="first-steps-name" className="sr-only">
                    {t("firstStepsNameLabel", "Their first name")}
                  </label>
                  <input
                    id="first-steps-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("firstStepsNamePlaceholder", "e.g. Sofie")}
                    autoComplete="off"
                    maxLength={100}
                    className={FIELD}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    busy={busy}
                    disabled={!name.trim() || busy}
                    className="sm:shrink-0 min-h-[44px]"
                  >
                    {t("firstStepsMakeInvite", "Make invite")}
                  </Button>
                </form>
              )}

              {invite && (
                <div className="mt-4" data-testid="first-steps-invite-ready">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t("firstStepsInviteReady", "{name} can connect now:", { name: invite.name })}
                  </p>
                  <div className="mt-3 flex items-center gap-4">
                    <div className="shrink-0 rounded-xl bg-white p-2 border border-gray-200 dark:border-gray-700">
                      <QRCodeSVG value={invite.url} size={116} level="M" aria-label={t("firstStepsQrAria", "QR code with their link")} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                        {t("firstStepsCodeLabel", "Code")}
                      </p>
                      <p className="font-mono text-2xl font-semibold tracking-[0.2em] text-gray-900 dark:text-gray-100" data-testid="first-steps-code">
                        {invite.code || "—"}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                        {t("firstStepsCodeHint", "Scan the QR with their camera, share the link — or they type the code at bonbox.dk/join. The code lasts 7 days.")}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="primary" onClick={shareLink} iconLeft={<Icon name="Share2" size={16} />}>
                      {t("firstStepsShare", "Share link")}
                    </Button>
                    <Button variant="secondary" onClick={copyLink} iconLeft={<Icon name={copied ? "Check" : "Copy"} size={16} />}>
                      {copied ? t("firstStepsCopied", "Copied") : t("firstStepsCopy", "Copy link")}
                    </Button>
                    <Button variant="ghost" onClick={() => { setInvite(null); setCopied(false); }}>
                      {t("firstStepsInviteAnother", "Invite one more")}
                    </Button>
                  </div>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3">
                    {t("firstStepsNoSms", "BonBox sends no text message — you share it from your own phone.")}
                  </p>
                </div>
              )}

              {error && (
                <p className="text-xs text-red-700 dark:text-red-400 mt-3" role="alert">{error}</p>
              )}
            </section>
          )}

          <div className="mt-8 text-center">
            <Link
              to="/dashboard"
              className="text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:underline underline-offset-2"
            >
              {t("firstStepsToDashboard", "Go to the overview")}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
