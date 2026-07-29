import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guards the security-relevant `contributes.configuration` scopes in the
 * extension manifest. These are a regression fence for drift audit S4: the
 * provider-connection settings must NOT be `machine-overridable` (which lets a
 * repo's `.vscode/settings.json` silently redirect the extension at an attacker
 * gateway, or inject a static token). They stay `machine` — a user/machine-only
 * decision that a workspace cannot override.
 */
const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
) as {
  contributes: {
    configuration: { properties: Record<string, { scope?: string }> };
    commands: { command: string; title: string }[];
  };
};

const props = manifest.contributes.configuration.properties;
const readme = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

describe("extension manifest — security-relevant setting scopes (S4)", () => {
  it("gatewayUrl/gatewayToken are machine-scoped (a workspace can't redirect the provider)", () => {
    expect(props["cloakcode.gatewayUrl"].scope).toBe("machine");
    expect(props["cloakcode.gatewayToken"].scope).toBe("machine");
  });

  it("the operator-auth settings are machine-scoped too", () => {
    expect(props["cloakcode.mfa"].scope).toBe("machine");
    expect(props["cloakcode.mfaEnrolment"].scope).toBe("machine");
  });

  it("embeddedBridge is machine-scoped (a workspace can't make a window serve)", () => {
    // Opening someone's repo must not flip this window into hosting its own
    // bridge + phone link.
    expect(props["cloakcode.embeddedBridge"].scope).toBe("machine");
  });
});

describe("extension manifest — the README documents what we ship", () => {
  // The README is the Marketplace page: an undocumented setting or command is a
  // support question we only find out about after publishing.
  it.each(Object.keys(props))("documents the %s setting", (key) => {
    expect(readme).toContain(key);
  });

  it.each(manifest.contributes.commands.map((c) => c.title))(
    "documents the %s command",
    (title) => {
      expect(readme).toContain(title);
    },
  );
});
