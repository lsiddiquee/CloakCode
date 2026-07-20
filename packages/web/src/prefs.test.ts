import { afterEach, describe, expect, it } from "vitest";
import { loadPrefs, savePrefs } from "./prefs";

afterEach(() => {
  localStorage.clear();
});

describe("session-list prefs", () => {
  it("defaults to read-only hidden and nothing collapsed when storage is empty", () => {
    expect(loadPrefs()).toEqual({ showReadOnly: false, collapsed: [] });
  });

  it("round-trips saved preferences", () => {
    savePrefs({ showReadOnly: true, collapsed: ["H1", "H2"] });
    expect(loadPrefs()).toEqual({
      showReadOnly: true,
      collapsed: ["H1", "H2"],
    });
  });

  it("falls back to defaults on corrupt JSON", () => {
    localStorage.setItem("cloakcode.sessionListPrefs.v1", "{not json");
    expect(loadPrefs()).toEqual({ showReadOnly: false, collapsed: [] });
  });

  it("sanitises unexpected shapes to defaults", () => {
    localStorage.setItem(
      "cloakcode.sessionListPrefs.v1",
      JSON.stringify({ showReadOnly: "yes", collapsed: [1, "H", null] }),
    );
    expect(loadPrefs()).toEqual({ showReadOnly: false, collapsed: ["H"] });
  });
});
