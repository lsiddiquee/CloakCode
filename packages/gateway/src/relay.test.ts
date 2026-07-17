import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";
import { Relay } from "./relay.js";

interface FakeOperator {
  readyState: number;
  OPEN: number;
  send: (text: string) => void;
  sent: Record<string, unknown>[];
}

function fakeOperator(): FakeOperator {
  const sent: Record<string, unknown>[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
    sent,
  };
}

const asWs = (o: FakeOperator): WebSocket => o as unknown as WebSocket;

describe("Relay", () => {
  it("forwards with a rewritten id and pipes streamed frames back", () => {
    const relay = new Relay();
    const operator = fakeOperator();
    let relayId = "";
    relay.forward(
      asWs(operator),
      {
        id: "op-1",
        op: "session.subscribe",
        params: { instanceId: "i1", sessionId: "s1" },
      },
      {},
      (text) => {
        relayId = (JSON.parse(text) as { id: string }).id;
      },
    );
    expect(relayId).not.toBe("op-1"); // rewritten on the wire

    expect(
      relay.routeProviderFrame(
        JSON.stringify({ id: relayId, op: "session.subscribe", kind: "event" }),
      ),
    ).toBe(true);
    relay.routeProviderFrame(
      JSON.stringify({ id: relayId, op: "session.subscribe", kind: "pending" }),
    );
    expect(operator.sent).toHaveLength(2); // streaming keeps the mapping
    expect(operator.sent[0]?.["id"]).toBe("op-1"); // rewritten back
  });

  it("ignores an unknown id and non-JSON", () => {
    const relay = new Relay();
    expect(relay.routeProviderFrame(JSON.stringify({ id: "nope" }))).toBe(
      false,
    );
    expect(relay.routeProviderFrame("not json")).toBe(false);
  });

  it("drops an operator's relays on disconnect", () => {
    const relay = new Relay();
    const operator = fakeOperator();
    let relayId = "";
    relay.forward(
      asWs(operator),
      { id: "op-1", op: "session.respond", params: {} },
      {},
      (text) => {
        relayId = (JSON.parse(text) as { id: string }).id;
      },
    );
    expect(relay.size).toBe(1);
    relay.dropOperator(asWs(operator));
    expect(relay.size).toBe(0);
    expect(relay.routeProviderFrame(JSON.stringify({ id: relayId }))).toBe(
      false,
    );
  });

  it("drops a provider's relays when that provider disconnects", () => {
    const relay = new Relay();
    const operator = fakeOperator();
    const providerA = {};
    const providerB = {};
    relay.forward(
      asWs(operator),
      { id: "a", op: "session.subscribe", params: {} },
      providerA,
      () => {},
    );
    relay.forward(
      asWs(operator),
      { id: "b", op: "session.subscribe", params: {} },
      providerB,
      () => {},
    );
    expect(relay.size).toBe(2);
    relay.dropProvider(providerA);
    expect(relay.size).toBe(1); // only providerA's relay is gone
  });
});
