import { describe, expect, it } from "vitest";
import { classifyRemote, parseDevcontainerName } from "./identity.js";

describe("classifyRemote", () => {
  it("maps known remote kinds", () => {
    expect(classifyRemote(undefined)).toBe("local");
    expect(classifyRemote("wsl")).toBe("wsl");
    expect(classifyRemote("dev-container")).toBe("devcontainer");
    expect(classifyRemote("attached-container")).toBe("devcontainer");
    expect(classifyRemote("codespaces")).toBe("codespaces");
    expect(classifyRemote("ssh-remote")).toBe("ssh");
    expect(classifyRemote("tunnel")).toBe("tunnel");
  });

  it("falls back to the lowercased remote name", () => {
    expect(classifyRemote("Foo")).toBe("foo");
  });
});

describe("parseDevcontainerName", () => {
  it("extracts the top-level name from JSONC (comments + trailing comma)", () => {
    const jsonc = `{\n  // dev container\n  "name": "CloakCode Dev",\n  "image": "x",\n}`;
    expect(parseDevcontainerName(jsonc)).toBe("CloakCode Dev");
  });

  it("returns undefined when there is no name", () => {
    expect(parseDevcontainerName(`{ "image": "x" }`)).toBeUndefined();
  });
});
