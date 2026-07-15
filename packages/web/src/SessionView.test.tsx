import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PendingBlocker, SessionSummary } from "@cloakcode/protocol";
import { SessionView } from "./SessionView";

// Controls the connection status + pending blockers the stubbed bridge reports.
const h = vi.hoisted(() => ({
  status: "open" as string,
  pending: [] as PendingBlocker[],
  respond: vi.fn(async (_params: unknown) => {}),
  steer: vi.fn(async (_params: unknown) => {}),
  stop: vi.fn(async (_params: unknown) => {}),
}));

// Stub the bridge so mounting SessionView never opens a real WebSocket and the
// action functions are inert no-ops (we only assert what renders).
vi.mock("./bridge", () => ({
  subscribeSession: (
    _params: unknown,
    _onEvent: unknown,
    onPending: (b: PendingBlocker[]) => void,
    _onError: unknown,
    onStatus: (s: string) => void = () => {},
  ) => {
    onStatus(h.status);
    onPending(h.pending);
    return () => {};
  },
  respondSession: h.respond,
  steerSession: h.steer,
  stopSession: h.stop,
  decideSession: async () => {},
  answerSession: async () => {},
}));

beforeEach(() => {
  h.status = "open";
  h.pending = [];
  h.respond.mockClear();
  h.steer.mockClear();
  h.stop.mockClear();
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
    inTurn: false,
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

describe("SessionView composer", () => {
  it("is a multi-line textarea; Ctrl/Cmd+Enter sends, plain Enter does not", () => {
    render(
      <SessionView session={session({ owned: true })} onBack={() => {}} />,
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    fireEvent.change(box, { target: { value: "line1" } });
    // Plain Enter inserts a newline in a textarea — it must NOT send.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(h.respond).not.toHaveBeenCalled();
    // Ctrl/Cmd+Enter sends the message.
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      text: "line1",
    });
  });
});

describe("SessionView composer — mid-turn actions", () => {
  it("not mid-turn: primary is a plain queued Send (no steer/stop UI)", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: false })}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Steer/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
  });

  it("mid-turn: Ctrl/Cmd+Enter steers into the running turn", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: true })}
        onBack={() => {}}
      />,
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "use zod" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      text: "use zod",
    });
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("mid-turn: Stop & send cancels then sends the typed text", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: true })}
        onBack={() => {}}
      />,
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "start over" } });
    fireEvent.click(screen.getByRole("button", { name: /Stop & send/ }));
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      text: "start over",
    });
  });

  it("mid-turn: pure Stop cancels with no message even when the box is empty", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: true })}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop.mock.calls[0]?.[0]).toEqual({ sessionId: "sess-1" });
  });

  it("mid-turn: “Send anyway” force-queues via respond (stale-tracking escape hatch)", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: true })}
        onBack={() => {}}
      />,
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "just queue it" } });
    fireEvent.click(screen.getByRole("button", { name: /Send anyway/ }));
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      text: "just queue it",
    });
    expect(h.steer).not.toHaveBeenCalled();
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

function askBlocker(): PendingBlocker {
  return {
    toolCallId: "tc1",
    toolName: "vscode_askQuestions",
    createdAt: new Date().toISOString(),
    resolveId: "tc1__vscode-0",
    confirmations: [
      {
        kind: "confirmation",
        id: "q1",
        prompt: "Pick a name",
        options: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      },
      {
        kind: "confirmation",
        id: "q2",
        prompt: "Overwrite?",
        options: [
          { id: "y", label: "Yes" },
          { id: "n", label: "No" },
        ],
      },
    ],
  };
}

describe("PendingCard question stepper", () => {
  it("steps through multiple questions one at a time", () => {
    h.pending = [askBlocker()];
    render(<SessionView session={session()} onBack={() => {}} />);

    // Q1 with progress; Q2 not yet shown.
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
    expect(screen.getByText("Pick a name")).toBeTruthy();
    expect(screen.queryByText("Overwrite?")).toBeNull();

    // Next is gated until Q1 is answered.
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // Advance to Q2.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Question 2 of 2")).toBeTruthy();
    expect(screen.getByText("Overwrite?")).toBeTruthy();

    // The last question shows Send (gated until answered).
    expect(
      (screen.getByRole("button", { name: /Send answer/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(
      (screen.getByRole("button", { name: /Send answer/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // Back returns to Q1 with its answer preserved.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Alpha/ }).className).toContain(
      "chosen",
    );
  });

  it("a single-question blocker shows no stepper chrome", () => {
    h.pending = [
      {
        toolCallId: "tc2",
        toolName: "vscode_askQuestions",
        createdAt: new Date().toISOString(),
        confirmations: [
          {
            kind: "confirmation",
            id: "q1",
            prompt: "Proceed?",
            options: [{ id: "y", label: "Yes" }],
          },
        ],
      },
    ];
    render(<SessionView session={session()} onBack={() => {}} />);
    expect(screen.queryByText(/Question 1 of/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByRole("button", { name: /Send answer/ })).toBeTruthy();
  });
});
