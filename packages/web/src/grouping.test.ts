import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@cloakcode/protocol";
import { groupByWorkspace } from "./grouping";

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    instanceId: "i1",
    sessionId: "s1",
    workspace: "repo",
    workspaceHash: "H",
    title: "t",
    turns: 0,
    status: "idle",
    idleSeconds: 0,
    owned: true,
    ...over,
  };
}

describe("groupByWorkspace", () => {
  it("groups by workspaceHash, merging rows reported under different instanceIds", () => {
    // Two windows of ONE environment (different instanceIds) reporting the same
    // workspace must collapse into ONE group — instanceId is a per-reporter label.
    const a = summary({
      instanceId: "devcontainer:cloakcode",
      sessionId: "s1",
      workspaceHash: "H",
    });
    const b = summary({
      instanceId: "devcontainer:workspaces",
      sessionId: "s2",
      workspaceHash: "H",
    });
    const groups = groupByWorkspace([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspaceHash).toBe("H");
    expect(groups[0]?.rows.map((r) => r.sessionId).sort()).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("keeps different workspace hashes in separate groups", () => {
    const a = summary({ sessionId: "s1", workspaceHash: "H1" });
    const b = summary({ sessionId: "s2", workspaceHash: "H2" });
    const groups = groupByWorkspace([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.workspaceHash).sort()).toEqual(["H1", "H2"]);
  });

  it("preserves first-seen order and the workspace label", () => {
    const groups = groupByWorkspace([
      summary({ sessionId: "s1", workspaceHash: "H2", workspace: "beta" }),
      summary({ sessionId: "s2", workspaceHash: "H1", workspace: "alpha" }),
    ]);
    expect(groups.map((g) => g.workspaceHash)).toEqual(["H2", "H1"]);
    expect(groups[0]?.workspace).toBe("beta");
  });
});
