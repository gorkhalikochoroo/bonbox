import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

export default function RegisterPage() {
  const { register } = useAuth();
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    email: "",
    password: "",
    business_name: "",
    business_type: "",
    currency: "DKK",
  });
  const [error, setError] = useState("");
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setAlreadyExists(false);
    if (!form.business_type) { setError(t("pleaseSelectType")); return; }
    setLoading(true);
    try {
      await register(form);
      navigate("/dashboard");
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail;
      if (status === 429) {
        setError(t("tooManyAttempts"));
      } else if (status === 409 || detail === "Email already registered") {
        setAlreadyExists(true);
      } else {
        const msg = detail || (err.code === "ECONNABORTED" || !err.response ? t("slowConnection") : t("registrationFailed"));
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-8">
      <div className="bg-white p-6 sm:p-8 rounded-xl shadow-md w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-green-600 rounded-2xl mb-3">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/><path d="M4 20h20" stroke="#FCD34D" strokeWidth="2"/></svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800">BonBox</h1>
          <p className="text-sm text-gray-500 mt-1">{t("createYourAccount")}</p>
        </div>
        {alreadyExists && (
          <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mb-4 text-center">
            <p className="text-sm text-blue-800 font-medium mb-2">{t("emailAlreadyRegistered")}</p>
            <Link to="/login" className="inline-block bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-green-700 transition">
              {t("signInInstead")}
            </Link>
          </div>
        )}
        {error && (
          <p className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("email")}</label>
            <input type="email" name="email" value={form.email} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("password")}</label>
            <input type="password" name="password" value={form.password} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{form.business_type === "personal" ? t("displayName") : t("businessName")}</label>
            <input type="text" name="business_name" value={form.business_name} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("businessType")}</label>
            <select name="business_type" value={form.business_type} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required>
              <option value="" disabled>{t("selectType")}</option>
              <option value="personal">{t("personalFinance")}</option>
              <optgroup label={t("foodAndDrink")}>
                <option value="restaurant">{t("btRestaurant")}</option>
                <option value="cafe">{t("btCafe")}</option>
                <option value="bar">{t("btBar")}</option>
                <option value="bakery">{t("btBakery")}</option>
                <option value="food_truck">{t("btFoodTruck")}</option>
                <option value="tea_shop">{t("btTeaShop")}</option>
              </optgroup>
              <optgroup label={t("retail")}>
                <option value="clothing">{t("btClothing")}</option>
                <option value="online_clothing">{t("btOnlineClothing")}</option>
                <option value="grocery">{t("btGrocery")}</option>
                <option value="veggie_shop">{t("btVeggieShop")}</option>
                <option value="kiosk">{t("btKiosk")}</option>
                <option value="electronics">{t("btElectronics")}</option>
                <option value="pharmacy">{t("btPharmacy")}</option>
                <option value="cosmetics">{t("btCosmetics")}</option>
                <option value="stationery">{t("btStationery")}</option>
                <option value="hardware">{t("btHardware")}</option>
                <option value="flower_shop">{t("btFlowerShop")}</option>
                <option value="jewelry">{t("btJewelry")}</option>
                <option value="thrift">{t("btThrift")}</option>
              </optgroup>
              <optgroup label={t("services")}>
                <option value="salon">{t("btSalon")}</option>
                <option value="mobile_repair">{t("btMobileRepair")}</option>
                <option value="laundry">{t("btLaundry")}</option>
              </optgroup>
              <optgroup label={t("other")}>
                <option value="retail">{t("btGeneralRetail")}</option>
                <option value="wholesale">{t("btWholesale")}</option>
                <option value="other">{t("other")}</option>
              </optgroup>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("currency")}</label>
            <select name="currency" value={form.currency} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base">
              <option value="DKK">{t("currDKK")}</option>
              <option value="SEK">{t("currSEK")}</option>
              <option value="NOK">{t("currNOK")}</option>
              <option value="EUR">{t("currEUR")}</option>
              <option value="EUR_PT">{t("currEUR_PT")}</option>
              <option value="EUR_DE">{t("currEUR_DE")}</option>
              <option value="EUR_FR">{t("currEUR_FR")}</option>
              <option value="EUR_ES">{t("currEUR_ES")}</option>
              <option value="EUR_IT">{t("currEUR_IT")}</option>
              <option value="EUR_NL">{t("currEUR_NL")}</option>
              <option value="USD">{t("currUSD")}</option>
              <option value="GBP">{t("currGBP")}</option>
              <option value="NPR">{t("currNPR")}</option>
              <option value="INR">{t("currINR")}</option>
              <option value="JPY">{t("currJPY")}</option>
              <option value="AUD">{t("currAUD")}</option>
              <option value="CAD">{t("currCAD")}</option>
              <option value="CHF">{t("currCHF")}</option>
            </select>
          </div>
          <button type="submit" disabled={loading}
            className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition font-semibold text-base disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2">
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                {t("creatingAccount")}
              </>
            ) : t("createAccount")}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-600">
          {t("alreadyHaveAccount")}{" "}
          <Link to="/login" className="text-blue-600 hover:underline">{t("signIn")}</Link>
        </p>
        <div className="flex justify-center gap-2 mt-4">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                lang === l.code
                  ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                  : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
              }`}
            >
              {l.flag} {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
