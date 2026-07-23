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
  };
};

const props = manifest.contributes.configuration.properties;

describe("extension manifest — security-relevant setting scopes (S4)", () => {
  it("gatewayUrl/gatewayToken are machine-scoped (a workspace can't redirect the provider)", () => {
    expect(props["cloakcode.gatewayUrl"].scope).toBe("machine");
    expect(props["cloakcode.gatewayToken"].scope).toBe("machine");
  });

  it("the operator-auth settings are machine-scoped too", () => {
    expect(props["cloakcode.mfa"].scope).toBe("machine");
    expect(props["cloakcode.mfaEnrolment"].scope).toBe("machine");
  });
});
