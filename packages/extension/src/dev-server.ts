import * as os from "node:os";
import { startBridge } from "./bridge.js";
import { defaultWorkspaceStorageRoot, scanSessions } from "./scanner.js";
import { findSessionLog, findTranscript } from "./session-observer.js";
import { defaultSpoolDir } from "./hook-spool.js";

/**
 * Dev harness: run the observer + bridge as a plain Node process (no `vscode`),
 * so the web client has something to talk to from I0. The VS Code extension host
 * (I3) will start the same bridge with an environment-derived `instanceId`.
 *
 *   pnpm --filter @cloakcode/extension dev
 */

const instanceId = os.hostname();
// Dev harness wants a FIXED port so Vite's proxy target stays put (not the
// 3543-then-ephemeral runtime rule). Standard env name: CLOAKCODE_GATEWAY_PORT.
const port = Number(process.env["CLOAKCODE_GATEWAY_PORT"] ?? 7801);
const root = defaultWorkspaceStorageRoot();
const spoolDir = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolDir();

const bridge = await startBridge(
  {
    listSessions: () => scanSessions({ instanceId, root }),
    findSessionLog: (sessionId) => findSessionLog(root, sessionId),
    findTranscript: (sessionId) => findTranscript(root, sessionId),
    spoolDir,
  },
  { host: "127.0.0.1", port },
);

console.log(
  `[cloakcode] bridge listening on ws://127.0.0.1:${bridge.port} (instance "${instanceId}")`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void bridge.close().then(() => process.exit(0));
  });
}
