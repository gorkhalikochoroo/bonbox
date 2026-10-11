/**
 * The real-producer sibling of authErrors.test.js: the backend sends a
 * structured `code` for only some auth errors, so the frontend matches the
 * exact English `detail` for the rest. If someone rewords one of those
 * sentences in backend/app/routers/auth.py, this fails in CI — instead of
 * the owner silently getting the generic fallback in production.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_CODES, AUTH_DETAIL } from "./authErrors";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, "../../../backend/app");
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), "utf8");

const AUTH = read("routers/auth.py");
const OAUTH = read("routers/auth_oauth.py");
const SCHEMAS = read("schemas/auth.py");

describe("authErrors ↔ backend (the strings are the contract)", () => {
  it.each(Object.entries(AUTH_DETAIL))("%s is sent verbatim by routers/auth.py", (name, sentence) => {
    expect(AUTH).toContain(`detail="${sentence}"`);
  });

  it("the locked-account sentence is services/auth.py's LOCKED_ACCOUNT_DETAIL (reset, team invite)", () => {
    expect(read("services/auth.py")).toContain(`LOCKED_ACCOUNT_DETAIL = "${AUTH_DETAIL.accountLocked}"`);
    expect(AUTH).toContain("refuse_locked_account(user)");
    expect(read("routers/team.py")).toContain("refuse_locked_account(invitee)");
  });

  it("every structured code the map knows is sent by an auth router", () => {
    for (const code of Object.keys(AUTH_CODES)) {
      const sent = AUTH.includes(`"code": "${code}"`) || OAUTH.includes(`"${code}"`);
      expect(sent, code).toBe(true);
    }
  });

  it("the codes ride on the statuses the map expects", () => {
    // 429s: paused, the resend cap and the e-mail-change cap.
    expect(AUTH).toMatch(/status_code=429, detail=\{\s*"code": "verification_paused"/);
    expect(AUTH).toMatch(/status_code=429, detail=\{\s*"code": "verification_resend_daily_cap"/);
    expect(AUTH).toMatch(/status_code=429, detail=\{\s*"code": "email_change_daily_cap"/);
    expect(AUTH).toMatch(/status_code=403, detail=\{\s*"code": "password_required"/);
    expect(AUTH).toMatch(/status_code=409, detail=\{\s*"code": "claim_question_open"/);
    expect(AUTH).toMatch(/status_code=400, detail=\{\s*"code": "verification_code_burned"/);
    expect(AUTH).toMatch(/status_code=status\.HTTP_409_CONFLICT,\s*detail="Email already registered"/);
  });

  it("the password rule the 422 mapping reads (8 / digit / letter) is the schema's", () => {
    expect(SCHEMAS).toMatch(/password: str = Field\(\.\.\., min_length=8, max_length=128\)/);
    expect(SCHEMAS).toContain('raise ValueError("Password must contain at least one digit")');
    expect(SCHEMAS).toContain('raise ValueError("Password must contain at least one letter")');
    expect(SCHEMAS).toMatch(/new_password: str = Field\(\.\.\., min_length=8, max_length=128\)/);
    expect(SCHEMAS).toMatch(/business_name: str = Field\(\.\.\., min_length=1, max_length=200\)/);
  });

  it("register's defaults let /register leave out business_type and currency (B1)", () => {
    // The page sends neither when the owner was not asked; the server then
    // uses these. A change here changes what a café signs up as.
    expect(SCHEMAS).toMatch(/class UserRegister[\s\S]*?business_type: str = "restaurant"/);
    expect(SCHEMAS).toMatch(/class UserRegister[\s\S]*?currency: str = "DKK"/);
  });
});
