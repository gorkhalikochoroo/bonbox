/**
 * Release gate R-a (9 Oct) — the small, pure pieces.
 *
 *   • closeEmailState: a day held while "Har du selv oprettet denne konto?"
 *     is open reads "claim_open" (never "confirm your e-mail"), and a held
 *     day whose owner copy ALSO failed keeps both facts from the persisted
 *     "revisor_<reason>;<error>" marker.
 *   • A forged / unknown login-link token on /login/magic is not bounced to
 *     /login by the 401 handler: the page says "Dette link er ugyldigt".
 *   • The verify-email code boxes share the row (no fixed 52 px width).
 *   • The cookie banner's FIRST layer names both optional purposes in every
 *     banner language — Analytics (usage statistics) and Marketing (which
 *     printed flyer led to a signup) — since "Accept all" turns both on.
 *   • After a password reset, "Nej / Ved ikke" says the password just chosen
 *     stops working too, and the new-password step follows.
 *   • The held revisor-invite notice after onboarding names the open
 *     question and offers "Send spørgsmålet igen", not "Bekræft nu".
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), user: null }));
vi.mock("../services/api", async (orig) => {
  const real = await orig();
  return { ...real, default: { post: (...a) => h.post(...a), get: (...a) => h.get(...a) } };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));

import { closeEmailState, emailErrorKey } from "../utils/closeEmail";
import { on401 } from "../services/api";
import { heldReasonForUser, heldReasonFromError } from "../utils/senderGate";
import VerifyEmailPage from "../pages/VerifyEmailPage";
import ClaimDecisionPage from "../pages/ClaimDecisionPage";
import RevisorInviteHeldNotice from "../components/RevisorInviteHeldNotice";
import CookieConsent from "../components/CookieConsent";
import { LanguageProvider } from "../hooks/useLanguage";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { np } from "../i18n/np";
import { vi as viDict } from "../i18n/vi";
import { th } from "../i18n/th";
import { tr } from "../i18n/tr";

beforeEach(() => {
  h.post.mockReset();
  h.get.mockReset();
  h.get.mockResolvedValue({ data: {} });
  h.user = null;
  localStorage.clear();
  localStorage.setItem("lang", "en");
});
afterEach(() => {
  vi.useRealTimers();
});

const P = { accountant_email: "pia@realrevisor.dk" };

describe("closeEmailState — held while the question is open (item 1)", () => {
  it("reads claim_open from the live skip or the persisted marker", () => {
    for (const k of [{ skip: "claim_question_open" }, { error: "revisor_claim_question_open" }]) {
      const s = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], profile: P, claimOpen: true, ...k });
      expect(s.kind).toBe("claim_open");
      expect(s.ownerSent).toBe(true);
    }
  });
  it("never says unverified for a confirmed address with the question open", () => {
    const s = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "email_unverified",
      profile: P, ownerConfirmed: true, claimOpen: true });
    expect(s.kind).toBe("claim_open");
  });
  it("returns to the ordinary line once the question is answered", () => {
    const s = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], error: "revisor_claim_question_open",
      profile: P, ownerConfirmed: true, claimOpen: false });
    expect(s.kind).toBe("owner_only");
  });
});

describe("History — held revisor copy AND a failed owner copy (item 9)", () => {
  it("the persisted 'revisor_<reason>;<error>' says both, after a reload", () => {
    const unv = closeEmailState({ status: "send_failed", sentTo: [], profile: P, ownerConfirmed: false,
      error: "revisor_email_unverified;email_not_configured" });
    expect(unv.kind).toBe("unverified_owner_failed");
    const claim = closeEmailState({ status: "send_failed", sentTo: [], profile: P, claimOpen: true,
      error: "revisor_claim_question_open;send_error: RuntimeError" });
    expect(claim.kind).toBe("claim_open_owner_failed");
    // The owner copy's own cause, not "unknown".
    expect(emailErrorKey("revisor_email_unverified;email_not_configured")).toBe("dcMailErrNotConfigured");
    expect(emailErrorKey("revisor_claim_question_open;send_error: RuntimeError")).toBe("dcMailErrProvider");
    expect(emailErrorKey("email_not_configured")).toBe("dcMailErrNotConfigured");
  });
});

describe("senderGate helpers", () => {
  it("reads the held reason from a 403 and from the account", () => {
    const err = (reason) => ({ response: { status: 403, data: { detail: { code: "email_unverified", ...(reason ? { reason } : {}) } } } });
    expect(heldReasonFromError(err("claim_question_open"))).toBe("claim_question_open");
    expect(heldReasonFromError(err())).toBe("email_unverified");
    expect(heldReasonFromError({ response: { status: 429, data: { detail: { code: "x" } } } })).toBeNull();
    expect(heldReasonForUser({ email_verified: false })).toBe("email_unverified");
    expect(heldReasonForUser({ email_verified: true, claim_question_open: true })).toBe("claim_question_open");
    expect(heldReasonForUser({ email_verified: true })).toBeNull();
    expect(heldReasonForUser({})).toBeNull();
  });
});

describe("a forged login-link token is not bounced to /login", () => {
  it("/login/magic and /login/claim keep the page (it says the link is invalid)", () => {
    expect(on401("/login/magic", "/auth/magic-link/verify").redirect).toBe(false);
    expect(on401("/login/claim", "/auth/claim-decision/status").redirect).toBe(false);
    // A stale stored token is still dropped there, as before.
    expect(on401("/login/magic", "/auth/magic-link/verify").wipeToken).toBe(true);
  });
  it("every other rule is unchanged", () => {
    expect(on401("/dashboard", "/sales").redirect).toBe(true);
    expect(on401("/dashboard", "/auth/me").redirect).toBe(false);
    expect(on401("/login", "/auth/login")).toEqual({ redirect: false, wipeToken: false });
    expect(on401("/r/cafe", "/billing/entitlements").redirect).toBe(false);
  });
  it("the page shows its own error state for a 401 from verify", async () => {
    h.post.mockRejectedValue({ response: { status: 401, data: { detail: { code: "magic_link_invalid" } } } });
    const LoginMagicPage = (await import("../pages/LoginMagicPage")).default;
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[`/login/magic?token=${"A".repeat(43)}`]}>
          <Routes><Route path="/login/magic" element={<LoginMagicPage />} /></Routes>
        </MemoryRouter>
      </LanguageProvider>,
    );
    expect(await screen.findByText(en.magicLinkInvalid)).toBeTruthy();
  });
});

describe("verify-email code boxes fit a 360–390 px phone (item 10)", () => {
  it("six boxes share the row instead of a fixed 52 px each", async () => {
    h.user = { email: "a@b.dk", email_verified: false };
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={["/verify-email"]}><VerifyEmailPage /></MemoryRouter>
      </LanguageProvider>,
    );
    const row = await screen.findByTestId("verify-code-row");
    const boxes = row.querySelectorAll("input");
    expect(boxes).toHaveLength(6);
    for (const b of boxes) {
      expect(b.style.width).toBe("");
      expect(b.className).toMatch(/\bflex-1\b/);
      expect(b.className).toMatch(/\bmin-w-0\b/);
      expect(b.className).toMatch(/max-w-\[3\.25rem\]/);
    }
    // 6 × 52 px + 5 × 12 px = 372 px did not fit 390 − 2 × 24 px; the
    // narrow gap leaves 45 px boxes at 360 px.
    expect(row.className).toMatch(/\bgap-2\b/);
    expect(row.className).toMatch(/\bsm:gap-3\b/);
  });
});

const DICT = { en, da, np, vi: viDict, th, tr };
// Review (9 Oct): the first layer must not read as if Analytics were off
// until "Accept all" while usage events were recorded until a decline.
// R-h (LEG-10) changed the code instead: usage events are now sent only after
// an explicit "yes" (hooks/useEventLog.analyticsAllowed), so the banner says
// "recorded only after you turn it on" — and the old "until you decline"
// clause must never come back. Marketing stays off until turned on.
const UNTIL_DECLINE = {
  en: "recorded for signed-in accounts until you decline",
  da: "registreres for loggede ind konti, indtil du afviser",
  np: "साइन इन गरिएका खाताहरूका लागि तपाईंले अस्वीकार नगरेसम्म रेकर्ड हुन्छ",
  vi: "được ghi lại cho các tài khoản đã đăng nhập cho đến khi bạn từ chối",
  th: "บันทึกสำหรับบัญชีที่เข้าสู่ระบบอยู่ จนกว่าคุณจะปฏิเสธ",
  tr: "oturum açmış hesaplar için siz reddedene kadar kaydedilir",
};
const AFTER_TURN_ON = {
  en: "recorded only after you turn it on",
  da: "registreres først, når du slår den til",
  np: "तपाईंले सक्रिय गरेपछि मात्र रेकर्ड हुन्छ",
  vi: "chỉ được ghi lại sau khi bạn bật",
  th: "บันทึกเฉพาะหลังจากที่คุณเปิดใช้",
  tr: "yalnızca siz açtıktan sonra kaydedilir",
};
const ONLY_IF_ON = {
  en: "only if you turn it on", da: "kun hvis du slår den til", np: "तपाईंले सक्रिय गर्नुभयो भने मात्र",
  vi: "chỉ khi bạn bật", th: "เฉพาะเมื่อคุณเปิดใช้", tr: "yalnızca siz açarsanız",
};
describe.each(Object.keys(DICT))("cookie banner first layer in %s — true to the code (review)", (lang) => {
  it("says usage statistics are recorded only after you turn Analytics on, and Marketing only if turned on", () => {
    const body = DICT[lang].cookieBannerBody;
    expect(body).toContain(AFTER_TURN_ON[lang]);
    expect(body).not.toContain(UNTIL_DECLINE[lang]);
    expect(body).toContain(ONLY_IF_ON[lang]);
  });
});
// R-h fix round: the clause is scoped to what the gate controls — the events
// this browser sends. Crash reports (index.html beacon, App.jsx,
// SelfHealBoundary) and the rows the server writes itself are not behind the
// banner, so "where the app breaks" is no longer part of Analytics: crash
// reports are the error log, which /privacy lists as its own 30-day item.
const BROWSER_EVENTS_AFTER_ON = {
  en: "which features are used — the events your browser sends are recorded only after you turn it on",
  da: "hvilke funktioner der bruges — hændelser fra din browser registreres først, når du slår den til",
  np: "कुन सुविधा प्रयोग हुन्छ — तपाईंको ब्राउजरले पठाउने घटनाहरू तपाईंले सक्रिय गरेपछि मात्र रेकर्ड हुन्छन्",
  vi: "tính năng nào được dùng — các sự kiện do trình duyệt của bạn gửi chỉ được ghi lại sau khi bạn bật",
  th: "ฟีเจอร์ใดถูกใช้ — เหตุการณ์ที่เบราว์เซอร์ของคุณส่งจะถูกบันทึกเฉพาะหลังจากที่คุณเปิดใช้",
  tr: "hangi özelliklerin kullanıldığı — tarayıcınızın gönderdiği olaylar yalnızca siz açtıktan sonra kaydedilir",
};
const WHERE_APP_BREAKS = {
  en: "where the app breaks", da: "hvor appen fejler", np: "एप कहाँ बिग्रन्छ",
  vi: "ứng dụng lỗi ở đâu", th: "แอปพังที่ใด", tr: "uygulamanın nerede sorun çıkardığı",
};
describe.each(Object.keys(DICT))("Analytics in %s covers browser-sent usage events only (R-h fix round)", (lang) => {
  it("the banner says the events your browser sends are recorded only after you turn it on", () => {
    expect(DICT[lang].cookieBannerBody).toContain(BROWSER_EVENTS_AFTER_ON[lang]);
  });
  it("neither the banner nor the Analytics description claims crash reports", () => {
    expect(DICT[lang].cookieBannerBody).not.toContain(WHERE_APP_BREAKS[lang]);
    expect(DICT[lang].cookieCatAnalyticsDesc).not.toContain(WHERE_APP_BREAKS[lang]);
  });
});
describe("the code the banner describes (review)", () => {
  const answer = (analytics) => localStorage.setItem("bonbox_cookie_consent", JSON.stringify({
    version: 1, timestamp: new Date().toISOString(),
    choices: { necessary: true, analytics, marketing: false },
  }));
  it("before any answer nothing is allowed; an explicit 'no' is declined; only a 'yes' allows", async () => {
    const { analyticsAllowed, analyticsDeclined } = await import("../hooks/useEventLog");
    localStorage.removeItem("bonbox_cookie_consent");
    expect(analyticsAllowed()).toBe(false);
    expect(analyticsDeclined()).toBe(false);
    answer(false);
    expect(analyticsAllowed()).toBe(false);
    expect(analyticsDeclined()).toBe(true);
    answer(true);
    expect(analyticsAllowed()).toBe(true);
    expect(analyticsDeclined()).toBe(false);
    localStorage.removeItem("bonbox_cookie_consent");
  });
  it("the component's own fallback sentence says the same", async () => {
    // CookieConsent.jsx shows this when no dictionary string is found.
    const src = (await import("../components/CookieConsent.jsx?raw")).default;
    expect(src).toContain(AFTER_TURN_ON.en);
    expect(src).not.toContain(UNTIL_DECLINE.en);
    expect(src).toContain(ONLY_IF_ON.en);
    expect(src).toContain(BROWSER_EVENTS_AFTER_ON.en);
    expect(src).not.toContain(WHERE_APP_BREAKS.en);
  });
});
describe.each(Object.keys(DICT))("cookie banner first layer in %s (item 6)", (lang) => {
  it("names both optional purposes and says Accept all turns both on", async () => {
    const d = DICT[lang];
    const body = d.cookieBannerBody;
    expect(body).toContain(d.cookieCatAnalytics);
    expect(body).toContain(d.cookieCatMarketing);
    expect(body).toContain(d.cookieAcceptAll);
    expect(body).toContain("QR");
    expect(body).toContain("30");
    localStorage.setItem("lang", lang);
    render(<LanguageProvider><MemoryRouter><CookieConsent /></MemoryRouter></LanguageProvider>);
    const dialog = await screen.findByRole("dialog", {}, { timeout: 3000 });
    expect(dialog.textContent).toContain(body);
  });
});

describe("after a password reset, 'Nej / Ved ikke' (item 3)", () => {
  const openReset = (lang) => {
    localStorage.setItem("lang", lang);
    h.post.mockImplementation((url) => (url === "/auth/claim-decision/status"
      ? Promise.resolve({ data: { state: "open", decision: null,
        question: { created_at: "2026-10-08", has_password: true, after_reset: true } } })
      : Promise.resolve({ data: { decision: "secure", access_closed: false } })));
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[`/login/claim?token=${"m".repeat(43)}&answer=secure`]}>
          <Routes><Route path="/login/claim" element={<ClaimDecisionPage />} /></Routes>
        </MemoryRouter>
      </LanguageProvider>,
    );
  };
  it("says the password just chosen stops working too — before the tap", async () => {
    openReset("da");
    await screen.findByTestId("claim-question");
    expect(screen.getByText(da.claimMailExplainAfterReset)).toBeTruthy();
    expect(da.claimMailExplainAfterReset).toContain("også den nye, du valgte med koden fra din e-mail");
    expect(en.claimMailExplainAfterReset).toContain("including the new one you chose with the code from your e-mail");
  });
  it("and after it, with the new-password step right there", async () => {
    openReset("en");
    await screen.findByTestId("claim-question");
    fireEvent.click(screen.getByRole("button", { name: en.claimQuestionNo }));
    const done = await screen.findByTestId("claim-secured");
    expect(done).toHaveTextContent(en.claimSecuredMailBodyAfterReset);
    expect(screen.getByRole("link", { name: en.magicLinkClaimedSetPassword })).toHaveAttribute("href", "/forgot-password");
  });
  it("a login-link question keeps its own words", async () => {
    localStorage.setItem("lang", "en");
    h.post.mockImplementation((url) => (url === "/auth/claim-decision/status"
      ? Promise.resolve({ data: { state: "open", decision: null,
        question: { created_at: "2026-10-08", has_password: true, after_reset: false } } })
      : Promise.reject(new Error(url))));
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[`/login/claim?token=${"m".repeat(43)}`]}>
          <Routes><Route path="/login/claim" element={<ClaimDecisionPage />} /></Routes>
        </MemoryRouter>
      </LanguageProvider>,
    );
    await screen.findByTestId("claim-question");
    expect(screen.getByText(en.claimMailExplain)).toBeTruthy();
  });
});

describe("the held revisor invite after onboarding, question open (item 1)", () => {
  it("names the mailed question and offers Send spørgsmålet igen — no Bekræft nu", async () => {
    h.user = { email_verified: true, claim_question_open: true };
    h.post.mockResolvedValue({ data: { ok: true, sent_to: "ejer@cafe.dk" } });
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[{ pathname: "/dashboard",
          state: { revisorInviteHeld: true, revisorInviteHeldReason: "claim_question_open" } }]}>
          <RevisorInviteHeldNotice />
        </MemoryRouter>
      </LanguageProvider>,
    );
    const row = await screen.findByTestId("revisor-invite-held-after-onboarding");
    expect(row).toHaveTextContent(en.onbRevisorInviteHeldClaimOpen);
    expect(row.querySelector("a[href^='/verify-email']")).toBeNull();
    fireEvent.click(screen.getByTestId("revisor-invite-held-claim-resend"));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/auth/claim-decision/remail", {}, { _noRetry: true }));
    expect(await screen.findByTestId("revisor-invite-held-claim-resend-result"))
      .toHaveTextContent("The question was sent again to ejer@cafe.dk");
  });
});
