/**
 * The unconfirmed-sender refusal names what waits — and nothing more.
 *
 * Until the owner's own e-mail is confirmed, BonBox holds fakturaer, team
 * invitations, supplier orders and mail to the revisor. Guest booking mail,
 * shift mail and gavekort mail still go out, so a general "BonBox only sends
 * mail to others for a confirmed account" is false (RELEASE_GATE 5). No
 * dictionary may carry that general claim, and the refusal the owner reads
 * (sendNeedsVerifiedEmail, en + da) names the revisor among what waits.
 */
import { describe, expect, it } from "vitest";

const DICTS = import.meta.glob("../i18n/*.js", { eager: true });

const strings = (node, out = []) => {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) strings(v, out);
  return out;
};

const GENERAL_CLAIMS = [
  /only sends? mail to others/i,
  /mail to others/i,
  /mails? no one else/i,
  /sender kun mail til andre/i,
  /mail til andre/i,
];

describe("no dictionary claims BonBox mails no one else", () => {
  const files = Object.keys(DICTS).filter((p) => !p.endsWith("languageCatalog.js"));
  it("finds the dictionaries", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });
  it.each(files)("%s", (path) => {
    const all = strings(DICTS[path]);
    for (const s of all) for (const re of GENERAL_CLAIMS) expect(s).not.toMatch(re);
  });
});

describe("sendNeedsVerifiedEmail names exactly what waits", () => {
  const en = DICTS["../i18n/en.js"].en;
  const da = DICTS["../i18n/da.js"].da;
  const find = (dict) => strings(dict).find((s) => s.startsWith("Confirm your own e-mail address first")
    || s.startsWith("Bekræft først din egen e-mailadresse"));
  it("en", () => {
    const s = find(en);
    expect(s).toBeTruthy();
    for (const w of ["fakturaer", "team invitations", "supplier orders", "mail to your revisor"]) expect(s).toContain(w);
  });
  it("da", () => {
    const s = find(da);
    expect(s).toBeTruthy();
    for (const w of ["fakturaer", "medarbejderinvitationer", "leverandørordrer", "mail til din revisor"]) expect(s).toContain(w);
  });
});
