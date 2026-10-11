/**
 * authErrors — every error the sign-up pages can get back, as a dictionary key.
 *
 * PQ-04. The auth pages used to put the server's English on screen
 * ("Email already registered", "Invalid verification code", axios's "Network
 * Error"), and LoginPage had its own hard-coded English lines. A Danish owner
 * signing up on a phone met English exactly when something went wrong.
 *
 *   authErrorKey(err, ctx, opts?) → { key, vars?, action?, field? }
 *
 *   ctx     register | login | magic | verify | resend | forgot | reset |
 *           changeEmail | oauth
 *   key     an i18n key (en + da) — the caller renders t(key, vars)
 *   action  login | reset | resend | logout — the next step the page offers
 *   field   email | password | business_name — show it under that field
 *   opts    { timedOut } — register: an earlier attempt in this page session
 *           got no answer, so a 409 is most likely that attempt's account;
 *           { fallbackKey } — oauth: the caller's localised fallback
 *
 * The pages never render `detail` or `err.message`.
 *
 * Order: no response → 429 → 5xx → a structured `detail.code` → the exact
 * English `detail` strings → FastAPI's 422 arrays → the context's fallback.
 *
 * The backend sends a `code` only for some errors, so the exact English
 * strings below ARE the contract: authErrors.contract.test.js reads
 * backend/app/routers/auth.py and fails CI if one is reworded, instead of the
 * owner silently getting the fallback.
 */

/** Exact English `detail` strings (backend/app/routers/auth.py). */
export const AUTH_DETAIL = {
  emailRegistered: "Email already registered",
  disposable:
    "Please use a real email address (work or personal). Disposable email services aren't supported.",
  noMx: "That email domain doesn't appear to exist. Please check the spelling.",
  registerBlocked: "Registration could not be completed. Please try again or contact support.",
  loginInvalid: "Invalid email or password",
  codeInvalid: "Invalid verification code",
  codeExpired: "Verification code has expired. Please request a new one.",
  codeNone: "No verification code found. Please request a new one.",
  resetInvalid: "Invalid or expired reset code",
  emailInUse: "Email already in use",
  // An admin-locked account (services/auth.LOCKED_ACCOUNT_DETAIL): what
  // reset-password, the team invite and the OAuth routes answer it, once
  // the code / link / provider has proved who is asking.
  accountLocked: "Account is locked. Contact support.",
};

/** Structured `detail.code` values the auth endpoints send. */
export const AUTH_CODES = {
  verification_code_burned: "verifyCodeBurned",
  verification_paused: "verifyEmailPaused",
  verification_resend_daily_cap: "suErrResendDailyCap",
  password_required: "suErrChangeEmailPw",
  claim_question_open: "suErrClaimOpen",
  email_change_daily_cap: "suErrEmailChangeCap",
  email_not_verified: "oauthEmailNotVerified",
  account_exists_login_first: "oauthAccountExistsLoginFirst",
};

const FALLBACK = {
  register: "registrationFailed",
  login: "suLoginWrong",
  magic: "magicLinkFallback",
  verify: "verificationFailed",
  resend: "couldNotResendCode",
  forgot: "somethingWentWrong",
  reset: "suErrResetCode",
  changeEmail: "somethingWentWrong",
  oauth: "somethingWentWrong",
};

const EMAIL_FIELD_CTX = new Set(["register", "login", "magic", "changeEmail", "forgot", "reset"]);

function lastLoc(item) {
  const loc = item && Array.isArray(item.loc) ? item.loc : [];
  return String(loc.length ? loc[loc.length - 1] : "");
}

/** FastAPI 422 validation arrays → the first item we can say something about. */
function fromValidationArray(detail, ctx) {
  for (const item of detail) {
    const field = lastLoc(item);
    const msg = String((item && item.msg) || "").toLowerCase();
    if (field === "email" && EMAIL_FIELD_CTX.has(ctx)) {
      return { key: "suErrEmailInvalid", field: "email" };
    }
    if ((field === "password" || field === "new_password") && (ctx === "register" || ctx === "reset")) {
      if (msg.includes("digit")) return { key: "suPwNeedDigit", field: "password" };
      if (msg.includes("letter")) return { key: "suPwNeedLetter", field: "password" };
      return { key: "pwMinLength", field: "password" };
    }
    if (field === "business_name" && ctx === "register") {
      return { key: "suErrBusinessNameEmpty", field: "business_name" };
    }
  }
  return null;
}

