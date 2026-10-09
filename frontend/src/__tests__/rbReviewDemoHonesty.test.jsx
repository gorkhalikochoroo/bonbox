/**
 * Release gate R-b review fixes (9 Oct) — the sample-data surfaces say only
 * what is there.
 *
 *  1. The first-run dashboard ("Velkommen til BonBox") said "To måder at
 *     starte på: udforsk med eksempeldata …" and drew the "eller start med
 *     dine rigtige tal" divider even when the sample-data card above it was
 *     not shown — e.g. an owner with their own details who invited one staff
 *     member from "Du er klar" (seedable === false). The header and divider
 *     now follow the card: two ways only while it is on screen.
 *  2. The sample-data banner reached invited members and revisors (the
 *     dashboard is delegated to the owner), with a "Ryd eksempeldata" button
 *     the server refuses for them (403 read_only) and a catch that said
 *     nothing. Now: the button for the owner's own session only; others read
 *     that it is sample data and that only the owner can clear it; a failed
 *     clear is said.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: "u1", role: "owner", business_type: "cafe" },
  lang: "da",
}));
vi.mock("../services/api", () => ({ default: { get: h.get, post: h.post } }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: h.lang }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/useFeatures", () => ({ useFeatures: () => ({ bank_connect_enabled: false }) }));

import FirstRunCollapsedDashboard from "../components/dashboard/FirstRunCollapsedDashboard";
import DemoActiveBanner from "../components/DemoActiveBanner";

const status = (s) => h.get.mockImplementation(() => Promise.resolve({ data: s }));

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.post.mockResolvedValue({ data: { ok: true } });
  h.user = { id: "u1", role: "owner", business_type: "cafe" };
  h.lang = "da";
  localStorage.clear();
});

async function firstRun() {
  render(
    <MemoryRouter>
      <FirstRunCollapsedDashboard user={h.user} />
    </MemoryRouter>,
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("first-run dashboard: the 'two ways' header only while the sample card is there", () => {
  it("own details + one staff member invited (seedable false): no sample-data wording, no divider, the one path", async () => {
    status({ has_demo: false, has_real: false, own_profile: true, seedable: false });
    await firstRun();
    expect(screen.queryByText("demoCardCta")).toBeNull();
    expect(screen.queryByText("dashFirstRunSubtitleTwoWays")).toBeNull();
    expect(screen.queryByText("dashFirstRunOrStartReal")).toBeNull();
    expect(screen.queryByTestId("first-run-or-divider")).toBeNull();
    expect(screen.getByText("dashFirstRunSubtitleOnePath")).toBeInTheDocument();
    // The real-numbers steps are all still there.
    expect(screen.getByText("dashFirstRunCloseTitle")).toBeInTheDocument();
  });

  it("the card is offered: two ways, the card and the divider — as before", async () => {
    status({ has_demo: false, has_real: false, own_profile: true, seedable: true });
    await firstRun();
    expect(screen.getByText("demoCardCta")).toBeInTheDocument();
    expect(screen.getByText("dashFirstRunSubtitleTwoWays")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-or-divider")).toBeInTheDocument();
    expect(screen.queryByText("dashFirstRunSubtitleOnePath")).toBeNull();
  });

  it("an older server (no seedable): the card and two ways, as before", async () => {
    status({ has_demo: false, has_real: false });
    await firstRun();
    expect(screen.getByText("demoCardCta")).toBeInTheDocument();
    expect(screen.getByText("dashFirstRunSubtitleTwoWays")).toBeInTheDocument();
  });

  it("data of its own already (has_real): the one path", async () => {
    status({ has_demo: false, has_real: true, own_profile: false, seedable: false });
    await firstRun();
    expect(screen.queryByText("dashFirstRunSubtitleTwoWays")).toBeNull();
    expect(screen.getByText("dashFirstRunSubtitleOnePath")).toBeInTheDocument();
  });

  it("'Nej tak' on the card: the header and divider follow it away", async () => {
    status({ has_demo: false, has_real: false, own_profile: false, seedable: true });
    await firstRun();
    expect(screen.getByText("dashFirstRunSubtitleTwoWays")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText("demoCardSkip")); });
    expect(screen.queryByText("demoCardCta")).toBeNull();
    expect(screen.queryByText("dashFirstRunSubtitleTwoWays")).toBeNull();
    expect(screen.queryByTestId("first-run-or-divider")).toBeNull();
    expect(screen.getByText("dashFirstRunSubtitleOnePath")).toBeInTheDocument();
  });

  it("while the status is still being read: no promise of a card yet", async () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <FirstRunCollapsedDashboard user={h.user} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("dashFirstRunSubtitleTwoWays")).toBeNull();
    expect(screen.queryByTestId("first-run-or-divider")).toBeNull();
  });
});

describe("sample-data banner: the clear button only where it works", () => {
  it.each(["accountant", "manager", "cashier", "viewer"])(
    "a %s session: the label that it is sample data, no 'Ryd eksempeldata' button",
    async (role) => {
      h.user = { id: "m1", role };
      status({ has_demo: true });
      render(<DemoActiveBanner />);
      expect(await screen.findByText("demoActiveBannerMember")).toBeInTheDocument();
      expect(screen.queryByText("demoActiveBanner")).toBeNull();
      expect(screen.queryByRole("button", { name: "demoActiveClear" })).toBeNull();
      expect(h.post).not.toHaveBeenCalled();
    },
  );

  it("the owner: the owner's line and the clear button, as before", async () => {
    status({ has_demo: true });
    render(<DemoActiveBanner />);
    expect(await screen.findByText("demoActiveBanner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "demoActiveClear" })).toBeInTheDocument();
  });

  it("a clear that fails is said (never a button that silently resets)", async () => {
    status({ has_demo: true });
    h.post.mockRejectedValue(Object.assign(new Error("Network Error"), { response: undefined }));
    render(<DemoActiveBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "demoActiveClear" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("demoActiveClearFailed");
    expect(screen.getByRole("button", { name: "demoActiveClear" })).not.toBeDisabled();
    expect(screen.queryByText("Network Error")).toBeNull();
  });

  it("a failed clear with a server sentence uses it, in the owner's language", async () => {
    status({ has_demo: true });
    h.post.mockRejectedValue({
      response: { status: 429, data: { detail: { message: "Too many tries.", message_da: "For mange forsøg." } } },
    });
    render(<DemoActiveBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "demoActiveClear" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("For mange forsøg."));
  });
});
