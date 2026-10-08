/**
 * Sample (demo) rows under the owner's OWN CVR never leave as a filing-ready
 * document (first15 review fix). The server refuses the momsangivelse PDF and
 * the bookkeeping exports with code "demo_in_period"; the pages say so in the
 * owner's language instead of a generic "couldn't generate".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { blobErrDetail } from "../utils/blobErrText";

const fakeBlob = (obj) => ({ text: () => Promise.resolve(typeof obj === "string" ? obj : JSON.stringify(obj)) });

describe("blobErrDetail", () => {
  it("reads the structured detail out of a refused blob download", async () => {
    const err = { response: { status: 422, data: fakeBlob({ detail: { code: "demo_in_period", n_demo: 7 } }) } };
    expect(await blobErrDetail(err)).toEqual({ code: "demo_in_period", n_demo: 7 });
  });
  it("null for a string detail, a non-JSON body, or no response", async () => {
    expect(await blobErrDetail({ response: { data: fakeBlob({ detail: "nope" }) } })).toBeNull();
    expect(await blobErrDetail({ response: { data: fakeBlob("<html>502</html>") } })).toBeNull();
    expect(await blobErrDetail({})).toBeNull();
  });
  it("reads a plain (non-blob) object body too", async () => {
    expect(await blobErrDetail({ response: { data: { detail: { code: "x" } } } })).toEqual({ code: "x" });
  });
});

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../services/api", () => ({ default: { get: h.get, post: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "da",
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, loading: false, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn() }));
vi.mock("../components/RevisorSection", () => ({ default: () => null }));
vi.mock("../components/ProcedureCard", () => ({ default: () => null }));

import BookkeepingExportPage from "../pages/BookkeepingExportPage";

beforeEach(() => {
  h.get.mockReset();
  h.get.mockImplementation((url) => {
    if (url === "/exports/formats") {
      return Promise.resolve({ data: [{ id: "bundle", label: "Monthly bundle", instructions: "", ext: "zip" }] });
    }
    if (url === "/exports/bundle") {
      return Promise.reject({
        response: {
          status: 422,
          data: fakeBlob({ detail: "The period holds 9 sample (demo) entries…", code: "demo_in_period", n_demo: 9, _error: true }),
        },
      });
    }
    return Promise.resolve({ data: {} });
  });
});

describe("BookkeepingExportPage — a period holding sample rows under the owner's CVR", () => {
  it("says why in the owner's words, never the generic failure", async () => {
    render(<MemoryRouter><BookkeepingExportPage /></MemoryRouter>);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText(/Download ZIP|Download/)); });
    expect(await screen.findByText(/The period holds 9 sample \(demo\) entries\. BonBox doesn't make a bookkeeping file under your own CVR/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not generate export/)).toBeNull();
  });
});
