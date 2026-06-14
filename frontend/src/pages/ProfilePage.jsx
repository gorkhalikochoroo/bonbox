/**
 * ProfilePage — owner settings, redesigned 2026-05-19 for scannability.
 *
 * Layout:
 *   • Desktop (≥ md): two-column. Sticky table-of-contents on the left,
 *     anchored Card sections on the right.
 *   • Mobile: single column, no TOC. Cards stack vertically.
 *
 * Sections, in display order (each is an anchor target for the TOC):
 *   #account            Sign-in details + change password
 *   #business           Business name/type/currency + cuisine + CVR lookup
 *   #operations         Smart-staffing card + operating profile editor
 *   #billing            Bank/MobilePay payment details + accountant contact
 *   #brand              Logo + accent color (faktura) + app theme picker
 *   #notifications      Email digests + push + WhatsApp bot
 *   #privacy            Analytics opt-out + data export + tax-prefs link
 *   #danger             Delete account
 *
 * Design rules respected throughout:
 *   • Flat surfaces — no gradients
 *   • Lucide icons via `Icon` primitive — no emoji in chrome, no
 *     rainbow inline SVGs (a couple of legacy emoji survive inside
 *     legally-required Danish copy + the WhatsApp brand glyph which
 *     stays as the actual WhatsApp logo)
 *   • Card primitive for every section — `default` for editable
 *     forms, `subtle` for informational/secondary cards
 *   • Button primitive for every action — `primary` for the section
 *     CTA, `accent` for "money moment" saves, `secondary`/`ghost`
 *     for navigation, `danger` for destructive
 *   • Consistent 16-20px gaps; labels above inputs, smaller h2's
 *
 * Functional contract preserved exactly:
 *   • Every existing API endpoint is still called with the same payload
 *   • Every existing translation key is still used (the new keys are
 *     additive — none were renamed)
 *   • The `/profile` URL is unchanged
 */
import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useTheme, THEMES } from "../hooks/useTheme";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";
import usePushNotifications from "../hooks/usePushNotifications";
import BusinessLookup, { countryFromCurrency } from "../components/BusinessLookup";
import OperatingProfileSection from "../components/OperatingProfileSection";
import SmartStaffingCard from "../components/SmartStaffingCard";
import { resetAllTips } from "../components/DismissibleTip";
import { localIso } from "../utils/dateFormat";
import { Button, Card, Icon, PageHeader } from "../components/ui";

/* ─── form primitives ─────────────────────────────────────────────
   Centralised here so every form field on the page lands at exactly
   the same height, radius, and focus colour. The old hand-rolled
   class strings drifted between sections (e.g. rounded-lg vs
   rounded-xl) which made the page feel inconsistent at a glance. */
const INPUT_CLASS =
  "w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 " +
  "bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm " +
  "placeholder:text-gray-400 dark:placeholder:text-gray-500 " +
  "focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent " +
  "disabled:opacity-50";
const LABEL_CLASS =
  "block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5";
const HINT_CLASS =
  "text-[11px] text-gray-500 dark:text-gray-400 mt-1.5";

/** The eight Card sections rendered on this page. The TOC reads from
 *  this list so adding a section in one place automatically gets the
 *  matching nav entry on desktop. */
const SECTIONS = [
  { id: "account",       titleKey: "profileSectionAccount",       descKey: "profileSectionAccountDesc",       icon: "User" },
  { id: "business",      titleKey: "profileSectionBusiness",      descKey: "profileSectionBusinessDesc",      icon: "Building2" },
  { id: "operations",    titleKey: "profileSectionOperations",    descKey: "profileSectionOperationsDesc",    icon: "Calendar" },
  { id: "billing",       titleKey: "profileSectionBilling",       descKey: "profileSectionBillingDesc",       icon: "CreditCard" },
  { id: "brand",         titleKey: "profileSectionBrand",         descKey: "profileSectionBrandDesc",         icon: "Palette" },
  { id: "notifications", titleKey: "profileSectionNotifications", descKey: "profileSectionNotificationsDesc", icon: "Bell" },
  { id: "privacy",       titleKey: "profileSectionPrivacy",       descKey: "profileSectionPrivacyDesc",       icon: "Shield" },
  { id: "danger",        titleKey: "profileSectionDanger",        descKey: "profileSectionDangerDesc",        icon: "AlertTriangle" },
];

