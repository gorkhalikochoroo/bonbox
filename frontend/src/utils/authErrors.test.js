/**
 * Push 6 (PQ-04) — every error on the sign-up surfaces maps to a key the
 * dictionaries carry in Danish and English. One row per line of the spec's
 * mapping table (§4), plus a sweep that no server English ever comes back.
 */
import { describe, expect, it } from "vitest";
import { AUTH_CODES, AUTH_DETAIL, authErrorKey } from "./authErrors";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const res = (status, detail) => ({ response: { status, data: detail === undefined ? {} : { detail } } });
const k = (err, ctx, opts) => authErrorKey(err, ctx, opts);

describe("authErrorKey — the §4 table", () => {
  it("any: no response, ECONNABORTED → suErrTimeout; other → suErrOffline", () => {
    expect(k({ code: "ECONNABORTED", message: "timeout of 60000ms exceeded" }, "register")).toMatchObject({ key: "suErrTimeout", network: true });
    expect(k({ code: "ERR_NETWORK", message: "Network Error" }, "login")).toMatchObject({ key: "suErrOffline", network: true });
    expect(k({}, "forgot").key).toBe("suErrOffline");
  });

  it("any: ≥ 500 → suErrServer (a resend that failed says the code was not sent)", () => {
    for (const ctx of ["register", "login", "verify", "forgot", "reset", "changeEmail", "magic"]) {
      expect(k(res(500), ctx).key, ctx).toBe("suErrServer");
      expect(k(res(503, "Service Unavailable"), ctx).key, ctx).toBe("suErrServer");
    }
    expect(k(res(500), "resend").key).toBe("couldNotResendCode");
  });

  it("any: 429 with no code → tooManyAttempts (resend → tooManyResendAttempts, e-mail link → its own line)", () => {
    expect(k(res(429, "Rate limit exceeded"), "register").key).toBe("tooManyAttempts");
    expect(k(res(429), "login").key).toBe("tooManyAttempts");
    expect(k(res(429), "verify").key).toBe("tooManyAttempts");
    expect(k(res(429), "resend").key).toBe("tooManyResendAttempts");
    expect(k(res(429), "magic").key).toBe("magicLinkRateLimited");
  });

  it("register: 409 / 'Email already registered' → suEmailExists (+login); after a timeout → suEmailExistsAfterTimeout", () => {
    expect(k(res(409, AUTH_DETAIL.emailRegistered), "register")).toEqual({ key: "suEmailExists", action: "login" });
    expect(k(res(409, "something else"), "register")).toEqual({ key: "suEmailExists", action: "login" });
    expect(k(res(400, AUTH_DETAIL.emailRegistered), "register").key).toBe("suEmailExists");
    expect(k(res(409, AUTH_DETAIL.emailRegistered), "register", { timedOut: true })).toEqual({ key: "suEmailExistsAfterTimeout", action: "login" });
  });

  it("register: the three 422 strings", () => {
    expect(k(res(422, AUTH_DETAIL.disposable), "register")).toEqual({ key: "suErrDisposable", field: "email" });
    expect(k(res(422, AUTH_DETAIL.noMx), "register")).toEqual({ key: "suErrDomain", field: "email" });
    expect(k(res(422, AUTH_DETAIL.registerBlocked), "register")).toEqual({ key: "suErrRegisterBlocked" });
  });

  it("register / login / changeEmail / forgot: a 422 array on email → suErrEmailInvalid, under the field", () => {
    const arr = [{ type: "value_error", loc: ["body", "email"], msg: "value is not a valid email address: An email address must have an @-sign." }];
    for (const ctx of ["register", "login", "changeEmail", "forgot", "magic"]) {
      expect(k(res(422, arr), ctx), ctx).toEqual({ key: "suErrEmailInvalid", field: "email" });
    }
  });

  it("register / reset: a 422 array on the password → pwMinLength / suPwNeedDigit / suPwNeedLetter", () => {
    const pw = (loc, msg) => res(422, [{ loc: ["body", loc], msg }]);
    expect(k(pw("password", "String should have at least 8 characters"), "register")).toEqual({ key: "pwMinLength", field: "password" });
    expect(k(pw("password", "Value error, Password must contain at least one digit"), "register")).toEqual({ key: "suPwNeedDigit", field: "password" });
    expect(k(pw("password", "Value error, Password must contain at least one letter"), "register")).toEqual({ key: "suPwNeedLetter", field: "password" });
    expect(k(pw("new_password", "String should have at least 8 characters"), "reset").key).toBe("pwMinLength");
    expect(k(pw("new_password", "Value error, Password must contain at least one digit"), "reset").key).toBe("suPwNeedDigit");
    expect(k(pw("new_password", "Value error, Password must contain at least one letter"), "reset").key).toBe("suPwNeedLetter");
  });

  it("register: a 422 array on business_name → suErrBusinessNameEmpty", () => {
    expect(k(res(422, [{ loc: ["body", "business_name"], msg: "String should have at least 1 character" }]), "register"))
      .toEqual({ key: "suErrBusinessNameEmpty", field: "business_name" });
  });

  it("register: anything else → registrationFailed", () => {
    expect(k(res(400, "Some new English sentence"), "register").key).toBe("registrationFailed");
    expect(k(res(422, [{ loc: ["body", "currency"], msg: "Unsupported currency" }]), "register").key).toBe("registrationFailed");
    expect(k(res(418), "register").key).toBe("registrationFailed");
  });

  it("login: 401 'Invalid email or password' and any other 4xx → suLoginWrong (+reset)", () => {
    expect(k(res(401, AUTH_DETAIL.loginInvalid), "login")).toEqual({ key: "suLoginWrong", action: "reset" });
    expect(k(res(400, "Bad"), "login")).toEqual({ key: "suLoginWrong", action: "reset" });
    expect(k(res(403), "login")).toEqual({ key: "suLoginWrong", action: "reset" });
  });

  it("verify: the three 400 strings and the two codes", () => {
    expect(k(res(400, AUTH_DETAIL.codeInvalid), "verify")).toEqual({ key: "suErrCodeWrong" });
    expect(k(res(400, AUTH_DETAIL.codeExpired), "verify")).toEqual({ key: "suErrCodeExpired", action: "resend" });
    expect(k(res(400, AUTH_DETAIL.codeNone), "verify")).toEqual({ key: "suErrCodeNone", action: "resend" });
    expect(k(res(400, { code: "verification_code_burned", message: "Too many wrong tries…" }), "verify").key).toBe("verifyCodeBurned");
    expect(k(res(429, { code: "verification_paused", message: "Too many wrong codes today." }), "verify").key).toBe("verifyEmailPaused");
    expect(k(res(400, "Something else"), "verify").key).toBe("verificationFailed");
  });

  it("resend: 429 daily cap (its own line — a cap for today, not 'wait a moment') or any 429; paused", () => {
    expect(k(res(429, { code: "verification_resend_daily_cap", message: "Too many codes today." }), "resend").key).toBe("suErrResendDailyCap");
    expect(k(res(429), "resend").key).toBe("tooManyResendAttempts");
    expect(k(res(429, { code: "verification_paused" }), "resend").key).toBe("verifyEmailPaused");
    expect(k(res(400, "x"), "resend").key).toBe("couldNotResendCode");
  });

  it("forgot: anything else → somethingWentWrong", () => {
    expect(k(res(400, "Whatever"), "forgot").key).toBe("somethingWentWrong");
  });

  it("reset: 'Invalid or expired reset code' (and anything else) → suErrResetCode", () => {
    expect(k(res(400, AUTH_DETAIL.resetInvalid), "reset").key).toBe("suErrResetCode");
    expect(k(res(400, "Other"), "reset").key).toBe("suErrResetCode");
  });

  it("changeEmail: 403 password_required, 400 'Email already in use' (+logout), 409 claim_question_open, 429 email_change_daily_cap", () => {
    expect(k(res(403, { code: "password_required", message: "Enter your current password…" }), "changeEmail").key).toBe("suErrChangeEmailPw");
    expect(k(res(400, AUTH_DETAIL.emailInUse), "changeEmail")).toEqual({ key: "suErrChangeEmailTaken", action: "logout" });
    expect(k(res(409, { code: "claim_question_open", message: "This account is waiting…" }), "changeEmail").key).toBe("suErrClaimOpen");
    expect(k(res(429, { code: "email_change_daily_cap", message: "The login e-mail can be changed…" }), "changeEmail").key).toBe("suErrEmailChangeCap");
  });

  it("oauth: the two codes; anything else → the caller's localised fallback", () => {
    expect(k(res(403, { code: "email_not_verified" }), "oauth").key).toBe("oauthEmailNotVerified");
    expect(k(res(409, { code: "account_exists_login_first" }), "oauth").key).toBe("oauthAccountExistsLoginFirst");
    expect(k(res(401, "Invalid or expired sign-in token."), "oauth", { fallbackKey: "googleSignupFailed" }).key).toBe("googleSignupFailed");
  });
});