export function authErrorKey(err, ctx, opts = {}) {
  const res = err && err.response;

  // 1. No answer at all: our own 60 s timeout, or the request never got there.
  if (!res) {
    return { key: err && err.code === "ECONNABORTED" ? "suErrTimeout" : "suErrOffline", network: true };
  }

  const status = Number(res.status) || 0;
  const detail = res.data ? res.data.detail : undefined;
  const code =
    detail && typeof detail === "object" && !Array.isArray(detail) && typeof detail.code === "string"
      ? detail.code
      : null;

  // 2. Rate limits — a structured code says which one.
  if (status === 429) {
    if (code && AUTH_CODES[code]) return { key: AUTH_CODES[code] };
    if (ctx === "resend") return { key: "tooManyResendAttempts" };
    if (ctx === "magic") return { key: "magicLinkRateLimited" };
    return { key: "tooManyAttempts" };
  }

  // 3. Our side broke. A code that could not be sent says so, so the owner
  //    does not wait for a mail that is not coming.
  if (status >= 500) {
    return { key: ctx === "resend" ? "couldNotResendCode" : "suErrServer" };
  }

  // 4. Structured codes.
  if (code && AUTH_CODES[code]) return { key: AUTH_CODES[code] };

  // 5. The exact English strings.
  if (typeof detail === "string") {
    const d = detail.trim();
    // Any page: a locked account is told so — not "wrong code" — so the
    // owner contacts support instead of asking for code after code.
    if (d === AUTH_DETAIL.accountLocked) return { key: "magicLinkLocked" };
    if (ctx === "register") {
      if (d === AUTH_DETAIL.emailRegistered) {
        return { key: opts.timedOut ? "suEmailExistsAfterTimeout" : "suEmailExists", action: "login" };
      }
      if (d === AUTH_DETAIL.disposable) return { key: "suErrDisposable", field: "email" };
      if (d === AUTH_DETAIL.noMx) return { key: "suErrDomain", field: "email" };
      if (d === AUTH_DETAIL.registerBlocked) return { key: "suErrRegisterBlocked" };
    }
    if (ctx === "login" && d === AUTH_DETAIL.loginInvalid) {
      return { key: "suLoginWrong", action: "reset" };
    }
    if (ctx === "verify") {
      if (d === AUTH_DETAIL.codeInvalid) return { key: "suErrCodeWrong" };
      if (d === AUTH_DETAIL.codeExpired) return { key: "suErrCodeExpired", action: "resend" };
      if (d === AUTH_DETAIL.codeNone) return { key: "suErrCodeNone", action: "resend" };
    }
    if (ctx === "reset" && d === AUTH_DETAIL.resetInvalid) return { key: "suErrResetCode" };
    if (ctx === "changeEmail" && d === AUTH_DETAIL.emailInUse) {
      return { key: "suErrChangeEmailTaken", action: "logout" };
    }
  }

  // A 409 on sign-up is the same answer even if the wording ever changes.
  if (ctx === "register" && status === 409) {
    return { key: opts.timedOut ? "suEmailExistsAfterTimeout" : "suEmailExists", action: "login" };
  }

  // 6. FastAPI's 422 validation arrays, by field.
  if (Array.isArray(detail)) {
    const hit = fromValidationArray(detail, ctx);
    if (hit) return hit;
  }

  // 7. The context's own fallback — never the server's words.
  if (ctx === "login") return { key: "suLoginWrong", action: "reset" };
  if (ctx === "oauth") return { key: opts.fallbackKey || FALLBACK.oauth };
  return { key: FALLBACK[ctx] || "somethingWentWrong" };
}

export default authErrorKey;
