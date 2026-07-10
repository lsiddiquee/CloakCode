import * as os from "node:os";
import { startBridge } from "./bridge.js";
import { defaultWorkspaceStorageRoot, scanSessions } from "./scanner.js";
import { findSessionLog, findTranscript } from "./session-observer.js";
import {
  controlDirFor,
  defaultSpoolDir,
  readControlPolicy,
  writeControlPolicy,
  writeDecision,
} from "./hook-spool.js";

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
const spoolDir = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolDir();

const bridge = await startBridge(
  {
    listSessions: () => scanSessions({ instanceId, root }),
    findSessionLog: (sessionId) => findSessionLog(root, sessionId),
    findTranscript: (sessionId) => findTranscript(root, sessionId),
    spoolDir,
    // Take-control is testable via the dev rig; `globalAutoApprove` is omitted
    // here (that read needs the vscode extension host), so the dev bridge treats
    // global auto-approve as off.
    setControl: async ({ sessionId, control }) => {
      const controlDir = controlDirFor(spoolDir);
      const prev = await readControlPolicy(controlDir, sessionId);
      writeControlPolicy(controlDir, sessionId, {
        control,
        ...(prev.allow ? { allow: prev.allow } : {}),
      });
    },
    decide: async ({ toolCallId, decision }) => {
      writeDecision(spoolDir, toolCallId, decision);
    },
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
