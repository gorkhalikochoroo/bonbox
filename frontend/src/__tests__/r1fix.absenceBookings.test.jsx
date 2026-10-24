/**
 * R1 fix round (24 Oct 2026) — Ferie with appointments already booked.
 *
 * Registering Ferie for Mia stopped NEW online bookings with her, but the
 * Vagtplan sheet said only "Vagter på de dage bliver markeret på
 * vagtplanen", and an appointment booked before stayed in the book with no
 * word (review: Lene at 11.00 with Mia on the Friday Mia went on Ferie).
 *
 *  • A salon's sheet says the times disappear from online booking.
 *  • After saving, the page names the appointments already on those days,
 *    with a link to the first one's day (the server counts them).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn(() => Promise.resolve({ data: {} }));
vi.mock("../services/api", () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
    post: (...a) => apiPost(...a),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "salon", role: "owner" } }),
}));

const { AbsenceSheet } = await import("../pages/StaffSchedulePage");
const { LanguageProvider, useLanguage } = await import("../hooks/useLanguage");
const { da } = await import("../i18n/da");

const STAFF = [{ id: "st-mia", name: "Mia", role: "Stylist", active: true }];

function Harness(props) {
  const { t, lang } = useLanguage();
  return (
    <AbsenceSheet staff={STAFF} initialStaffId="st-mia" initialDate="2026-10-30" absences={[]}
      onClose={vi.fn()} onChanged={vi.fn()} onSaved={vi.fn()} t={t} lang={lang} {...props} />
  );
}
async function mount(props = {}) {
  localStorage.setItem("lang", "da");
  await act(async () => {
    render(<LanguageProvider><Harness {...props} /></LanguageProvider>);
  });
}

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockImplementation(() => Promise.resolve({ data: {} }));
});

describe("the fravær sheet at a salon", () => {
  it("says the times leave online booking", async () => {
    await mount({ apptBooking: true });
    expect(screen.getByTestId("absence-online-hint").textContent).toBe(da.absenceSheetOnlineHint);
  });

  it("a café's sheet does not", async () => {
    await mount({ apptBooking: false });
    expect(screen.queryByTestId("absence-online-hint")).toBeNull();
  });

  it("hands the page the appointments already booked on those days", async () => {
    apiPost.mockImplementation(() => Promise.resolve({ data: { bookings: { count: 1, first: "2026-10-30" } } }));
    const onSaved = vi.fn();
    await mount({ apptBooking: true, onSaved });
    fireEvent.click(screen.getByRole("button", { name: "Ferie" }));
    fireEvent.click(screen.getByRole("button", { name: "Gem fravær" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [msg, booked] = onSaved.mock.calls[0];
    expect(msg).toMatch(/^Mia: Ferie .* registreret$/);
    expect(booked).toEqual({ count: 1, first: "2026-10-30", name: "Mia" });
  });

  it("nothing booked: nothing to say", async () => {
    apiPost.mockImplementation(() => Promise.resolve({ data: { bookings: { count: 0, first: null } } }));
    const onSaved = vi.fn();
    await mount({ apptBooking: true, onSaved });
    fireEvent.click(screen.getByRole("button", { name: "Gem fravær" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][1]).toBe(null);
  });

  it("the words exist in en and da", async () => {
    const { en } = await import("../i18n/en");
    for (const k of ["absenceSheetOnlineHint", "absenceBookingsOne", "absenceBookingsN",
      "absenceBookingsSeeOne", "absenceBookingsSeeN"]) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    expect(da.absenceBookingsOne.replace("{name}", "Mia")).toBe("1 aftale hos Mia ligger allerede på de dage.");
  });
});
