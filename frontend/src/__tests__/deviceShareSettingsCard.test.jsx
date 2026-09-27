/**
 * Shared-device settings — changing the PIN needs the password.
 *
 * The server now refuses a PIN change without the account password (whoever
 * held the shared iPad could otherwise set a PIN of their own and reveal the
 * owner's finances). The card has to ask for it, and must not re-set the PIN
 * when a second device is turned on — that silently changed the PIN every
 * other shared device uses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let share;
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => share }));

const DeviceShareSettingsCard = (await import("../components/DeviceShareSettingsCard")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

const renderCard = () => {
  localStorage.setItem("lang", "en");
  return render(<LanguageProvider><DeviceShareSettingsCard /></LanguageProvider>);
};

const typePin = (value) => {
  const field = screen.getAllByRole("textbox").find((el) => el.getAttribute("inputmode") === "numeric");
  fireEvent.change(field, { target: { value } });
};

describe("DeviceShareSettingsCard", () => {
  beforeEach(() => {
    localStorage.clear();
    share = {
      ready: true, enabled: false, hasPin: false,
      setPin: vi.fn(() => Promise.resolve()),
      enableShared: vi.fn(() => Promise.resolve()),
      disableShared: vi.fn(() => Promise.resolve()),
    };
  });

  it("asks for the password before changing the PIN", async () => {
    share.enabled = true; share.hasPin = true;
    const { container } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change PIN" }));
    typePin("8642");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter your password.")).toBeTruthy();
    expect(share.setPin).not.toHaveBeenCalled();

    fireEvent.change(container.querySelector('input[type="password"]'), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(share.setPin).toHaveBeenCalledWith("8642", "pw"));
    expect(await screen.findByText("PIN updated.")).toBeTruthy();
  });

  it("says 'too many tries' on a rate limit, not 'wrong password'", async () => {
    share.enabled = true; share.hasPin = true;
    share.setPin = vi.fn(() => Promise.reject({ response: { status: 429 } }));
    const { container } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change PIN" }));
    typePin("8642");
    fireEvent.change(container.querySelector('input[type="password"]'), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Too many tries/)).toBeTruthy();
    expect(screen.queryByText("Wrong password.")).toBeNull();
  });

  it("turns on a second device with the existing PIN, without re-setting it", async () => {
    share.hasPin = true;
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Turn on for this device" }));
    expect(screen.getByText("Uses the PIN you already set.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(share.enableShared).toHaveBeenCalled());
    expect(share.setPin).not.toHaveBeenCalled();
  });

  it("sets the first PIN without a password, then turns sharing on", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Set up on this device" }));
    typePin("4271");
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(share.enableShared).toHaveBeenCalled());
    expect(share.setPin).toHaveBeenCalledWith("4271");
    // The old reset() fired a second, empty set-PIN request after success.
    expect(share.setPin).toHaveBeenCalledTimes(1);
  });
});
