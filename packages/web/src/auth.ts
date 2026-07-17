import { rpcErrorSchema, sessionAuthResponseSchema } from "@cloakcode/protocol";
import { bridgeUrl } from "./bridge";

/**
 * Operator app-layer auth on the web client (docs/04, F2a). When the bridge/
 * gateway requires TOTP, a fresh socket is refused with `needsAuth` until it
 * presents a code or a stored session token. This module holds the token
 * (localStorage), builds the resume frame, classifies auth replies, and submits
 * a typed code. Pure over `localStorage` + `WebSocket`, so it unit-tests with the
 * same mocks as the bridge.
 */

const TOKEN_KEY = "cloakcode.operatorToken";

/** The session token from a prior login, if still stored. */
export function getStoredToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode) — auth just re-prompts next time */
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** A fresh `auth` frame resuming with a stored token, for a new socket. */
export function tokenAuthFrame(token: string): string {
  return JSON.stringify({
    id: `auth-${Math.random().toString(36).slice(2)}`,
    op: "auth",
    params: { token },
  });
}

/**
 * Classify a frame for the auth layer: the gateway/bridge's `auth` ack (ignore
 * it — it precedes the real op reply on the same socket), a `needsAuth` refusal
 * (prompt the operator), or an ordinary frame.
 */
export function authKind(raw: unknown): "ack" | "needs" | "other" {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o["op"] === "auth" && o["ok"] === true) return "ack";
    if (o["ok"] === false && o["needsAuth"] === true) return "needs";
  }
  return "other";
}

// --- needs-auth event bus: the bridge signals, the App shows the prompt ---
type Handler = () => void;
let needsAuthHandler: Handler | undefined;

/** Register the (single) handler shown when a socket is refused with needsAuth. */
export function onNeedsAuth(cb: Handler): () => void {
  needsAuthHandler = cb;
  return () => {
    if (needsAuthHandler === cb) needsAuthHandler = undefined;
  };
}

export function emitNeedsAuth(): void {
  needsAuthHandler?.();
}

/**
 * Submit a TOTP `code` to authenticate; on success store and return the session
 * token. `remember` asks the server for a long-lived (30d) token for this device
 * instead of the 12h default. Rejects on a bad code / error / timeout.
 */
export function submitAuthCode(
  code: string,
  remember: boolean,
  url: string = bridgeUrl(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = `auth-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, op: "auth", params: { code, remember } }));
    });

    ws.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String((ev as MessageEvent).data));
      } catch {
        return;
      }
      const ok = sessionAuthResponseSchema.safeParse(raw);
      if (ok.success && ok.data.token) {
        clearTimeout(timer);
        storeToken(ok.data.token);
        ws.close();
        resolve(ok.data.token);
        return;
      }
      const err = rpcErrorSchema.safeParse(raw);
      if (err.success) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(err.data.error.message));
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cannot reach the bridge"));
    });
  });
}
