import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Mock the auth module so the component's submit path is driven without a socket.
const { submitAuthCodeMock } = vi.hoisted(() => ({
  submitAuthCodeMock: vi.fn(),
}));
vi.mock("./auth", () => ({
  submitAuthCode: submitAuthCodeMock,
}));

import { AuthPrompt } from "./AuthPrompt";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuthPrompt", () => {
  it("keeps Sign in disabled until a 6-digit code is entered", () => {
    render(<AuthPrompt onDone={() => {}} />);
    const button = screen.getByRole("button", {
      name: /sign in/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "123456" },
    });
    expect(button.disabled).toBe(false);
  });

  it("strips non-digits from the code input", () => {
    render(<AuthPrompt onDone={() => {}} />);
    const input = screen.getByPlaceholderText("123456") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1a2b3c" } });
    expect(input.value).toBe("123");
  });

  it("submits the code with remember and calls onDone on success", async () => {
    submitAuthCodeMock.mockResolvedValue("tok");
    const onDone = vi.fn();
    render(<AuthPrompt onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(submitAuthCodeMock).toHaveBeenCalledWith("654321", true);
  });

  it("shows the error and stays open on a bad code", async () => {
    submitAuthCodeMock.mockRejectedValue(new Error("invalid code"));
    const onDone = vi.fn();
    render(<AuthPrompt onDone={onDone} />);
    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await screen.findByText("invalid code");
    expect(onDone).not.toHaveBeenCalled();
  });
});
