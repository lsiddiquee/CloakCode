import * as os from "node:os";
import * as vscode from "vscode";
import { startBridge, type Bridge } from "./bridge.js";
import { defaultWorkspaceStorageRoot, scanSessions } from "./scanner.js";
import { findTranscript } from "./session-observer.js";
import { defaultSpoolFile } from "./hook-spool.js";

/**
 * The VS Code extension host entry — the ONLY place that imports `vscode`. It
 * starts the same localhost bridge the `dev-server` runs (observer + spool
 * live-pending), but from inside a real window so later slices can drive
 * `vscode.commands` (the M3b question actuator). Everything else stays in the
 * pure, testable modules; this file is a thin adapter.
 */

let bridge: Bridge | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const out = vscode.window.createOutputChannel("CloakCode");
  context.subscriptions.push(out);

  const instanceId = process.env["CLOAKCODE_INSTANCE_ID"] ?? os.hostname();
  const port = Number(process.env["CLOAKCODE_PORT"] ?? 7801);
  const root = defaultWorkspaceStorageRoot();
  const spoolFile = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolFile();

  try {
    bridge = await startBridge(
      {
        listSessions: () => scanSessions({ instanceId, root }),
        findTranscript: (sessionId) => findTranscript(root, sessionId),
        spoolFile,
        respond: async ({ text }) => {
          // M3b question channel: submit the remote operator's answer as a chat
          // message to the ACTIVE panel chat (Q1). `{ query }` alone auto-sends;
          // `isPartialQuery` would only populate. v1 targets the active session.
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: text,
          });
        },
      },
      { host: "127.0.0.1", port },
    );
    out.appendLine(
      `bridge listening on ws://127.0.0.1:${bridge.port} (instance "${instanceId}")`,
    );
  } catch (err) {
    out.appendLine(
      `failed to start bridge on ${port}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  context.subscriptions.push({
    dispose: () => {
      void bridge?.close();
      bridge = undefined;
    },
  });
}

export function deactivate(): void {
  void bridge?.close();
  bridge = undefined;
}
