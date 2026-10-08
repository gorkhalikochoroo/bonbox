import { describe, it, expect } from "vitest";
import { oauthErrText } from "./errText";

const t = (k) => `T:${k}`;
const err = (detail) => ({ response: { data: { detail } } });

describe("oauthErrText", () => {
  it("names the unverified-email refusal in the owner's language", () => {
    expect(oauthErrText(err({ code: "email_not_verified", message: "English" }), "fb", t))
      .toBe("T:oauthEmailNotVerified");
  });
  it("names the no-silent-link refusal in the owner's language", () => {
    expect(oauthErrText(err({ code: "account_exists_login_first", message: "English" }), "fb", t))
      .toBe("T:oauthAccountExistsLoginFirst");
  });
  it("falls back to errText for everything else", () => {
    expect(oauthErrText(err("Invalid or expired sign-in token."), "fb", t))
      .toBe("Invalid or expired sign-in token.");
    expect(oauthErrText({}, "fb", t)).toBe("fb");
  });
});
