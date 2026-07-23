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
vi.mock("./bridge", () => ({ fetchConnectInfo: fetchConnectInfoMock }));

import { ConnectExtensionView } from "./ConnectExtensionView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectExtensionView", () => {
  it("renders the wss url, fingerprint pin and cert when TLS is available", async () => {
    fetchConnectInfoMock.mockResolvedValue({
      available: true,
      urls: ["wss://192.168.1.10:7443"],
      fingerprint: "AB:CD:EF",
      certPem: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----",
    });
    render(<ConnectExtensionView onBack={() => {}} />);

    await screen.findByText("wss://192.168.1.10:7443");
    expect(screen.getByText("cloakcode.gatewayCertFingerprint")).toBeTruthy();
    expect(screen.getByText("AB:CD:EF")).toBeTruthy();
    const cert = screen.getByLabelText(/certificate/i) as HTMLTextAreaElement;
    expect(cert.value).toContain("BEGIN CERTIFICATE");
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
      certPem: "PEM",
    });
    render(<ConnectExtensionView onBack={() => {}} />);

    await screen.findByText("wss://h:7443");
    fireEvent.click(screen.getAllByRole("button", { name: /copy/i })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("wss://h:7443"));
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
