import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { startBridge, type Bridge, type BridgeDeps } from "./bridge.js";
import { connectGateway, type GatewayClient } from "./gateway-client.js";
import { resolveConnectionPlan } from "./connection-plan.js";
import { createOutputChannelLogger } from "./logger.js";
import { type Logger, type LogLevel } from "@cloakcode/protocol";
import {
  defaultWorkspaceStorageRoot,
  scanSessions,
  storageHashFromUri,
} from "./scanner.js";
import { findSessionLog, findTranscript } from "./session-observer.js";
import {
  formatDiagnostics,
  type DiagnosticsSnapshot,
  type ScannedHash,
} from "./diagnostics.js";
import {
  baseToolCallId,
  buildCarouselAnswers,
  buildHookConfig,
  defaultSpoolDir,
  hookConfigPath,
  localChatSessionUri,
  removeSpoolForSession,
  stableHookPath,
} from "./hook-spool.js";
import { phoneLinkHtml, isLoopback } from "./phone-link.js";
import {
  devTunnelInstallHint,
  devTunnelName,
  parseLogLevel,
  resolvePortPlan,
  startDevTunnel,
  TunnelError,
  type PortPlan,
  type Tunnel,
  type TunnelLog,
} from "@cloakcode/gateway";
import { classifyRemote, parseDevcontainerName } from "./identity.js";
import { tunnelFixAction } from "./tunnel-policy.js";

/**
 * The VS Code extension host entry — the ONLY place that imports `vscode`. It
 * starts the same localhost bridge the `dev-server` runs (observer + spool
 * live-pending) from inside a real window (so it can drive `vscode.commands` for
 * the M3b answer channel), and **self-installs** the Copilot hook using paths it
 * resolves from `context` — portable across container / WSL / host. Everything
 * else stays in the pure, testable modules; this file is a thin adapter.
 */

let bridge: Bridge | undefined;
let gatewayClient: GatewayClient | undefined;
let tunnel: Tunnel | undefined;

/**
 * Write the user-global hook config (`~/.copilot/hooks/cloakcode.json`) pointing
 * at the bundled hook + this environment's node + the given spool dir. Best
 * effort: a failure just means no live-pending overlay. Idempotent — only writes
 * when the content changed.
 */
