import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount React trees between component tests.
afterEach(cleanup);

// jsdom doesn't implement ResizeObserver, which the transcript auto-scroll uses.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;
