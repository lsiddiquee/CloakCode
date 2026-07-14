import { WebSocket } from "ws";
import { discoveryProbeUrls } from "@cloakcode/gateway";
import { knockFrame, isGatewayKnock } from "./ws-knock.js";

/**
 * Probe the known-local candidates for a running CloakCode gateway and return
 * the WebSocket URL of the FIRST that identifies itself, or `undefined` if none
 * do. Candidates come from `discoveryProbeUrls` (loopback first, then
 * `host.docker.internal`, then any `extraHosts`), tried in that preference order,
 * so a gateway on loopback wins after a single fast connect.
 *
 * The probe sends only the minimal `cloakcode.hello` knock (NO provider info) and
 * treats a candidate as a gateway iff it answers with the gateway knock — so a
 * non-CloakCode server on the same port never receives our instanceId/workspace,
 * and no separate discovery API is needed. Each probe is bounded by `timeoutMs`;
 * the winning URL is handed to `connectGateway` for the real connection.
 *
 * Security: this AUTO-CONNECTS the extension (a provider) to whatever answers, so
 * only trust it on local hosts until gateway auth lands (M4) — it is opt-in
 * (`cloakcode.gatewayDiscovery`) and candidates are local-only (docs/04).
 */
export async function discoverGateway(
  port: number,
  extraHosts: string[] = [],
  timeoutMs = 500,
  log?: (line: string) => void,
): Promise<string | undefined> {
  for (const url of discoveryProbeUrls(port, extraHosts)) {
    if (await isGateway(url, timeoutMs)) {
      log?.(`discovered gateway at ${url}`);
      return url;
    }
  }
  return undefined;
}

/**
 * Open one candidate WS, send the minimal knock, and resolve `true` if the peer
 * answers with the gateway knock within `timeoutMs` — else `false` (unreachable,
 * not a WS server, or not a CloakCode gateway). No provider info is sent. The
 * probe socket is always closed; the caller reconnects for real via
 * `connectGateway`.
 */
function isGateway(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* the probe socket is disposable */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const settle = (ok: boolean): void => {
      clearTimeout(timer);
      finish(ok);
    };
    ws.on("open", () => ws.send(knockFrame("provider")));
    ws.on("message", (raw) => {
      if (isGatewayKnock(raw.toString())) settle(true);
    });
    ws.on("error", () => settle(false));
    ws.on("close", () => settle(false));
  });
}
