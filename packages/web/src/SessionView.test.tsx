import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionSummary } from "@cloakcode/protocol";
import { SessionView } from "./SessionView";

// Controls the connection status the stubbed bridge reports (see the mock).
const h = vi.hoisted(() => ({ status: "open" as string }));

// Stub the bridge so mounting SessionView never opens a real WebSocket and the
// action functions are inert no-ops (we only assert what renders).
vi.mock("./bridge", () => ({
  subscribeSession: (
    _params: unknown,
    _onEvent: unknown,
    _onPending: unknown,
    _onError: unknown,
    onStatus: (s: string) => void = () => {},
  ) => {
    onStatus(h.status);
    return () => {};
  },
  respondSession: async () => {},
  decideSession: async () => {},
  answerSession: async () => {},
}));

beforeEach(() => {
  h.status = "open";
});

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    instanceId: "ext-dev",
    sessionId: "sess-1",
    workspace: "myrepo",
    workspaceHash: "hashA",
    title: "A session",
    turns: 3,
    status: "idle",
    idleSeconds: 5,
    owned: true,
    ...over,
  };
}

describe("SessionView read-only gating", () => {
  it("hides the composer and shows a read-only banner for a foreign session", () => {
    render(
      <SessionView session={session({ owned: false })} onBack={() => {}} />,
    );
    expect(screen.getByText(/Read-only/i)).toBeTruthy();
    // No composer input while read-only.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the composer for an owned session", () => {
    render(
      <SessionView session={session({ owned: true })} onBack={() => {}} />,
    );
    expect(screen.queryByText(/no CloakCode extension is running/i)).toBeNull();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

describe("SessionView connection state", () => {
  it("shows a reconnecting banner when the socket drops", () => {
    h.status = "reconnecting";
    render(<SessionView session={session()} onBack={() => {}} />);
    expect(screen.getByText(/Reconnecting/i)).toBeTruthy();
  });

  it("shows no connection banner when open", () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    expect(screen.queryByText(/Reconnecting|Disconnected/i)).toBeNull();
  });
});
