import { describe, expect, it } from "vitest";
import { safeNextPath } from "../utils/safeNext";

describe("safeNextPath — ?next= on the login page (Push 8)", () => {
  it("accepts an in-app path", () => {
    expect(safeNextPath("?next=/staff/schedule")).toBe("/staff/schedule");
    expect(safeNextPath("?next=%2Fstaff%2Fschedule")).toBe("/staff/schedule");
    expect(safeNextPath("?next=/staff/hours?tab=time")).toBe("/staff/hours?tab=time");
  });

  it("refuses anything that leaves the site", () => {
    for (const bad of [
      "?next=//evil.example", "?next=%2F%2Fevil.example", "?next=/\\evil.example",
      "?next=https://evil.example", "?next=javascript:alert(1)", "?next=staff",
      "?next=/%0d%0aLocation:x", "?next=",
    ]) {
      expect(safeNextPath(bad)).toBeNull();
    }
  });

  it("never loops back to the sign-in pages", () => {
    expect(safeNextPath("?next=/login")).toBeNull();
    expect(safeNextPath("?next=/login/magic")).toBeNull();
    expect(safeNextPath("?next=/register")).toBeNull();
  });

  it("is null without a next", () => {
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});
