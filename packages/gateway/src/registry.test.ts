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
    inTurn: false,
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
  it("dedupes by sessionId", () => {
    const a = summary({ instanceId: "i1", sessionId: "s1" });
    expect(mergeSessions([[a], [a]])).toHaveLength(1);
  });

  it("prefers the owned row on a duplicate, order-independent", () => {
    const ro = summary({ instanceId: "i1", sessionId: "s1", owned: false });
    const owned = summary({ instanceId: "i1", sessionId: "s1", owned: true });
    expect(mergeSessions([[ro], [owned]])[0]?.owned).toBe(true);
    expect(mergeSessions([[owned], [ro]])[0]?.owned).toBe(true);
  });

  it("dedupes the same sessionId across instances, preferring the owned copy", () => {
    // The same session reported by its owner AND by another window's foreign
    // scan of the shared storage → ONE row, the owned/actuatable one (so
    // respond/decide/answer still route to the owning instance).
    const owned = summary({ instanceId: "i1", sessionId: "s1", owned: true });
    const foreign = summary({
      instanceId: "i2",
      sessionId: "s1",
      owned: false,
    });
    const a = mergeSessions([[owned], [foreign]]);
    expect(a).toHaveLength(1);
    expect(a[0]?.instanceId).toBe("i1");
    const b = mergeSessions([[foreign], [owned]]);
    expect(b).toHaveLength(1);
    expect(b[0]?.instanceId).toBe("i1");
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

  it("forInstance returns the providers registered under an instanceId", () => {
    const reg = new ProviderRegistry();
    reg.add(provider("i1", []));
    reg.add(provider("i1", []));
    expect(reg.forInstance("i1")).toHaveLength(2);
    expect(reg.forInstance("nope")).toEqual([]);
  });

  it("maps a session to its owning provider (owned wins), after listSessions", async () => {
    const reg = new ProviderRegistry();
    const foreign = provider("i1", [
      summary({ instanceId: "i1", sessionId: "s1", owned: false }),
    ]);
    const owner = provider("i2", [
      summary({ instanceId: "i2", sessionId: "s1", owned: true }),
      summary({ instanceId: "i2", sessionId: "s2", owned: true }),
    ]);
    reg.add(foreign);
    reg.add(owner);
    await reg.listSessions(); // builds the sessionId -> owning provider map
    expect(reg.providerForSession("s1")).toBe(owner); // owned wins over foreign
    expect(reg.providerForSession("s2")).toBe(owner);
    expect(reg.providerForSession("nope")).toBeUndefined();
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
