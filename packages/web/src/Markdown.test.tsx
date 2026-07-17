import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders GFM markdown (headings, lists)", () => {
    render(<Markdown text={"# Title\n\n- item"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(screen.getByText("item")).toBeTruthy();
  });

  it("opens links in a new tab with a safe rel", () => {
    render(<Markdown text={"[go](https://example.com)"} />);
    const link = screen.getByRole("link", { name: "go" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("href")).toBe("https://example.com");
  });

  it("honours a custom className", () => {
    const { container } = render(<Markdown text="hi" className="mine" />);
    expect(container.querySelector(".mine")).toBeTruthy();
  });

  it("does not render raw HTML (no injection)", () => {
    const { container } = render(
      <Markdown text={"<img src=x onerror=alert(1)>"} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});
