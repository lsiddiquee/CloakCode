import { describe, expect, it } from "vitest";
import { phoneLinkHtml, qrSvg } from "./phone-link.js";

describe("qrSvg", () => {
  it("returns inline SVG markup for the text", () => {
    const svg = qrSvg("https://new-field-z3z34x8.euw.devtunnels.ms");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg.length).toBeGreaterThan(100);
  });

  it("is deterministic for the same input", () => {
    expect(qrSvg("abc")).toBe(qrSvg("abc"));
  });
});

describe("phoneLinkHtml", () => {
  it("embeds the QR and the URL under a strict CSP", () => {
    const html = phoneLinkHtml("https://x.devtunnels.ms/?a=1");
    expect(html).toContain("<svg");
    expect(html).toContain("https://x.devtunnels.ms/?a=1");
    expect(html).toContain("default-src 'none'");
  });

  it("escapes HTML in the URL (no markup injection)", () => {
    const html = phoneLinkHtml('https://x/">-<script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
