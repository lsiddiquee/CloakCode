import { afterEach, describe, expect, it } from "vitest";
import { nextScrollAction, readScroll, writeScroll } from "./scroll";

afterEach(() => sessionStorage.clear());

describe("readScroll / writeScroll", () => {
  it("round-trips a saved position", () => {
    writeScroll("s1", { top: 420, atBottom: false });
    expect(readScroll("s1")).toEqual({ top: 420, atBottom: false });
  });

  it("returns null for an unknown or malformed entry", () => {
    expect(readScroll("missing")).toBeNull();
    sessionStorage.setItem("cc-scroll:bad", "{not json");
    expect(readScroll("bad")).toBeNull();
    sessionStorage.setItem("cc-scroll:partial", JSON.stringify({ top: 1 }));
    expect(readScroll("partial")).toBeNull();
  });
});

describe("nextScrollAction", () => {
  const base = {
    restored: false,
    stick: true,
    scrollHeight: 0,
    clientHeight: 0,
  };

  it("sticks to the bottom when there is nothing to restore", () => {
    expect(nextScrollAction({ ...base, saved: null })).toEqual({
      kind: "stick",
    });
  });

  it("does nothing when the user scrolled up and there's no saved spot", () => {
    expect(nextScrollAction({ ...base, saved: null, stick: false })).toEqual({
      kind: "none",
    });
  });

  it("waits until the streamed content can reach the saved offset", () => {
    // saved.top 500 but only 300px of scrollable content so far -> wait.
    expect(
      nextScrollAction({
        ...base,
        saved: { top: 500, atBottom: false },
        scrollHeight: 400,
        clientHeight: 100,
      }),
    ).toEqual({ kind: "wait" });
  });

  it("restores once the content is tall enough", () => {
    expect(
      nextScrollAction({
        ...base,
        saved: { top: 500, atBottom: false },
        scrollHeight: 900,
        clientHeight: 300,
      }),
    ).toEqual({ kind: "restore", top: 500 });
  });

  it("sticks (never restores) when the saved position was the bottom", () => {
    expect(
      nextScrollAction({
        ...base,
        saved: { top: 500, atBottom: true },
        scrollHeight: 900,
        clientHeight: 300,
      }),
    ).toEqual({ kind: "stick" });
  });

  it("resumes normal behavior after a restore has happened", () => {
    expect(
      nextScrollAction({
        ...base,
        restored: true,
        saved: { top: 500, atBottom: false },
        stick: false,
        scrollHeight: 900,
        clientHeight: 300,
      }),
    ).toEqual({ kind: "none" });
  });
});
