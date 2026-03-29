import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

export default function RegisterPage() {
  const { register } = useAuth();
  const { lang, setLang, LANGUAGES } = useLanguage();
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
    if (!form.business_type) { setError("Please select a type"); return; }
    setLoading(true);
    try {
      await register(form);
      navigate("/dashboard");
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail;
      if (status === 429) {
        setError("Too many attempts — please wait a minute and try again.");
      } else if (status === 409 || detail === "Email already registered") {
        setAlreadyExists(true);
      } else {
        const msg = detail || (err.code === "ECONNABORTED" || !err.response ? "Slow connection — please try again" : "Registration failed");
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
          <p className="text-sm text-gray-500 mt-1">Create your account</p>
        </div>
        {alreadyExists && (
          <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mb-4 text-center">
            <p className="text-sm text-blue-800 font-medium mb-2">This email is already registered</p>
            <Link to="/login" className="inline-block bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-green-700 transition">
              Sign in instead →
            </Link>
          </div>
        )}
        {error && (
          <p className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" name="email" value={form.email} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" name="password" value={form.password} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{form.business_type === "personal" ? "Display Name" : "Business Name"}</label>
            <input type="text" name="business_name" value={form.business_name} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Business Type</label>
            <select name="business_type" value={form.business_type} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base" required>
              <option value="" disabled>Select type...</option>
              <option value="personal">Personal Finance</option>
              <optgroup label="Food & Drink">
                <option value="restaurant">Restaurant / Pizza / Grill</option>
                <option value="cafe">Cafe / Coffee Shop</option>
                <option value="bar">Bar / Nightclub</option>
                <option value="bakery">Bakery / Sweet Shop</option>
                <option value="food_truck">Food Truck / Street Food</option>
                <option value="tea_shop">Tea Shop / Chiya Pasal</option>
              </optgroup>
              <optgroup label="Retail">
                <option value="clothing">Clothing / Fashion</option>
                <option value="online_clothing">Online Clothing Store</option>
                <option value="grocery">Grocery / Kirana Store</option>
                <option value="veggie_shop">Veggie / Fruit Shop</option>
                <option value="kiosk">Kiosk / Convenience Store</option>
                <option value="electronics">Electronics / Mobile</option>
                <option value="pharmacy">Pharmacy / Medical</option>
                <option value="cosmetics">Cosmetics / Beauty Supply</option>
                <option value="stationery">Stationery / Book Shop</option>
                <option value="hardware">Hardware / Construction</option>
                <option value="flower_shop">Flower Shop</option>
                <option value="jewelry">Jewelry / Accessories</option>
                <option value="thrift">Thrift / Second-hand</option>
              </optgroup>
              <optgroup label="Services">
                <option value="salon">Salon / Barber / Nail</option>
                <option value="mobile_repair">Mobile Repair</option>
                <option value="laundry">Laundry / Dry Cleaning</option>
              </optgroup>
              <optgroup label="Other">
                <option value="retail">General Retail</option>
                <option value="wholesale">Wholesale / Distributor</option>
                <option value="other">Other</option>
              </optgroup>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
            <select name="currency" value={form.currency} onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-base">
              <option value="DKK">DKK - Danish Krone</option>
              <option value="SEK">SEK - Swedish Krona</option>
              <option value="NOK">NOK - Norwegian Krone</option>
              <option value="EUR">EUR - Euro (General)</option>
              <option value="EUR_PT">EUR - Portugal (IVA 23%)</option>
              <option value="EUR_DE">EUR - Germany (MwSt 19%)</option>
              <option value="EUR_FR">EUR - France (TVA 20%)</option>
              <option value="EUR_ES">EUR - Spain (IVA 21%)</option>
              <option value="EUR_IT">EUR - Italy (IVA 22%)</option>
              <option value="EUR_NL">EUR - Netherlands (BTW 21%)</option>
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
          <button type="submit" disabled={loading}
            className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition font-semibold text-base disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2">
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                Creating account...
              </>
            ) : "Create Account"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link to="/login" className="text-blue-600 hover:underline">Sign in</Link>
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
