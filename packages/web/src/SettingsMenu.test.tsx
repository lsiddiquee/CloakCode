import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsMenu, Toggle } from "./SettingsMenu";

afterEach(cleanup);

describe("SettingsMenu", () => {
  it("opens on gear click and closes on Esc", () => {
    render(
      <SettingsMenu>
        <div>panel body</div>
      </SettingsMenu>,
    );
    expect(screen.queryByText("panel body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("panel body")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("panel body")).toBeNull();
  });

  it("closes on click outside the menu", () => {
    render(
      <div>
        <SettingsMenu>
          <div>panel body</div>
        </SettingsMenu>
        <button>outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("panel body")).toBeTruthy();

    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByText("panel body")).toBeNull();
  });
});

describe("Toggle", () => {
  it("reflects state and reports the next value on click", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Toggle label="Wi-Fi" checked={false} onChange={onChange} />,
    );
    const sw = screen.getByRole("switch", { name: "Wi-Fi" });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Toggle label="Wi-Fi" checked onChange={onChange} />);
    expect(
      screen
        .getByRole("switch", { name: "Wi-Fi" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renders optional description text", () => {
    render(
      <Toggle
        label="Wi-Fi"
        description="2 networks"
        checked={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("2 networks")).toBeTruthy();
  });
});
