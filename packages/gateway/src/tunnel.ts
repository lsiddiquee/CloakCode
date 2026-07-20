import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const URL_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 30_000;

/**
 * The `*.devtunnels.ms` URL in `output`. When `port` is given, prefer the URL
 * whose subdomain carries that port (`<name>-<port>.<region>.devtunnels.ms`) so
 * we pick OUR forwarded port when the tunnel exposes several; otherwise the
 * first URL. Pure.
 */
export function parseTunnelUrl(
  output: string,
  port?: number,
): string | undefined {
  // Tokenize on whitespace / commas / quotes so each candidate is bounded — we
  // never run an unbounded regex over the (uncontrolled) CLI output, so there is
  // no polynomial backtracking (ReDoS-safe).
  const urls = output
    .split(/[\s,"']+/)
    .filter((t) => t.startsWith("https://") && t.includes(".devtunnels.ms"));
  if (urls.length === 0) return undefined;
  if (port !== undefined) {
    // Prefer the URL whose first subdomain label carries OUR forwarded port
    // (`<name>-<port>.<region>.devtunnels.ms`) when several are exposed.
    const scoped = urls.find((u) =>
      (u.slice("https://".length).split(/[/.]/, 1)[0] ?? "").endsWith(
        `-${port}`,
      ),
    );
    if (scoped) return scoped;
  }
  return urls[0];
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

/** Sink for human-readable tunnel progress lines (wired to the Output channel). */
export type TunnelLog = (line: string) => void;

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
  log: TunnelLog = () => {},
): Promise<Tunnel> {
  await ensureTunnel(name, port, log);
  // Host WITHOUT `-p`: the port is added individually by `ensureTunnel`, so
  // hosting serves the tunnel's configured ports. Passing `-p` here makes the
  // CLI submit a BATCH port update, which the service rejects ("Batch update of
  // ports is not supported") whenever the named tunnel already has ports — i.e.
  // on every reload of our persistent tunnel.
  log(`$ devtunnel host ${name}`);
  const child = spawn("devtunnel", ["host", name], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await firstTunnelUrl(child, port, log);
  return { url, stop: () => stop(child) };
}

/** Create the named tunnel + forwarded port, tolerating "already exists". */
async function ensureTunnel(
  name: string,
  port: number,
  log: TunnelLog,
): Promise<void> {
  log(`$ devtunnel create ${name}`);
  await cli(["create", name]).catch(ignoreExists);
  log(`$ devtunnel port create ${name} -p ${port}`);
  await cli(["port", "create", name, "-p", String(port)]).catch(ignoreExists);
}

async function cli(args: string[]): Promise<void> {
  await execFileAsync("devtunnel", args, { timeout: CLI_TIMEOUT_MS });
}

/**
 * True when a devtunnel failure means the entity already exists, so an
 * idempotent re-run can safely continue. The service reports this as either
 * `already exists` / `already has` (older wording) or, on `create` for a name
 * that is already present, `Conflict with existing entity`. Pure.
 */
export function isExistsConflict(message: string): boolean {
  return /already exists|already has|conflict|existing entity/i.test(message);
}

/** Swallow an "already exists" conflict (idempotent re-run); rethrow real failures. */
function ignoreExists(err: unknown): void {
  if (isExistsConflict(errText(err))) return;
  throw tunnelError(err);
}

function firstTunnelUrl(
  child: ChildProcess,
  port: number,
  log: TunnelLog,
): Promise<string> {
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
    const emit = (chunk: string): void => {
      const line = chunk.replace(/\s+$/, "");
      if (line) log(line);
    };
    const ok = (url: string): void => {
      if (done) return;
      done = true;
      cleanup();
      log(`tunnel URL: ${url}`);
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
      const s = c.toString("utf8");
      emit(s);
      out = (out + s).slice(-8192);
      const url = parseTunnelUrl(out, port);
      if (url) ok(url);
    });
    child.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      emit(s);
      errBuf = (errBuf + s).slice(-8192);
      const url = parseTunnelUrl(errBuf, port);
      if (url) ok(url);
    });
    child.once("error", (e) => fail(tunnelError(e)));
    child.once("exit", (code) => {
      if (done) return;
      done = true;
      cleanup();
      const detail =
        `devtunnel exited (code ${code ?? "?"}) before a URL. ${errBuf.trim()}`.trim();
      reject(tunnelError(new Error(detail), errBuf));
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

export type TunnelErrorKind = "missing" | "auth" | "other";

/** A devtunnel failure tagged with a kind so the UI can offer the right fix. */
export class TunnelError extends Error {
  readonly kind: TunnelErrorKind;
  constructor(message: string, kind: TunnelErrorKind) {
    super(message);
    this.name = "TunnelError";
    this.kind = kind;
  }
}

const AUTH_RE =
  /authoriz|not permitted|forbidden|sign ?in|log ?in|not.*authenticated|does not have|no access/i;

/** Classify a devtunnel failure from an error and/or its stderr. Pure. */
export function classifyTunnelError(
  err: unknown,
  stderr = "",
): TunnelErrorKind {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
  if (AUTH_RE.test(`${errText(err)} ${stderr}`)) return "auth";
  return "other";
}

function tunnelError(err: unknown, stderr = ""): TunnelError {
  const kind = classifyTunnelError(err, stderr);
  const message =
    kind === "missing"
      ? `devtunnel CLI not found. Install: ${devTunnelInstallHint()}`
      : kind === "auth"
        ? "devtunnel is not signed in. Run: devtunnel user login"
        : errText(err) || "devtunnel failed.";
  return new TunnelError(message, kind);
}