describe("authErrorKey — never the server's English", () => {
  // Every English detail the auth endpoints can send, plus axios's own.
  const ENGLISH = [
    ...Object.values(AUTH_DETAIL),
    "Invalid or expired sign-in token.",
    "Apple did not return an email",
    "Rate limit exceeded: 5 per 1 minute",
    "Internal Server Error",
    "Network Error",
    "timeout of 60000ms exceeded",
  ];
  const CTX = ["register", "login", "magic", "verify", "resend", "forgot", "reset", "changeEmail", "oauth"];
  const STATUSES = [400, 401, 403, 404, 409, 410, 422, 429, 500, 502, 503];

  it("every result is a key with real text in both da and en — never a sentence from the server", () => {
    for (const ctx of CTX) {
      for (const status of STATUSES) {
        for (const detail of ENGLISH) {
          const r = k(res(status, detail), ctx);
          expect(typeof da[r.key], `${ctx} ${status} ${detail} → ${r.key} (da)`).toBe("string");
          expect(typeof en[r.key], `${ctx} ${status} ${detail} → ${r.key} (en)`).toBe("string");
          expect(ENGLISH).not.toContain(r.key);
        }
        const net = k({ message: "Network Error", code: "ERR_NETWORK" }, ctx);
        expect(typeof da[net.key]).toBe("string");
      }
    }
  });

  it("every code it knows maps to a key with real text in both da and en", () => {
    for (const key of Object.values(AUTH_CODES)) {
      expect(typeof da[key], key).toBe("string");
      expect(typeof en[key], key).toBe("string");
    }
  });

  it("the su* keys this release adds are in both dictionaries, and Danish is not English", () => {
    const suKeys = Object.keys(en).filter((key) => /^su[A-Z]/.test(key));
    expect(suKeys.length).toBeGreaterThanOrEqual(60);
    for (const key of suKeys) {
      expect(typeof da[key], key).toBe("string");
      expect(da[key].trim().length, key).toBeGreaterThan(0);
    }
    // The ones that read the same in both languages on purpose.
    const SAME = new Set([]);
    const identical = suKeys.filter((key) => da[key] === en[key] && !SAME.has(key));
    expect(identical).toEqual([]);
  });
});
