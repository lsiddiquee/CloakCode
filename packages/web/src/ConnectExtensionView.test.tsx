import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const { fetchConnectInfoMock } = vi.hoisted(() => ({
  fetchConnectInfoMock: vi.fn(),
}));
vi.mock("./bridge", () => ({
  fetchConnectInfo: fetchConnectInfoMock,
  isBridgeInsecure: () => false,
}));

import { ConnectExtensionView } from "./ConnectExtensionView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectExtensionView", () => {
  it("renders ONE pairing URL that already carries the pin, plus the bare pin", async () => {
    fetchConnectInfoMock.mockResolvedValue({
      available: true,
      urls: ["wss://192.168.1.10:7443"],
      fingerprint: "AB:CD:EF",
    });
    render(<ConnectExtensionView onBack={() => {}} />);

    // Address + pin in one copy-paste string, so they cannot drift apart.
    await screen.findByText("wss://192.168.1.10:7443#fp=ABCDEF");
    expect(screen.getByText("cloakcode.gatewayCertFingerprint")).toBeTruthy();
    expect(screen.getByText("AB:CD:EF")).toBeTruthy();
    // The certificate itself is never handed out for pairing — the pin is the
    // whole anchor, and the extension fetches the cert and verifies it itself.
    expect(screen.queryByLabelText(/certificate/i)).toBeNull();
  });

  it("warns and shows a plain ws url when the provider listener is insecure", async () => {
    fetchConnectInfoMock.mockResolvedValue({
      available: true,
      insecure: true,
      urls: ["ws://192.168.1.10:3544"],
    });
    render(<ConnectExtensionView onBack={() => {}} />);

    await screen.findByText("ws://192.168.1.10:3544");
    // The insecure banner appears and names the provider-link exposure.
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/provider.*plain ws/i);
    // No fingerprint pin is offered for a plain-ws listener.
    expect(screen.queryByText("cloakcode.gatewayCertFingerprint")).toBeNull();
  });

  it("explains how to enable TLS when it is off", async () => {
    fetchConnectInfoMock.mockResolvedValue({ available: false, urls: [] });
    render(<ConnectExtensionView onBack={() => {}} />);

    await screen.findByText(/isn.t serving native TLS/i);
    expect(screen.getByText("CLOAKCODE_TLS_PORT")).toBeTruthy();
  });

  it("shows an error when the fetch fails (e.g. needs auth)", async () => {
    fetchConnectInfoMock.mockRejectedValue(
      new Error("authentication required"),
    );
    render(<ConnectExtensionView onBack={() => {}} />);
    await screen.findByText("authentication required");
  });

  it("copies a value to the clipboard on Copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fetchConnectInfoMock.mockResolvedValue({
      available: true,
      urls: ["wss://h:7443"],
      fingerprint: "AB",
    });
    render(<ConnectExtensionView onBack={() => {}} />);

    await screen.findByText("wss://h:7443#fp=AB");
    fireEvent.click(screen.getAllByRole("button", { name: /copy/i })[0]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("wss://h:7443#fp=AB"),
    );
  });

  it("calls onBack when the back button is clicked", async () => {
    fetchConnectInfoMock.mockResolvedValue({ available: false, urls: [] });
    const onBack = vi.fn();
    render(<ConnectExtensionView onBack={onBack} />);

    await screen.findByText(/isn.t serving native TLS/i);
    fireEvent.click(screen.getByTitle("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
