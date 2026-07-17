import { generateTotpSecret } from "@cloakcode/gateway";

/**
 * Embedded (extension) side of operator TOTP (docs/04, F2a). The standalone
 * gateway persists its secret to a file; a VS Code window has a real keychain, so
 * the secret lives in **SecretStorage** instead. Pure over a minimal store port,
 * so it unit-tests without an extension host.
 */

/** SecretStorage key for the operator TOTP secret. */
export const OPERATOR_SECRET_KEY = "cloakcode.operatorTotpSecret";

/** The slice of `vscode.SecretStorage` we use (get + store). */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

export interface OperatorSecret {
  /** The base32 TOTP secret. */
  secret: string;
  /** True when this call generated + stored a fresh secret (⇒ show the QR). */
  created: boolean;
}

/**
 * Load the operator TOTP secret from SecretStorage, or generate one and store it
 * on first use. `created` lets the caller surface the pairing QR exactly once.
 */
export async function loadOrCreateOperatorSecret(
  secrets: SecretStore,
): Promise<OperatorSecret> {
  const existing = await secrets.get(OPERATOR_SECRET_KEY);
  if (existing && existing.trim()) {
    return { secret: existing.trim(), created: false };
  }
  const secret = generateTotpSecret();
  await secrets.store(OPERATOR_SECRET_KEY, secret);
  return { secret, created: true };
}

/**
 * Whether the embedded bridge is reachable beyond this machine and therefore
 * needs operator auth by default. The bridge always binds loopback, so the only
 * way a phone reaches it is a **tunnel**: a managed Dev Tunnel
 * (`cloakcode.tunnel: devtunnel`) or a bring-your-own public URL
 * (`CLOAKCODE_PUBLIC_URL`).
 */
export function embeddedExposed(opts: {
  tunnel?: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  return (
    opts.tunnel === "devtunnel" ||
    Boolean(opts.publicUrl && opts.publicUrl.trim())
  );
}
