/**
 * Native Scheduler shell + keyboard, wired on the REAL portal page (round-2
 * C11). The Keyboard plugin's "body" resize never shortened the portal's
 * 100dvh scroller, so the Fravær note and its Send button stayed under the
 * keyboard. Now: the shell ends at the keyboard, sheets ride on top of it,
 * and the forms are marked so the reveal brings their buttons along. The
 * scroll math itself is pinned in useKeyboardReveal.test.jsx.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokkb";
const ok = (data) => Promise.resolve({ data });
let kb = 0;

vi.mock("../utils/platform", () => ({
  platform: { isNative: true, isIOS: true, isAndroid: false, isWeb: false },
  isNativeApp: () => true,
  canPurchaseInApp: () => false,
  isIPad: () => false,
}));
// Stateful like the real hook: the keyboard event re-renders every user of
// it, not just whichever component happened to re-render next.
const kbBus = vi.hoisted(() => ({ listeners: new Set() }));
vi.mock("../hooks/useKeyboardLift", async () => {
  const React = await import("react");
  const useKb = () => {
    const [v, set] = React.useState(kb);
    React.useEffect(() => {
      kbBus.listeners.add(set);
      return () => kbBus.listeners.delete(set);
    }, []);
    return v;
  };
  return {
    useKeyboardLift: useKb,
    useKeyboardState: () => {
      const v = useKb();
      return { lift: v, open: v > 0 };
    },
  };
});
function setKeyboard(h) {
  kb = h;
  act(() => { kbBus.listeners.forEach((f) => f(h)); });
}
vi.mock("../services/portalApi", () => ({
  default: {
    get: (url) => {
      if (url === `/portal/${TOK}`) return ok({ has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" });
      if (url.includes("/schedule")) return ok({ shifts: [] });
      if (url.includes("/absence")) return ok({ absence: [] });
      if (url.includes("/notifications")) return ok({ notifications: [] });
      if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
      if (url.includes("/hours")) return ok({ period_start: "2026-10-01", period_end: "2026-10-31", total_hours: 0, entries: [] });
      return ok([]);
    },
    post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" },
  },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) } }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount() {
  localStorage.setItem("lang", "da");
  const r = render(
    <LanguageProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
          <Routes>
            <Route path="/portal/:token" element={<StaffPortalPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
  return r;
}

beforeEach(() => {
  localStorage.clear();
  kb = 0;
  document.documentElement.style.removeProperty("--kb-h");
});

describe("Native keyboard over the portal", () => {
  it("the Fravær form: shell ends at the keyboard, the form travels as one block", async () => {
    await mount();
    fireEvent.click(within(document.querySelector("nav")).getByText("Fravær").closest("button"));
    fireEvent.click(await screen.findByRole("button", { name: /Anmod om fri/ }));
    const form = await screen.findByTestId("fravaer-form");
    expect(form.hasAttribute("data-kb-block")).toBe(true);

    const shell = document.querySelector(".full-height.scrollable");
    // Release A device pass: the shell is fixed over the layout viewport
    // (100% of it), never a 100dvh block in the document's flow.
    expect(shell.style.position).toBe("fixed");
    expect(shell.style.height).toBe("100%");

    const note = within(form).getByPlaceholderText("Note (valgfri)");
    note.focus();
    setKeyboard(336);
    await waitFor(() => expect(shell.style.height).toBe("calc(100% - 336px)"));
    expect(document.documentElement.style.getPropertyValue("--kb-h")).toBe("336px");
    // iOS keeps the dock's room under the content while typing (only the
    // Android app hides the dock and gives it back).
    expect(shell.style.paddingBottom).toContain("76px");

    setKeyboard(0);
    await waitFor(() => expect(shell.style.height).toBe("100%"));   // the full frame again
    expect(shell.style.position).toBe("fixed");
    expect(document.documentElement.style.getPropertyValue("--kb-h")).toBe("");
  });

  it("the profile sheet (contact + bank fields) sits on top of the keyboard", async () => {
    await mount();
    fireEvent.click(screen.getByTitle("Rediger profil"));
    await waitFor(() => expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull());
    const sheet = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(sheet.style.paddingBottom).toBe("var(--kb-h, 0px)");
  });

  it("--vp-ih is the layout viewport's height, read again on a resize (WKWebView after a keyboard), gone after unmount", async () => {
    const was = window.innerHeight;
    try {
      const { unmount } = await mount();
      const ih = () => document.documentElement.style.getPropertyValue("--vp-ih");
      expect(ih()).toBe(`${window.innerHeight}px`);
      window.innerHeight = 778;
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(ih()).toBe("778px");
      unmount();
      expect(ih()).toBe("");
    } finally {
      window.innerHeight = was;
    }
  });
});
