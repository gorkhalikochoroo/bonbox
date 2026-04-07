import { useState, useEffect } from "react";
import api from "../services/api";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";
import usePushNotifications from "../hooks/usePushNotifications";

export default function ProfilePage() {
  const [dark] = useDarkMode();
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
  const { permission: pushPerm, supported: pushSupported, requestPermission: requestPush } = usePushNotifications();
  const [sendingTest, setSendingTest] = useState(false);
  const [waStatus, setWaStatus] = useState(null);
  const [waPhone, setWaPhone] = useState("");
  const [waMsg, setWaMsg] = useState("");
  const [waLinking, setWaLinking] = useState(false);
  const [waCode, setWaCode] = useState("");

  useEffect(() => {
    api.get("/auth/me").then((res) => {
      setUser(res.data);
      setForm({
        business_name: res.data.business_name || "",
        business_type: res.data.business_type || "",
        currency: res.data.currency || "DKK",
        email: res.data.email || "",
      });
    });
    api.get("/email/preferences").then((res) => setEmailPrefs(res.data)).catch(() => {});
    api.get("/whatsapp/status").then((res) => setWaStatus(res.data)).catch(() => {});
  }, []);

  const toggleEmailPref = async (key) => {
    const updated = { ...emailPrefs, [key]: !emailPrefs[key] };
    setEmailPrefs(updated);
    try {
      await api.patch("/email/preferences", updated);
    } catch { /* ignore */ }
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
    </div>
  );
}
