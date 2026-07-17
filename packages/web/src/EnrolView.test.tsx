import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { beginEnrolmentMock, submitAuthCodeMock } = vi.hoisted(() => ({
  beginEnrolmentMock: vi.fn(),
  submitAuthCodeMock: vi.fn(),
}));
vi.mock("./auth", () => ({
  beginEnrolment: beginEnrolmentMock,
  submitAuthCode: submitAuthCodeMock,
}));

import { EnrolView } from "./EnrolView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EnrolView", () => {
  it("shows the QR + secret (Option A) then verifies a code and calls onDone", async () => {
    beginEnrolmentMock.mockResolvedValue({
      otpauthUri: "otpauth://totp/x?secret=ABC234",
      secret: "ABC234",
    });
    submitAuthCodeMock.mockResolvedValue("tok");
    const onDone = vi.fn();
    render(<EnrolView onDone={onDone} />);

    // The secret renders once provisioning resolves.
    await screen.findByText("ABC234");
    expect(document.querySelector(".qr svg")).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enable/i }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(submitAuthCodeMock).toHaveBeenCalledWith("654321", true);
  });

  it("in strict mode (no secret) shows the out-of-band instruction", async () => {
    beginEnrolmentMock.mockResolvedValue({});
    render(<EnrolView onDone={() => {}} />);
    await screen.findByText(/gateway console/i);
    expect(document.querySelector(".qr svg")).toBeNull();
  });

  it("shows an error when pairing can't start", async () => {
    beginEnrolmentMock.mockRejectedValue(new Error("bridge timed out"));
    render(<EnrolView onDone={() => {}} />);
    await screen.findByText("bridge timed out");
  });

  it("surfaces a bad verify code without calling onDone", async () => {
    beginEnrolmentMock.mockResolvedValue({ otpauthUri: "otpauth://x" });
    submitAuthCodeMock.mockRejectedValue(new Error("invalid code"));
    const onDone = vi.fn();
    render(<EnrolView onDone={onDone} />);
    await screen.findByPlaceholderText("123456");
    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enable/i }));
    await screen.findByText("invalid code");
    expect(onDone).not.toHaveBeenCalled();
  });
});
