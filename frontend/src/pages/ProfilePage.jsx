import { useState, useEffect } from "react";
import api from "../services/api";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";

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
  }, []);

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
      setSuccess("Profile updated!");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update profile");
    }
    setSaving(false);
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError("");
    setPwSuccess("");
    if (passwords.new_password !== passwords.confirm_password) {
      setPwError("New passwords don't match");
      return;
    }
    if (passwords.new_password.length < 8) {
      setPwError("Password must be at least 8 characters");
      return;
    }
    setChangingPw(true);
    try {
      await api.post("/auth/change-password", {
        current_password: passwords.current_password,
        new_password: passwords.new_password,
      });
      setPwSuccess("Password changed!");
      setPasswords({ current_password: "", new_password: "", confirm_password: "" });
      setTimeout(() => setPwSuccess(""), 3000);
    } catch (err) {
      setPwError(err.response?.data?.detail || "Failed to change password");
    }
    setChangingPw(false);
  };

  if (!user) return <div className="p-6 text-center text-gray-500">Loading...</div>;

  const inputClass = "w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Profile</h1>

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
            <label className={labelClass}>Email</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Business Name</label>
            <input type="text" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Business Type</label>
              <select value={form.business_type} onChange={(e) => setForm({ ...form, business_type: e.target.value })} className={inputClass}>
                <option value="restaurant">Restaurant</option>
                <option value="cafe">Cafe</option>
                <option value="bar">Bar</option>
                <option value="bakery">Bakery</option>
                <option value="food_truck">Food Truck</option>
                <option value="retail">Retail / Shop</option>
                <option value="clothing">Clothing Store</option>
                <option value="grocery">Grocery Store</option>
                <option value="salon">Salon / Beauty</option>
                <option value="pharmacy">Pharmacy</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Currency</label>
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className={inputClass}>
                <option value="DKK">DKK - Danish Krone</option>
                <option value="SEK">SEK - Swedish Krona</option>
                <option value="NOK">NOK - Norwegian Krone</option>
                <option value="EUR">EUR - Euro</option>
                <option value="USD">USD - US Dollar</option>
                <option value="GBP">GBP - British Pound</option>
                <option value="NPR">NPR - Nepalese Rupee</option>
                <option value="INR">INR - Indian Rupee</option>
                <option value="JPY">JPY - Japanese Yen</option>
                <option value="AUD">AUD - Australian Dollar</option>
                <option value="CAD">CAD - Canadian Dollar</option>
                <option value="CHF">CHF - Swiss Franc</option>
              </select>
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
          {success && <p className="text-sm text-green-500">{success}</p>}

          <button type="submit" disabled={saving}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition disabled:opacity-50">
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </form>
      </div>

      {/* Change Password */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Change Password</h2>
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className={labelClass}>Current Password</label>
            <input type="password" value={passwords.current_password}
              onChange={(e) => setPasswords({ ...passwords, current_password: e.target.value })}
              className={inputClass} required />
          </div>
          <div>
            <label className={labelClass}>New Password</label>
            <input type="password" value={passwords.new_password}
              onChange={(e) => setPasswords({ ...passwords, new_password: e.target.value })}
              className={inputClass} required />
          </div>
          <div>
            <label className={labelClass}>Confirm New Password</label>
            <input type="password" value={passwords.confirm_password}
              onChange={(e) => setPasswords({ ...passwords, confirm_password: e.target.value })}
              className={inputClass} required />
          </div>

          {pwError && <p className="text-sm text-red-500">{pwError}</p>}
          {pwSuccess && <p className="text-sm text-green-500">{pwSuccess}</p>}

          <button type="submit" disabled={changingPw}
            className="w-full py-3 bg-gray-800 dark:bg-gray-600 hover:bg-gray-900 dark:hover:bg-gray-500 text-white font-semibold rounded-xl transition disabled:opacity-50">
            {changingPw ? "Changing..." : "Change Password"}
          </button>
        </form>
      </div>

      {/* Account Details */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Account Details</h2>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <p>Account ID: <span className="font-mono text-xs">{user.id}</span></p>
          <p>Daily Goal: {user.daily_goal > 0 ? `${Number(user.daily_goal).toLocaleString()} ${form.currency}` : "Not set"}</p>
        </div>
      </div>
    </div>
  );
}
