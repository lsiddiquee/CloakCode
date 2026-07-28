import { normalizeFingerprint, splitPinnedGatewayUrl } from "@cloakcode/protocol";
import type { GatewayPinConfig } from "./gateway-tls.js";

/**
 * The pre-connect DECISION, computed purely from settings so it is testable
 * without an extension host. The async connect I/O stays in the extension
 * adapter (`extension.ts`); this only decides WHAT to do.
 */
export type ConnectionPlan =
  | { kind: "gateway"; url: string; fingerprint?: string }
  | { kind: "embedded" }
  | { kind: "disabled" };

/**
 * Resolve the connection plan from the setting + env. Pure.
 *
 * - `CLOAKCODE_GATEWAY_URL` (env) then `gatewayUrl` (setting), first usable wins
 *   → connect OUT to that standalone gateway. A hostless `ws://:port` is skipped
 *   (an unfilled `${env:HOST_IP}`), so F5 on a non-WSL host still goes embedded.
 * - Else embedded (serve our own PWA + `/bridge`) — unless `embeddedBridge` is
 *   `false`, which means **no bridge at all**: this window talks only to a
 *   gateway the operator named, and never quietly starts serving its own PWA and
 *   phone link. The flag gates the fallback, not the outbound link.
 *
 * The chosen URL may be the gateway's **pairing URL** — address plus a
 * `#fp=<fingerprint>` pin in one copy-paste string (docs/04). The pin is split
 * out here so everything downstream dials, logs and keys secrets by the bare
 * address. **Throws** on a URL whose fragment is present but unusable: ignoring
 * it would quietly downgrade a pinned link to an unpinned one.
 */
export function resolveConnectionPlan(input: {
  gatewayUrl: string | undefined;
  envGatewayUrl?: string | undefined;
  embeddedBridge?: boolean | undefined;
}): ConnectionPlan {
  const raw =
    usableGatewayUrl(input.envGatewayUrl) ?? usableGatewayUrl(input.gatewayUrl);
  if (!raw) return input.embeddedBridge === false ? { kind: "disabled" } : { kind: "embedded" };
  const { url, fingerprint } = splitPinnedGatewayUrl(raw);
  return { kind: "gateway", url, ...(fingerprint ? { fingerprint } : {}) };
}

/** A trimmed, non-empty `ws(s)://host…` URL (rejects a hostless `ws://:port`). */
function usableGatewayUrl(raw: string | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  return /^wss?:\/\/[^/:?#]/i.test(url) ? url : undefined;
}

/**
 * Resolve the provider↔gateway shared secret. Pure. The `CLOAKCODE_GATEWAY_TOKEN`
 * env var **overrides** the `cloakcode.gatewayToken` setting — matching the
 * manifest and the env-first URL resolution above — so a deployment's env wins
 * over a stale machine-level setting rather than the setting silently winning
 * (drift audit S4). Empty/whitespace on both → `undefined` (no static token: the
 * loopback-dev / interactive **Sign in to Gateway** path).
 */
export function resolveGatewayToken(input: {
  gatewayToken: string | undefined;
  envGatewayToken?: string | undefined;
}): string | undefined {
  return nonEmpty(input.envGatewayToken) ?? nonEmpty(input.gatewayToken);
}

/** A trimmed, non-empty string, or `undefined`. */
function nonEmpty(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

/**
 * Resolve the `wss://` server-identity pin (drift audit S4b, docs/04) from the
 * two places a fingerprint can arrive: the `#fp=` fragment of the pairing URL
 * and the standalone `cloakcode.gatewayCertFingerprint` setting. Pure.
 *
 * They are the same value expressed two ways, so either alone wins. Both set and
 * **disagreeing** is a genuine ambiguity — one of them is stale or mistyped, and
 * picking either silently would be a trust decision made by precedence rules the
 * operator never saw. Fail closed and say which two disagree (truncated: a pin
 * belongs in an out-of-band channel, not in a log).
 */
export function resolveGatewayPin(input: {
  urlFingerprint?: string | undefined;
  settingFingerprint?: string | undefined;
}): GatewayPinConfig {
  const fromUrl = nonEmpty(input.urlFingerprint);
  const fromSetting = nonEmpty(input.settingFingerprint);
  if (
    fromUrl &&
    fromSetting &&
    normalizeFingerprint(fromUrl) !== normalizeFingerprint(fromSetting)
  ) {
    throw new Error(
      "cloakcode: the pin in cloakcode.gatewayUrl and the one in " +
        "cloakcode.gatewayCertFingerprint disagree — remove whichever is stale, " +
        "then re-copy the pairing URL from the gateway's console.",
    );
  }
  const fingerprint = fromUrl ?? fromSetting;
  return fingerprint ? { fingerprint } : {};
}
