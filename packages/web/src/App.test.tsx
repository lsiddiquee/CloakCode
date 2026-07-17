import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary } from "@cloakcode/protocol";

// Mock the bridge so App renders without a real socket; hoisted for vi.mock.
const { fetchSessionsMock } = vi.hoisted(() => ({
  fetchSessionsMock: vi.fn(),
}));
vi.mock("./bridge", () => ({
  fetchSessions: fetchSessionsMock,
  bridgeUrl: () => "ws://test/bridge",
}));
// Keep the App test focused on the list — stub the heavy SessionView.
vi.mock("./SessionView", () => ({
  SessionView: ({
    session,
    onBack,
  }: {
    session: SessionSummary;
    onBack: () => void;
  }) => (
    <div>
      <p>viewing {session.sessionId}</p>
      <button onClick={onBack}>back</button>
    </div>
  ),
}));

import { App } from "./App";

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    instanceId: "i1",
    sessionId: "s1",
    workspace: "repo",
    workspaceHash: "H",
    title: "My session",
    turns: 3,
    status: "idle",
    idleSeconds: 0,
    owned: true,
    inTurn: false,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App", () => {
  it("shows the loading hint before the bridge responds", () => {
    fetchSessionsMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<App />);
    expect(screen.getByText("Reaching the bridge…")).toBeTruthy();
  });

  it("renders the session list with counts and a blocked badge", async () => {
    fetchSessionsMock.mockResolvedValue([
      summary({ sessionId: "s1", status: "blocked" }),
      summary({ sessionId: "s2" }),
    ]);
    render(<App />);

    expect(await screen.findByText(/2 sessions · 1 needs input/)).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText("Needs input")).toBeTruthy();
    expect(screen.getByText(/workspace repo/)).toBeTruthy();
  });

  it("shows the empty state when there are no sessions", async () => {
    fetchSessionsMock.mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText(/No Copilot sessions found/)).toBeTruthy();
  });

  it("marks a session with no local extension as read-only", async () => {
    fetchSessionsMock.mockResolvedValue([summary({ owned: false })]);
    render(<App />);
    expect(
      await screen.findByText(/read-only \(no extension here\)/),
    ).toBeTruthy();
    expect(screen.getByText("read-only")).toBeTruthy();
  });

  it("shows the error state and retries on demand", async () => {
    fetchSessionsMock.mockRejectedValueOnce(new Error("boom"));
    render(<App />);

    expect(await screen.findByText(/Can’t reach the bridge/)).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();

    fetchSessionsMock.mockResolvedValueOnce([summary({})]);
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("My session")).toBeTruthy();
  });

  it("opens a session and returns via back", async () => {
    fetchSessionsMock.mockResolvedValue([summary({ sessionId: "abc12345" })]);
    render(<App />);

    fireEvent.click(await screen.findByText("My session"));
    expect(screen.getByText("viewing abc12345")).toBeTruthy();

    fireEvent.click(screen.getByText("back"));
    expect(await screen.findByText("My session")).toBeTruthy();
  });

  it("reloads when the header connection button is clicked", async () => {
    fetchSessionsMock.mockResolvedValue([summary({})]);
    render(<App />);
    await screen.findByText("My session");
    expect(fetchSessionsMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("connected"));
    expect(fetchSessionsMock).toHaveBeenCalledTimes(2);
  });
});
