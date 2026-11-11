/**
 * The owner's one-time check of the staff app's map pin (Vagtplan R2).
 *
 *   • a looked-up pin asks "Sidder nålen rigtigt?" — "Ja, det passer" sends
 *     {confirm: true} and the card settles to one line;
 *   • "Pin forkert? Indsæt et kortlink" sends {map_link}; an unreadable link
 *     says what to do in Danish;
 *   • no pin found: says so and offers the link straight away;
 *   • the map image is fetched as a blob and only shown once in hand;
 *   • the full map credit is on the card.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), put: (...a) => put(...a), post: vi.fn() } }));

const VenuePinCheck = (await import("../components/VenuePinCheck")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

const UNCONFIRMED = {
  address_line: "Solsikkegade 7, 2200 København N",
  pin: { lat: 55.6872, lng: 12.5532, source: "dawa", confirmed: false },
  staff_see_map: false,
};
let location;
// jsdom has no object URLs: stub them for the whole file (unmount revokes).
URL.createObjectURL = vi.fn(() => "blob:owner-map");
URL.revokeObjectURL = vi.fn();

beforeEach(() => {
  localStorage.setItem("lang", "da");
  location = UNCONFIRMED;
  get.mockReset();
  put.mockReset();
  get.mockImplementation((url) => {
    if (url === "/staff/venue-location") return Promise.resolve({ data: location });
    if (url.startsWith("/staff/venue-map")) {
      return Promise.resolve({ status: 200, data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) });
    }
    return Promise.reject(new Error(url));
  });
});

const mount = () => render(<LanguageProvider><VenuePinCheck /></LanguageProvider>);

describe("VenuePinCheck", () => {
  it("asks once, confirms with 'Ja, det passer', then settles to one line", async () => {
    put.mockResolvedValue({ data: { ...UNCONFIRMED, pin: { ...UNCONFIRMED.pin, confirmed: true }, staff_see_map: true } });
    mount();
    expect(await screen.findByText("Sidder nålen rigtigt?")).toBeInTheDocument();
    expect(screen.getByText("Personalet ser kortet, når du har bekræftet.")).toBeInTheDocument();
    expect(screen.getByText("Kort: OpenFreeMap · OpenMapTiles · © OpenStreetMap-bidragydere")).toBeInTheDocument();
    const img = await screen.findByAltText("Kort med den nål, personalet ser");
    expect(img.getAttribute("src")).toBe("blob:owner-map");
    expect(get).toHaveBeenCalledWith("/staff/venue-map?w=360&h=112&dpr=2", { responseType: "blob" });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ja, det passer" })); });
    expect(put).toHaveBeenCalledWith("/staff/venue-location", { confirm: true });
    const summary = await screen.findByTestId("venue-pin-summary");
    expect(summary.textContent).toContain("Kort på personalets vagtkort");
    expect(summary.textContent).toContain("Solsikkegade 7");
  });

  it("a wrong pin is fixed with a pasted map link; an unreadable one says what to do", async () => {
    const e = new Error("422");
    e.response = { status: 422, data: { detail: { error: "map_link_unreadable" } } };
    put.mockRejectedValueOnce(e);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Pin forkert? Indsæt et kortlink" }));
    const input = screen.getByLabelText("Indsæt et link fra Google Maps eller Apple Kort");
    fireEvent.change(input, { target: { value: "https://example.com/nope" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Brug denne nål" })); });
    expect(put).toHaveBeenCalledWith("/staff/venue-location", { map_link: "https://example.com/nope" });
    expect((await screen.findByRole("alert")).textContent).toBe("Vi kunne ikke læse linket. Kopiér det igen fra kort-appens Del-knap.");

    put.mockResolvedValueOnce({ data: { ...UNCONFIRMED, pin: { lat: 55.7, lng: 12.5, source: "maplink", confirmed: true }, staff_see_map: true } });
    fireEvent.change(input, { target: { value: "https://maps.apple.com/?ll=55.7,12.5" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Brug denne nål" })); });
    expect(await screen.findByTestId("venue-pin-summary")).toBeInTheDocument();
  });

  it("no pin found: says so and offers the link at once", async () => {
    location = { address_line: "Solsikkegade 7, 2200 København N", pin: null, staff_see_map: false };
    mount();
    expect(await screen.findByText("Vi kunne ikke finde adressen på kortet. Indsæt et kortlink i stedet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Indsæt et link fra Google Maps eller Apple Kort")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ja, det passer" })).toBeNull();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));   // no map request without a pin
  });

  it("renders nothing while loading or when the check cannot be read", async () => {
    get.mockImplementation(() => Promise.reject(new Error("down")));
    const { container } = mount();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