async function installHook(
  context: vscode.ExtensionContext,
  spoolDir: string,
  log: Logger,
): Promise<void> {
  try {
    const extHookBin = vscode.Uri.joinPath(
      context.extensionUri,
      "dist",
      "hook.cjs",
    ).fsPath;
    // Point the config at a STABLE copy so an orphaned hook degrades to a no-op
    // (not a missing-file error) if the extension is later uninstalled/updated.
    const hookBin = await ensureStableHook(extHookBin);
    const config = buildHookConfig({
      runtime: process.execPath,
      hookBin,
      spoolDir,
    });
    const hookFile = hookConfigPath();
    const next = JSON.stringify(config, null, 2) + "\n";
    const current = await fs.readFile(hookFile, "utf8").catch(() => "");
    if (current !== next) {
      await fs.mkdir(path.dirname(hookFile), { recursive: true });
      await fs.writeFile(hookFile, next);
      log.info("hook.installed");
    }
  } catch (err) {
    log.warn("hook.install_skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Copy the bundled hook to the STABLE per-environment path so Copilot keeps a
 * working command even after the versioned extension dir is gone — the orphan
 * then no-ops instead of erroring on every tool call. Atomic (temp + rename) so a
 * concurrent hook invocation from another window never reads a half-written file.
 * Returns the path to point the config at: the stable copy on success, else the
 * extension's own bundle (still valid while installed).
 */
async function ensureStableHook(extHookBin: string): Promise<string> {
  const stable = stableHookPath();
  try {
    const bundle = await fs.readFile(extHookBin);
    const current = await fs.readFile(stable).catch(() => null);
    if (!current || !current.equals(bundle)) {
      await fs.mkdir(path.dirname(stable), { recursive: true });
      const tmp = `${stable}.tmp-${process.pid}`;
      await fs.writeFile(tmp, bundle);
      await fs.rename(tmp, stable);
    }
    return stable;
  } catch {
    return extHookBin; // fall back to the ext-dir path (works while installed)
  }
}

/**
 * Remove the CloakCode Copilot hook for the WHOLE environment: the user-global
 * config + the stable hook copy. Only ever run from the explicit `removeHook`
 * command — NEVER on deactivation (the config is shared by every window, so a
 * lifecycle-driven removal would break the others). Best effort.
 */
async function uninstallHook(log: Logger): Promise<void> {
  for (const p of [hookConfigPath(), stableHookPath()]) {
    await fs.rm(p, { force: true }).catch(() => undefined);
  }
  log.info("hook.removed");
}

/**
 * The workspaceStorage `<hash>` dirs THIS window owns — the sessions this
 * instance can actuate; `scanSessions` marks the rest observe-only. Resolved
 * fresh per scan from two signals:
 *   1. `context.storageUri` (= `.../workspaceStorage/<hash>/<extId>`) — the
 *      canonical hash for this window's workspace. NB the extension id itself
 *      contains a slash (`cloakcode.@cloakcode/extension`), so the hash is the
 *      first segment under the root, not `basename(dirname())` — see
 *      `storageHashFromUri`.
 *   2. `CLOAKCODE_OWNED_HASHES` (comma-separated) — a deterministic override for
 *      the dev harness and tests.
 * An empty result makes the scanner list every session read-only (secure default).
 */
function resolveOwnedHashes(
  context: vscode.ExtensionContext,
  root: string,
): { hashes: Set<string>; source: string; names: Map<string, string> } {
  const hashes = new Set<string>();
  const names = new Map<string, string>();
  const sources: string[] = [];

  const uri = context.storageUri;
  const hash = uri ? storageHashFromUri(root, uri.fsPath) : undefined;
  if (hash) {
    hashes.add(hash);
    sources.push("context.storageUri");
    // Label the owned workspace with its real folder name (single-root windows).
    const folders = vscode.workspace.workspaceFolders ?? [];
    const only = folders.length === 1 ? folders[0] : undefined;
    if (only) names.set(hash, only.name);
  }

  const override = process.env["CLOAKCODE_OWNED_HASHES"]?.trim();
  if (override) {
    for (const h of override.split(",")) {
      const t = h.trim();
      if (t) hashes.add(t);
    }
    sources.push("CLOAKCODE_OWNED_HASHES");
  }

  return { hashes, source: sources.join("+") || "none", names };
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const out = vscode.window.createOutputChannel("CloakCode");
  context.subscriptions.push(out);

  const cfg = vscode.workspace.getConfiguration("cloakcode");
  // Local-only structured logger → the CloakCode output channel (docs/03). The
  // level is a function so the `cloakcode.logLevel` setting changes it live.
  let logLevel: LogLevel = parseLogLevel(cfg.get<string>("logLevel")) ?? "info";
  // Per-session action logs (docs/03): one JSONL per `sessionId` under CloakCode's
  // OWN workspace storage (global storage when no folder is open) — like Copilot's
  // transcripts, but recording the actions CloakCode took. Local-only, best-effort
  // (no hard audit, no forced mount); mount the storage dir yourself for durability.
  const sessionLogDir = path.join(
    context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
    "session-logs",
  );
  const log = createOutputChannelLogger(out, () => logLevel, {
    base: { component: "extension" },
    sessionLogDir,
  });
  // Every remote actuation is provenance-stamped so the session log answers
  // "who acted" — the phone, never the local keyboard (docs/04).
  const actuatorLog = log.child({ provenance: "remote-operator" });
  // The instanceId is a DISPLAY LABEL only (never routing/identity). It lives in
  // this workspace's `workspaceState`, changed via the `CloakCode: Set Instance
  // ID` command — NOT a setting (a setting confused the User/Remote/Workspace
  // scopes). Empty override => auto: `<env-kind>:<workspace-or-devcontainer>`.
  const INSTANCE_ID_KEY = "cloakcode.instanceId";
  const resolveInstanceId = async (): Promise<string> =>
    (context.workspaceState.get<string>(INSTANCE_ID_KEY) ?? "").trim() ||
    (await defaultInstanceId());
  let instanceId = await resolveInstanceId();
  log.info("activate", { instanceId });
  // Bind rule (resolvePortPlan, tested): `cloakcode.port` / `CLOAKCODE_GATEWAY_PORT`
  // unset → try 3543, then an ephemeral port if it's taken; `0` → ephemeral; a
  // fixed N → lock N (stable phone/tunnel URL). `let` so establishConnection()
  // refreshes it on reconnect.
  let portPlan = resolvePortPlan(
    process.env["CLOAKCODE_GATEWAY_PORT"],
    cfg.get<number | null>("port"),
  );
  const root = defaultWorkspaceStorageRoot();
  // The spool is a fixed, per-environment dir shared by the hook and every
  // window's follower (see hook-spool `defaultSpoolDir`) — NOT `globalStorageUri`,
  // which is per-profile and the separate hook process can't read anyway.
  // Overridable via env for the dev-server / isolated rig.
  const spoolDir = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolDir();

  // Opt-out for the per-environment hook file. Machine-scoped (User/Remote
  // settings, not per-workspace) because it controls one global file shared by
  // every window. Off = we never write it; the user manages the hook themselves.
  const installEnabled = cfg.get<boolean>("installHook", true);
  if (installEnabled) {
    await installHook(context, spoolDir, log);
  } else {
    log.info("hook.install_disabled");
  }

  const surfaceDebounceMs = cfg.get<number>("surfaceDebounceMs");

  // Packaged gateway: if the built PWA was bundled into the .vsix, serve it from
  // the bridge so ONE tunnelled port carries the app + `/bridge`. Absent in dev
  // (Vite serves the app), so the bridge stays WebSocket-only.
  const webDir = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "web",
  ).fsPath;
  const serveDir = await fs
    .access(path.join(webDir, "index.html"))
    .then(() => webDir)
    .catch(() => undefined);

  const deps: BridgeDeps = {
    listSessions: () => {
      const { hashes, names } = resolveOwnedHashes(context, root);
      return scanSessions({
        instanceId,
        root,
        ownedWorkspaceHashes: hashes,
        workspaceNames: names,
      });
    },
    findSessionLog: (sessionId) => findSessionLog(root, sessionId),
    findTranscript: (sessionId) => findTranscript(root, sessionId),
    spoolDir,
    logger: log,
    ...(surfaceDebounceMs !== undefined ? { surfaceDebounceMs } : {}),
    respond: async ({ sessionId, text, traceId }) => {
      // M3b targeted-send PROBE. Instead of only the active chat, focus the
      // SPECIFIC local session by its resource URI, then submit. Verified in
      // source: our observed `sessionId` names the transcript AND is exactly
      // what Copilot base64url-encodes into `vscode-chat-session://local/<id>`
      // (toolCalling.tsx), and that scheme is a registered editor
      // (chat.shared.contribution.ts) — so opening it should load THAT session
      // and `chat.open` should target it. See docs/02.
      const uri = vscode.Uri.parse(localChatSessionUri(sessionId));
      actuatorLog.info("actuator.respond", { sessionId, traceId });
      await vscode.commands.executeCommand("vscode.open", uri);
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: text,
      });
    },
    steer: async ({ sessionId, text, traceId }) => {
      // Redirect the IN-FLIGHT turn (docs/02 §4.28 / research §7): focus the
      // session, PREFILL the composer without sending (`isPartialQuery`), then
      // fire `steerWithMessage` — VS Code folds the text into the running turn
      // at the next tool-call boundary. Window-local/focus-dependent, like
      // respond; a remote-operator action, never genuine-local intent.
      const uri = vscode.Uri.parse(localChatSessionUri(sessionId));
      actuatorLog.info("actuator.steer", { sessionId, traceId });
      await vscode.commands.executeCommand("vscode.open", uri);
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: text,
        isPartialQuery: true,
      });
      await vscode.commands.executeCommand(
        "workbench.action.chat.steerWithMessage",
      );
    },
    stop: async ({ sessionId, text, traceId }) => {
      // Cancel the in-flight turn (`chat.cancel` is no-arg, acts on the focused
      // session; research §7). With a follow-up `text`, send it as a fresh
      // prompt afterwards (stop-and-send). A remote-operator action.
      const uri = vscode.Uri.parse(localChatSessionUri(sessionId));
      actuatorLog.info("actuator.stop", {
        sessionId,
        send: Boolean(text),
        traceId,
      });
      await vscode.commands.executeCommand("vscode.open", uri);
      await vscode.commands.executeCommand("workbench.action.chat.cancel");
      // Force-stop abandons the in-flight turn's pending tool call(s): we're
      // ignoring that blocker (dismissing the popover), so GC its spool file NOW
      // on the same signal instead of waiting for `isSuperseded` to catch it on
      // the next turn (fixes the force-stop spool leak; docs/02 §4.19).
      await removeSpoolForSession(spoolDir, sessionId);
      if (text) {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: text,
        });
      }
    },
    decide: async ({ sessionId, toolCallId, decision, traceId }) => {
      // Resolve VS Code's OWN native tool confirmation via command, targeted
      // by the session URI (EXACT-match, so a wrong id is a safe no-op; docs/
      // 02 4.16). No per-tool id: acceptTool/skipTool act on that session's
      // first waiting confirmation; `toolCallId` is logged for traceability.
      if (!sessionId) {
        actuatorLog.warn("actuator.decide_no_session");
        return;
      }
      const uri = vscode.Uri.parse(localChatSessionUri(sessionId));
      const cmd =
        decision === "allow"
          ? "workbench.action.chat.acceptTool"
          : "workbench.action.chat.skipTool";
      actuatorLog.info("actuator.decide", {
        sessionId,
        decision,
        toolCallId,
        traceId,
      });
      await vscode.commands.executeCommand(cmd, { sessionResource: uri });
    },
    answer: async ({ sessionId, toolCallId, answers, traceId }) => {
      // Deliver the operator's STRUCTURED answer to the pending question
      // carousel (docs/02 §4.16). `toolCallId` is the carousel `resolveId`,
      // but VS Code keys it on the BASE id (`chatStreamToolCallId` =
      // `id.split('__vscode')[0]`, inlineChatIntent.ts) while the hook hands
      // us the RAW suffixed id — so try BOTH forms; the non-matching fire
      // no-ops. This resolves `vscode_askQuestions` with `{answers}` instead
      // of cancelling it (what a chat-text answer does).
      const base = baseToolCallId(toolCallId);
      const ids = base === toolCallId ? [toolCallId] : [toolCallId, base];
      actuatorLog.info("actuator.answer", {
        sessionId,
        questions: answers.length,
        traceId,
      });
      for (const rid of ids) {
        await vscode.commands.executeCommand(
          "_chat.notifyQuestionCarouselAnswer",
          rid,
          buildCarouselAnswers(rid, answers),
        );
      }
    },
  };

  // Always-visible one-click entry to the phone link (QR) — the low-friction way
  // in, instead of hunting the command palette. Its tooltip reflects the live
  // connection; establishConnection() refreshes it on every (re)connect.
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.name = "CloakCode";
  status.text = "$(broadcast) CloakCode";
  status.command = "cloakcode.showPhoneLink";
  status.show();
  context.subscriptions.push(status);

  // (Re)establish the connection from the CURRENT settings: an explicit
  // `cloakcode.gatewayUrl` connects OUT to that standalone gateway; otherwise run
  // the embedded bridge. Re-run by the reconnect command / a relevant settings
  // change.
  const establishConnection = async (): Promise<string> => {
    const cfgNow = vscode.workspace.getConfiguration("cloakcode");
    portPlan = resolvePortPlan(
      process.env["CLOAKCODE_GATEWAY_PORT"],
      cfgNow.get<number | null>("port"),
    );
    // Pure decision (tested in connection-plan.test.ts): explicit url → gateway;
    // else embedded.
    const plan = resolveConnectionPlan({
      gatewayUrl: cfgNow.get<string>("gatewayUrl"),
      envGatewayUrl: process.env["CLOAKCODE_GATEWAY_URL"],
    });
    // Provider↔gateway shared secret (machine-to-machine): setting wins, else
    // env; unset → no auth (loopback dev). Presented in the provider hello —
    // never operator-facing (docs/04).
    const gatewayToken =
      (cfgNow.get<string>("gatewayToken") ?? "").trim() ||
      process.env["CLOAKCODE_GATEWAY_TOKEN"] ||
      undefined;
    const gatewayUrl = plan.kind === "gateway" ? plan.url : undefined;
    if (gatewayUrl) {
      // Client mode (docs/03 "Explicit gateway"): connect OUT as a provider; the
      // gateway serves the PWA + owns the phone link. Unreachable → embedded.
      try {
        gatewayClient = await connectGateway(
          gatewayUrl,
          { instanceId },
          deps,
          (m) => log.debug("gateway.client", { msg: m }),
          undefined,
          gatewayToken,
        );
      } catch (err) {
        log.warn("gateway.unreachable", {
          error: err instanceof Error ? err.message : String(err),
        });
        bridge = await startEmbeddedBridge(
          deps,
          portPlan,
          serveDir,
          instanceId,
          log,
        );
      }
    } else {
      bridge = await startEmbeddedBridge(
        deps,
        portPlan,
        serveDir,
        instanceId,
        log,
      );
    }
    status.tooltip = gatewayClient
      ? `CloakCode: gateway mode (${gatewayClient.url}) — click for the phone link`
      : bridge
        ? `CloakCode bridge on 127.0.0.1:${bridge.port} — click for the phone link`
        : "CloakCode: bridge failed to start";
    return gatewayClient
      ? `gateway ${gatewayClient.url}`
      : bridge
        ? `embedded bridge on 127.0.0.1:${bridge.port}`
        : "no bridge or gateway (failed to start)";
  };

  // Tear down the live connection and re-establish from the latest settings.
  // Serialized so overlapping triggers (a multi-key settings edit) can't race.
  let reconnecting = false;
  const reconnect = async (reason: string): Promise<void> => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      log.info("reconnect", { reason });
      gatewayClient?.close();
      gatewayClient = undefined;
      await bridge?.close();
      bridge = undefined;
      tunnel?.stop();
      tunnel = undefined;
      const summary = await establishConnection();
      log.info("reconnected", { summary });
    } finally {
      reconnecting = false;
    }
  };

  // A change to any of these connection settings hot-applies via reconnect (no
  // reload). The `cloakcode.tunnel` mode still needs a reload; the instanceId is
  // changed via the `CloakCode: Set Instance ID` command (which reconnects).
  const reconnectKeys = ["cloakcode.gatewayUrl", "cloakcode.port"];
  context.subscriptions.push(
    vscode.commands.registerCommand("cloakcode.reconnect", () =>
      reconnect("command"),
    ),
    vscode.commands.registerCommand("cloakcode.setInstanceId", async () => {
      const input = await vscode.window.showInputBox({
        title: "CloakCode: Instance ID",
        prompt:
          "Display label for this environment + workspace (empty = auto). " +
          "Never used for routing or identity.",
        value: instanceId,
        ignoreFocusOut: true,
      });
      if (input === undefined) return; // cancelled
      // Empty => clear the override (revert to the auto label).
      await context.workspaceState.update(
        INSTANCE_ID_KEY,
        input.trim() || undefined,
      );
      instanceId = await resolveInstanceId();
      log.info("instanceId.set", { instanceId });
      await reconnect("instanceId changed");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cloakcode.logLevel")) {
        logLevel =
          parseLogLevel(
            vscode.workspace
              .getConfiguration("cloakcode")
              .get<string>("logLevel"),
          ) ?? "info";
        log.info("logLevel.changed", { level: logLevel });
      }
      if (reconnectKeys.some((k) => e.affectsConfiguration(k))) {
        void reconnect("settings changed");
      }
    }),
  );

  // Initial connection — non-blocking so activation doesn't hang on a slow hub.
  void establishConnection();

  const gatherDiagnostics = async (): Promise<DiagnosticsSnapshot> => {
    const { hashes, source } = resolveOwnedHashes(context, root);
    const scanned: ScannedHash[] = [];
    let hashDirs: string[] = [];
    try {
      hashDirs = await fs.readdir(root);
    } catch {
      // no workspaceStorage root yet
    }
    for (const hash of [...hashDirs].sort()) {
      let transcripts = 0;
      try {
        const files = await fs.readdir(
          path.join(root, hash, "GitHub.copilot-chat", "transcripts"),
        );
        transcripts = files.filter((f) => f.endsWith(".jsonl")).length;
      } catch {
        // no transcripts under this hash
      }
      if (transcripts > 0 || hashes.has(hash)) {
        scanned.push({ hash, transcripts, owned: hashes.has(hash) });
      }
    }
    const modeName =
      context.extensionMode === vscode.ExtensionMode.Development
        ? "Development"
        : context.extensionMode === vscode.ExtensionMode.Test
          ? "Test"
          : "Production";
    return {
      instanceId,
      pid: process.pid,
      extensionMode: modeName,
      extensionVersion:
        (context.extension.packageJSON as { version?: string }).version ??
        "unknown",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "Web" : "Desktop",
      remoteName: vscode.env.remoteName ?? null,
      uriScheme: vscode.env.uriScheme,
      language: vscode.env.language,
      machineId: vscode.env.machineId,
      extensionUri: context.extensionUri.toString(),
      storageUri: context.storageUri?.fsPath ?? null,
      globalStorageUri: context.globalStorageUri.fsPath,
      logUri: context.logUri.fsPath,
      workspaceFile: vscode.workspace.workspaceFile?.toString() ?? null,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        name: f.name,
        uri: f.uri.toString(),
      })),
      ownedHashes: [...hashes],
      ownedSource: source,
      root,
      scanned,
      bridgePort: bridge?.port ?? null,
      configuredPort: portPlan.port,
      spoolDir,
      hookConfigPath: path.join(
        os.homedir(),
        ".copilot",
        "hooks",
        "cloakcode.json",
      ),
      cloakcodeEnv: Object.entries(process.env)
        .filter(([k]) => k.startsWith("CLOAKCODE_"))
        .map(([key, value]) => ({ key, value: value ?? "" }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  };

  // Log a diagnostics snapshot on activation and expose it as a command — the
  // fastest way to see why a session is (not) owned (e.g. a missing storageUri).
  // With CLOAKCODE_DIAG_FILE set (the dev launch), also dump it to that file so
  // the snapshot can be inspected without opening the output channel.
  const diag = await gatherDiagnostics();
  out.appendLine(formatDiagnostics(diag));
  const diagFile = process.env["CLOAKCODE_DIAG_FILE"];
  if (diagFile) {
    try {
      await fs.mkdir(path.dirname(diagFile), { recursive: true });
      await fs.writeFile(diagFile, formatDiagnostics(diag) + "\n");
    } catch {
      // best effort — a diagnostics dump must never break activation
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("cloakcode.showDiagnostics", async () => {
      out.appendLine("");
      out.appendLine(formatDiagnostics(await gatherDiagnostics()));
      out.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cloakcode.reinstallHook", async () => {
      await installHook(context, spoolDir, log);
      void vscode.window.showInformationMessage(
        "CloakCode: Copilot hook installed / repaired.",
      );
    }),
    vscode.commands.registerCommand("cloakcode.removeHook", async () => {
      // Env-wide + shared by every window — confirm before removing, and only
      // ever from this explicit command (never on deactivation).
      const pick = await vscode.window.showWarningMessage(
        "Remove the CloakCode Copilot hook for this whole environment (every " +
          "workspace and window)? Copilot keeps working; CloakCode stops " +
          "observing tool calls until you reinstall it.",
        { modal: true },
        "Remove hook",
      );
      if (pick !== "Remove hook") return;
      await uninstallHook(log);
      void vscode.window.showInformationMessage(
        "CloakCode: Copilot hook removed.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cloakcode.showPhoneLink", async () => {
      // Gateway (client) mode: the hub owns the phone link — show the URL it
      // pushed down, not a local bridge (which this window doesn't run).
      if (gatewayClient) {
        const url = gatewayClient.phoneUrl();
        if (url) {
          showLinkPanel(url);
        } else {
          void vscode.window.showInformationMessage(
            `CloakCode: connected to the gateway (${gatewayClient.url}), but it ` +
              `hasn't published a phone URL yet. Run the gateway with a tunnel ` +
              `(CLOAKCODE_TUNNEL=devtunnel) and it will flow here automatically.`,
          );
        }
        return;
      }
      if (!bridge) {
        void vscode.window.showWarningMessage(
          "CloakCode bridge is not running yet.",
        );
        return;
      }
      showLinkPanel(
        await resolvePhoneUrl(bridge.port, devTunnelName(instanceId), (m) =>
          log.debug("tunnel", { msg: m }),
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cloakcode.setupTunnel", async () => {
      // In gateway mode the hub owns the tunnel — nothing to host in this window.
      if (gatewayClient) {
        void vscode.window.showInformationMessage(
          `CloakCode is in gateway mode (${gatewayClient.url}); the gateway owns ` +
            `the phone tunnel. Start it with CLOAKCODE_TUNNEL=devtunnel and its ` +
            `phone URL appears here automatically.`,
        );
        return;
      }
      if (!bridge) {
        void vscode.window.showWarningMessage(
          "CloakCode bridge is not running yet.",
        );
        return;
      }
      // Explicitly (re)establish the private Dev Tunnel, guiding through install
      // / sign-in when needed; show the link on success. Reveal the log so the
      // devtunnel progress/errors are visible while it runs.
      out.show(true);
      log.info("tunnel.setup", { port: bridge.port });
      const url = await startOrRecoverTunnel(
        bridge.port,
        devTunnelName(instanceId),
        (m) => log.debug("tunnel", { msg: m }),
      );
      if (url) showLinkPanel(url);
    }),
  );

  void recommendDebugLog(context);
  void promptTunnelOnce(context);

  // Tunnel already opted-in on a prior run: re-host it on activation so the phone
  // URL is live again after a reload without re-opening the link. Best-effort:
  // transient failures only log, but an actionable setup error (not signed in /
  // CLI missing) still prompts the fix so an opted-in tunnel never fails invisibly.
  if (bridge && cfg.get<string>("tunnel") === "devtunnel") {
    const b = bridge;
    void startOrRecoverTunnel(
      b.port,
      devTunnelName(instanceId),
      (m) => log.debug("tunnel", { msg: m }),
      true,
    );
  }

  context.subscriptions.push({
    dispose: () => {
      void bridge?.close();
      bridge = undefined;
      gatewayClient?.close();
      gatewayClient = undefined;
      tunnel?.stop();
      tunnel = undefined;
    },
  });
}

export function deactivate(): void {
  void bridge?.close();
  bridge = undefined;
  gatewayClient?.close();
  gatewayClient = undefined;
  tunnel?.stop();
  tunnel = undefined;
}

/**
 * Start the embedded bridge (serves the PWA + `/bridge`) with logging. Returns
 * the running bridge, or `undefined` when it failed to bind.
 */
async function startEmbeddedBridge(
  deps: BridgeDeps,
  portPlan: PortPlan,
  serveDir: string | undefined,
  instanceId: string,
  log: Logger,
): Promise<Bridge | undefined> {
  try {
    const b = await startBridge(deps, {
      host: "127.0.0.1",
      port: portPlan.port,
      fallbackToEphemeral: portPlan.fallbackToEphemeral,
      ...(serveDir ? { serveDir } : {}),
    });
    log.info("bridge.listen", {
      port: b.port,
      pwa: Boolean(serveDir),
      instanceId,
    });
    return b;
  } catch (err) {
    log.error("bridge.listen_failed", {
      port: portPlan.port,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Resolve the phone URL: an explicit public URL → an already-running managed
 * tunnel → auto-host one when `cloakcode.tunnel: devtunnel` → `asExternalUri`
 * (desktop-loopback in local containers). Re-resolved per call.
 */
async function resolvePhoneUrl(
  port: number,
  name: string,
  log: TunnelLog = () => {},
): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("cloakcode");
  // Advanced bring-your-own-tunnel escape hatch (no UI setting): CLOAKCODE_PUBLIC_URL
  // forces the phone URL for a tunnel you run yourself.
  const configured = process.env["CLOAKCODE_PUBLIC_URL"]?.trim();
  if (configured) return configured;
  if (tunnel) return tunnel.url;
  if (cfg.get<string>("tunnel") === "devtunnel") {
    const url = await startOrRecoverTunnel(port, name, log);
    if (url) return url;
  }
  return (
    await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}`))
  ).toString();
}

/**
 * Start (and cache) the managed Dev Tunnel, or guide the user through the fix
 * (install / sign-in) when it fails. Returns the URL, or `undefined` when a
 * remedy was offered (the user retries via “Set Up Phone Tunnel”).
 */
async function startOrRecoverTunnel(
  port: number,
  name: string,
  log: TunnelLog = () => {},
  silent = false,
): Promise<string | undefined> {
  try {
    tunnel ??= await startDevTunnel(port, name, log);
    return tunnel.url;
  } catch (err) {
    log(`tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
    // Even on a silent activation, guide the ACTIONABLE setup errors (sign-in,
    // install) so an opted-in tunnel that isn't logged in prompts the login
    // instead of failing invisibly; stay quiet on transient/unknown errors.
    const kind = err instanceof TunnelError ? err.kind : "unknown";
    const action = tunnelFixAction(kind, silent);
    if (action === "ignore") return undefined;
    if (action === "show-error") {
      void vscode.window.showErrorMessage(
        `CloakCode tunnel: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    if (err instanceof TunnelError) await guideTunnelFix(err);
    return undefined;
  }
}

/** Confirmation-based remedy for a tunnel failure: install the CLI or sign in. */
async function guideTunnelFix(err: TunnelError): Promise<void> {
  if (err.kind === "missing") {
    const pick = await vscode.window.showWarningMessage(
      "CloakCode: the devtunnel CLI isn't installed.",
      {
        modal: true,
        detail: `Install it, then set up the tunnel again.\n\n${devTunnelInstallHint()}`,
      },
      "Install in terminal",
      "Open docs",
    );
    if (pick === "Install in terminal") {
      runSetupTerminal("CloakCode: install devtunnel", devTunnelInstallHint());
    } else if (pick === "Open docs") {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://aka.ms/DevTunnelCliInstall"),
      );
    }
    return;
  }
  if (err.kind === "auth") {
    const flows: (vscode.QuickPickItem & { args: string[] })[] = [
      {
        label: "$(github) GitHub — device code",
        description: "recommended in containers / remote",
        args: ["-g", "-d"],
      },
      { label: "$(github) GitHub — browser", args: ["-g"] },
      { label: "$(account) Microsoft — device code", args: ["-d"] },
      { label: "$(account) Microsoft — browser", args: [] },
    ];
    const pick = await vscode.window.showQuickPick(flows, {
      title: "Sign in to Dev Tunnels",
      placeHolder: "Choose an account and login method",
    });
    if (pick) {
      runSetupTerminal(
        "CloakCode: devtunnel login",
        `devtunnel user login ${pick.args.join(" ")}`.trim(),
      );
    }
    return;
  }
  void vscode.window.showErrorMessage(`CloakCode tunnel: ${err.message}`);
}

/** Run a setup command in a visible terminal + offer a one-click retry. */
function runSetupTerminal(name: string, command: string): void {
  const term = vscode.window.createTerminal(name);
  term.show();
  term.sendText(command);
  void vscode.window
    .showInformationMessage(
      "CloakCode: finish in the terminal, then run “Set Up Phone Tunnel”.",
      "Set Up Phone Tunnel",
    )
    .then((p) => {
      if (p === "Set Up Phone Tunnel") {
        void vscode.commands.executeCommand("cloakcode.setupTunnel");
      }
    });
}

/** Show the phone-link webview (QR) + a Copy notification; warn on loopback. */
function showLinkPanel(url: string): void {
  if (isLoopback(url)) {
    void vscode.window.showWarningMessage(
      `CloakCode phone link is loopback (${url}) — a phone can't reach it. ` +
        `Set "cloakcode.tunnel": "devtunnel" (run “Set Up Phone Tunnel”) or ` +
        `set the CLOAKCODE_PUBLIC_URL env var to your own tunnel URL.`,
    );
  }
  const panel = vscode.window.createWebviewPanel(
    "cloakcodePhoneLink",
    "CloakCode — Phone Link",
    vscode.ViewColumn.Active,
    { enableScripts: false },
  );
  panel.webview.html = phoneLinkHtml(url);
  void vscode.window
    .showInformationMessage(`CloakCode phone link: ${url}`, "Copy")
    .then((pick) => {
      if (pick === "Copy") void vscode.env.clipboard.writeText(url);
    });
}

/** Default instanceId: `<env-kind>:<workspace-or-devcontainer-name>`. */
async function defaultInstanceId(): Promise<string> {
  const kind = classifyRemote(vscode.env.remoteName);
  const folder = vscode.workspace.workspaceFolders?.[0];
  let loc = folder?.name ?? "no-folder";
  if (kind === "devcontainer" && folder) {
    const name = await readDevcontainerName(folder.uri.fsPath);
    if (name) loc = name;
  }
  return `${kind}:${loc}`;
}

/** Best-effort friendly dev-container name from its `devcontainer.json`. */
async function readDevcontainerName(
  folderPath: string,
): Promise<string | undefined> {
  for (const rel of [".devcontainer/devcontainer.json", ".devcontainer.json"]) {
    try {
      const buf = await fs.readFile(path.join(folderPath, rel), "utf8");
      const name = parseDevcontainerName(buf);
      if (name) return name;
    } catch {
      // absent / unreadable — try the next location
    }
  }
  return undefined;
}

const DEBUG_LOG_SETTING =
  "github.copilot.chat.agentDebugLog.fileLogging.enabled";

/**
 * Recommend Copilot's agent debug log — the observer's preferred source: more
 * complete for editor-hosted sessions and closer to live than the transcript
 * (docs/02 §3.6). Non-blocking, suppressible; offers a one-click enable.
 */
async function recommendDebugLog(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>("skipDebugLogHint")) return;
  const conf = vscode.workspace.getConfiguration();
  if (conf.get<boolean>(DEBUG_LOG_SETTING)) return;
  const pick = await vscode.window.showInformationMessage(
    "CloakCode mirrors best with Copilot's agent debug log enabled (a more complete, live source). Enable it?",
    "Enable",
    "Not now",
    "Don't show again",
  );
  if (pick === "Enable") {
    await conf.update(
      DEBUG_LOG_SETTING,
      true,
      vscode.ConfigurationTarget.Global,
    );
    const reload = await vscode.window.showInformationMessage(
      "Copilot agent debug log enabled — reload the window to apply.",
      "Reload Window",
    );
    if (reload === "Reload Window") {
      void vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else if (pick === "Don't show again") {
    await context.globalState.update("skipDebugLogHint", true);
  }
}

/**
 * On first activation, offer remote (phone) access via a private Dev Tunnel, or
 * keep it local. Asked once (globalState); enabling flips `cloakcode.tunnel` and
 * kicks off the guided setup.
 */
async function promptTunnelOnce(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>("promptedTunnel")) return;
  await context.globalState.update("promptedTunnel", true);
  const cfg = vscode.workspace.getConfiguration("cloakcode");
  if (cfg.get<string>("tunnel") === "devtunnel") return;
  const pick = await vscode.window.showInformationMessage(
    "CloakCode: reach your Copilot sessions from a phone? Enable a private Dev Tunnel, or keep it local for now.",
    "Enable Dev Tunnel",
    "Keep local",
  );
  if (pick === "Enable Dev Tunnel") {
    await cfg.update("tunnel", "devtunnel", vscode.ConfigurationTarget.Global);
    void vscode.commands.executeCommand("cloakcode.setupTunnel");
  }
}
