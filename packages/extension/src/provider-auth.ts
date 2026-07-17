import { WebSocket } from "ws";
import { rpcErrorSchema, sessionAuthResponseSchema } from "@cloakcode/protocol";

/**
 * Provider↔gateway auth for the extension (docs/04, F2a slice 2). A gateway with
 * operator MFA authenticates providers the same way it authenticates the phone:
 * a human enters a TOTP code once in VS Code, the extension exchanges it for a
 * session **token** (never holding the secret), stores it, and presents it in its
 * provider hello. The static `cloakcode.gatewayToken` stays as the demoted
 * headless/automation escape hatch. Pure over a minimal SecretStorage port + the
 * `ws` client, so the store logic unit-tests without an extension host.
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

/**
 * Exchange a TOTP `code` for a provider session token via the gateway's operator
 * `auth` handshake (the same one the phone uses — no secret ever reaches the
 * provider). `remember` asks for a long-lived (30d) token so a background
 * provider seldom re-prompts. Rejects on a bad code / error / timeout.
 */
export function exchangeCodeForToken(
  url: string,
  code: string,
  remember = true,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = `auth-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("gateway timed out"));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, op: "auth", params: { code, remember } }));
    });
    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const ok = sessionAuthResponseSchema.safeParse(parsed);
      if (ok.success && ok.data.token) {
        clearTimeout(timer);
        ws.close();
        resolve(ok.data.token);
        return;
      }
      const err = rpcErrorSchema.safeParse(parsed);
      if (err.success) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(err.data.error.message));
      }
    });
    ws.on("error", (e: unknown) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}
