import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const URL_RE = /https:\/\/[^\s,"']+\.devtunnels\.ms[^\s,"']*/i;
const URL_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 30_000;

/** The first `*.devtunnels.ms` URL in `output`, or `undefined`. Pure. */
export function parseTunnelUrl(output: string): string | undefined {
  return output.match(URL_RE)?.[0];
}

/**
 * Deterministic Dev Tunnel name for an environment `seed` (e.g. the instanceId):
 * a **stable** public URL across extension reloads, and distinct per environment
 * so container / WSL / host don't collide on one Microsoft account.
 */
export function devTunnelName(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `cloakcode-${h}`;
}

/** Platform-specific `devtunnel` install hint. Pure. */
export function devTunnelInstallHint(
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case "darwin":
      return "brew install --cask devtunnel";
    case "linux":
      return "curl -sL https://aka.ms/DevTunnelCliInstall | bash";
    case "win32":
      return "winget install Microsoft.devtunnel";
    default:
      return "see https://aka.ms/DevTunnelCliInstall";
  }
}

export interface Tunnel {
  readonly url: string;
  stop(): void;
}

/**
 * Host `port` on a persistent, **private** Microsoft Dev Tunnel named `name`,
 * resolving once the public URL appears in the CLI output. Private by design —
 * never `--allow-anonymous`: the tunnel's own sign-in is the compensating control
 * while app-level auth is deferred (docs/05 Q9). The named tunnel is created
 * idempotently so the URL is stable across reloads. Rejects with a friendly,
 * actionable error when the CLI is missing or not signed in.
 */
export async function startDevTunnel(
  port: number,
  name: string,
): Promise<Tunnel> {
  await ensureTunnel(name, port);
  const child = spawn("devtunnel", ["host", name, "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await firstTunnelUrl(child);
  return { url, stop: () => stop(child) };
}

/** Create the named tunnel + forwarded port, tolerating "already exists". */
async function ensureTunnel(name: string, port: number): Promise<void> {
  await cli(["create", name]).catch(ignoreExists);
  await cli(["port", "create", name, "-p", String(port)]).catch(ignoreExists);
}

async function cli(args: string[]): Promise<void> {
  await execFileAsync("devtunnel", args, { timeout: CLI_TIMEOUT_MS });
}

/** Swallow "already exists" (idempotent re-run); rethrow real failures. */
function ignoreExists(err: unknown): void {
  const msg = errText(err);
  if (/already exists|already has/i.test(msg)) return;
  throw toFriendly(err);
}

function firstTunnelUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let errBuf = "";
    let done = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
    };
    const ok = (url: string): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(url);
    };
    const fail = (e: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      stop(child);
      reject(e);
    };

    child.stdout?.on("data", (c: Buffer) => {
      out = (out + c.toString("utf8")).slice(-8192);
      const url = parseTunnelUrl(out);
      if (url) ok(url);
    });
    child.stderr?.on("data", (c: Buffer) => {
      errBuf = (errBuf + c.toString("utf8")).slice(-8192);
      const url = parseTunnelUrl(errBuf);
      if (url) ok(url);
    });
    child.once("error", (e) => fail(toFriendly(e)));
    child.once("exit", (code) => {
      if (done) return;
      done = true;
      cleanup();
      const hint = /unauthorized|not permitted|sign ?in|login|does not have/i.test(
        errBuf,
      )
        ? " — run: devtunnel user login"
        : "";
      reject(
        new Error(
          `devtunnel exited (code ${code ?? "?"}) before a URL${hint}. ${errBuf.trim()}`.trim(),
        ),
      );
    });
    const timer = setTimeout(
      () => fail(new Error("Timed out waiting for the devtunnel URL (30s).")),
      URL_TIMEOUT_MS,
    );
  });
}

function stop(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  try {
    if (!child.kill("SIGINT")) child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string } | undefined;
  return String(e?.stderr ?? e?.message ?? err ?? "");
}

function toFriendly(err: unknown): Error {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new Error(
      `devtunnel CLI not found. Install: ${devTunnelInstallHint()}`,
    );
  }
  const msg = errText(err);
  if (/unauthorized|not permitted|sign ?in|login|does not have/i.test(msg)) {
    return new Error("devtunnel not signed in. Run: devtunnel user login");
  }
  return err instanceof Error ? err : new Error(msg);
}
