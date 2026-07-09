import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { startBridge, type Bridge } from "./bridge.js";
import { defaultWorkspaceStorageRoot, scanSessions } from "./scanner.js";
import { findTranscript } from "./session-observer.js";
import { buildHookConfig, defaultSpoolDir } from "./hook-spool.js";

/**
 * The VS Code extension host entry — the ONLY place that imports `vscode`. It
 * starts the same localhost bridge the `dev-server` runs (observer + spool
 * live-pending) from inside a real window (so it can drive `vscode.commands` for
 * the M3b answer channel), and **self-installs** the Copilot hook using paths it
 * resolves from `context` — portable across container / WSL / host. Everything
 * else stays in the pure, testable modules; this file is a thin adapter.
 */

let bridge: Bridge | undefined;

/**
 * Write the user-global hook config (`~/.copilot/hooks/cloakcode.json`) pointing
 * at the bundled hook + this environment's node + the given spool dir. Best
 * effort: a failure just means no live-pending overlay. Idempotent — only writes
 * when the content changed.
 */
async function installHook(
  context: vscode.ExtensionContext,
  spoolDir: string,
  out: vscode.OutputChannel,
): Promise<void> {
  try {
    const hookBin = vscode.Uri.joinPath(
      context.extensionUri,
      "dist",
      "hook.cjs",
    ).fsPath;
    const config = buildHookConfig({
      runtime: process.execPath,
      hookBin,
      spoolDir,
    });
    const hookDir = path.join(os.homedir(), ".copilot", "hooks");
    const hookFile = path.join(hookDir, "cloakcode.json");
    const next = JSON.stringify(config, null, 2) + "\n";
    const current = await fs.readFile(hookFile, "utf8").catch(() => "");
    if (current !== next) {
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookFile, next);
      out.appendLine(`installed hook -> ${hookFile}`);
    }
  } catch (err) {
    out.appendLine(
      `hook install skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const out = vscode.window.createOutputChannel("CloakCode");
  context.subscriptions.push(out);

  const instanceId = process.env["CLOAKCODE_INSTANCE_ID"] ?? os.hostname();
  const port = Number(process.env["CLOAKCODE_PORT"] ?? 7801);
  const root = defaultWorkspaceStorageRoot();
  // The spool is a fixed, per-environment dir shared by the hook and every
  // window's follower (see hook-spool `defaultSpoolDir`) — NOT `globalStorageUri`,
  // which is per-profile and the separate hook process can't read anyway.
  // Overridable via env for the dev-server / isolated rig.
  const spoolDir = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolDir();

  // Opt-out for the per-environment hook file. Machine-scoped (User/Remote
  // settings, not per-workspace) because it controls one global file shared by
  // every window. Off = we never write it; the user manages the hook themselves.
  const installEnabled = vscode.workspace
    .getConfiguration("cloakcode")
    .get<boolean>("installHook", true);
  if (installEnabled) {
    await installHook(context, spoolDir, out);
  } else {
    out.appendLine("hook install disabled (cloakcode.installHook = false)");
  }

  try {
    bridge = await startBridge(
      {
        listSessions: () => scanSessions({ instanceId, root }),
        findTranscript: (sessionId) => findTranscript(root, sessionId),
        spoolDir,
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
