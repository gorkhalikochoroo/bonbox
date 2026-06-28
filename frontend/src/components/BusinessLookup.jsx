import { useState, useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { errText } from "../utils/errText";

/**
 * BusinessLookup — multilayer auto-detect form for the user's
 * registered business. Handles:
 *
 *   L1 — smart input (CVR / domain / name) — backend parses
 *   L2 — primary CVR source (cvrapi.dk) + automatic fallback
 *   L4 — confidence badges per result (verified | likely | guess)
 *   L5 — status warnings (konkurs / ophørt / protected / no MOMS)
 *   L6 — branchekode-driven business_type suggestion banner
 *   L7 — DAWA address cross-check after a result is selected
 *
 * Falls open at every layer:
 *   • Lookup error → inline manual form
 *   • No DAWA match → keep CVR address as-is
 *   • Branchekode unmapped → no banner, owner picks business_type later
 */

const AUTO_LOOKUP_COUNTRIES = new Set(["DK", "NO", "GB"]);


// ── Country auto-detect — priority: profile > currency > locale ──────
//
// Returns the best-guess country code at component mount, used as the
// initial value of the dropdown. The user can always change it.
//
// Priority order (was navigator.language only — caused DK businesses
// using English Chrome to default to GB):
//   1. initialProfile.country  — already set, source of truth
//   2. defaultCountry prop     — derived from user.currency by parent
//                                (DKK → DK, NOK → NO, GBP → GB, etc.)
//   3. navigator.language      — fallback for new users with no
//                                currency set (e.g. signup flow)
//   4. "DK"                    — final fallback (BonBox is DK-first)
function detectCountry(initialCountry, defaultCountry) {
  if (initialCountry) return initialCountry;
  if (defaultCountry) return defaultCountry;
  try {
    const lang = navigator.language || "";  // "da-DK" / "en-GB" / "nb-NO" etc.
    if (lang.includes("-")) {
      const cc = lang.split("-")[1].toUpperCase();
      if (["DK", "NO", "GB", "SE", "DE", "FR", "NL", "US", "AU", "IN", "NP"].includes(cc)) {
        return cc;
      }
    }
  } catch { /* default below */ }
  return "DK";
}


// Currency code → country code mapping. Only the codes auto-lookup
// supports; other currencies (USD, EUR, NPR, INR, AUD, etc.) fall
// through to the locale heuristic in detectCountry above.
const _COUNTRY_BY_CURRENCY = {
  DKK: "DK",
  NOK: "NO",
  GBP: "GB",
};

export function countryFromCurrency(currency) {
  return _COUNTRY_BY_CURRENCY[String(currency || "").toUpperCase()] || null;
}


// ── Confidence badge ─────────────────────────────────────────────────

function ConfidenceBadge({ level }) {
  const { t } = useLanguage();
  const map = {
    verified: { color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", label: t("confidenceVerified") || "Verified" },
    likely:   { color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300", label: t("confidenceLikely") || "Likely match" },
    guess:    { color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", label: t("confidenceGuess") || "Best guess" },
  };
  const cfg = map[level] || map.guess;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}


// ── Status flag warning banners ──────────────────────────────────────

function StatusFlagsBanner({ flags }) {
  const { t } = useLanguage();
  if (!flags || flags.length === 0) return null;
  // Status flag titles are intentionally kept in Danish — these are
  // the canonical CVR register terms (konkurs/ophørt/beskyttet navn/
  // ikke MOMS-registreret) and Danish business owners recognize them
  // immediately. The DETAIL line is in English by default but is
  // wrapped in t() for future locale overrides.
  const map = {
    konkurs: {
      icon: "🚨",
      color: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300",
      title: "Under konkursbehandling",
      detail: t("flagKonkursDetail") ||
        "This company is in liquidation. Saving anyway is fine if it's still operational, but check the legal status.",
    },
    ophoert: {
      icon: "⚠️",
      color: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300",
      title: "Ophørt / Opløst",
      detail: t("flagOphoertDetail") ||
        "The CVR record shows this company has ceased.",
    },
    protected: {
      icon: "🔒",
      color: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300",
      title: "Beskyttet navn",
      detail: t("flagProtectedDetail") ||
        "This is a protected-name registration. Some search results won't show it publicly.",
    },
    no_vat: {
      icon: "💡",
      color: "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300",
      title: "Ikke MOMS-registreret",
      detail: t("flagNoVatDetail") ||
        "The company has CVR but isn't VAT-registered. Kasserapport will skip MOMS calculations until you register.",
    },
  };
  return (
    <div className="space-y-2">
      {flags.map((f) => {
        const cfg = map[f];
        if (!cfg) return null;
        return (
          <div key={f} className={`flex gap-2 items-start px-3 py-2 rounded-lg border text-xs ${cfg.color}`}>
            <span className="text-base leading-none">{cfg.icon}</span>
            <div className="flex-1">
              <p className="font-semibold">{cfg.title}</p>
              <p className="opacity-80">{cfg.detail}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ── Branchekode "Detected: …" banner ─────────────────────────────────

function BranchekodeBanner({ inference, currentBusinessType, onApply }) {
  const { t } = useLanguage();
  if (!inference) return null;
  // Don't nag the owner if their business_type already matches the
  // suggestion — the banner only appears when applying defaults
  // would actually change something.
  const same = currentBusinessType === inference.business_type;
  if (same) return null;

  // Vertical labels — Café/Bar/Kiosk/Købmand are kept in Danish form
  // since they're industry standard terms in DK; Workshop / Bakery /
  // Retail are translatable.
  const labels = {
    restaurant: t("vertRestaurant") || "Restaurant",
    cafe:       "Café",
    bar:        "Bar / Diskotek",
    kiosk:      "Kiosk / Købmand",
    bakery:     t("vertBakery") || "Bakery",
    workshop:   t("vertWorkshop") || "Workshop / Repair",
    retail:     t("vertRetail") || "Retail",
  };
  const label = labels[inference.business_type] || inference.business_type;
  const fuzzyHint = inference.fuzzy
    ? ` (${t("branchekodeFuzzyHint") || "best-guess from branchekode prefix"})`
    : "";

  return (
    <div className="px-3 py-2 rounded-lg bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 text-xs flex items-center gap-2 flex-wrap">
      <span className="text-base">🎯</span>
      <p className="text-purple-700 dark:text-purple-300 flex-1">
        {t("branchekodeDetected") || "Detected"}: <strong>{label}</strong>
        <span className="text-purple-500 dark:text-purple-400 ml-1">· {inference.description}{fuzzyHint}</span>
      </p>
      <button
        onClick={onApply}
        className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-700 text-white font-semibold text-[11px]"
      >
        {t("branchekodeApplyBtn") || "Apply defaults"}
      </button>
    </div>
  );
}


// ── DAWA address-mismatch picker ─────────────────────────────────────
//
// Shown after a CVR result is selected, if DAWA returns a canonical
// address that differs from CVR's. The owner picks which to keep.

function AddressVerifyPicker({ cvrAddress, dawa, onPick }) {
  const { t } = useLanguage();
  if (!dawa) return null;
  if (dawa.matches_input) {
    return (
      <div className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 text-xs flex items-center gap-2">
        <span>✓</span>
        <span className="text-gray-700 dark:text-gray-300">
          {t("dawaAddressVerified") || "Address verified against DAWA postal register"}
        </span>
      </div>
    );
  }
  // Mismatch — show both and let owner pick
  return (
    <div className="px-3 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs">
      <p className="font-semibold text-amber-700 dark:text-amber-300 mb-2">
        {t("dawaMismatchTitle") || "DAWA suggests a slightly different canonical address:"}
      </p>
      <div className="space-y-2">
        <button
          onClick={() => onPick(cvrAddress)}
          className="block w-full text-left px-3 py-2 rounded bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-700 hover:border-amber-500 transition"
        >
          <p className="text-[10px] uppercase text-amber-500">{t("dawaFromCvrLabel") || "From CVR"}</p>
          <p className="text-gray-700 dark:text-gray-200">{cvrAddress}</p>
        </button>
        <button
          onClick={() => onPick(dawa.betegnelse, dawa.id)}
          className="block w-full text-left px-3 py-2 rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-gray-300 transition"
        >
          <p className="text-[10px] uppercase text-gray-500 dark:text-gray-400">{t("dawaFromDawaLabel") || "From DAWA postal register (recommended)"}</p>
          <p className="text-gray-700 dark:text-gray-200">{dawa.betegnelse}</p>
        </button>
      </div>
    </div>
  );
}


// ─── Main component ──────────────────────────────────────────────────

export default function BusinessLookup({ onSave, initialProfile, currentBusinessType, defaultCountry }) {
  const { t } = useLanguage();
  const [countries, setCountries] = useState([]);
  const [country, setCountry] = useState(detectCountry(initialProfile?.country, defaultCountry));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(initialProfile || null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [manual, setManual] = useState(!AUTO_LOOKUP_COUNTRIES.has(initialProfile?.country || "DK"));
  const [lookupError, setLookupError] = useState("");
  const [dawa, setDawa] = useState(null);                  // DAWA verify result
  const [verifyingAddress, setVerifyingAddress] = useState(false);
  const [appliedBusinessType, setAppliedBusinessType] = useState(null);
  const searchTimer = useRef(null);

  const [form, setForm] = useState({
    company_name: initialProfile?.company_name || "",
    org_number: initialProfile?.org_number || "",
    address: initialProfile?.address || "",
    city: initialProfile?.city || "",
    zipcode: initialProfile?.zipcode || "",
    industry: initialProfile?.industry || "",
    industry_code: initialProfile?.industry_code || "",
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
    setDawa(null);
  }, [country]);

  // Smart-input live search with debounce
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
          setLookupError(errText(err, ""));
          if (msg.includes("limit") || msg.includes("manually")) {
            setManual(true);
          }
        }
      }
      setSearching(false);
    }, 400);
    return () => clearTimeout(searchTimer.current);
  }, [query, country, manual]);

  /** Cross-check the chosen CVR address against DAWA. Best-effort —
   * silent failure means we just don't show the verify badge. */
  const verifyAddressDawa = async (addr, zipcode, city) => {
    if (country !== "DK" || !addr) {
      setDawa(null);
      return;
    }
    setVerifyingAddress(true);
    try {
      const res = await api.post("/business/verify-address", {
        address: addr, zipcode, city,
      });
      setDawa(res.data?.verified ? res.data : null);
    } catch {
      setDawa(null);
    } finally {
      setVerifyingAddress(false);
    }
  };

  const selectResult = (r) => {
    setSelected(r);
    setForm({
      company_name: r.name,
      org_number: r.org_number,
      address: r.address,
      city: r.city,
      zipcode: r.zipcode,
      industry: r.industry,
      industry_code: r.industry_code || "",
      phone: r.phone,
      email: r.email,
    });
    setResults([]);
    setQuery(r.name);
    // Kick off DAWA verification in the background
    verifyAddressDawa(r.address, r.zipcode, r.city);
  };

  /** Apply business_type defaults from the branchekode inference. */
  const applyBusinessTypeDefaults = async () => {
    const bt = selected?.branchekode_inference?.business_type;
    if (!bt) return;
    try {
      await api.patch("/auth/profile", { business_type: bt });
      setAppliedBusinessType(bt);
    } catch { /* ignore — owner can change manually */ }
  };

  const useDawaCanonical = (newAddress, dawaId) => {
    setForm(f => ({ ...f, address: newAddress.split(",")[0] }));
    // Persist DAWA id so we can detect future changes precisely
    setSelected(s => ({ ...(s || {}), dawa_address_id: dawaId }));
    // Mark as verified now (matches_input becomes true with the new addr)
    setDawa({ verified: true, matches_input: true, betegnelse: newAddress, id: dawaId });
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
        industry_code: form.industry_code,
        phone: form.phone,
        email: form.email,
        source: selected?.source || "manual",
        company_type: selected?.company_type || "",
        founded: selected?.founded || "",
        // Verification trail — passed through if present
        dawa_address_id: selected?.dawa_address_id || dawa?.id || null,
        vat_registered: selected?.vat_registered ?? null,
        status_flags: (selected?.status_flags || []).join("|") || null,
      };
      const res = await api.put("/business", payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSave?.(res.data);
    } catch { /* ignore */ }
    setSaving(false);
  };

  const currentCountry = countries.find((c) => c.code === country);
  const regLabel = currentCountry?.reg_label || t("blRegNumberFallback", "Registration Number");
  const hasAutoLookup = currentCountry?.auto_lookup;

  return (
    <div className="space-y-4">
      {/* Country selector */}
      <div>
        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("blCountryLabel", "Country")}</label>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} {c.auto_lookup ? t("blAutoLookupSuffix", "(auto-lookup)") : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Smart-input search */}
      {hasAutoLookup && !manual && (
        <div className="relative">
          <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
            {t("blSearchLabel", "Search by name, {regLabel}, or company email/domain").replace("{regLabel}", regLabel)}
          </label>
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(null); setDawa(null); }}
            placeholder={t("blSearchPlaceholder", `e.g. "Mirabelle ApS", "39842851", or "anna@mirabelle.dk"`)}
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
            autoComplete="off"
          />
          {searching && (
            <div className="absolute right-3 top-8 text-xs text-blue-500">{t("blSearching", "Searching…")}</div>
          )}

          {/* Smart-input hint chip — visible when query looks like a CVR/email */}
          {query && query.length >= 2 && (
            <SmartInputHint query={query} />
          )}

          {/* Results dropdown */}
          {results.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm z-20 max-h-80 overflow-y-auto">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => selectResult(r)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-50 dark:border-gray-700/50 transition"
                >
                  <div className="flex items-start gap-2 mb-0.5">
                    <p className="text-sm font-semibold text-gray-800 dark:text-white flex-1">{r.name}</p>
                    {r.confidence && <ConfidenceBadge level={r.confidence} />}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {regLabel}: {r.org_number} &middot; {r.address}
                  </p>
                  {r.industry && (
                    <p className="text-[10px] text-gray-400 mt-0.5">{r.industry}</p>
                  )}
                  {/* Inline status flag preview — even before selection */}
                  {(r.status_flags || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {r.status_flags.includes("konkurs") && (
                        <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold"><AlertTriangle className="w-2.5 h-2.5" />konkurs</span>
                      )}
                      {r.status_flags.includes("ophoert") && (
                        <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold"><AlertTriangle className="w-2.5 h-2.5" />ophørt</span>
                      )}
                      {r.status_flags.includes("no_vat") && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">no MOMS</span>
                      )}
                    </div>
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
            {t("blEnterManually", "Enter manually instead")}
          </button>
        </div>
      )}

      {/* Selected company preview / manual form */}
      {(selected || manual) && (
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
          {selected && !manual && (
            <div className="pb-2 border-b border-gray-200 dark:border-gray-600 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-emerald-600 text-lg">&#10003;</span>
                <span className="text-sm font-semibold text-gray-800 dark:text-white">{form.company_name}</span>
                {selected.confidence && <ConfidenceBadge level={selected.confidence} />}
                <span className="text-xs text-gray-400">via {selected.source}</span>
              </div>
              <StatusFlagsBanner flags={selected.status_flags} />
              <BranchekodeBanner
                inference={selected.branchekode_inference}
                currentBusinessType={appliedBusinessType || currentBusinessType}
                onApply={applyBusinessTypeDefaults}
              />
              {appliedBusinessType && (
                <div className="px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 text-xs text-gray-700 dark:text-gray-300">
                  ✓ {t("blBusinessTypeSet", "Business type set to")} <strong>{appliedBusinessType}</strong>
                </div>
              )}
              {country === "DK" && (
                <AddressVerifyPicker
                  cvrAddress={form.address || selected.address}
                  dawa={dawa}
                  onPick={useDawaCanonical}
                />
              )}
              {verifyingAddress && (
                <p className="text-[11px] text-gray-400">{t("blVerifyingAddress", "Verifying address with DAWA…")}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{t("blFieldCompanyName", "Company Name")}</label>
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
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{t("blFieldAddress", "Address")}</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{t("blFieldCity", "City")}</label>
              <input
                type="text"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{t("blFieldZipcode", "Zipcode")}</label>
              <input
                type="text"
                value={form.zipcode}
                onChange={(e) => setForm({ ...form, zipcode: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{t("blFieldIndustry", "Industry")}</label>
              <input
                type="text"
                value={form.industry}
                onChange={(e) => setForm({ ...form, industry: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wider">{t("blFieldPhone", "Phone")}</label>
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
            className="w-full py-2.5 bg-gray-900 text-white rounded-xl font-semibold hover:bg-gray-700 disabled:opacity-40 transition mt-2"
          >
            {saving ? t("blSaving", "Saving…") : saved ? t("blSaved", "Saved!") : t("blSaveProfile", "Save Business Profile")}
          </button>

          {manual && hasAutoLookup && (
            <button
              onClick={() => { setManual(false); setSelected(null); setDawa(null); }}
              className="text-xs text-blue-500 hover:underline"
            >
              {t("blSearchRegister", "Search register instead")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}


/**
 * Tiny chip that confirms what kind of input the smart-parser saw.
 * Local copy of the backend's parse_input() heuristics — purely UI
 * confirmation; the backend is the source of truth on the actual
 * lookup. Helps the user understand "ah, it's treating this as a CVR."
 */
function SmartInputHint({ query }) {
  const { t } = useLanguage();
  const detect = (q) => {
    const trimmed = q.trim();
    if (!trimmed) return null;
    if (trimmed.includes("@")) return { kind: "domain", label: t("blHintEmailDomain", "Email → searching domain") };
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 10) {
      // Strip common prefixes for the visible form
      return { kind: "cvr", label: `CVR ${digits.slice(0,2)} ${digits.slice(2,4)} ${digits.slice(4,6)} ${digits.slice(6)}` };
    }
    if (trimmed.includes(".") && !trimmed.includes(" ") && trimmed.length > 4) {
      return { kind: "domain", label: t("blHintDomain", "Domain → searching") };
    }
    return null;
  };
  const hint = detect(query);
  if (!hint) return null;
  return (
    <p className="mt-1 text-[10px] text-blue-500 dark:text-blue-400">
      🎯 {hint.label}
    </p>
  );
}
