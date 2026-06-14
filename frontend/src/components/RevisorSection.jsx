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
import { useEffect, useState } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Card, Icon } from "./ui";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";

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
      : "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/50";
  return (
    <div className={`text-xs px-3 py-2 rounded-lg border ${palette}`}>
      {children}
    </div>
  );
}

export default function RevisorSection() {
  const { t } = useLanguage();
  const [revisorEmail, setRevisorEmail] = useState("");
  const [revisorName, setRevisorName] = useState("");
  const [grants, setGrants] = useState([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [revisorSaving, setRevisorSaving] = useState(false);
  const [revisorMsg, setRevisorMsg] = useState("");
  const [revisorError, setRevisorError] = useState("");
  const [revisorLocked, setRevisorLocked] = useState(false);

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
        t("revisorEmailInvalid") || "Enter a valid email address.",
      );
      return;
    }
    setRevisorSaving(true);
    try {
      await api.post("/accountants/invite", {
        email,
        name: revisorName.trim() || null,
      });
      setRevisorMsg(
        t("revisorInviteSent") ||
          `Invite sent to ${email}. They have 7 days to accept.`,
      );
      setRevisorEmail("");
      setRevisorName("");
      refreshGrants();
      setTimeout(() => setRevisorMsg(""), 5000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 402 && detail?.code === "plan_required") {
        setRevisorLocked(true);
        // App Store compliance (Apple 3.1.1): neutral message on native (no
        // tier name / "upgrade"). Web keeps the conversion copy.
        setRevisorError(
          isNativeApp()
            ? (t("revisorPlanRequiredNative") || "Inviting a revisor isn't part of your current plan.")
            : (t("revisorPlanRequired") ||
                "Inviting a revisor is on Starter. Upgrade to unlock read-only revisor access."),
        );
      } else if (detail?.code === "already_active_grant") {
        setRevisorError(
          t("revisorAlreadyActive") ||
            "This revisor already has active access.",
        );
      } else {
        setRevisorError(
          errText(err, t("revisorInviteFailed") ||
            "Could not send the invite. Try again."),
        );
      }
    } finally {
      setRevisorSaving(false);
    }
  };

  const revokeRevisor = async (grantId) => {
    if (!window.confirm(t("revisorRevokeConfirm") || "Revoke this revisor's access?")) return;
    try {
      await api.delete(`/accountants/grants/${grantId}`);
      refreshGrants();
    } catch (err) {
      setRevisorError(
        err?.response?.data?.detail?.message ||
          t("revisorRevokeFailed") ||
          "Could not revoke. Try again.",
      );
    }
  };

  return (
    <Card>
      <Card.Header
        title={t("teamRevisorSectionTitle") || "Revisor"}
        subtitle={
          t("teamRevisorSectionSubtitle") ||
          "Free read-only login for your accountant. They see fakturaer, daily closes, expenses, MOMS overview — they can't change a single thing."
        }
        icon={<Icon name="KeyRound" size={18} />}
      />
      <form onSubmit={inviteRevisor} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t("revisorEmailLabel") || "Revisor email"}>
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
          <Field label={t("revisorNameLabel") || "Name (optional)"}>
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
        {revisorMsg && <Message tone="success">{revisorMsg}</Message>}
        {revisorError && <Message tone="error">{revisorError}</Message>}
        {revisorLocked && (
          <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {/* App Store compliance (Apple 3.1.1): neutral hint on native (no
                tier name / "upgrade"); the "See plans" link is web-only. */}
            {isNativeApp()
              ? (t("revisorUpgradeHintNative") || "Inviting a revisor isn't part of your current plan.")
              : (t("revisorUpgradeHint") || "Upgrade to Starter to invite revisors.")}{" "}
            {canPurchaseInApp() && (
              <a href="/subscription" className="underline font-medium">
                {t("seePlans") || "See plans"}
              </a>
            )}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button type="submit" variant="primary" busy={revisorSaving}>
            {revisorSaving
              ? t("sending") || "Sending…"
              : t("revisorSendInvite") || "Send invite"}
          </Button>
        </div>
      </form>

      {/* Existing grants list */}
      <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
        <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t("revisorListTitle") || "Active and recent invites"}
        </div>
        {grantsLoading && grants.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 py-2">
            {t("loading") || "Loading…"}
          </div>
        ) : grants.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 py-2">
            {t("revisorEmptyState") ||
              "No revisor invites yet. Send one above to give your revisor their own login."}
          </div>
        ) : (
          <ul className="space-y-2">
            {grants.map((g) => {
              const isActive = g.status === "active";
              const isPending = g.status === "pending";
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
                          ? (t("teamRevisorChipActive") ||
                              "Revisor — read-only · since {date}").replace(
                              "{date}",
                              sinceDate,
                            )
                          : isPending
                            ? t("teamRevisorChipPending") ||
                              "Revisor — invited · awaiting accept"
                            : t("revisorStatusRevoked") || "Revoked"}
                      </span>
                      {g.last_used_at && (
                        <>
                          {t("revisorLastLogin") || "Last seen"}{" "}
                          {new Date(g.last_used_at).toLocaleDateString()}
                        </>
                      )}
                    </div>
                  </div>
                  {g.status !== "revoked" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => revokeRevisor(g.id)}
                    >
                      {t("revoke") || "Revoke"}
                    </Button>
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
