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

/** Wrap session rows in the `fetchSessions` result envelope (optional gateway name). */
function listResult(
  sessions: SessionSummary[],
  gateway?: string,
): { sessions: SessionSummary[]; gateway?: string } {
  return gateway ? { sessions, gateway } : { sessions };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("App", () => {
  it("shows the loading hint before the bridge responds", () => {
    fetchSessionsMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<App />);
    expect(screen.getByText("Reaching the bridge…")).toBeTruthy();
  });

  it("renders the session list with counts and a blocked badge", async () => {
    fetchSessionsMock.mockResolvedValue(
      listResult([
        summary({ sessionId: "s1", status: "blocked" }),
        summary({ sessionId: "s2" }),
      ]),
    );
    render(<App />);

    expect(await screen.findByText(/2 sessions · 1 needs input/)).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText("Needs input")).toBeTruthy();
    expect(screen.getByText(/workspace repo/)).toBeTruthy();
  });

  it("shows the gateway name in the header when the hub reports one", async () => {
    fetchSessionsMock.mockResolvedValue(listResult([summary({})], "office"));
    render(<App />);
    expect(await screen.findByText(/office · 1 sessions/)).toBeTruthy();
  });

  it("shows the empty state when there are no sessions", async () => {
    fetchSessionsMock.mockResolvedValue(listResult([]));
    render(<App />);
    expect(await screen.findByText(/No Copilot sessions found/)).toBeTruthy();
  });

  it("hides read-only workspaces until the setting is enabled, then reveals them", async () => {
    fetchSessionsMock.mockResolvedValue(
      listResult([summary({ owned: false })]),
    );
    render(<App />);
    // Default: read-only workspaces are hidden; the gear is the only affordance.
    const gear = await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByText(/read-only \(no extension here\)/)).toBeNull();

    fireEvent.click(gear);
    fireEvent.click(
      screen.getByRole("switch", { name: "Show read-only workspaces" }),
    );
    expect(
      await screen.findByText(/read-only \(no extension here\)/),
    ).toBeTruthy();
    expect(screen.getByText("read-only")).toBeTruthy();
  });

  it("persists the show-read-only setting across remounts", async () => {
    fetchSessionsMock.mockResolvedValue(
      listResult([summary({ owned: false })]),
    );
    const first = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Show read-only workspaces" }),
    );
    await screen.findByText(/read-only \(no extension here\)/);
    first.unmount();

    render(<App />);
    // The persisted pref re-reveals the read-only workspace without re-toggling.
    expect(
      await screen.findByText(/read-only \(no extension here\)/),
    ).toBeTruthy();
  });

  it("reveals the workspace hash when the Show workspace ID setting is on", async () => {
    fetchSessionsMock.mockResolvedValue(
      listResult([summary({ workspaceHash: "ws-hash-xyz" })]),
    );
    render(<App />);
    await screen.findByText("My session");
    expect(screen.queryByText("ws-hash-xyz")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show workspace ID" }));
    expect(screen.getByText("ws-hash-xyz")).toBeTruthy();
  });

  it("collapses a workspace's rows when its header is clicked, and persists it", async () => {
    fetchSessionsMock.mockResolvedValue(listResult([summary({})]));
    const first = render(<App />);
    await screen.findByText("My session");

    fireEvent.click(screen.getByText(/workspace repo/));
    expect(screen.queryByText("My session")).toBeNull();
    first.unmount();

    render(<App />);
    // Collapsed state persisted: the header shows but the row stays hidden.
    expect(await screen.findByText(/workspace repo/)).toBeTruthy();
    expect(screen.queryByText("My session")).toBeNull();
  });

  it("orders owned workspaces above read-only ones", async () => {
    fetchSessionsMock.mockResolvedValue(
      listResult([
        summary({
          sessionId: "ro",
          workspaceHash: "RO",
          title: "readonly one",
          owned: false,
        }),
        summary({
          sessionId: "own",
          workspaceHash: "OWN",
          title: "owned one",
          owned: true,
        }),
      ]),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Show read-only workspaces" }),
    ); // reveal read-only
    const labels = screen
      .getAllByText(/workspace repo/)
      .map((el) => el.textContent ?? "");
    expect(labels[0]).toMatch(/i1/); // owned group's instanceId label leads
    expect(labels[1]).toMatch(/read-only/); // read-only group sinks below
  });

  it("shows the error state and retries on demand", async () => {
    fetchSessionsMock.mockRejectedValueOnce(new Error("boom"));
    render(<App />);

    expect(await screen.findByText(/Can’t reach the bridge/)).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();

    fetchSessionsMock.mockResolvedValueOnce(listResult([summary({})]));
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("My session")).toBeTruthy();
  });

  it("opens a session and returns via back", async () => {
    fetchSessionsMock.mockResolvedValue(
      listResult([summary({ sessionId: "abc12345" })]),
    );
    render(<App />);

    fireEvent.click(await screen.findByText("My session"));
    expect(screen.getByText("viewing abc12345")).toBeTruthy();

    fireEvent.click(screen.getByText("back"));
    expect(await screen.findByText("My session")).toBeTruthy();
  });

  it("reloads when the header connection button is clicked", async () => {
    fetchSessionsMock.mockResolvedValue(listResult([summary({})]));
    render(<App />);
    await screen.findByText("My session");
    expect(fetchSessionsMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("connected"));
    expect(fetchSessionsMock).toHaveBeenCalledTimes(2);
  });
});
