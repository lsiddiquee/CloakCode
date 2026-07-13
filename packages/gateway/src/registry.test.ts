import { describe, it, expect } from "vitest";
import type { SessionSummary } from "@cloakcode/protocol";
import {
  mergeSessions,
  ProviderRegistry,
  type SessionProvider,
} from "./registry.js";

function summary(
  over: Partial<SessionSummary> &
    Pick<SessionSummary, "instanceId" | "sessionId">,
): SessionSummary {
  return {
    workspace: "repo",
    workspaceHash: "hash",
    title: "t",
    turns: 1,
    status: "idle",
    idleSeconds: 0,
    owned: false,
    ...over,
  };
}

function provider(
  instanceId: string,
  sessions: SessionSummary[],
): SessionProvider {
  return { instanceId, listSessions: () => Promise.resolve(sessions) };
}

describe("mergeSessions", () => {
  it("dedupes by (instanceId, sessionId)", () => {
    const a = summary({ instanceId: "i1", sessionId: "s1" });
    expect(mergeSessions([[a], [a]])).toHaveLength(1);
  });

  it("prefers the owned row on a duplicate, order-independent", () => {
    const ro = summary({ instanceId: "i1", sessionId: "s1", owned: false });
    const owned = summary({ instanceId: "i1", sessionId: "s1", owned: true });
    expect(mergeSessions([[ro], [owned]])[0]?.owned).toBe(true);
    expect(mergeSessions([[owned], [ro]])[0]?.owned).toBe(true);
  });

  it("keeps the same sessionId under different instances", () => {
    const x = summary({ instanceId: "i1", sessionId: "s1" });
    const y = summary({ instanceId: "i2", sessionId: "s1" });
    expect(mergeSessions([[x, y]])).toHaveLength(2);
  });

  it("returns [] for no providers", () => {
    expect(mergeSessions([])).toEqual([]);
  });
});

describe("ProviderRegistry", () => {
  it("aggregates + dedupes across providers, owned wins", async () => {
    const reg = new ProviderRegistry();
    reg.add(
      provider("i1", [
        summary({ instanceId: "i1", sessionId: "s1", owned: false }),
      ]),
    );
    reg.add(
      provider("i1", [
        summary({ instanceId: "i1", sessionId: "s1", owned: true }),
        summary({ instanceId: "i1", sessionId: "s2" }),
      ]),
    );
    reg.add(provider("i2", [summary({ instanceId: "i2", sessionId: "s3" })]));
    const list = await reg.listSessions();
    expect(list).toHaveLength(3);
    expect(list.find((s) => s.sessionId === "s1")?.owned).toBe(true);
  });

  it("routes by instanceId", () => {
    const reg = new ProviderRegistry();
    reg.add(provider("i1", []));
    reg.add(provider("i1", []));
    expect(reg.forInstance("i1")).toHaveLength(2);
    expect(reg.forInstance("nope")).toEqual([]);
  });

  it("removes a provider and cleans up its empty instance bucket", () => {
    const reg = new ProviderRegistry();
    const p = provider("i1", []);
    reg.add(p);
    reg.remove(p);
    expect(reg.all()).toEqual([]);
    expect(reg.forInstance("i1")).toEqual([]);
  });

  it("skips a provider that rejects when listing", async () => {
    const reg = new ProviderRegistry();
    reg.add({
      instanceId: "bad",
      listSessions: () => Promise.reject(new Error("boom")),
    });
    reg.add(provider("i1", [summary({ instanceId: "i1", sessionId: "s1" })]));
    expect(await reg.listSessions()).toHaveLength(1);
  });
});
