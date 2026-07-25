import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionPart } from "@cloakcode/protocol";
import { applyEvents, prependEvents } from "./SessionView";

const empty = {
  parts: [] as SessionPart[],
  resolved: new Set<string>(),
  pending: [],
  error: null,
  inTurn: false,
  lastActivityAt: 0,
  lowSeq: Number.POSITIVE_INFINITY,
  highSeq: 0,
};

const md = (id: string, seq: number): SessionEvent => ({
  type: "append",
  seq,
  part: { kind: "markdown", id, text: `t${id}` },
});
const tool = (
  id: string,
  seq: number,
  status: "running" | "done" | "error" = "running",
): SessionEvent => ({
  type: "append",
  seq,
  part: { kind: "toolCall", id, name: "read_file", input: {}, status },
});

describe("applyEvents", () => {
  it("appends parts in order in a single pass", () => {
    const s = applyEvents(empty, [md("a", 0), md("b", 1), md("c", 2)]);
    expect(s.parts.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("dedupes appends by id (a reconnect may resume with overlap)", () => {
    const s = applyEvents(empty, [md("a", 0), md("a", 0), md("b", 1)]);
    expect(s.parts.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("folds a status update onto the matching toolCall", () => {
    const s = applyEvents(empty, [
      tool("t", 0, "running"),
      { type: "updateStatus", seq: 1, id: "t", status: "done" },
    ]);
    const p = s.parts[0];
    expect(p && p.kind === "toolCall" && p.status).toBe("done");
  });

  it("records resolves", () => {
    const s = applyEvents(empty, [{ type: "resolve", seq: 0, id: "c1" }]);
    expect(s.resolved.has("c1")).toBe(true);
  });

  it("returns the same state reference for an empty or no-op batch", () => {
    expect(applyEvents(empty, [])).toBe(empty);
    const base = applyEvents(empty, [md("a", 0)]);
    // Re-applying an already-seen append changes nothing -> same ref (no render).
    expect(applyEvents(base, [md("a", 0)])).toBe(base);
  });

  it("applies a mixed batch (append + status + resolve) in one update", () => {
    const s = applyEvents(empty, [
      md("m", 0),
      tool("t", 1, "running"),
      { type: "updateStatus", seq: 2, id: "t", status: "done" },
      { type: "resolve", seq: 3, id: "m" },
    ]);
    expect(s.parts.map((p) => p.id)).toEqual(["m", "t"]);
    const t = s.parts[1];
    expect(t && t.kind === "toolCall" && t.status).toBe("done");
    expect(s.resolved.has("m")).toBe(true);
  });

  it("tracks lowSeq (page floor) and highSeq (resume point) across a batch", () => {
    const s = applyEvents(empty, [md("a", 5), md("b", 6), md("c", 7)]);
    expect(s.lowSeq).toBe(5);
    expect(s.highSeq).toBe(8); // next expected seq
  });
});

describe("prependEvents", () => {
  it("prepends an older page ahead of held parts and lowers lowSeq", () => {
    const base = applyEvents(empty, [md("c", 5), md("d", 6)]);
    expect(base.lowSeq).toBe(5);
    const s = prependEvents(base, [md("a", 3), md("b", 4)]);
    expect(s.parts.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(s.lowSeq).toBe(3);
    expect(s.highSeq).toBe(base.highSeq); // the ceiling is unchanged by a prepend
  });

  it("dedupes an overlapping older page by id", () => {
    const base = applyEvents(empty, [md("b", 4), md("c", 5)]);
    const s = prependEvents(base, [md("a", 3), md("b", 4)]);
    expect(s.parts.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(s.lowSeq).toBe(3);
  });

  it("returns the same reference for an empty page", () => {
    const base = applyEvents(empty, [md("a", 0)]);
    expect(prependEvents(base, [])).toBe(base);
  });
});
