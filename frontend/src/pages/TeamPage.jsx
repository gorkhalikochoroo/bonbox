import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";
import Modal from "../components/Modal";
import { Icon } from "../components/ui";
// Task #204 P2.8 — revisor invite moved from ProfilePage to TeamPage
// so the people-with-access surfaces all live in one place.
import RevisorSection from "../components/RevisorSection";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";
import { errText } from "../utils/errText";

const ROLE_COLORS = {
  owner: "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400",
  manager: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
  cashier: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
  viewer: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400",
};

// DK i18n leak fix — role icons are Lucide names (resolved by <Icon name />),
// not emoji. Crown=owner, ClipboardList=manager, Wallet=cashier, Eye=viewer.
// Localized descriptions/labels live on the t() side; this map only controls
// the visual glyph next to each role badge.
const ROLE_ICON_NAME = {
  owner: "Crown",
  manager: "ClipboardList",
  cashier: "Wallet",
  viewer: "Eye",
};

// Keys for localized role labels + descriptions. The labels render via t()
// at the call-site so locale switching is live (no re-mount needed).
const ROLE_LABEL_KEY = {
  owner: "teamRoleOwner",
  manager: "teamRoleManager",
  cashier: "teamRoleCashier",
  viewer: "teamRoleViewer",
};
const ROLE_DESC_KEY = {
  owner: "teamRoleDescOwner",
  manager: "teamRoleDescManager",
  cashier: "teamRoleDescCashier",
  viewer: "teamRoleDescViewer",
};

