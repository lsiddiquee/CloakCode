import { describe, expect, it } from "vitest";
import { isGatewayKnock, knockFrame } from "./ws-knock";

describe("knockFrame", () => {
  it("builds a cloakcode.hello frame for a role", () => {
    expect(JSON.parse(knockFrame("provider"))).toEqual({
      type: "cloakcode.hello",
      role: "provider",
    });
  });
});

describe("isGatewayKnock", () => {
  it("accepts the gateway's answering knock", () => {
    expect(isGatewayKnock(knockFrame("gateway"))).toBe(true);
  });

  it("rejects a non-gateway role", () => {
    expect(isGatewayKnock(knockFrame("provider"))).toBe(false);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(isGatewayKnock("not json {")).toBe(false);
    expect(isGatewayKnock("")).toBe(false);
  });

  it("rejects a well-formed but wrong-shaped frame", () => {
    expect(isGatewayKnock(JSON.stringify({ type: "other" }))).toBe(false);
  });
});
