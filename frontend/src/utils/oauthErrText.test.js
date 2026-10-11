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
  // Push 6 (PQ-04): the caller's localised line for everything else — the
  // server's English never reaches a Danish page (it used to fall through to
  // errText and return "Invalid or expired sign-in token.").
  it("returns the caller's localised fallback for everything else, never the server's English", () => {
    expect(oauthErrText(err("Invalid or expired sign-in token."), "fb", t)).toBe("fb");
    expect(oauthErrText(err([{ loc: ["body", "id_token"], msg: "Field required" }]), "fb", t)).toBe("fb");
    expect(oauthErrText({ message: "Network Error" }, "fb", t)).toBe("fb");
    expect(oauthErrText({}, "fb", t)).toBe("fb");
  });
});
