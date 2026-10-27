/**
 * Fix round 27 Oct (L) — the door screen.
 *
 *   • The plan-cap upgrade nudge (R1b) never draws on the door screen: a
 *     paired device has no session and no plan to change. Its own build drops
 *     it whole (__STAND_BUILD__), and the owner app's /stand/<token> hides it.
 *   • The two sheets the door screen opens least — the edit sheet and "no
 *     table fits" — load on first use in the door screen's own build
 *     (MERGE §5 item 4): headroom under the 200 kB budget. stand/standSheet
 *     fetches them quietly once the book has had the screen a while; a fetch
 *     that fails says so with "Prøv igen" and can be closed — never a tap
 *     that does nothing, never the crash screen. The owner app (and vitest)
 *     imports both as before.
 * The budget itself is checked by STAND_BUDGET_STRICT=1 npm run build.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const { da } = await import("../i18n/da");
const { default: standSheet } = await import("../stand/standSheet");

const t = (k, fb) => da[k] ?? fb;
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
afterEach(() => cleanup());

describe("a sheet loaded on first use", () => {
  it("draws the sheet once it has arrived, with every prop", async () => {
    const Sheet = ({ t: tt, label }) => <div data-testid="the-sheet">{label} {tt("close", "Close")}</div>;
    const Lazy = standSheet(() => Promise.resolve({ default: Sheet }));
    render(<Lazy t={t} label="Rediger" onClose={() => {}} />);
    await settle();
    expect(screen.getByTestId("the-sheet").textContent).toContain("Rediger");
  });

  it("a fetch that fails is said, with Prøv igen that fetches again, and Luk", async () => {
    const onClose = vi.fn();
    let ok = false;
    const Sheet = () => <div data-testid="the-sheet">ok</div>;
    const load = vi.fn(() => (ok ? Promise.resolve({ default: Sheet }) : Promise.reject(new Error("offline"))));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const Lazy = standSheet(load);
    render(<Lazy t={t} onClose={onClose} />);
    await settle();
    const box = screen.getByRole("alertdialog");
    expect(box.textContent).toContain(da.rsvpErrNoNet);
    fireEvent.click(screen.getByRole("button", { name: da.close }));
    expect(onClose).toHaveBeenCalledTimes(1);
    ok = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.tryAgain })); });
    await settle();
    expect(screen.getByTestId("the-sheet")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    quiet.mockRestore();
  });

  it("its overlay sits flush (m-0) — the space-y lesson", () => {
    expect(read("stand/standSheet.jsx")).toContain('"fixed inset-0 z-50 m-0 ');
  });
});

describe("the book's page", () => {
  const page = read("pages/ReservationsPage.jsx");

  it("loads both sheets on first use in the door screen's build only (a module swap)", async () => {
    const { STAND_SWAPS, standFiles } = await import("../../scripts/standBuild.mjs");
    expect(STAND_SWAPS["components/reservations/NoTableFitsSheet.jsx"]).toBe("stand/standNoTableFitsSheet.jsx");
    expect(STAND_SWAPS["components/reservations/EditBookingSheet.jsx"]).toBe("stand/standEditBookingSheet.jsx");
    for (const [stand, real] of [["stand/standNoTableFitsSheet.jsx", "NoTableFitsSheet"],
      ["stand/standEditBookingSheet.jsx", "EditBookingSheet"]]) {
      const src = read(stand);
      expect(src).toContain(`standSheet(() => import("../components/reservations/${real}.jsx"))`);
      expect(src).not.toMatch(/^import .*components\/reservations/m);   // never a static import
    }
    // The owner app imports both as before; the page no longer holds the edit sheet.
    expect(page).toContain('import NoTableFitsSheet from "../components/reservations/NoTableFitsSheet";');
    expect(page).toContain('import EditBookingSheet from "../components/reservations/EditBookingSheet";');
    expect(page).not.toMatch(/^function EditBookingSheet\(/m);
    expect(read("components/reservations/EditBookingSheet.jsx")).toMatch(/^export default function EditBookingSheet\(/m);
    // The door screen's words still hold what the sheets say (read through the lazy import).
    const files = [...standFiles()].map((f) => f.split("/src/")[1]);
    expect(files).toContain("stand/standEditBookingSheet.jsx");
    expect(files).toContain("components/reservations/EditBookingSheet.jsx");
  });

  it("never draws the plan-cap nudge on the door screen", () => {
    expect(page).toContain("{!__STAND_BUILD__ && !onStand && heldForPlanCap(r) && <PlanCapHeldNudge");
    expect(page).toContain("onStand={isStandDevice}");
  });
});
