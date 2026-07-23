import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InsecureBanner } from "./InsecureBanner";

afterEach(cleanup);

describe("InsecureBanner", () => {
  it("renders nothing when there are no insecure aspects", () => {
    const { container } = render(<InsecureBanner aspects={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists each aspect and frames it as confidentiality (not access)", () => {
    render(
      <InsecureBanner
        aspects={["Aspect one is exposed.", "Aspect two is exposed."]}
      />,
    );
    expect(screen.getByText("INSECURE")).toBeTruthy();
    expect(screen.getByText("Aspect one is exposed.")).toBeTruthy();
    expect(screen.getByText("Aspect two is exposed.")).toBeTruthy();
    // Confidentiality framing: sign-in still gates *who* connects.
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/who/i);
    expect(banner.textContent).toMatch(/only confidentiality is lost/i);
  });
});
