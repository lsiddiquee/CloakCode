import * as os from "node:os";
import { startBridge } from "./bridge.js";
import { defaultWorkspaceStorageRoot, scanSessions } from "./scanner.js";
import { findTranscript } from "./session-observer.js";

/**
 * Dev harness: run the observer + bridge as a plain Node process (no `vscode`),
 * so the web client has something to talk to from I0. The VS Code extension host
 * (I3) will start the same bridge with an environment-derived `instanceId`.
 *
 *   pnpm --filter @cloakcode/extension dev
 */

const instanceId = process.env["CLOAKCODE_INSTANCE_ID"] ?? os.hostname();
const port = Number(process.env["CLOAKCODE_PORT"] ?? 7801);
const root = defaultWorkspaceStorageRoot();

const bridge = await startBridge(
  {
    listSessions: () => scanSessions({ instanceId, root }),
    findTranscript: (sessionId) => findTranscript(root, sessionId),
  },
  { host: "127.0.0.1", port },
);

// eslint-disable-next-line no-console
console.log(
  `[cloakcode] bridge listening on ws://127.0.0.1:${bridge.port} (instance "${instanceId}")`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void bridge.close().then(() => process.exit(0));
  });
}
