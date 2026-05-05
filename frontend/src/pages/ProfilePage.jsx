import { useState, useEffect } from "react";
import api from "../services/api";
import { useDarkMode } from "../hooks/useDarkMode";
import { useTheme, THEMES } from "../hooks/useTheme";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";
import usePushNotifications from "../hooks/usePushNotifications";
import BusinessLookup from "../components/BusinessLookup";
import { resetAllTips } from "../components/DismissibleTip";

export default function ProfilePage() {
  const [dark] = useDarkMode();
  const [theme, setTheme] = useTheme();
  const { t } = useLanguage();
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ business_name: "", business_type: "", currency: "", email: "" });
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [pwError, setPwError] = useState("");
  const [saving, setSaving] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [emailPrefs, setEmailPrefs] = useState({ daily_digest_enabled: false, expense_alerts_enabled: true });
  const [emailMsg, setEmailMsg] = useState("");
  // GDPR: per-user analytics opt-out. Synced from /auth/me. When ON,
  // backend silently drops every event_log write for this user.
  const [analyticsOptOut, setAnalyticsOptOut] = useState(false);
  const [privacyMsg, setPrivacyMsg] = useState("");
  // Tax preferences live in /tax-autopilot now (next to where they take effect),
  // so no local state for them here anymore — see TaxAutopilotPage.jsx.
  const { permission: pushPerm, supported: pushSupported, requestPermission: requestPush } = usePushNotifications();
  const [businessProfile, setBusinessProfile] = useState(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [waStatus, setWaStatus] = useState(null);
  const [waPhone, setWaPhone] = useState("");
  const [waMsg, setWaMsg] = useState("");
  const [waLinking, setWaLinking] = useState(false);
  const [waCode, setWaCode] = useState("");

  // GDPR: Export & Delete
  const [exporting, setExporting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    api.get("/auth/me").then((res) => {
      setUser(res.data);
      setForm({
        business_name: res.data.business_name || "",
        business_type: res.data.business_type || "",
        currency: res.data.currency || "DKK",
        email: res.data.email || "",
      });
      setAnalyticsOptOut(!!res.data.analytics_opt_out);
    });
    api.get("/email/preferences").then((res) => setEmailPrefs(res.data)).catch(() => {});
    api.get("/whatsapp/status").then((res) => setWaStatus(res.data)).catch(() => {});
    api.get("/business").then((res) => setBusinessProfile(res.data)).catch(() => {});
  }, []);

  const toggleEmailPref = async (key) => {
    const updated = { ...emailPrefs, [key]: !emailPrefs[key] };
    setEmailPrefs(updated);
    try {
      await api.patch("/email/preferences", updated);
    } catch { /* ignore */ }
  };

  /** Toggle product-analytics opt-out. Optimistic — rolls back on error. */
  const toggleAnalyticsOptOut = async () => {
    const next = !analyticsOptOut;
    setAnalyticsOptOut(next);
    setPrivacyMsg("");
    try {
      await api.patch("/auth/profile", { analytics_opt_out: next });
      setPrivacyMsg(next ? "Analytics paused — no new events will be recorded." : "Analytics resumed.");
      setTimeout(() => setPrivacyMsg(""), 4000);
    } catch {
      setAnalyticsOptOut(!next); // roll back
      setPrivacyMsg("Couldn't update — please try again.");
      setTimeout(() => setPrivacyMsg(""), 4000);
    }
  };

  const sendTestDigest = async () => {
    setSendingTest(true);
    setEmailMsg("");
    try {
      const res = await api.post("/email/test-digest");
      setEmailMsg(res.data.sent ? `${t("digestSentTo")} ${res.data.to}!` : t("digestFailedToSend"));
    } catch { setEmailMsg(t("failedToSendTest")); }
    setSendingTest(false);
    setTimeout(() => setEmailMsg(""), 4000);
  };

  const linkWhatsApp = async () => {
    if (!waPhone.trim()) return;
    setWaLinking(true);
    setWaMsg("");
    try {
      const res = await api.post("/whatsapp/link-phone", null, { params: { phone: waPhone } });
      setWaCode(res.data.code || "");
      setWaMsg(res.data.code ? "" : t("codeSentCheckWhatsapp"));
      setWaStatus({ linked: true, phone: waPhone, verified: false });
    } catch (err) {
      setWaMsg(err.response?.data?.detail || t("failedToLink"));
    }
    setWaLinking(false);
  };

  const unlinkWhatsApp = async () => {
    try {
      await api.delete("/whatsapp/unlink");
      setWaStatus({ linked: false, phone: null, verified: false });
      setWaPhone("");
      setWaMsg(t("whatsappUnlinked"));
      setTimeout(() => setWaMsg(""), 3000);
    } catch { /* ignore */ }
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const res = await api.patch("/auth/profile", form);
      setUser(res.data);
      // Update stored user in localStorage
      const stored = localStorage.getItem("bonbox_user");
      if (stored) {
        const parsed = JSON.parse(stored);
        localStorage.setItem("bonbox_user", JSON.stringify({ ...parsed, ...res.data }));
      }
      setSuccess(t("profileUpdated"));
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToUpdateProfile"));
    }
    setSaving(false);
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError("");
    setPwSuccess("");
    if (passwords.new_password !== passwords.confirm_password) {
      setPwError(t("passwordsDontMatch"));
      return;
    }
    if (passwords.new_password.length < 8) {
      setPwError(t("passwordMinLength"));
      return;
    }
    setChangingPw(true);
    try {
      await api.post("/auth/change-password", {
        current_password: passwords.current_password,
        new_password: passwords.new_password,
      });
      setPwSuccess(t("passwordChanged"));
      setPasswords({ current_password: "", new_password: "", confirm_password: "" });
      setTimeout(() => setPwSuccess(""), 3000);
    } catch (err) {
      setPwError(err.response?.data?.detail || t("failedToChangePassword"));
    }
    setChangingPw(false);
  };

  if (!user) return <div className="p-6 text-center text-gray-500">{t("loading")}</div>;

  const inputClass = "w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <FadeIn><h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("profile")}</h1></FadeIn>

      {/* Account Info */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-2xl font-bold text-blue-600 dark:text-blue-400">
            {user.business_name?.charAt(0)?.toUpperCase() || "B"}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{user.business_name}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{user.email}</p>
          </div>
        </div>

        <form onSubmit={saveProfile} className="space-y-4">
          <div>
            <label className={labelClass}>{t("emailLabel")}</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>{t("businessNameLabel")}</label>
            <input type="text" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>{t("businessTypeLabel")}</label>
              <select value={form.business_type} onChange={(e) => setForm({ ...form, business_type: e.target.value })} className={inputClass}>
                <option value="restaurant">{t("restaurantType")}</option>
                <option value="cafe">{t("cafeType")}</option>
                <option value="bar">{t("barType")}</option>
                <option value="bakery">{t("bakeryType")}</option>
                <option value="food_truck">{t("foodTruckType")}</option>
                <option value="retail">{t("retailShopType")}</option>
                <option value="clothing">{t("clothingStoreType")}</option>
                <option value="grocery">{t("groceryStoreType")}</option>
                <option value="salon">{t("salonBeautyType")}</option>
                <option value="pharmacy">{t("pharmacyType")}</option>
                <option value="other">{t("otherType")}</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>{t("currencyLabel")}</label>
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className={inputClass}>
                <option value="DKK">DKK - Danish Krone (Moms 25%)</option>
                <option value="SEK">SEK - Swedish Krona (Moms 25%)</option>
                <option value="NOK">NOK - Norwegian Krone (MVA 25%)</option>
                <option value="EUR">EUR - Euro (General, VAT 20%)</option>
                <option value="EUR_PT">EUR - Portugal (IVA 23%)</option>
                <option value="EUR_DE">EUR - Germany (MwSt 19%)</option>
                <option value="EUR_FR">EUR - France (TVA 20%)</option>
                <option value="EUR_ES">EUR - Spain (IVA 21%)</option>
                <option value="EUR_IT">EUR - Italy (IVA 22%)</option>
                <option value="EUR_NL">EUR - Netherlands (BTW 21%)</option>
                <option value="USD">USD - US Dollar (Sales Tax varies)</option>
                <option value="GBP">GBP - British Pound (VAT 20%)</option>
                <option value="NPR">NPR - Nepalese Rupee (VAT 13%)</option>
                <option value="INR">INR - Indian Rupee (GST 18%)</option>
                <option value="JPY">JPY - Japanese Yen (税 10%)</option>
                <option value="AUD">AUD - Australian Dollar (GST 10%)</option>
                <option value="CAD">CAD - Canadian Dollar (GST 5%)</option>
                <option value="CHF">CHF - Swiss Franc (MWST 8.1%)</option>
              </select>
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
          {success && <p className="text-sm text-green-500">{success}</p>}

          <button type="submit" disabled={saving}
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition disabled:opacity-50">
            {saving ? t("saving") : t("saveChanges")}
          </button>
        </form>
      </div>

      {/* Business Registration */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t("businessRegistration") || "Business Registration"}</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500">{t("businessRegistrationDesc") || "Look up and save your company details from public registers"}</p>
          </div>
        </div>

        {businessProfile && (
          <div className="mb-4 px-4 py-3 bg-green-50 dark:bg-green-900/20 rounded-xl flex items-center gap-2">
            <span className="text-green-500">&#10003;</span>
            <span className="text-sm font-medium text-green-700 dark:text-green-400">
              {businessProfile.company_name}
              {businessProfile.org_number && <span className="text-green-600/70 dark:text-green-500/70 ml-2">({businessProfile.org_number})</span>}
            </span>
          </div>
        )}

        <BusinessLookup
          onSave={(profile) => {
            setBusinessProfile(profile);
            // Also refresh user data since business_name syncs
            api.get("/auth/me").then((res) => {
              setUser(res.data);
              setForm(f => ({ ...f, business_name: res.data.business_name || "" }));
            });
          }}
          initialProfile={businessProfile}
        />
      </div>

      {/* Change Password */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t("changePassword")}</h2>
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className={labelClass}>{t("currentPassword")}</label>
            <input type="password" value={passwords.current_password}
              onChange={(e) => setPasswords({ ...passwords, current_password: e.target.value })}
              className={inputClass} required />
          </div>
          <div>
            <label className={labelClass}>{t("newPassword")}</label>
            <input type="password" value={passwords.new_password}
              onChange={(e) => setPasswords({ ...passwords, new_password: e.target.value })}
              className={inputClass} required />
          </div>
          <div>
            <label className={labelClass}>{t("confirmNewPassword")}</label>
            <input type="password" value={passwords.confirm_password}
              onChange={(e) => setPasswords({ ...passwords, confirm_password: e.target.value })}
              className={inputClass} required />
          </div>

          {pwError && <p className="text-sm text-red-500">{pwError}</p>}
          {pwSuccess && <p className="text-sm text-green-500">{pwSuccess}</p>}

          <button type="submit" disabled={changingPw}
            className="w-full py-3 bg-gray-800 dark:bg-gray-600 hover:bg-gray-900 dark:hover:bg-gray-500 text-white font-semibold rounded-xl transition disabled:opacity-50">
            {changingPw ? t("changing") : t("changePassword")}
          </button>
        </form>
      </div>

      {/* Email Notifications */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t("emailNotifications")}</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("dailyDigestLabel")}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("dailyDigestDesc")}</p>
            </div>
            <button
              onClick={() => toggleEmailPref("daily_digest_enabled")}
              className={`relative w-11 h-6 rounded-full transition ${emailPrefs.daily_digest_enabled ? "bg-green-600" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${emailPrefs.daily_digest_enabled ? "translate-x-5" : ""}`} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("expenseAlertsLabel")}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("expenseAlertsDesc")}</p>
            </div>
            <button
              onClick={() => toggleEmailPref("expense_alerts_enabled")}
              className={`relative w-11 h-6 rounded-full transition ${emailPrefs.expense_alerts_enabled ? "bg-green-600" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${emailPrefs.expense_alerts_enabled ? "translate-x-5" : ""}`} />
            </button>
          </div>
          {/* Push notifications */}
          {pushSupported && (
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Push Notifications</p>
                <p className="text-xs text-gray-400">Get browser alerts for budget & stock warnings</p>
              </div>
              {pushPerm === "granted" ? (
                <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-1 rounded-full">Enabled</span>
              ) : pushPerm === "denied" ? (
                <span className="text-xs text-red-500">Blocked in browser settings</span>
              ) : (
                <button
                  onClick={requestPush}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition"
                >
                  Enable
                </button>
              )}
            </div>
          )}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
            <button
              onClick={sendTestDigest}
              disabled={sendingTest}
              className="px-4 py-2 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg text-sm font-medium hover:bg-blue-100 dark:hover:bg-blue-900/50 transition disabled:opacity-50"
            >
              {sendingTest ? t("sending") : t("sendTestDigest")}
            </button>
            {emailMsg && <span className="ml-3 text-sm text-green-600 dark:text-green-400">{emailMsg}</span>}
          </div>
        </div>
      </div>

      {/* Privacy & Data */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Privacy & Data</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500">You're in control of what BonBox learns from your use.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Pause product analytics</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                When ON, BonBox stops recording your clicks, page views and AI questions.
                Your business data (sales, expenses, inventory) is unaffected.
                You can resume any time. Existing analytics older than 180 days
                are auto-deleted.
              </p>
            </div>
            <button
              onClick={toggleAnalyticsOptOut}
              aria-pressed={analyticsOptOut}
              aria-label="Pause product analytics"
              className={`shrink-0 mt-1 relative w-11 h-6 rounded-full transition ${analyticsOptOut ? "bg-purple-600" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${analyticsOptOut ? "translate-x-5" : ""}`} />
            </button>
          </div>
          {privacyMsg && (
            <p className="text-xs text-purple-600 dark:text-purple-400">{privacyMsg}</p>
          )}
          <p className="text-[11px] text-gray-400 dark:text-gray-500 pt-2 border-t border-gray-100 dark:border-gray-700">
            🇪🇺 GDPR: BonBox processes analytics under legitimate-interest basis.
            Your right to opt out is respected here. To delete all your data, see "Your Data" below.
          </p>
        </div>
      </div>

      {/* WhatsApp Bot */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-green-600" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t("whatsappBot")}</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500">{t("whatsappBotDesc")}</p>
          </div>
        </div>

        {waStatus?.verified ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-4 py-3 bg-green-50 dark:bg-green-900/20 rounded-xl">
              <span className="w-2 h-2 bg-green-500 rounded-full" />
              <span className="text-sm font-medium text-green-700 dark:text-green-400">{t("connectedLabel")}: {waStatus.phone}</span>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t("quickCommandsLabel")}:</p>
              <div className="grid grid-cols-2 gap-1 text-xs text-gray-600 dark:text-gray-300">
                <span><code className="bg-gray-200 dark:bg-gray-600 px-1 rounded">14500</code> → Log revenue</span>
                <span><code className="bg-gray-200 dark:bg-gray-600 px-1 rounded">expense 2500 food</code> → Log expense</span>
                <span><code className="bg-gray-200 dark:bg-gray-600 px-1 rounded">summary</code> → Today's stats</span>
                <span><code className="bg-gray-200 dark:bg-gray-600 px-1 rounded">profit</code> → Monthly profit</span>
                <span><code className="bg-gray-200 dark:bg-gray-600 px-1 rounded">inventory</code> → Stock alerts</span>
                <span><code className="bg-gray-200 dark:bg-gray-600 px-1 rounded">help</code> → All commands</span>
              </div>
            </div>
            <button onClick={unlinkWhatsApp} className="text-xs text-red-500 hover:underline">{t("unlinkWhatsapp")}</button>
          </div>
        ) : waStatus?.linked ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-4 py-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-xl">
              <span className="w-2 h-2 bg-yellow-500 rounded-full" />
              <span className="text-sm text-yellow-700 dark:text-yellow-400">{t("verificationPendingFor")} {waStatus.phone}</span>
            </div>
            {waCode && (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t("yourVerificationCode")}:</p>
                <p className="text-3xl font-bold tracking-widest text-blue-600 dark:text-blue-400">{waCode}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{t("sendCodeToBonbox")}</p>
              </div>
            )}
            {!waCode && <p className="text-xs text-gray-400">{t("sendCodeToBonbox")}</p>}
            <button onClick={unlinkWhatsApp} className="text-xs text-red-500 hover:underline">{t("unlinkWhatsapp")}</button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">{t("linkPhoneDesc")}</p>
            <div className="flex gap-2">
              <input
                type="tel"
                value={waPhone}
                onChange={(e) => setWaPhone(e.target.value)}
                placeholder="+45 91 67 59 74"
                className={inputClass + " flex-1"}
              />
              <button
                onClick={linkWhatsApp}
                disabled={waLinking || !waPhone.trim()}
                className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 transition disabled:opacity-50"
              >
                {waLinking ? t("sending") : t("link")}
              </button>
            </div>
            {waMsg && <p className="text-sm text-green-600 dark:text-green-400">{waMsg}</p>}
          </div>
        )}
      </div>

      {/* Account Details */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">{t("accountDetailsTitle")}</h2>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <p>{t("accountIdLabel")}: <span className="font-mono text-xs">{user.id}</span></p>
          <p>{t("dailyGoal")}: {user.daily_goal > 0 ? `${Number(user.daily_goal).toLocaleString()} ${form.currency}` : t("notSetLabel")}</p>
        </div>
      </div>

      {/* GDPR: Your Data */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-200 dark:border-red-900/50 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t("yourData") || "Your Data"}</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500">{t("gdprRights") || "GDPR: Right to data portability & right to erasure"}</p>
          </div>
        </div>

        {/* Export Data */}
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("exportAllData") || "Export All Data"}</p>
              <p className="text-xs text-gray-400">{t("exportAllDataDesc") || "Download everything BonBox stores about you as a CSV file"}</p>
            </div>
            <button
              onClick={async () => {
                setExporting(true);
                try {
                  const res = await api.get("/auth/export-data", { responseType: "blob" });
                  const url = window.URL.createObjectURL(new Blob([res.data]));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `bonbox_export_${new Date().toISOString().slice(0, 10)}.csv`;
                  a.click();
                  window.URL.revokeObjectURL(url);
                } catch { /* ignore */ }
                setExporting(false);
              }}
              disabled={exporting}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50 shrink-0"
            >
              {exporting ? t("exporting") || "Exporting..." : t("downloadCsv") || "Download CSV"}
            </button>
          </div>

          {/* Tax preferences moved → Tax Autopilot page (next to the deadlines they drive). */}
          <a
            href="/tax-autopilot"
            className="block p-4 rounded-xl border border-green-200/70 dark:border-green-800/40 bg-green-50/60 dark:bg-green-900/15 hover:border-green-300 dark:hover:border-green-700 transition"
          >
            <div className="flex items-center gap-3">
              <span className="text-xl">🧾</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-green-900 dark:text-green-100">Tax preferences moved</p>
                <p className="text-xs text-green-800/80 dark:text-green-200/80 mt-0.5">
                  Filing frequency, Moms inclusion and employee flag now live in Tax Autopilot — next to the deadlines they affect.
                </p>
              </div>
              <span className="text-green-700 dark:text-green-300 text-sm">→</span>
            </div>
          </a>

          {/* Help — show all dismissed tips again (works across all pages) */}
          <div className="p-4 bg-gray-50 dark:bg-gray-800/40 rounded-xl">
            <div className="mb-3">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Tips &amp; hints</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                We show small contextual tips around the app. Dismissed them all and want a refresher?
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                resetAllTips();
                // Force a reload so every mounted DismissibleTip re-reads localStorage.
                window.location.reload();
              }}
              className="px-4 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-800 dark:text-gray-100 rounded-lg hover:border-green-400 hover:text-green-700 dark:hover:text-green-300 transition"
            >
              Show all tips again
            </button>
          </div>

          {/* Appearance — theme picker (4 accent themes; works alongside light/dark mode) */}
          <div className="p-4 bg-gray-50 dark:bg-gray-800/40 rounded-xl">
            <div className="mb-3">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{t("appearance") || "Appearance"}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Pick the accent that feels right. Works in both light and dark mode.</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {THEMES.map((th) => {
                const active = theme === th.id;
                return (
                  <button
                    key={th.id}
                    onClick={() => setTheme(th.id)}
                    aria-pressed={active}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition
                      ${active
                        ? "bg-white dark:bg-gray-700 border-2 border-gray-700 dark:border-gray-300 text-gray-900 dark:text-white"
                        : "bg-white dark:bg-gray-700/60 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-400"}`}
                  >
                    <span
                      className="w-4 h-4 rounded-full shrink-0 ring-1 ring-black/10 dark:ring-white/10"
                      style={{ backgroundColor: th.swatch }}
                    />
                    <span>{th.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Delete Account */}
          <div className="p-4 bg-red-50 dark:bg-red-900/10 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-red-700 dark:text-red-400">{t("deleteAccount") || "Delete Account"}</p>
                <p className="text-xs text-red-500/70 dark:text-red-400/60">{t("deleteAccountDesc") || "Permanently delete your account and all data. This cannot be undone."}</p>
              </div>
              {!deleteConfirm && (
                <button
                  onClick={() => setDeleteConfirm(true)}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition shrink-0"
                >
                  {t("deleteMyAccount") || "Delete My Account"}
                </button>
              )}
            </div>

            {deleteConfirm && (
              <div className="mt-4 pt-4 border-t border-red-200 dark:border-red-800/50 space-y-3">
                <p className="text-sm text-red-600 dark:text-red-400 font-medium">
                  {t("deleteConfirmWarning") || "This will permanently delete ALL your data: sales, expenses, inventory, reports, everything. Enter your password to confirm."}
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(""); }}
                    placeholder={t("enterPassword") || "Enter your password"}
                    className="flex-1 px-3 py-2 rounded-lg border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <button
                    onClick={async () => {
                      if (!deletePassword) return;
                      setDeleting(true);
                      setDeleteError("");
                      try {
                        await api.delete("/auth/delete-account", { data: { password: deletePassword } });
                        localStorage.clear();
                        window.location.href = "/login";
                      } catch (err) {
                        setDeleteError(err.response?.data?.detail || t("deleteFailed") || "Failed to delete account");
                      }
                      setDeleting(false);
                    }}
                    disabled={deleting || !deletePassword}
                    className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-bold hover:bg-red-800 transition disabled:opacity-50"
                  >
                    {deleting ? t("deleting") || "Deleting..." : t("confirmDelete") || "Confirm Delete"}
                  </button>
                  <button
                    onClick={() => { setDeleteConfirm(false); setDeletePassword(""); setDeleteError(""); }}
                    className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition"
                  >
                    {t("cancel") || "Cancel"}
                  </button>
                </div>
                {deleteError && <p className="text-sm text-red-500">{deleteError}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
