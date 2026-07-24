/**
 * Provider↔gateway token storage for the extension (docs/04, F2a slice 2). A
 * gateway with operator MFA authenticates a provider the same way it does the
 * phone: a human enters a TOTP code once in VS Code and the extension exchanges
 * it — over its OWN (knocked) provider connection, see `connectGateway` — for a
 * provider **token** (never holding the secret). This module just persists that
 * token per gateway and resolves the credential for the hello; a pure
 * SecretStorage port, unit-tested without an extension host.
 */

/** The slice of `vscode.SecretStorage` we use (get + store). */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

/** Per-gateway SecretStorage key for the issued provider token. */
export function providerTokenKey(gatewayUrl: string): string {
  return `cloakcode.providerToken:${gatewayUrl}`;
}

/**
 * The credential to present in the provider hello: a stored TOTP-issued token for
 * this gateway (the interactive path), else the static shared secret (the escape
 * hatch), else none (open loopback dev).
 */
export async function resolveProviderCredential(
  secrets: SecretStore,
  gatewayUrl: string,
  staticToken?: string,
): Promise<string | undefined> {
  const stored = await secrets.get(providerTokenKey(gatewayUrl));
  if (stored && stored.trim()) return stored.trim();
  return staticToken?.trim() || undefined;
}

export function storeProviderToken(
  secrets: SecretStore,
  gatewayUrl: string,
  token: string,
): Thenable<void> {
  return secrets.store(providerTokenKey(gatewayUrl), token);
}