export default function ProfilePage() {
  const [theme, setTheme] = useTheme();
  const { t } = useLanguage();
  // Task #55 — "Run onboarding again" link. Resets the user's
  // onboarding_completed_at to null then navigates to /onboarding.
  // Quiet error fallback — failures just leave the button enabled.
  const [reRunOnbBusy, setReRunOnbBusy] = useState(false);
  const [reRunOnbError, setReRunOnbError] = useState("");
  const reRunOnboarding = async () => {
    setReRunOnbBusy(true);
    setReRunOnbError("");
    try {
      await api.post("/auth/onboarding/reset");
      // Use hard navigation so AuthProvider re-fetches /auth/me
      // with the new (null) onboarding_completed_at — otherwise the
      // OnboardingRoute redirect would kick us straight back.
      window.location.href = "/onboarding";
    } catch (err) {
      setReRunOnbError(
        errText(err, t("onbReRunFailed") || "Couldn't reset onboarding. Try again."),
      );
      setReRunOnbBusy(false);
    }
  };
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ business_name: "", business_type: "", currency: "", email: "" });
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [pwError, setPwError] = useState("");
  const [saving, setSaving] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [emailPrefs, setEmailPrefs] = useState({
    daily_digest_enabled: false,
    expense_alerts_enabled: true,
    // Task #54 — Daily Brief 8am email. Default true matches the
    // server's opt-out posture. Server-confirmed value overwrites this
    // on /email/preferences load.
    daily_brief_email_enabled: true,
  });
  const [emailMsg, setEmailMsg] = useState("");
  // Send-test-brief flow — separate from sendTestDigest below.
  const [sendingBriefTest, setSendingBriefTest] = useState(false);
  const [briefTestMsg, setBriefTestMsg] = useState("");
  // GDPR: per-user analytics opt-out. Synced from /auth/me. When ON,
  // backend silently drops every event_log write for this user.
  const [analyticsOptOut, setAnalyticsOptOut] = useState(false);
  // SmartStaffingCard's "Edit details" button toggles this — opens the
  // OperatingProfileSection editor inline + scrolls into view.
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [privacyMsg, setPrivacyMsg] = useState("");
  // Task #68 — per-user demo-data status + clear control.  Renders
  // the "Clear sample data" card only when the user actually has
  // demo rows on their account, so the Privacy section stays clean.
  const [demoStatus, setDemoStatus] = useState(null);
  const [demoClearBusy, setDemoClearBusy] = useState(false);
  const [demoClearMsg, setDemoClearMsg] = useState("");
  // Push notifications — legacy (local-only) + Web Push (Task #72).
  // The hook exposes both surfaces; subscribed/subscribe/unsubscribe/
  // sendTest are the new VAPID pipeline that fires the 8am brief.
  const {
    permission: pushPerm,
    supported: pushSupported,
    subscribed: pushSubscribed,
    busy: pushBusy,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
    sendTest: pushSendTest,
  } = usePushNotifications();
  const [pushMsg, setPushMsg] = useState("");
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [businessProfile, setBusinessProfile] = useState(null);
  // Accountant contact — pre-fills the Daily Close "Send to accountant"
  // export button. Stored on BusinessProfile.
  const [accountantForm, setAccountantForm] = useState({ accountant_email: "", accountant_name: "" });
  const [accountantSaving, setAccountantSaving] = useState(false);
  const [accountantMsg, setAccountantMsg] = useState("");

  // Task #49 — Revisor read-only access.  State + handlers now live in
  // <RevisorSection /> on /team (Task #204 P2.8).  ProfilePage keeps
  // only a breadcrumb pointing at /team.

  // Payment details rendered on every faktura PDF — bank reg+account,
  // MobilePay Erhverv, optional IBAN/BIC. Required by Momsbekendtgørelsen §57.
  const [paymentForm, setPaymentForm] = useState({
    bank_reg_number: "",
    bank_account_number: "",
    mobilepay_number: "",
    iban: "",
    bic: "",
  });
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentMsg, setPaymentMsg] = useState("");

  // Cuisine / specialization — finer than business_type. Powers the
  // "Same cuisine market" feature on Competitor Scan.
  const [cuisine, setCuisine] = useState("");
  const [cuisineSaving, setCuisineSaving] = useState(false);
  const [cuisineMsg, setCuisineMsg] = useState("");

  // Brand & logo (migration 034). Lives behind a dedicated endpoint so
  // mutations are atomic + audit-logged independent of /api/business.
  const [brand, setBrand] = useState({
    logo_url: null,
    accent_color: null,
    logo_position: "left",
    accent_palette: {},
  });
  const [brandSaving, setBrandSaving] = useState(false);
  const [brandMsg, setBrandMsg] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);

  // Re-verify state — pulls a fresh CVR record into the saved profile
  const [reverifying, setReverifying] = useState(false);
  const [reverifyMsg, setReverifyMsg] = useState("");

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
    api.get("/business").then((res) => {
      setBusinessProfile(res.data);
      if (res.data) {
        setAccountantForm({
          accountant_email: res.data.accountant_email || "",
          accountant_name: res.data.accountant_name || "",
        });
        setPaymentForm({
          bank_reg_number: res.data.bank_reg_number || "",
          bank_account_number: res.data.bank_account_number || "",
          mobilepay_number: res.data.mobilepay_number || "",
          iban: res.data.iban || "",
          bic: res.data.bic || "",
        });
        setCuisine(res.data.cuisine || "");
      }
    }).catch(() => {});
    // Brand & logo — separate endpoint because it returns a signed
    // logo URL (1h TTL) we can't keep in main profile response.
    api.get("/business/brand").then((res) => setBrand(res.data)).catch(() => {});
    // Task #49 — Revisor grants now fetched inside <RevisorSection />
    // on /team.  ProfilePage shows a breadcrumb only (Task #204 P2.8).
    // Task #68 — has the user seeded demo data on their own account?
    // Best-effort; on failure we leave demoStatus null so the card
    // simply doesn't render.
    api
      .get("/demo/status")
      .then((res) => setDemoStatus(res.data || null))
      .catch(() => setDemoStatus(null));
  }, []);

  // Task #68 — clear demo data button handler (Profile → Privacy)
  const onClearDemoData = async () => {
    setDemoClearBusy(true);
    setDemoClearMsg("");
    try {
      const res = await api.post("/demo/clear");
      const d = res?.data?.deleted || {};
      const total =
        (d.expenses || 0) +
        (d.closes || 0) +
        (d.inventory || 0) +
        (d.expense_cats || 0);
      setDemoClearMsg(
        t("demoClearDone", "Sample data cleared.") + ` (${total} rows)`,
      );
      // Reload status so the card hides
      setDemoStatus({ has_demo: false, has_real: !!demoStatus?.has_real });
      // Let Dashboard re-pull
      try {
        window.dispatchEvent(new CustomEvent("bonbox-data-changed"));
      } catch {
        /* no-op */
      }
    } catch {
      setDemoClearMsg(
        t("demoClearError", "Could not clear sample data. Please try again."),
      );
    } finally {
      setDemoClearBusy(false);
      setTimeout(() => setDemoClearMsg(""), 5000);
    }
  };

  // Revisor invite/revoke handlers moved to <RevisorSection /> (Task #204 P2.8).

  /** Re-verify the saved profile against CVR (or whichever register
   *  applies for the country). */
  const reverifyProfile = async () => {
    setReverifying(true);
    setReverifyMsg("");
    try {
      const res = await api.post("/business/reverify");
      const data = res.data || {};
      if (data.refreshed) {
        const fresh = await api.get("/business");
        setBusinessProfile(fresh.data);
        const changed = data.fields_changed || [];
        setReverifyMsg(
          changed.length === 0
            ? "Profile is already up to date"
            : `Updated: ${changed.join(", ")}`,
        );
      } else {
        setReverifyMsg(data.message || "Could not refresh — try again");
      }
      setTimeout(() => setReverifyMsg(""), 5000);
    } catch (err) {
      const inner = err?.response?.data?.detail;
      let msg;
      if (inner && typeof inner === "object" && inner.code === "reverify_cooldown") {
        msg = inner.message;
      } else if (typeof inner === "string") {
        msg = inner;
      } else if (inner?.message) {
        msg = inner.message;
      } else {
        msg = "Re-verify failed — try again";
      }
      setReverifyMsg(msg);
      setTimeout(() => setReverifyMsg(""), 6000);
    } finally {
      setReverifying(false);
    }
  };

  /** PUT /api/business does an upsert; we echo company_name so the
   *  backend (model_dump exclude_unset) doesn't blank it. */
  const saveAccountant = async (e) => {
    e?.preventDefault?.();
    setAccountantSaving(true);
    setAccountantMsg("");
    try {
      const payload = {
        company_name: businessProfile?.company_name || "",
        accountant_email: accountantForm.accountant_email.trim() || null,
        accountant_name: accountantForm.accountant_name.trim() || null,
      };
      const res = await api.put("/business", payload);
      setBusinessProfile(res.data);
      setAccountantMsg(t("accountantSaved") || "Accountant contact saved");
      setTimeout(() => setAccountantMsg(""), 3000);
    } catch {
      setAccountantMsg(t("accountantSaveFailed") || "Could not save — try again");
      setTimeout(() => setAccountantMsg(""), 4000);
    } finally {
      setAccountantSaving(false);
    }
  };

  const saveCuisine = async (e) => {
    e?.preventDefault?.();
    setCuisineSaving(true);
    setCuisineMsg("");
    try {
      const payload = {
        company_name: businessProfile?.company_name || "",
        cuisine: cuisine.trim() || null,
      };
      const res = await api.put("/business", payload);
      setBusinessProfile(res.data);
      setCuisineMsg(t("cuisineSaved", "Saved — we'll scan for similar places near you."));
      setTimeout(() => setCuisineMsg(""), 3000);
    } catch {
      setCuisineMsg(t("cuisineSaveFailed", "Could not save — try again"));
      setTimeout(() => setCuisineMsg(""), 4000);
    } finally {
      setCuisineSaving(false);
    }
  };

  const savePayment = async (e) => {
    e?.preventDefault?.();
    setPaymentSaving(true);
    setPaymentMsg("");
    try {
      const payload = {
        company_name: businessProfile?.company_name || "",
        bank_reg_number: paymentForm.bank_reg_number.trim() || null,
        bank_account_number: paymentForm.bank_account_number.trim() || null,
        mobilepay_number: paymentForm.mobilepay_number.trim() || null,
        iban: paymentForm.iban.trim() || null,
        bic: paymentForm.bic.trim() || null,
      };
      const res = await api.put("/business", payload);
      setBusinessProfile(res.data);
      setPaymentMsg(t("paymentSaved") || "Payment details saved");
      setTimeout(() => setPaymentMsg(""), 3000);
    } catch {
      setPaymentMsg(t("paymentSaveFailed") || "Could not save — try again");
      setTimeout(() => setPaymentMsg(""), 4000);
    } finally {
      setPaymentSaving(false);
    }
  };

  const uploadLogo = async (file) => {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setBrandMsg("Logo must be PNG or JPEG (SVG not allowed)");
      setTimeout(() => setBrandMsg(""), 5000);
      return;
    }
    if (file.size > 1_000_000) {
      setBrandMsg("Logo too large (max 1 MB)");
      setTimeout(() => setBrandMsg(""), 5000);
      return;
    }
    setLogoUploading(true);
    setBrandMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post("/business/logo", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setBrand(res.data);
      setBrandMsg(t("logoUploaded") || "Logo uploaded");
      setTimeout(() => setBrandMsg(""), 3000);
    } catch (err) {
      const detail = errText(err, "Upload failed");
      setBrandMsg(detail);
      setTimeout(() => setBrandMsg(""), 5000);
    } finally {
      setLogoUploading(false);
    }
  };

  const deleteLogo = async () => {
    if (!confirm(t("confirmDeleteLogo") || "Remove logo from your fakturaer?")) return;
    try {
      const res = await api.delete("/business/logo");
      setBrand(res.data);
      setBrandMsg(t("logoDeleted") || "Logo removed");
      setTimeout(() => setBrandMsg(""), 3000);
    } catch {
      setBrandMsg(t("logoDeleteFailed") || "Could not remove logo");
      setTimeout(() => setBrandMsg(""), 5000);
    }
  };

  const saveBrand = async (next) => {
    setBrandSaving(true);
    setBrandMsg("");
    try {
      const res = await api.patch("/business/brand", next);
      setBrand(res.data);
      setBrandMsg(t("brandSaved") || "Brand settings saved");
      setTimeout(() => setBrandMsg(""), 3000);
    } catch (err) {
      const detail = errText(err, "Could not save");
      setBrandMsg(detail);
      setTimeout(() => setBrandMsg(""), 5000);
    } finally {
      setBrandSaving(false);
    }
  };

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
      setAnalyticsOptOut(!next);
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

  // Task #54 — Send today's Daily Brief to the caller's inbox right now.
  // The endpoint enforces force=true so this works even after the cron
  // has already sent today's brief — owners can re-verify how the
  // template renders without waiting until tomorrow morning.
  const sendTestBrief = async () => {
    setSendingBriefTest(true);
    setBriefTestMsg("");
    try {
      const res = await api.post("/dashboard/daily-brief/send-now");
      if (res.data?.ok) {
        setBriefTestMsg(t("briefSentToast"));
      } else {
        setBriefTestMsg(t("briefSendFailedToast"));
      }
    } catch {
      setBriefTestMsg(t("briefSendFailedToast"));
    }
    setSendingBriefTest(false);
    setTimeout(() => setBriefTestMsg(""), 4000);
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
      setWaMsg(errText(err, t("failedToLink")));
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
      const stored = localStorage.getItem("bonbox_user");
      if (stored) {
        const parsed = JSON.parse(stored);
        localStorage.setItem("bonbox_user", JSON.stringify({ ...parsed, ...res.data }));
      }
      setSuccess(t("profileUpdated"));
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(errText(err, t("failedToUpdateProfile")));
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
      setPwError(errText(err, t("failedToChangePassword")));
    }
    setChangingPw(false);
  };

  /** Cuisine quick-suggest chips, keyed by business_type. */
  const cuisinePresets = useMemo(() => {
    const PRESETS = {
      restaurant: ["French bistro", "Italian", "Nepali", "Indian", "Thai", "Sushi", "Ramen", "Mexican", "Spanish tapas", "Mediterranean", "Vegan", "Steakhouse"],
      cafe:       ["Specialty coffee", "Brunch", "Vegan bakery", "Pastries", "Sandwiches"],
      bar:        ["Cocktail bar", "Wine bar", "Sports pub", "Beer garden", "Whisky bar"],
      bakery:     ["Sourdough", "French patisserie", "Gluten-free", "Danish wienerbrød", "Nordic bread"],
      food_truck: ["Burgers", "Tacos", "Asian fusion", "BBQ"],
      workshop:   ["BMW + Audi", "Tesla + EV", "Classic cars", "Motorcycle"],
    };
    return PRESETS[form.business_type] || PRESETS.restaurant;
  }, [form.business_type]);

  if (!user) return <div className="p-6 text-center text-gray-500">{t("loading")}</div>;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Task #120 polish (Agent E): migrated H1 → PageHeader, KPI cards →
          StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
          + i18n + a11y unchanged. */}
      <FadeIn>
        <PageHeader
          eyebrow="ACCOUNT"
          title={t("profile")}
          subtitle={t("profileSubtitle")}
        />
      </FadeIn>

      <div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:gap-10">
        {/* Sticky table of contents — desktop only */}
        <TableOfContents t={t} />

        <main className="space-y-6 min-w-0">
          {/* ─── Account ─────────────────────────────────────────── */}
          <SectionAnchor id="account">
            <Card>
              <Card.Header
                title={t("profileSectionAccount")}
                subtitle={t("profileSectionAccountDesc")}
                icon={<Icon name="User" size={18} />}
              />
              <ProfileIdentity user={user} t={t} />
              <form onSubmit={saveProfile} className="space-y-4 mt-4">
                <Field label={t("emailLabel")}>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className={INPUT_CLASS}
                  />
                </Field>
                {error && <Message tone="error">{error}</Message>}
                {success && <Message tone="success">{success}</Message>}
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary" busy={saving}>
                    {saving ? t("saving") : t("saveChanges")}
                  </Button>
                </div>
              </form>
            </Card>

            <Card className="mt-4">
              <Card.Header
                title={t("changePassword")}
                subtitle={t("passwordMinLength") /* fallback hint */}
                icon={<Icon name="Lock" size={18} />}
              />
              <form onSubmit={changePassword} className="space-y-4">
                <Field label={t("currentPassword")}>
                  <input
                    type="password"
                    value={passwords.current_password}
                    onChange={(e) => setPasswords({ ...passwords, current_password: e.target.value })}
                    className={INPUT_CLASS}
                    required
                    autoComplete="current-password"
                  />
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label={t("newPassword")}>
                    <input
                      type="password"
                      value={passwords.new_password}
                      onChange={(e) => setPasswords({ ...passwords, new_password: e.target.value })}
                      className={INPUT_CLASS}
                      required
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label={t("confirmNewPassword")}>
                    <input
                      type="password"
                      value={passwords.confirm_password}
                      onChange={(e) => setPasswords({ ...passwords, confirm_password: e.target.value })}
                      className={INPUT_CLASS}
                      required
                      autoComplete="new-password"
                    />
                  </Field>
                </div>
                {pwError && <Message tone="error">{pwError}</Message>}
                {pwSuccess && <Message tone="success">{pwSuccess}</Message>}
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary" busy={changingPw}>
                    {changingPw ? t("changing") : t("changePassword")}
                  </Button>
                </div>
              </form>
            </Card>
          </SectionAnchor>

          {/* ─── Business profile ────────────────────────────────── */}
          <SectionAnchor id="business">
            <Card>
              <Card.Header
                title={t("profileBusinessAccountTitle")}
                subtitle={t("profileBusinessAccountDesc")}
                icon={<Icon name="Building2" size={18} />}
              />
              <form onSubmit={saveProfile} className="space-y-4">
                <Field label={t("businessNameLabel")}>
                  <input
                    type="text"
                    value={form.business_name}
                    onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                    className={INPUT_CLASS}
                  />
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label={t("businessTypeLabel")}>
                    <select
                      value={form.business_type}
                      onChange={(e) => setForm({ ...form, business_type: e.target.value })}
                      className={INPUT_CLASS}
                    >
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
                  </Field>
                  <Field label={t("currencyLabel")}>
                    <select
                      value={form.currency}
                      onChange={(e) => setForm({ ...form, currency: e.target.value })}
                      className={INPUT_CLASS}
                    >
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
                  </Field>
                </div>
                {error && <Message tone="error">{error}</Message>}
                {success && <Message tone="success">{success}</Message>}
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary" busy={saving}>
                    {saving ? t("saving") : t("saveChanges")}
                  </Button>
                </div>
              </form>
            </Card>

            <Card className="mt-4">
              <Card.Header
                title={t("profileCuisineCardTitle")}
                subtitle={t("profileCuisineCardDesc")}
                icon={<Icon name="Utensils" size={18} />}
              />
              <form onSubmit={saveCuisine} className="space-y-3">
                <input
                  type="text"
                  value={cuisine}
                  onChange={(e) => setCuisine(e.target.value.slice(0, 60))}
                  placeholder={
                    (form.business_type === "cafe" && t("cuisineExampleCafe", "e.g. specialty coffee, brunch, vegan bakery"))
                    || (form.business_type === "bar" && t("cuisineExampleBar", "e.g. cocktail bar, sports pub, wine bar"))
                    || (form.business_type === "bakery" && t("cuisineExampleBakery", "e.g. sourdough, French patisserie, gluten-free"))
                    || t("cuisineExampleRestaurant", "e.g. French bistro, Nepali, sushi, ramen, Italian, vegan, tapas")
                  }
                  className={INPUT_CLASS}
                  maxLength={60}
                />
                <div className="flex flex-wrap gap-1.5">
                  {cuisinePresets.map((p) => {
                    const active = cuisine.toLowerCase() === p.toLowerCase();
                    return (
                      <button
                        type="button"
                        key={p}
                        onClick={() => setCuisine(p)}
                        className={
                          "px-2.5 py-1 rounded-full text-xs font-medium border transition " +
                          (active
                            ? "bg-gray-900 text-white border-gray-900"
                            : "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700")
                        }
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
                {cuisineMsg && (
                  <Message tone={cuisineMsg.toLowerCase().includes("could not") ? "error" : "success"}>
                    {cuisineMsg}
                  </Message>
                )}
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary" busy={cuisineSaving}>
                    {cuisineSaving ? t("saving") : t("save")}
                  </Button>
                </div>
              </form>
            </Card>

            <Card className="mt-4">
              <Card.Header
                title={t("businessRegistration") || "Business Registration"}
                subtitle={t("businessRegistrationDesc") || "Look up and save your company details from public registers"}
                icon={<Icon name="FileText" size={18} />}
              />
              {businessProfile && (
                <VerifiedBusinessBanner
                  profile={businessProfile}
                  reverifying={reverifying}
                  reverifyMsg={reverifyMsg}
                  onReverify={reverifyProfile}
                />
              )}
              <BusinessLookup
                onSave={(profile) => {
                  setBusinessProfile(profile);
                  if (profile) {
                    setAccountantForm({
                      accountant_email: profile.accountant_email || "",
                      accountant_name: profile.accountant_name || "",
                    });
                  }
                  api.get("/auth/me").then((res) => {
                    setUser(res.data);
                    setForm((f) => ({ ...f, business_name: res.data.business_name || "" }));
                  });
                }}
                initialProfile={businessProfile}
                currentBusinessType={user?.business_type}
                defaultCountry={countryFromCurrency(user?.currency)}
              />
            </Card>
          </SectionAnchor>

          {/* ─── Operations (smart staffing / operating profile) ── */}
          <SectionAnchor id="operations">
            <div className="space-y-4">
              <SmartStaffingCard
                onEditClick={() => {
                  setEditorExpanded(true);
                  setTimeout(() => {
                    document
                      .getElementById("operating-profile-editor")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }, 50);
                }}
              />
              {/* Labor-cost target — tunes the Pro Schedule Autopilot.
                  Stored on BusinessProfile.target_labor_pct, default 30%.
                  Backend clamps to [0.10, 0.50] regardless of input. */}
              <LaborTargetStepper />
              {/* Day rollover — when the business day flips for kasse-
                  rapport / daily-close / live-KPI windows. Stored on
                  BusinessProfile.day_cutoff_hour, default 6 (Danish
                  restaurant convention — 02:00 = yesterday's shift).
                  Backend clamps to [0, 23]. */}
              <DayCutoffStepper />

              {editorExpanded ? (
                <div id="operating-profile-editor">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t("smartStaffingFineTune") ||
                        "Fine-tune individual values below — these save independently from the card above."}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditorExpanded(false)}
                      className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                      {t("smartStaffingHideAdvanced") || "Hide advanced editor"}
                    </button>
                  </div>
                  <OperatingProfileSection />
                </div>
              ) : (
                <div className="px-1">
                  <button
                    type="button"
                    onClick={() => setEditorExpanded(true)}
                    className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    {t("smartStaffingShowAdvanced") || "Show advanced operating-profile editor"}
                  </button>
                </div>
              )}
            </div>
          </SectionAnchor>

          {/* ─── Billing details + accountant ─────────────────────── */}
          <SectionAnchor id="billing">
            <Card>
              <Card.Header
                title={t("paymentDetailsTitle") || "Payment details on faktura"}
                subtitle={
                  t("paymentDetailsDesc") ||
                  "How customers pay you. Printed on every faktura PDF. Required for a valid Danish faktura."
                }
                icon={<Icon name="CreditCard" size={18} />}
              />
              <form onSubmit={savePayment} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label={t("bankRegLabel") || "Bank reg. nr."}>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={paymentForm.bank_reg_number}
                      onChange={(e) => setPaymentForm((f) => ({ ...f, bank_reg_number: e.target.value }))}
                      placeholder="1234"
                      maxLength={8}
                      className={INPUT_CLASS}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label={t("bankAccountLabel") || "Bank konto nr."}>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={paymentForm.bank_account_number}
                      onChange={(e) => setPaymentForm((f) => ({ ...f, bank_account_number: e.target.value }))}
                      placeholder="1234567890"
                      maxLength={20}
                      className={INPUT_CLASS}
                      autoComplete="off"
                    />
                  </Field>
                </div>
                <Field
                  label={t("mobilepayLabel") || "MobilePay Erhverv nr."}
                  hint={
                    t("mobilepayHint") ||
                    "Your 5-digit MobilePay Erhverv code. Renders alongside bank info on the faktura."
                  }
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    value={paymentForm.mobilepay_number}
                    onChange={(e) => setPaymentForm((f) => ({ ...f, mobilepay_number: e.target.value }))}
                    placeholder="12345"
                    maxLength={20}
                    className={INPUT_CLASS}
                    autoComplete="off"
                  />
                </Field>

                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">
                    {t("ibanShowToggle") || "International (IBAN/BIC)"}
                  </summary>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                    <div className="sm:col-span-2">
                      <Field label="IBAN">
                        <input
                          type="text"
                          value={paymentForm.iban}
                          onChange={(e) =>
                            setPaymentForm((f) => ({ ...f, iban: e.target.value.toUpperCase().replace(/\s/g, "") }))
                          }
                          placeholder="DK5000400440116243"
                          maxLength={34}
                          className={INPUT_CLASS + " font-mono"}
                          autoComplete="off"
                        />
                      </Field>
                    </div>
                    <Field label="BIC / SWIFT">
                      <input
                        type="text"
                        value={paymentForm.bic}
                        onChange={(e) =>
                          setPaymentForm((f) => ({ ...f, bic: e.target.value.toUpperCase().replace(/\s/g, "") }))
                        }
                        placeholder="DABADKKK"
                        maxLength={11}
                        className={INPUT_CLASS + " font-mono"}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                </details>

                {paymentMsg && <Message tone="success">{paymentMsg}</Message>}
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="accent" busy={paymentSaving}>
                    {paymentSaving ? (t("saving") || "Saving…") : (t("save") || "Save")}
                  </Button>
                </div>
              </form>
            </Card>

            <Card className="mt-4">
              <Card.Header
                title={t("accountantContact") || "Accountant contact"}
                subtitle={
                  t("accountantContactDesc") ||
                  "Pre-fills the Send button on Daily Close range exports. Optional."
                }
                icon={<Icon name="Mail" size={18} />}
              />
              <form onSubmit={saveAccountant} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field
                    label={t("accountantNameLabel") || "Accountant name (optional)"}
                    hint={t("accountantNameHint") || 'Used in the email greeting ("Hej Anna,").'}
                  >
                    <input
                      type="text"
                      value={accountantForm.accountant_name}
                      onChange={(e) => setAccountantForm((f) => ({ ...f, accountant_name: e.target.value }))}
                      placeholder="Anna Hansen"
                      maxLength={150}
                      className={INPUT_CLASS}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label={t("accountantEmailLabel") || "Accountant email"}>
                    <input
                      type="email"
                      value={accountantForm.accountant_email}
                      onChange={(e) => setAccountantForm((f) => ({ ...f, accountant_email: e.target.value }))}
                      placeholder="anna@revisor.dk"
                      maxLength={254}
                      className={INPUT_CLASS}
                      autoComplete="off"
                    />
                  </Field>
                </div>
                {accountantMsg && <Message tone="success">{accountantMsg}</Message>}
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary" busy={accountantSaving}>
                    {accountantSaving ? (t("saving") || "Saving…") : (t("save") || "Save")}
                  </Button>
                </div>
              </form>
            </Card>

            {/* Task #204 P2.8 — Revisor access section was previously
                rendered here; moved to /team so all people-with-access
                surfaces live in one place.  We leave a one-line
                breadcrumb so anyone who bookmarked /profile#billing
                still discovers the new home. */}
            <Card className="mt-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <Icon name="KeyRound" size={16} className="text-gray-500 dark:text-gray-400" />
                <span>
                  {t("profileRevisorMovedNotice") ||
                    "Revisor adgang er flyttet til Hold."}
                </span>
                <a
                  href="/team"
                  className="text-gray-900 dark:text-gray-100 font-medium underline hover:no-underline"
                >
                  {t("profileRevisorMovedCta") || "Åbn Hold"}
                </a>
              </div>
            </Card>
          </SectionAnchor>

          {/* ─── Brand & appearance ───────────────────────────────── */}
          <SectionAnchor id="brand">
            <Card>
              <Card.Header
                title={t("profileBrandCardTitle")}
                subtitle={
                  t("brandDesc") ||
                  "Customize how your faktura looks. Logo + one accent color from our Copenhagen palette."
                }
                icon={<Icon name="Image" size={18} />}
              />
              <div className="space-y-5">
                <div>
                  <label className={LABEL_CLASS}>{t("brandLogoLabel") || "Logo"}</label>
                  <div className="flex items-center gap-4">
                    {brand.logo_url ? (
                      <img
                        src={brand.logo_url}
                        alt="Current logo"
                        className="w-20 h-20 object-contain border border-gray-200 dark:border-gray-700 rounded-lg bg-white p-2"
                      />
                    ) : (
                      <div className="w-20 h-20 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg flex items-center justify-center text-gray-400 dark:text-gray-600">
                        <Icon name="Image" size={24} />
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <label className="cursor-pointer">
                        <span className="inline-flex items-center gap-2 px-3.5 py-2 h-9 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-100 text-sm font-medium rounded-lg transition">
                          {logoUploading
                            ? (t("uploading") || "Uploading…")
                            : (brand.logo_url ? (t("brandReplaceLogo") || "Replace") : (t("brandUploadLogo") || "Upload logo"))}
                        </span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          onChange={(e) => uploadLogo(e.target.files?.[0])}
                          disabled={logoUploading}
                          className="hidden"
                        />
                      </label>
                      {brand.logo_url && (
                        <Button variant="ghost" size="sm" onClick={deleteLogo} className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                          {t("brandRemoveLogo") || "Remove"}
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className={HINT_CLASS}>
                    {t("brandLogoHint") || "PNG or JPEG, max 1 MB. Auto-resized + EXIF stripped for privacy."}
                  </p>
                </div>

                <div>
                  <label className={LABEL_CLASS}>{t("brandPositionLabel") || "Logo position"}</label>
                  <div className="flex gap-2">
                    {[
                      { value: "left", label: t("brandPositionLeft") || "Left (default)" },
                      { value: "center", label: t("brandPositionCenter") || "Center" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => saveBrand({ logo_position: opt.value })}
                        className={
                          "px-3.5 py-2 h-9 rounded-lg text-sm font-medium border transition " +
                          (brand.logo_position === opt.value
                            ? "bg-gray-900 dark:bg-gray-100 border-gray-900 dark:border-gray-100 text-white dark:text-gray-900"
                            : "bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800")
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className={LABEL_CLASS} id="brand-accent-label">{t("brandColorLabel") || "Accent color"}</span>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="brand-accent-label">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!brand.accent_color}
                      aria-label={t("brandColorDefault") || "Default (no accent color)"}
                      onClick={() => saveBrand({ accent_color: null })}
                      className={
                        "w-10 h-10 rounded-lg border-2 transition inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
                        (!brand.accent_color
                          ? "border-gray-900 dark:border-gray-100"
                          : "border-gray-200 dark:border-gray-700")
                      }
                      title="Default (no color)"
                    >
                      <span className="text-gray-500 text-xs" aria-hidden="true">×</span>
                    </button>
                    {Object.entries(brand.accent_palette || {}).map(([name, hex]) => (
                      <button
                        key={name}
                        type="button"
                        role="radio"
                        aria-checked={(brand.accent_color || "").toUpperCase() === hex.toUpperCase()}
                        aria-label={name}
                        onClick={() => saveBrand({ accent_color: name })}
                        className={
                          "w-10 h-10 rounded-lg border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
                          ((brand.accent_color || "").toUpperCase() === hex.toUpperCase()
                            ? "border-gray-900 dark:border-gray-100 scale-105"
                            : "border-gray-200 dark:border-gray-700")
                        }
                        style={{ backgroundColor: hex }}
                        title={name}
                      />
                    ))}
                  </div>
                  <p className={HINT_CLASS}>
                    {t("brandColorHint") || "Locked to 6 presets — keeps fakturaer professional."}
                  </p>
                </div>

                {brandMsg && <Message tone="success">{brandMsg}</Message>}
              </div>
            </Card>

            <Card variant="subtle" className="mt-4">
              <Card.Header
                title={t("profileThemeCardTitle")}
                subtitle={t("profileThemeCardDesc")}
                icon={<Icon name="Palette" size={18} />}
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {THEMES.map((th) => {
                  const active = theme === th.id;
                  return (
                    <button
                      key={th.id}
                      onClick={() => setTheme(th.id)}
                      aria-pressed={active}
                      className={
                        "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition " +
                        (active
                          ? "bg-white dark:bg-gray-900 border-2 border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100"
                          : "bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600")
                      }
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
            </Card>
          </SectionAnchor>

          {/* ─── Notifications ────────────────────────────────────── */}
          <SectionAnchor id="notifications">
            <Card>
              <Card.Header
                title={t("emailNotifications")}
                subtitle={t("dailyDigestDesc")}
                icon={<Icon name="Bell" size={18} />}
              />
              <div className="divide-y divide-gray-200 dark:divide-gray-800 -mx-1">
                {/* Task #54 — Daily Brief 8am email. Sits at the TOP of the
                    notifications list because it's the headline product
                    experience: owners get the same /dashboard brief in their
                    inbox each morning. */}
                <ToggleRow
                  label={t("dailyBriefEmail")}
                  desc={t("dailyBriefEmailDesc")}
                  checked={emailPrefs.daily_brief_email_enabled}
                  onChange={() => toggleEmailPref("daily_brief_email_enabled")}
                  rightSlot={
                    emailPrefs.daily_brief_email_enabled ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        busy={sendingBriefTest}
                        onClick={sendTestBrief}
                      >
                        {sendingBriefTest ? t("sending") : t("sendTestNow")}
                      </Button>
                    ) : null
                  }
                />
                {briefTestMsg && (
                  <div className="py-1.5 px-1 text-xs text-gray-700 dark:text-emerald-400">
                    {briefTestMsg}
                  </div>
                )}
                <ToggleRow
                  label={t("dailyDigestLabel")}
                  desc={t("dailyDigestDesc")}
                  checked={emailPrefs.daily_digest_enabled}
                  onChange={() => toggleEmailPref("daily_digest_enabled")}
                />
                <ToggleRow
                  label={t("expenseAlertsLabel")}
                  desc={t("expenseAlertsDesc")}
                  checked={emailPrefs.expense_alerts_enabled}
                  onChange={() => toggleEmailPref("expense_alerts_enabled")}
                />
                {pushSupported && (
                  <div className="py-4 px-1">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1 pr-2">
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                          {t("pushPhoneTitle") || t("pushNotificationsLabel")}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {t("pushPhoneDesc") || t("pushNotificationsDesc")}
                        </p>
                      </div>
                      {pushPerm === "denied" ? (
                        <span className="text-xs text-gray-500">{t("pushDenied") || t("blockedInBrowser")}</span>
                      ) : pushSubscribed ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          busy={pushBusy}
                          onClick={async () => {
                            setPushMsg("");
                            const res = await pushUnsubscribe();
                            if (res?.ok) setPushMsg(t("pushDisabledMsg") || "Push turned off on this device.");
                          }}
                        >
                          {t("pushDisable") || "Turn off"}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          busy={pushBusy}
                          onClick={async () => {
                            setPushMsg("");
                            const res = await pushSubscribe();
                            if (res?.ok) {
                              setPushMsg(t("pushEnabledMsg") || "Push is on. Try the test below.");
                            } else if (res?.error === "denied") {
                              setPushMsg(t("pushDenied") || "Push is blocked in your browser settings.");
                            } else if (res?.error === "push_disabled") {
                              setPushMsg(t("pushUnavailable") || "Push is temporarily unavailable.");
                            } else if (res?.error) {
                              setPushMsg(t("pushGenericError") || "Couldn't enable push. Try again later.");
                            }
                          }}
                        >
                          {t("pushEnable") || "Enable"}
                        </Button>
                      )}
                    </div>
                    {pushSubscribed && (
                      <div className="mt-3 flex items-center gap-3 flex-wrap">
                        <Button
                          size="sm"
                          variant="secondary"
                          busy={pushTestBusy}
                          onClick={async () => {
                            setPushTestBusy(true);
                            setPushMsg("");
                            try {
                              const res = await pushSendTest();
                              if (res?.ok) {
                                setPushMsg(t("pushTestSent") || "Test sent — check your lock screen.");
                              } else if (res?.error === "rate_limited") {
                                setPushMsg(t("pushTestRateLimited") || "Slow down — limit reached. Try again later.");
                              } else {
                                setPushMsg(t("pushGenericError") || "Couldn't send test. Try again later.");
                              }
                            } finally {
                              setPushTestBusy(false);
                            }
                          }}
                        >
                          {pushTestBusy ? (t("sending") || "Sending...") : (t("pushTest") || "Send test push")}
                        </Button>
                        {pushMsg && (
                          <span className="text-xs text-gray-700 dark:text-emerald-400">{pushMsg}</span>
                        )}
                      </div>
                    )}
                    {!pushSubscribed && pushMsg && (
                      <p className="mt-2 text-xs text-gray-700 dark:text-emerald-400">{pushMsg}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="pt-4 mt-2 border-t border-gray-200 dark:border-gray-800 flex items-center gap-3 flex-wrap">
                <Button variant="secondary" size="sm" busy={sendingTest} onClick={sendTestDigest}>
                  {sendingTest ? t("sending") : t("sendTestDigest")}
                </Button>
                {emailMsg && <span className="text-sm text-gray-700 dark:text-emerald-400">{emailMsg}</span>}
              </div>
            </Card>

            <Card className="mt-4">
              <Card.Header
                title={t("whatsappBot")}
                subtitle={t("whatsappBotDesc")}
                icon={<Icon name="MessageCircle" size={18} />}
              />
              <WhatsAppBlock
                t={t}
                waStatus={waStatus}
                waPhone={waPhone}
                setWaPhone={setWaPhone}
                waCode={waCode}
                waMsg={waMsg}
                waLinking={waLinking}
                onLink={linkWhatsApp}
                onUnlink={unlinkWhatsApp}
              />
            </Card>
          </SectionAnchor>

          {/* ─── Privacy & data ───────────────────────────────────── */}
          <SectionAnchor id="privacy">
            <Card>
              <Card.Header
                title={t("privacyDataSection")}
                subtitle={t("privacyDataDesc")}
                icon={<Icon name="Shield" size={18} />}
              />
              <div className="space-y-4">
                <ToggleRow
                  label={t("pauseAnalytics")}
                  desc="When ON, BonBox stops recording your clicks, page views and AI questions. Your business data (sales, expenses, inventory) is unaffected. You can resume any time. Existing analytics older than 180 days are auto-deleted."
                  checked={analyticsOptOut}
                  onChange={toggleAnalyticsOptOut}
                />
                {privacyMsg && <Message tone="info">{privacyMsg}</Message>}
                <p className="text-[11px] text-gray-500 dark:text-gray-400 pt-3 border-t border-gray-200 dark:border-gray-800">
                  GDPR: BonBox processes analytics under legitimate-interest basis. Your right to opt
                  out is respected here. To delete all your data, see the Danger Zone below.
                </p>
              </div>
            </Card>

            <Card variant="subtle" className="mt-4">
              <Card.Header
                title={t("exportAllData") || "Export All Data"}
                subtitle={t("exportAllDataDesc") || "Download everything BonBox stores about you as a CSV file"}
                icon={<Icon name="Download" size={18} />}
                action={
                  <Button
                    variant="primary"
                    size="md"
                    busy={exporting}
                    onClick={async () => {
                      setExporting(true);
                      try {
                        const res = await api.get("/auth/export-data", { responseType: "blob" });
                        const url = window.URL.createObjectURL(new Blob([res.data]));
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `bonbox_export_${localIso()}.csv`;
                        a.click();
                        window.URL.revokeObjectURL(url);
                      } catch { /* ignore */ }
                      setExporting(false);
                    }}
                  >
                    {exporting ? t("exporting") || "Exporting..." : t("downloadCsv") || "Download CSV"}
                  </Button>
                }
              />
            </Card>

            <Card
              variant="subtle"
              className="mt-4 hover:shadow-sm transition-shadow"
              to="/tax"
            >
              <div className="flex items-center gap-3">
                <Icon name="Calculator" size={18} className="text-gray-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t("profileTaxLinkTitle")}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t("profileTaxLinkBody")}
                  </p>
                </div>
                <span className="text-sm text-gray-400 shrink-0">→</span>
              </div>
            </Card>

            <Card variant="subtle" className="mt-4">
              <Card.Header
                title={t("profileTipsCardTitle")}
                subtitle={t("profileTipsCardDesc")}
                icon={<Icon name="Sparkles" size={18} />}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      resetAllTips();
                      window.location.reload();
                    }}
                  >
                    {t("profileTipsResetBtn")}
                  </Button>
                }
              />
            </Card>

            {/* Task #68 — Clear demo data. Only renders when the user
                actually has " · demo"-tagged rows on their account.
                Privacy posture: the clear only touches rows that
                carry the demo marker, so the owner's real data is
                never at risk. */}
            {demoStatus?.has_demo && (
              <Card variant="subtle" className="mt-4">
                <Card.Header
                  title={t("demoClearTitle") || "Clear sample data"}
                  subtitle={
                    t("demoClearDesc") ||
                    "Remove the demo restaurant data you loaded from the dashboard. Only rows tagged as sample data are removed — anything you've added yourself stays put."
                  }
                  icon={<Icon name="Eraser" size={18} />}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onClearDemoData}
                      busy={demoClearBusy}
                    >
                      {t("demoClearBtn") || "Clear sample data"}
                    </Button>
                  }
                />
                {demoClearMsg && (
                  <p className="text-xs text-gray-600 dark:text-gray-300 mt-2">
                    {demoClearMsg}
                  </p>
                )}
              </Card>
            )}

            {/* Task #55 — Re-run the welcome wizard. Owners only (the
                /auth/onboarding/reset endpoint 403s non-owners anyway). */}
            {(user.role || "owner").toLowerCase() === "owner" && (
              <Card variant="subtle" className="mt-4">
                <Card.Header
                  title={t("onbReRunTitle") || "Run the welcome wizard again"}
                  subtitle={
                    t("onbReRunDesc") ||
                    "Revisit the 4-step setup — useful if you skipped it, changed verticals, or want to invite a new revisor."
                  }
                  icon={<Icon name="RotateCw" size={18} />}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={reRunOnboarding}
                      busy={reRunOnbBusy}
                    >
                      {t("onbReRunBtn") || "Open onboarding"}
                    </Button>
                  }
                />
                {reRunOnbError && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                    {reRunOnbError}
                  </p>
                )}
              </Card>
            )}

            <Card variant="subtle" className="mt-4">
              <Card.Header
                title={t("profileAccountDetailsTitle")}
                icon={<Icon name="UserCog" size={18} />}
              />
              <dl className="text-sm space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-gray-500 dark:text-gray-400">
                    {t("profileAccountIdLabel")}
                  </dt>
                  <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 truncate">
                    {user.id}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-gray-500 dark:text-gray-400">
                    {t("profileDailyGoalLabel")}
                  </dt>
                  <dd className="text-gray-700 dark:text-gray-300">
                    {user.daily_goal > 0
                      ? `${Number(user.daily_goal).toLocaleString()} ${form.currency}`
                      : t("notSetLabel")}
                  </dd>
                </div>
              </dl>
            </Card>
          </SectionAnchor>

          {/* ─── Danger zone ──────────────────────────────────────── */}
          <SectionAnchor id="danger">
            <div
              className="rounded-xl p-5 sm:p-6 border border-red-200 dark:border-red-900/60 bg-red-50/40 dark:bg-red-950/20"
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon name="AlertTriangle" size={18} className="text-red-600 dark:text-red-400 shrink-0" />
                    <h3 className="text-base font-semibold text-red-700 dark:text-red-300">
                      {t("deleteAccount") || "Delete Account"}
                    </h3>
                  </div>
                  <p className="text-xs text-red-600/80 dark:text-red-400/80 mt-1">
                    {t("deleteAccountDesc") ||
                      "Permanently delete your account and all data. This cannot be undone."}
                  </p>
                </div>
                {!deleteConfirm && (
                  <Button variant="danger" size="md" onClick={() => setDeleteConfirm(true)}>
                    {t("deleteMyAccount") || "Delete My Account"}
                  </Button>
                )}
              </div>

              {deleteConfirm && (
                <div className="pt-4 mt-2 border-t border-red-200/70 dark:border-red-900/50 space-y-3">
                  <p className="text-sm text-red-700 dark:text-red-300 font-medium">
                    {t("deleteConfirmWarning") ||
                      "This will permanently delete ALL your data: sales, expenses, inventory, reports, everything. Enter your password to confirm."}
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="password"
                      value={deletePassword}
                      onChange={(e) => {
                        setDeletePassword(e.target.value);
                        setDeleteError("");
                      }}
                      placeholder={t("enterPassword") || "Enter your password"}
                      className={
                        "flex-1 px-3 py-2 rounded-lg border border-red-300 dark:border-red-800 " +
                        "bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 " +
                        "focus:outline-none focus:ring-2 focus:ring-red-500"
                      }
                      autoComplete="current-password"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        busy={deleting}
                        onClick={async () => {
                          if (!deletePassword) return;
                          setDeleting(true);
                          setDeleteError("");
                          try {
                            await api.delete("/auth/delete-account", { data: { password: deletePassword } });
                            localStorage.clear();
                            window.location.href = "/login";
                          } catch (err) {
                            setDeleteError(errText(err, t("deleteFailed") || "Failed to delete account"));
                          }
                          setDeleting(false);
                        }}
                        disabled={!deletePassword}
                      >
                        {deleting ? t("deleting") || "Deleting..." : t("confirmDelete") || "Confirm Delete"}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setDeleteConfirm(false);
                          setDeletePassword("");
                          setDeleteError("");
                        }}
                      >
                        {t("cancel") || "Cancel"}
                      </Button>
                    </div>
                  </div>
                  {deleteError && <Message tone="error">{deleteError}</Message>}
                </div>
              )}
            </div>
          </SectionAnchor>
        </main>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Page-local presentational helpers
   ═══════════════════════════════════════════════════════════════ */

/** Wraps each Card group so the matching TOC entry can scroll-to with
 *  scroll-margin-top compensating for the sticky app header. */
function SectionAnchor({ id, children }) {
  return (
    <section id={id} className="scroll-mt-24">
      {children}
    </section>
  );
}

/** Sticky left-rail nav. Hidden below md; renders one link per SECTION
 *  entry, smooth-scrolls to the anchor. Marks the active section via
 *  the scroll position so the user always knows where they are. */
function TableOfContents({ t }) {
  const [active, setActive] = useState("account");

  useEffect(() => {
    // IntersectionObserver beats scroll handlers here — fires only when
    // a section enters/leaves the top-third of the viewport, so the
    // active state stays stable mid-scroll.
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      },
      { rootMargin: "-30% 0% -60% 0%", threshold: 0 },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <aside className="hidden md:block">
      <nav className="sticky top-20" aria-label={t("profileNavOnThisPage")}>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          {t("profileNavOnThisPage")}
        </p>
        <ul className="space-y-0.5">
          {SECTIONS.map((s) => {
            const isActive = active === s.id;
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className={
                    "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition " +
                    (isActive
                      ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-100")
                  }
                >
                  <Icon name={s.icon} size={15} className="shrink-0" />
                  <span className="truncate">{t(s.titleKey)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

/** Identity strip at the top of the Account card — name + email +
 *  verified badge. Compact, no avatar circle (the page header already
 *  tells you whose settings you're looking at). */
function ProfileIdentity({ user, t }) {
  return (
    <div className="flex items-center gap-3 mb-4 pb-4 border-b border-gray-200 dark:border-gray-800">
      <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-base font-semibold text-gray-700 dark:text-gray-200">
        {user.business_name?.charAt(0)?.toUpperCase() || "B"}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
          {user.business_name}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5 truncate">
          <span className="truncate">{user.email}</span>
          {user.email_verified ? (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-full text-[10px] font-medium shrink-0"
              title="Email verified"
            >
              <Icon name="CheckCircle2" size={10} />
              {t("profileVerified")}
            </span>
          ) : (
            <a
              href="/verify-email"
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 rounded-full text-[10px] font-medium hover:bg-amber-100 dark:hover:bg-amber-950/60 transition shrink-0"
              title="Click to verify your email"
            >
              <Icon name="AlertTriangle" size={10} />
              {t("profileUnverified")}
            </a>
          )}
        </p>
      </div>
    </div>
  );
}

/** Generic field wrapper — label, optional hint, child input. Keeps
 *  every form section visually identical. */
function Field({ label, hint, children }) {
  return (
    <div>
      {label && <label className={LABEL_CLASS}>{label}</label>}
      {children}
      {hint && <p className={HINT_CLASS}>{hint}</p>}
    </div>
  );
}

/** Inline message under a form — success / error / info.
 *  role="status" + aria-live="polite" ensure screen readers announce
 *  these inline confirmations / errors as they appear (WCAG 4.1.3). */
function Message({ tone = "info", children }) {
  const TONE = {
    success: "text-gray-700 dark:text-emerald-400",
    error: "text-red-700 dark:text-red-400",
    info: "text-gray-700 dark:text-gray-300",
  };
  // Errors are assertive — interrupt the screen reader. Success/info are polite.
  const live = tone === "error" ? "assertive" : "polite";
  const role = tone === "error" ? "alert" : "status";
  return (
    <p className={"text-sm " + (TONE[tone] || TONE.info)} role={role} aria-live={live}>
      {children}
    </p>
  );
}

/** Settings toggle row used across notifications + privacy.
 *  `rightSlot` (optional) renders an action chip BETWEEN the desc text and
 *  the toggle switch — used by the Daily Brief row to surface a "Send a
 *  test now" button next to the toggle. */
function ToggleRow({ label, desc, checked, onChange, rightSlot = null }) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 px-1">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{label}</p>
        {desc && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{desc}</p>}
      </div>
      {rightSlot ? <div className="shrink-0 self-center">{rightSlot}</div> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={
          "shrink-0 mt-0.5 relative w-11 h-6 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
          (checked ? "bg-gray-900" : "bg-gray-300 dark:bg-gray-700")
        }
      >
        <span
          className={
            "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform " +
            (checked ? "translate-x-5" : "")
          }
        />
      </button>
    </div>
  );
}

/** Labor-cost target stepper — tunes the Schedule Autopilot.
 *  Self-contained: fetches /business GET on mount, displays the
 *  current target_labor_pct (default 30%), lets the owner adjust
 *  with a number input + range slider, persists via PUT /business.
 *
 *  Backend clamps to [0.10, 0.50] regardless of input so this UI
 *  doesn't need to guard against weird values.
 */
function LaborTargetStepper() {
  const { t } = useLanguage();
  const [pct, setPct] = useState(30);  // displayed as integer %
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    let alive = true;
    api.get("/business")
      .then((r) => {
        if (!alive) return;
        const raw = r.data?.target_labor_pct;
        if (raw != null) {
          const v = Math.round(Number(raw) * 100);
          if (!Number.isNaN(v) && v >= 10 && v <= 50) setPct(v);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => { alive = false; };
  }, []);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setToast("");
    try {
      await api.put("/business", { target_labor_pct: pct / 100 });
      setToast(t("laborTargetSaved") || "Saved");
      setTimeout(() => setToast(""), 2000);
    } catch {
      setToast(t("laborTargetFailed") || "Couldn't save — try again.");
      setTimeout(() => setToast(""), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <Card variant="subtle">
      <Card.Header
        title={t("laborTargetTitle") || "Labor cost target"}
        subtitle={
          t("laborTargetSubtitle") ||
          "What share of revenue should go to wages? The schedule autopilot uses this when suggesting next week's shifts."
        }
        icon={<Icon name="Target" size={16} className="text-gray-500" />}
      />
      <div className="flex items-center gap-4 py-2">
        <input
          type="range"
          min={10}
          max={50}
          step={1}
          value={pct}
          onChange={(e) => setPct(parseInt(e.target.value, 10))}
          className="flex-1 accent-emerald-600"
          aria-label="Labor target percentage"
        />
        <span className="text-xl font-semibold text-gray-900 dark:text-gray-100 w-14 text-right">
          {pct}%
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {t("laborTargetHint") ||
            "Most Danish cafés target 25–35%. Tighter operations run lower."}
        </p>
        <div className="flex items-center gap-3 shrink-0">
          {toast && (
            <span className="text-xs text-gray-700 dark:text-emerald-400">
              {toast}
            </span>
          )}
          <Button onClick={onSave} disabled={saving} size="sm">
            {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** DayCutoffStepper — service-day rollover hour editor.
 *
 *  Stored on BusinessProfile.day_cutoff_hour (integer, [0, 23]). The
 *  whole TZ stack (tz_utils.business_day_window / business_today_local)
 *  uses this to decide which calendar date a sale belongs to. A 02:00
 *  ring with cutoff=6 lands on YESTERDAY's books — that's the Danish
 *  restaurant convention.
 *
 *  Defaults to 6 if the API returns null/undefined so the UI matches
 *  what the backend default + tz_utils helper now promise (migration
 *  012 made the column default 6 as well, but defensive defaulting here
 *  keeps the editor sensible if /business returns nothing).
 *
 *  Backend clamps [0, 23] regardless of input; this UI bounds the input
 *  itself so the slider never represents an invalid hour visually.
 */
function DayCutoffStepper() {
  const { t } = useLanguage();
  const [hour, setHour] = useState(6);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    let alive = true;
    api.get("/business")
      .then((r) => {
        if (!alive) return;
        const raw = r.data?.day_cutoff_hour;
        if (raw != null) {
          const v = parseInt(raw, 10);
          if (!Number.isNaN(v) && v >= 0 && v <= 23) setHour(v);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => { alive = false; };
  }, []);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setToast("");
    try {
      await api.put("/business", { day_cutoff_hour: hour });
      setToast(t("dayCutoffSaved") || "Saved");
      setTimeout(() => setToast(""), 2000);
    } catch {
      setToast(t("dayCutoffFailed") || "Couldn't save — try again.");
      setTimeout(() => setToast(""), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  // Pad hour for the display label so 06:00 reads cleanly.
  const hourLabel = String(hour).padStart(2, "0") + ":00";

  return (
    <Card variant="subtle">
      <Card.Header
        title={t("dayCutoffTitle") || "Business-day rollover"}
        subtitle={
          t("dayCutoffSubtitle") ||
          "When does today's books close and tomorrow's open? Restaurants usually pick 06:00 so late-night service still counts toward last night's shift."
        }
        icon={<Icon name="Clock" size={16} className="text-gray-500" />}
      />
      <div className="flex items-center gap-4 py-2">
        <input
          type="range"
          min={0}
          max={23}
          step={1}
          value={hour}
          onChange={(e) => setHour(parseInt(e.target.value, 10))}
          className="flex-1 accent-emerald-600"
          aria-label={t("dayCutoffSliderAria") || "Day rollover hour (0-23)"}
        />
        <span className="text-xl font-semibold text-gray-900 dark:text-gray-100 w-16 text-right tabular-nums">
          {hourLabel}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {t("dayCutoffHint") ||
            "06:00 = Danish restaurant convention (02:00 sale → yesterday). 00:00 = midnight rollover (office hours)."}
        </p>
        <div className="flex items-center gap-3 shrink-0">
          {toast && (
            <span className="text-xs text-gray-700 dark:text-emerald-400">
              {toast}
            </span>
          )}
          <Button onClick={onSave} disabled={saving} size="sm">
            {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Three-state WhatsApp linking block. Extracted because the inline
 *  version was too long and obscured the rest of the notifications
 *  card. Logic is unchanged. */
function WhatsAppBlock({ t, waStatus, waPhone, setWaPhone, waCode, waMsg, waLinking, onLink, onUnlink }) {
  if (waStatus?.verified) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-100/70 dark:border-gray-700">
          <span className="w-2 h-2 bg-emerald-500 rounded-full" />
          <span className="text-sm font-medium text-gray-800 dark:text-gray-300">
            {t("connectedLabel")}: {waStatus.phone}
          </span>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border border-gray-200/70 dark:border-gray-700/50">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            {t("quickCommandsLabel")}:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
            <span><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">14500</code> Log revenue</span>
            <span><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">expense 2500 food</code> Log expense</span>
            <span><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">summary</code> Today's stats</span>
            <span><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">profit</code> Monthly profit</span>
            <span><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">inventory</code> Stock alerts</span>
            <span><code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">help</code> All commands</span>
          </div>
        </div>
        <button onClick={onUnlink} className="text-xs text-red-600 dark:text-red-400 hover:underline">
          {t("unlinkWhatsapp")}
        </button>
      </div>
    );
  }
  if (waStatus?.linked) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200/70 dark:border-amber-900/50">
          <span className="w-2 h-2 bg-amber-500 rounded-full" />
          <span className="text-sm text-amber-800 dark:text-amber-300">
            {t("verificationPendingFor")} {waStatus.phone}
          </span>
        </div>
        {waCode && (
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 text-center border border-gray-200/70 dark:border-gray-700/50">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t("yourVerificationCode")}:
            </p>
            <p className="text-2xl font-bold tracking-widest text-gray-900 dark:text-gray-100">
              {waCode}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{t("sendCodeToBonbox")}</p>
          </div>
        )}
        {!waCode && <p className="text-xs text-gray-500">{t("sendCodeToBonbox")}</p>}
        <button onClick={onUnlink} className="text-xs text-red-600 dark:text-red-400 hover:underline">
          {t("unlinkWhatsapp")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t("linkPhoneDesc")}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="tel"
          value={waPhone}
          onChange={(e) => setWaPhone(e.target.value)}
          placeholder="+45 91 67 59 74"
          className={INPUT_CLASS + " flex-1"}
        />
        <Button variant="accent" busy={waLinking} onClick={onLink} disabled={!waPhone.trim()}>
          {waLinking ? t("sending") : t("link")}
        </Button>
      </div>
      {waMsg && <Message tone="success">{waMsg}</Message>}
    </div>
  );
}

/**
 * Verified-business banner — shows the freshness + provenance of the
 * saved profile, plus warning flags + the Re-verify button.
 *
 * Three visual states:
 *   1. cvr_verified_at set + recent  → green "Verified · 2 days ago"
 *   2. cvr_verified_at set + stale   → amber "Last checked 4 months ago"
 *   3. cvr_verified_at NULL          → grey "Manual entry · not verified"
 *
 * Stale threshold: 90 days.
 */
function VerifiedBusinessBanner({ profile, reverifying, reverifyMsg, onReverify }) {
  if (!profile) return null;

  const verifiedAt = profile.cvr_verified_at ? new Date(profile.cvr_verified_at) : null;
  const ageMs = verifiedAt ? (Date.now() - verifiedAt.getTime()) : null;
  const ageDays = ageMs !== null ? Math.floor(ageMs / 86400000) : null;
  const isStale = ageDays !== null && ageDays > 90;
  const isVerified = !!verifiedAt && !isStale;

  const flags = (profile.status_flags || "").split("|").filter(Boolean);

  const ageLabel =
    ageDays === null ? "Not yet verified"
    : ageDays === 0 ? "Just now"
    : ageDays === 1 ? "Yesterday"
    : ageDays < 7 ? `${ageDays} days ago`
    : ageDays < 30 ? `${Math.floor(ageDays / 7)} weeks ago`
    : ageDays < 365 ? `${Math.floor(ageDays / 30)} months ago`
    : `${Math.floor(ageDays / 365)} years ago`;

  const surfaceClass = isVerified
    ? "bg-gray-50/60 dark:bg-gray-800/50 border-gray-100/70 dark:border-gray-700"
    : isStale
      ? "bg-amber-50/60 dark:bg-amber-950/20 border-amber-200/70 dark:border-amber-900/50"
      : "bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700";

  const titleColor = isVerified
    ? "text-gray-800 dark:text-gray-300"
    : isStale
      ? "text-amber-800 dark:text-amber-300"
      : "text-gray-700 dark:text-gray-200";

  const StatusIcon = isVerified ? (
    <Icon name="CheckCircle2" size={16} className="text-emerald-600 dark:text-emerald-400" />
  ) : isStale ? (
    <Icon name="AlertTriangle" size={16} className="text-amber-600 dark:text-amber-400" />
  ) : (
    <Icon name="Building" size={16} className="text-gray-500" />
  );

  return (
    <div className={`mb-4 px-4 py-3 rounded-lg border ${surfaceClass}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <span className="mt-0.5">{StatusIcon}</span>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${titleColor} truncate`}>
              {profile.company_name}
              {profile.org_number && (
                <span className="font-normal opacity-70 ml-2">({profile.org_number})</span>
              )}
            </p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
              {isVerified
                ? `Verified · ${profile.cvr_verified_source || "register"} · ${ageLabel}`
                : isStale
                  ? `Last checked ${ageLabel} — re-verify to pick up any changes`
                  : "Manual entry — not verified against any register"}
            </p>
            {profile.dawa_address_id && (
              <p className="text-[10px] text-gray-500 dark:text-gray-500 mt-0.5">
                Address cross-checked with DAWA postal register
              </p>
            )}
          </div>
        </div>

        {profile.org_number && (
          <Button
            variant={isStale ? "accent" : "secondary"}
            size="sm"
            busy={reverifying}
            onClick={onReverify}
          >
            {reverifying ? "Checking…" : "Re-verify"}
          </Button>
        )}
      </div>

      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-gray-200/70 dark:border-gray-700/50">
          {flags.includes("konkurs") && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300 font-semibold">
              Under konkurs
            </span>
          )}
          {flags.includes("ophoert") && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300 font-semibold">
              Ophørt
            </span>
          )}
          {flags.includes("protected") && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 font-semibold">
              Beskyttet navn
            </span>
          )}
          {flags.includes("no_vat") && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 font-semibold">
              Ikke MOMS-registreret
            </span>
          )}
        </div>
      )}

      {reverifyMsg && (
        <p className="text-[11px] text-gray-600 dark:text-gray-300 mt-2 pt-2 border-t border-gray-200/70 dark:border-gray-700/50">
          {reverifyMsg}
        </p>
      )}
    </div>
  );
}
