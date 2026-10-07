/**
 * /join — round 2 (C12, C10/C1 web lane).
 *
 *   • 429 / 5xx used to print axios's English "Request failed with status code
 *     429" (errText fell through to err.message) — now always our own copy.
 *   • A correct code that has expired or was already used was reported as a
 *     typo ("Forkert kode — tjek den."). The backend keeps ONE indistinguishable
 *     404 on purpose (enumeration; test_join_code_hardening), so the copy names
 *     every real cause and the fix: ask the manager for a new code.
 *   • Only a wrong code turns the field red and shakes it; no connection / a
 *     busy server is not the staffer's mistake.
 *   • Staff title, DA/EN switch, readable hint.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

let postImpl;
vi.mock("../services/portalApi", () => ({
  default: { post: (...a) => postImpl(...a), get: vi.fn() },
}));
const haptic = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("../utils/haptics", () => ({ haptic }));

const JoinPage = (await import("../pages/JoinPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

const reject = (status, data = {}) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data };
  return Promise.reject(e);
};

function mount(lang = "da") {
  localStorage.setItem("lang", lang);
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/join"]}>
        <Routes>
          <Route path="/join" element={<JoinPage />} />
          <Route path="/s/:token" element={<div>portal</div>} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
  return screen.getByLabelText(/Tilslutningskode|Join code|kode/i);
}

async function submitCode(input, code = "K7P2QM") {
  fireEvent.change(input, { target: { value: code } });
  await act(async () => { fireEvent.submit(input.closest("form")); });
  return screen.findByRole("alert");
}

beforeEach(() => {
  localStorage.clear();
  document.title = "BonBox — Bagkontoret din virksomhed faktisk kører på";
  Object.values(haptic).forEach((f) => f.mockClear());
  postImpl = () => Promise.resolve({ data: { path: "/s/abc" } });
});

describe("/join errors speak Danish and say what to do", () => {
  it("429: wait a minute — never axios's English", async () => {
    postImpl = () => reject(429, { error: "Rate limit exceeded: 8 per 1 minute" });
    const alert = await submitCode(mount());
    expect(alert.textContent).toBe("For mange forsøg — vent et minut og prøv igen.");
    expect(document.body.textContent).not.toMatch(/Request failed|Rate limit/);
  });

  it.each([
    [500, { detail: "Something went wrong on our side. Please try again." }],
    [503, { detail: "Server is starting up, please retry in a moment" }],
    [502, "<html>Bad Gateway</html>"],
  ])("%s: the server is not answering — never the server's English", async (status, body) => {
    postImpl = () => reject(status, body);
    const alert = await submitCode(mount());
    expect(alert.textContent).toBe("Serveren svarer ikke lige nu — prøv igen om lidt.");
    expect(document.body.textContent).not.toMatch(/Request failed|Something went wrong on our side|starting up|Bad Gateway/);
  });

  it("404: not called a typo — expired / already used / ask the manager", async () => {
    postImpl = () => reject(404, { detail: "Ukendt kode" });
    const input = mount();
    const alert = await submitCode(input);
    expect(alert.textContent).toContain("udløbet");
    expect(alert.textContent).toContain("allerede brugt");
    expect(alert.textContent).toContain("bed din leder om en ny kode");
    expect(alert.textContent).not.toContain("Forkert kode");
    // A dead code is the one case that marks the field.
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toContain("border-red-400");
    expect(haptic.error).toHaveBeenCalledTimes(1);
  });

  it("no connection: a calm line — the code is not marked wrong, not shaken, kept as typed", async () => {
    postImpl = () => Promise.reject(new Error("Network Error"));
    const input = mount();
    const alert = await submitCode(input);
    expect(alert.textContent).toBe("Ingen forbindelse — tjek internettet og prøv igen.");
    expect(alert.dataset.kind).toBe("offline");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.className).not.toContain("border-red-400");
    expect(input.className).not.toContain("animate-shake");
    expect(haptic.error).not.toHaveBeenCalled();
    expect(input.value).toBe("K7P2QM");
  });

  it("a slow server says so instead of a silent 'Tilslutter…'", async () => {
    vi.useFakeTimers();
    try {
      postImpl = () => new Promise(() => {});   // never answers
      const input = mount();
      fireEvent.change(input, { target: { value: "K7P2QM" } });
      await act(async () => { fireEvent.submit(input.closest("form")); });
      expect(screen.queryByRole("status")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(4100); });
      expect(screen.getByRole("status").textContent).toBe("Det tager længere end normalt — vi prøver stadig.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/join chrome", () => {
  it("staff title, not the owner marketing title — restored on leave", async () => {
    mount();
    await waitFor(() => expect(document.title).toBe("BonBox Scheduler — Tilslut"));
  });

  it("DA/EN switch before joining", async () => {
    mount("da");
    expect(screen.getByText("Tilslut dig din arbejdsplads")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    await waitFor(() => expect(screen.getByText("Connect to your workplace")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "EN" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the link hint is readable (gray-500, 12px — was 11px gray-400 ≈ 2.4:1)", () => {
    mount();
    const hint = screen.getByText(/Har du et link i stedet/);
    expect(hint.className).toContain("text-gray-500");
    expect(hint.className).toContain("text-[12px]");
  });
});
