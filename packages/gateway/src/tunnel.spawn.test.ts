import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock child_process so we can drive `devtunnel` without a real binary. Hoisted
// so the mocks exist before the module under test is imported.
const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
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
  vi.useRealTimers();
});

describe("startDevTunnel", () => {
  it("resolves with the URL printed on stdout and can stop the child", async () => {
    execOk();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const p = startDevTunnel(7801, "cloakcode-x");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(`Connect: ${URL}\n`));

    const tunnel = await p;
    expect(tunnel.url).toBe(URL);
    // ensureTunnel ran create + port create before hosting.
    expect(execFileMock).toHaveBeenCalledTimes(2);
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
