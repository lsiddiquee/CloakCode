import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock child_process so we can drive `devtunnel` without a real binary. Hoisted
// so the mocks exist before the module under test is imported.
const { spawnMock, execFileMock, accessSyncMock, statSyncMock } = vi.hoisted(
  () => ({
    spawnMock: vi.fn(),
    execFileMock: vi.fn(),
    accessSyncMock: vi.fn(),
    statSyncMock: vi.fn(() => ({ isFile: () => true })),
  }),
);
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));
vi.mock("node:fs", () => ({
  accessSync: accessSyncMock,
  statSync: statSyncMock,
  constants: { X_OK: 1 },
}));

import { startDevTunnel, TunnelError } from "./tunnel.js";

/** A minimal ChildProcess stand-in with drivable stdout/stderr and lifecycle. */
class MockChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  readonly kill = vi.fn((_sig?: string) => {
    this.killed = true;
    return true;
  });
}

/** Default: every `execFile` (create/port) succeeds. */
function execOk(): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (...a: unknown[]) => void,
    ) => cb(null, { stdout: "", stderr: "" }),
  );
}

const URL = "https://cloakcode-ab12cd34-7801.euw.devtunnels.ms";

afterEach(() => {
  vi.clearAllMocks();
  statSyncMock.mockImplementation(() => ({ isFile: () => true }));
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("startDevTunnel", () => {
  it("logs the executable found on the process PATH without logging the PATH", async () => {
    vi.stubEnv("PATH", "/unavailable:/opt/tunnel/bin");
    accessSyncMock.mockImplementation((path: string) => {
      if (path !== "/opt/tunnel/bin/devtunnel") {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
    });
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const log = vi.fn();

    const p = startDevTunnel(7801, "n", log);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(URL));
    await p;

    expect(log).toHaveBeenCalledWith(
      "devtunnel CLI on process PATH: /opt/tunnel/bin/devtunnel",
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain("/unavailable");
  });

  it("logs when the CLI is not on the process PATH and preserves the missing error", async () => {
    vi.stubEnv("PATH", "/unavailable");
    accessSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    execFileMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
        cb(
          Object.assign(new Error("spawn devtunnel ENOENT"), {
            code: "ENOENT",
          }),
        ),
    );
    const log = vi.fn();

    await expect(startDevTunnel(7801, "n", log)).rejects.toMatchObject({
      kind: "missing",
    });
    expect(log).toHaveBeenCalledWith("devtunnel CLI not found on process PATH");
  });

  it("does not report a directory named devtunnel as a CLI executable", async () => {
    vi.stubEnv("PATH", "/opt/tunnel/bin");
    statSyncMock.mockImplementation(() => ({ isFile: () => false }));
    execFileMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
        cb(
          Object.assign(new Error("spawn devtunnel EACCES"), {
            code: "EACCES",
          }),
        ),
    );
    const log = vi.fn();

    await expect(startDevTunnel(7801, "n", log)).rejects.toMatchObject({
      kind: "other",
    });
    expect(log).toHaveBeenCalledWith("devtunnel CLI not found on process PATH");
  });

  it("resolves with the URL printed on stdout and can stop the child", async () => {
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "cloakcode-x");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(`Connect: ${URL}\n`));

    const tunnel = await p;
    expect(tunnel.url).toBe(URL);
    // ensureTunnel ran create + port list (stale-port cleanup) + port create.
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(spawnMock).toHaveBeenCalledWith(
      "devtunnel",
      ["host", "cloakcode-x"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    tunnel.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("also resolves when the URL appears on stderr", async () => {
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "n");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.emit("data", Buffer.from(`browser: ${URL}`));

    expect((await p).url).toBe(URL);
  });

  it("tolerates an 'already exists' conflict from ensureTunnel", async () => {
    // create fails with a conflict (idempotent), port create succeeds.
    execFileMock
      .mockImplementationOnce(
        (
          _c: string,
          _a: string[],
          _o: unknown,
          cb: (...a: unknown[]) => void,
        ) => cb(Object.assign(new Error("x"), { stderr: "already exists" })),
      )
      .mockImplementation(
        (
          _c: string,
          _a: string[],
          _o: unknown,
          cb: (...a: unknown[]) => void,
        ) => cb(null, {}),
      );
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "n");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(URL));
    expect((await p).url).toBe(URL);
  });

  it("deletes a STALE forwarded port before hosting, keeping the current one", async () => {
    const deleted: string[][] = [];
    execFileMock.mockImplementation(
      (
        _c: string,
        args: string[],
        _o: unknown,
        cb: (...a: unknown[]) => void,
      ) => {
        if (args[0] === "port" && args[1] === "list") {
          // A previous run left 7905; the current port is 7801 (--json output).
          cb(null, {
            stdout: JSON.stringify({
              ports: [{ portNumber: 7905 }, { portNumber: 7801 }],
            }),
            stderr: "",
          });
          return;
        }
        if (args[0] === "port" && args[1] === "delete") deleted.push(args);
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "n");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(URL));
    await p;

    // Only the stale 7905 is deleted; the current 7801 is preserved.
    expect(deleted).toEqual([["port", "delete", "n", "-p", "7905"]]);
  });

  it("rejects with a 'missing' TunnelError when the CLI is absent (ENOENT)", async () => {
    execFileMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
        cb(
          Object.assign(new Error("spawn devtunnel ENOENT"), {
            code: "ENOENT",
          }),
        ),
    );

    await expect(startDevTunnel(7801, "n")).rejects.toMatchObject({
      name: "TunnelError",
      kind: "missing",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects if the host process exits before a URL", async () => {
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "n");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.emit("data", Buffer.from("could not host"));
    child.emit("exit", 1);

    await expect(p).rejects.toBeInstanceOf(TunnelError);
  });

  it("rejects when the host process emits an error", async () => {
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "n");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));

    await expect(p).rejects.toMatchObject({ kind: "missing" });
  });

  it("times out if no URL ever appears", async () => {
    vi.useFakeTimers();
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "n");
    const assertion = expect(p).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
  });
});
