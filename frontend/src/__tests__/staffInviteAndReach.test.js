/**
 * The pure halves of the Vagtplan team flow: one staffer's status from
 * `last_accessed`, the team rollup, and the one invitation message with its
 * SMS / WhatsApp hand-offs. See StaffSchedulePage.teamInvite.test.jsx for the
 * page mounted.
 */
import { describe, expect, it } from "vitest";
import { parseServerUtc, staffReachState, teamReach, ACTIVE_WITHIN_DAYS } from "../utils/portalReach";
import { inviteMessage, whatsappNumber, smsHref, whatsappHref, canSendSms, firstName, VAGTPLAN_APP_URL } from "../utils/staffInvite";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const tFor = (dict) => (k, vars) => {
  let s = dict[k] ?? k;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

describe("staffReachState — four outcomes, and 'unknown' renders nothing", () => {
  const NOW = new Date(2026, 9, 12, 14, 0, 0).getTime(); // 12 Oct 2026, 14:00 local

  it("absent key = we never asked", () => {
    expect(staffReachState(undefined, NOW).state).toBe("unknown");
  });
  it("null (or garbage) = never opened", () => {
    expect(staffReachState(null, NOW).state).toBe("none");
    expect(staffReachState("not a date", NOW).state).toBe("none");
  });
  it("opened today / within the week = active, with the day count", () => {
    const r = staffReachState(new Date(NOW - 3600e3).toISOString().slice(0, 19), NOW);
    expect(r).toMatchObject({ state: "active", daysAgo: 0 });
    const r2 = staffReachState(new Date(NOW - 2 * 86400e3).toISOString().slice(0, 19), NOW);
    expect(r2).toMatchObject({ state: "active", daysAgo: 2 });
  });
  it(`opened ${ACTIVE_WITHIN_DAYS}+ days ago = joined, not active`, () => {
    const r = staffReachState(new Date(NOW - 12 * 86400e3).toISOString().slice(0, 19), NOW);
    expect(r).toMatchObject({ state: "joined", daysAgo: 12 });
  });
  it("reads the server's naive timestamp as UTC, not local", () => {
    expect(parseServerUtc("2026-10-11T23:32:03")).toBe(Date.UTC(2026, 9, 11, 23, 32, 3));
    expect(parseServerUtc("2026-10-11 23:32:03.274214")).toBe(Date.UTC(2026, 9, 11, 23, 32, 3, 274));
    expect(parseServerUtc("2026-10-11T23:32:03+02:00")).toBe(Date.UTC(2026, 9, 11, 21, 32, 3));
  });
});

describe("teamReach — active staff only, answered rows only", () => {
  it("null until the server has answered for somebody", () => {
    expect(teamReach([{ id: "a" }], {})).toBeNull();
  });
  it("counts who is in and who is not; ignores people it was not asked about", () => {
    const r = teamReach([{ id: "a" }, { id: "b" }, { id: "c" }], { a: null, b: "2026-10-10T10:00:00" });
    expect(r).toEqual({ total: 2, joined: 1, notYet: 1 });
  });
});

describe("the invitation", () => {
  const base = { name: "Sofie Holm", restaurant: "Café Mirabelle", url: "https://www.bonbox.dk/s/x/sofie/tok", code: "2TC5NS" };

  it.each([["da", da], ["en", en]])("carries the greeting, the link, the app and the code (%s)", (_, dict) => {
    const msg = inviteMessage({ t: tFor(dict), ...base });
    const lines = msg.split("\n");
    expect(lines[0]).toContain("Sofie");
    expect(lines[0]).not.toContain("Holm");
    expect(lines[0]).toContain("Café Mirabelle");
    expect(lines[1]).toBe(base.url);
    expect(msg).toContain(VAGTPLAN_APP_URL);
    expect(msg).toContain("2TC5NS");
    // Every placeholder resolved, no raw key.
    expect(msg).not.toMatch(/\{\w+\}|staffInvite/);
  });

  it("says the Danish greeting in du-form", () => {
    expect(inviteMessage({ t: tFor(da), ...base }).split("\n")[0])
      .toBe("Hej Sofie! Her er dit personlige link til dine vagter hos Café Mirabelle:");
  });

  it("leaves the code line out when there is no code", () => {
    expect(inviteMessage({ t: tFor(da), ...base, code: "" })).not.toContain("koden");
  });

  it("first name", () => {
    expect(firstName("  Mads  Kjær ")).toBe("Mads");
    expect(firstName("")).toBe("");
  });
});

describe("hand-offs to the owner's own apps", () => {
  it("WhatsApp: a bare Danish 8-digit number gets 45; + and 00 prefixes are kept", () => {
    expect(whatsappNumber("22 33 44 55")).toBe("4522334455");
    expect(whatsappNumber("+45 22 33 44 55")).toBe("4522334455");
    expect(whatsappNumber("0046701234567")).toBe("46701234567");
    expect(whatsappNumber("")).toBe("");
    expect(whatsappHref(null, "hej")).toBe("https://wa.me/?text=hej");
  });

  it("SMS: the body is encoded and the number cleaned", () => {
    expect(smsHref("22 33 44 55", "Hej & link")).toBe("sms:22334455?&body=Hej%20%26%20link");
    expect(smsHref("", "x")).toBe("sms:?&body=x");
  });

  it("offers SMS only where something can open it", () => {
    expect(canSendSms({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 })).toBe(true);
    expect(canSendSms({ userAgent: "Mozilla/5.0 (Linux; Android 14)", maxTouchPoints: 5 })).toBe(true);
    expect(canSendSms({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", maxTouchPoints: 0 })).toBe(true);
    expect(canSendSms({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", maxTouchPoints: 0 })).toBe(false);
    expect(canSendSms(null)).toBe(false);
  });
});