export default function TeamPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [members, setMembers] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [permissions, setPermissions] = useState(null);
  const [loading, setLoading] = useState(true);
  // Plan caps from /billing/me — drives the seat counter + the upgrade
  // prompt when at cap. Owner counts as 1 seat.
  const [billing, setBilling] = useState(null);

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("cashier");
  const [inviting, setInviting] = useState(false);
  // Toast-style result. NEVER carries a plaintext password or magic link.
  const [inviteResult, setInviteResult] = useState(null);
  const [error, setError] = useState("");

  // Confirm dialog — replaces native window.confirm().
  const [confirmState, setConfirmState] = useState(null);
  // { title, body, confirmLabel, onConfirm }

  const reloadAll = () =>
    Promise.all([
      api.get("/team/members"),
      api.get("/team/pending-invites").catch(() => ({ data: [] })),
    ]).then(([memRes, pendingRes]) => {
      setMembers(memRes.data || []);
      setPendingInvites(pendingRes.data || []);
    });

  // Fetch team + billing in parallel
  useEffect(() => {
    Promise.all([
      api.get("/team/members"),
      api.get("/team/permissions"),
      api.get("/billing/me").catch(() => ({ data: null })),
      api.get("/team/pending-invites").catch(() => ({ data: [] })),
    ])
      .then(([memRes, permRes, billingRes, pendingRes]) => {
        setMembers(memRes.data || []);
        setPermissions(permRes.data);
        setBilling(billingRes.data);
        setPendingInvites(pendingRes.data || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Seat math — owner counts as 1 seat (matches backend gate). Pending
  // invites also count so seat-aware UI stays honest.
  const teamCap = billing?.caps?.team_users ?? null;
  const seatsUsed = members.length + pendingInvites.length;
  // members already includes the owner; do not double-count
  const teamUnlimited = teamCap !== null && teamCap < 0;
  const teamAtCap = teamCap !== null && !teamUnlimited && seatsUsed >= teamCap;

  const isOwner = permissions?.is_owner;

  const handleInvite = async () => {
    if (!email.trim()) return;
    setInviting(true);
    setError("");
    try {
      const res = await api.post("/team/invite", { email: email.trim(), role, name: name.trim() });
      // res.data is { status, email, role, email_sent, expires_at, invite_token_sent }
      // It NEVER carries a plaintext password or the magic-link token.
      setInviteResult(res.data);
      await reloadAll();
    } catch (err) {
      setError(errText(err, t("teamInviteFailed")));
    }
    setInviting(false);
  };

  const handleResend = async (memberId) => {
    setError("");
    try {
      const res = await api.post(`/team/${memberId}/resend-invite`);
      setInviteResult(res.data);
      await reloadAll();
    } catch (err) {
      setError(errText(err, t("teamResendFailed")));
    }
  };

  const handleRevokeInvite = (memberId, emailAddr) => {
    setConfirmState({
      title: t("teamConfirmRevokeTitle"),
      body: t("teamConfirmRevokeBody", { email: emailAddr }),
      confirmLabel: t("teamConfirmRevokeCta"),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.post(`/team/${memberId}/revoke-invite`);
          await reloadAll();
        } catch (err) {
          setError(errText(err, t("teamRevokeFailed")));
        }
      },
    });
  };

  const changeRole = async (memberId, newRole) => {
    try {
      await api.patch(`/team/${memberId}/role`, { role: newRole });
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)));
    } catch (err) {
      setError(errText(err, t("teamUpdateRoleFailed")));
    }
  };

  const removeMember = (memberId, emailAddr) => {
    setConfirmState({
      title: t("teamConfirmRemoveTitle"),
      body: t("teamConfirmRemoveBody", { email: emailAddr }),
      confirmLabel: t("teamConfirmRemoveCta"),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.delete(`/team/${memberId}`);
          setMembers((prev) => prev.filter((m) => m.id !== memberId));
        } catch (err) {
          setError(errText(err, t("teamRemoveFailed")));
        }
      },
    });
  };

  const resetInvite = () => {
    setShowInvite(false);
    setEmail("");
    setName("");
    setRole("cashier");
    setInviteResult(null);
    setError("");
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[900px] mx-auto">
      <FadeIn>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("team")}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t("teamSubtitle")}
            </p>
            {/* Cap-aware seat counter — visible only when we have billing data */}
            {teamCap !== null && (
              <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5">
                {teamUnlimited
                  ? t("teamSeatsUnlimited")
                  : t("teamSeatsUsedOfCap", { used: seatsUsed, cap: teamCap })}
              </p>
            )}
          </div>
          {isOwner && (
            <button
              onClick={() => setShowInvite(!showInvite)}
              disabled={teamAtCap}
              title={teamAtCap ? t("teamAtCapHint") : ""}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {t("teamInviteCta")}
            </button>
          )}
        </div>
      </FadeIn>

      {/* Cap-hit banner — appears when at seat cap, even if invite form is closed.
          App Store compliance (Apple 3.1.1): the body pitches "Upgrade to Pro /
          Business", so the banner is hidden on native. Web unchanged. */}
      {teamAtCap && isOwner && !isNativeApp() && (
        <FadeIn>
          <div className="px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 text-[13px] text-amber-800 dark:text-amber-200 flex items-center gap-3 flex-wrap">
            <span className="font-semibold">
              {t("teamCapHitTitle", { cap: teamCap })}
            </span>
            <span>
              {t("teamCapHitBody")}
            </span>
            {canPurchaseInApp() && (
              <a href="/subscription" className="font-semibold text-amber-900 dark:text-amber-100 underline whitespace-nowrap">
                {t("seePlans")}
              </a>
            )}
          </div>
        </FadeIn>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Your role card */}
      {permissions && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center text-blue-600 dark:text-blue-300">
                <Icon name={ROLE_ICON_NAME[permissions.role] || "Users"} size={18} />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-800 dark:text-white">
                  {t("teamYourRole")} <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${ROLE_COLORS[permissions.role]}`}>{t(ROLE_LABEL_KEY[permissions.role]) || permissions.role}</span>
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{t(ROLE_DESC_KEY[permissions.role])}</p>
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Task #204 P2.8 — Revisor invite section.  Moved from
          ProfilePage so all people-with-access surfaces live on /team.
          Only the owner can invite revisors (backend enforces — service
          re-checks regardless of UI state). */}
      {isOwner && (
        <FadeIn>
          <RevisorSection />
        </FadeIn>
      )}

      {/* Invite form */}
      {showInvite && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm space-y-4">
            <h3 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("teamInviteHeader")}</h3>

            {inviteResult ? (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800/50 rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold text-green-800 dark:text-green-200">
                  {inviteResult.email_sent
                    ? t("teamInvitationSent", { email: inviteResult.email })
                    : t("teamInvitationCreated", { email: inviteResult.email })}
                </p>
                <p className="text-sm text-green-700 dark:text-green-300">
                  {inviteResult.email_sent
                    ? t("teamInvitationHelp")
                    : t("teamInvitationEmailFailed")}
                </p>
                <p className="text-xs text-green-700/70 dark:text-green-300/70">
                  {t("teamInvitationSecurity")}
                </p>
                <button onClick={resetInvite} className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
                  {t("teamInviteDone")}
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("teamFieldEmail")}
                    className="px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("teamFieldName")}
                    className="px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 mb-1.5 block">{t("teamFieldRole")}</label>
                  <div className="flex gap-2">
                    {["manager", "cashier", "viewer"].map((r) => (
                      <button
                        key={r}
                        onClick={() => setRole(r)}
                        className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-medium border transition ${
                          role === r
                            ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                            : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                        }`}
                      >
                        <span className="block">{t(ROLE_LABEL_KEY[r])}</span>
                        <span className="block text-[10px] mt-0.5 opacity-60">{t(ROLE_DESC_KEY[r])}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={handleInvite}
                  disabled={!email.trim() || inviting}
                  className="w-full py-2.5 bg-gray-900 text-white rounded-xl font-semibold hover:bg-gray-700 disabled:opacity-40 transition"
                >
                  {inviting ? t("teamInviteSending") : t("teamInviteSend")}
                </button>
              </>
            )}
          </div>
        </FadeIn>
      )}

      {/* Pending invites — visible above active members so the owner sees
          what's in-flight. Only the owner sees this section. */}
      {isOwner && pendingInvites.length > 0 && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              {t("teamPendingInvitesHeader")}
              <span className="ml-2 text-xs font-normal text-gray-400">{pendingInvites.length}</span>
            </h3>
            <div className="space-y-2">
              {pendingInvites.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-gray-50 dark:bg-gray-700/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.email}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      <span>{t(ROLE_LABEL_KEY[p.role]) || p.role}</span>
                      {" · "}
                      {p.expired
                        ? <span className="text-red-500">{t("teamPendingExpired")}</span>
                        : <span>{t("teamPendingDaysLeft", { n: p.days_remaining, s: p.days_remaining === 1 ? "" : "s" })}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleResend(p.id)}
                      className="px-2.5 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition"
                    >
                      {t("teamPendingResend")}
                    </button>
                    <button
                      onClick={() => handleRevokeInvite(p.id, p.email)}
                      className="px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 transition"
                    >
                      {t("teamPendingRevoke")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Team members list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />)}
        </div>
      ) : members.length > 0 ? (
        <FadeIn>
          <div className="space-y-3">
            {members.map((m) => (
              <div key={m.id} className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm flex items-center gap-2 sm:gap-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 uppercase">
                  {(m.business_name || m.email).slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 dark:text-white truncate">{m.business_name || m.email}</p>
                  <p className="text-xs text-gray-400 truncate">{m.email}</p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-bold inline-flex items-center gap-1 ${ROLE_COLORS[m.role]}`}>
                  <Icon name={ROLE_ICON_NAME[m.role] || "Users"} size={11} /> {t(ROLE_LABEL_KEY[m.role]) || m.role}
                </span>
                {isOwner && m.role !== "owner" && (
                  <div className="flex items-center gap-1">
                    <select
                      value={m.role}
                      onChange={(e) => changeRole(m.id, e.target.value)}
                      className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-xs text-gray-700 dark:text-gray-300"
                    >
                      <option value="manager">{t("teamRoleManager")}</option>
                      <option value="cashier">{t("teamRoleCashier")}</option>
                      <option value="viewer">{t("teamRoleViewer")}</option>
                    </select>
                    <button
                      onClick={() => removeMember(m.id, m.email)}
                      className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                      title={t("teamRemoveTitle")}
                      aria-label={t("teamRemoveAria", { email: m.email })}
                    >
                      <Icon name="Trash2" size={16} className="text-red-400" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </FadeIn>
      ) : (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-10 border border-gray-100 dark:border-gray-700 text-center">
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">{t("teamEmptyTitle")}</h3>
            <p className="text-sm text-gray-400 mb-4">{t("teamEmptyBody")}</p>
            {isOwner && (
              <button
                onClick={() => setShowInvite(true)}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition"
              >
                {t("teamInviteCta")}
              </button>
            )}
          </div>
        </FadeIn>
      )}

      {/* Role reference */}
      <FadeIn>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t("teamRolePermissions")}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {["owner", "manager", "cashier", "viewer"].map((r) => (
              <div key={r} className="flex items-start gap-2 p-2 rounded-lg">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold mt-0.5 inline-flex items-center gap-1 ${ROLE_COLORS[r]}`}>
                  <Icon name={ROLE_ICON_NAME[r]} size={10} /> {t(ROLE_LABEL_KEY[r])}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{t(ROLE_DESC_KEY[r])}</span>
              </div>
            ))}
          </div>
        </div>
      </FadeIn>

      {/* In-app confirm dialog — replaces native window.confirm() */}
      <Modal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={confirmState?.title || ""}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">{confirmState?.body}</p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmState(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition"
            >
              {t("teamConfirmCancel")}
            </button>
            <button
              onClick={async () => {
                const fn = confirmState?.onConfirm;
                setConfirmState(null);
                if (fn) await fn();
              }}
              className={`px-4 py-2 text-sm font-semibold text-white rounded-lg transition ${
                confirmState?.destructive
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-gray-900 hover:bg-gray-700"
              }`}
            >
              {confirmState?.confirmLabel || t("teamConfirmDefault")}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
