import { useState, useEffect, useRef } from "react";
import api from "../services/api";

const AUTO_LOOKUP_COUNTRIES = new Set(["DK", "NO", "GB"]);

export default function BusinessLookup({ onSave, initialProfile }) {
  const [countries, setCountries] = useState([]);
  const [country, setCountry] = useState(initialProfile?.country || "DK");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(initialProfile || null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [manual, setManual] = useState(!AUTO_LOOKUP_COUNTRIES.has(initialProfile?.country || "DK"));
  const [lookupError, setLookupError] = useState("");
  const searchTimer = useRef(null);

  // Manual form state
  const [form, setForm] = useState({
    company_name: initialProfile?.company_name || "",
    org_number: initialProfile?.org_number || "",
    address: initialProfile?.address || "",
    city: initialProfile?.city || "",
    zipcode: initialProfile?.zipcode || "",
    industry: initialProfile?.industry || "",
    phone: initialProfile?.phone || "",
    email: initialProfile?.email || "",
  });

  useEffect(() => {
    api.get("/business/countries").then((r) => setCountries(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    setManual(!AUTO_LOOKUP_COUNTRIES.has(country));
    setResults([]);
    setSelected(null);
  }, [country]);

  // Auto-search with debounce
  useEffect(() => {
    if (!query || query.length < 2 || manual) return;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      setLookupError("");
      try {
        const res = await api.get("/business/lookup", { params: { q: query, country } });
        setResults(res.data);
      } catch (err) {
        setResults([]);
        const msg = err.response?.data?.detail || "";
        if (msg) {
          setLookupError(msg);
          // Auto-switch to manual form if API is unavailable
          if (msg.includes("limit") || msg.includes("manually")) {
            setManual(true);
          }
        }
      }
      setSearching(false);
    }, 400);
    return () => clearTimeout(searchTimer.current);
  }, [query, country, manual]);

  const selectResult = (r) => {
    setSelected(r);
    setForm({
      company_name: r.name,
      org_number: r.org_number,
      address: r.address,
      city: r.city,
      zipcode: r.zipcode,
      industry: r.industry,
      phone: r.phone,
      email: r.email,
    });
    setResults([]);
    setQuery(r.name);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        company_name: form.company_name || query,
        org_number: form.org_number,
        country,
        address: form.address,
        city: form.city,
        zipcode: form.zipcode,
        industry: form.industry,
        phone: form.phone,
        email: form.email,
        source: selected?.source || "manual",
        company_type: selected?.company_type || "",
        founded: selected?.founded || "",
      };
      const res = await api.put("/business", payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSave?.(res.data);
    } catch {}
    setSaving(false);
  };

  const currentCountry = countries.find((c) => c.code === country);
  const regLabel = currentCountry?.reg_label || "Registration Number";
  const hasAutoLookup = currentCountry?.auto_lookup;

  return (
    <div className="space-y-4">
      {/* Country selector */}
      <div>
        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Country</label>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} {c.auto_lookup ? "(auto-lookup)" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Search box (for auto-lookup countries) */}
      {hasAutoLookup && !manual && (
        <div className="relative">
          <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
            Search by company name or {regLabel}
          </label>
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
            placeholder={`e.g. "BonBox" or "12345678"`}
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
          />
          {searching && (
            <div className="absolute right-3 top-8 text-xs text-blue-500">Searching...</div>
          )}

          {/* Results dropdown */}
          {results.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl z-20 max-h-60 overflow-y-auto">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => selectResult(r)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-50 dark:border-gray-700/50 transition"
                >
                  <p className="text-sm font-semibold text-gray-800 dark:text-white">{r.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {regLabel}: {r.org_number} &middot; {r.address}
                  </p>
                  {r.industry && (
                    <p className="text-[10px] text-gray-400 mt-0.5">{r.industry}</p>
                  )}
                </button>
              ))}
            </div>
          )}

          {lookupError && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 rounded-lg">
              {lookupError}
            </p>
          )}

          <button
            onClick={() => { setManual(true); setLookupError(""); }}
            className="mt-1 text-xs text-blue-500 hover:underline"
          >
            Enter manually instead
          </button>
        </div>
      )}

      {/* Selected company preview OR manual form */}
      {(selected || manual) && (
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
          {selected && !manual && (
            <div className="flex items-center gap-2 pb-2 border-b border-gray-200 dark:border-gray-600">
              <span className="text-green-500 text-lg">&#10003;</span>
              <span className="text-sm font-semibold text-gray-800 dark:text-white">{form.company_name}</span>
              <span className="text-xs text-gray-400">via {selected.source}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">Company Name</label>
              <input
                type="text"
                value={form.company_name}
                onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{regLabel}</label>
              <input
                type="text"
                value={form.org_number}
                onChange={(e) => setForm({ ...form, org_number: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">Address</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">City</label>
              <input
                type="text"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">Zipcode</label>
              <input
                type="text"
                value={form.zipcode}
                onChange={(e) => setForm({ ...form, zipcode: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">Industry</label>
              <input
                type="text"
                value={form.industry}
                onChange={(e) => setForm({ ...form, industry: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">Phone</label>
              <input
                type="text"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving || !form.company_name}
            className="w-full py-2.5 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-40 transition mt-2"
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save Business Profile"}
          </button>

          {manual && hasAutoLookup && (
            <button
              onClick={() => { setManual(false); setSelected(null); }}
              className="text-xs text-blue-500 hover:underline"
            >
              Search register instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}
