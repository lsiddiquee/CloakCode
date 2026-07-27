import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import type { PendingBlocker, SessionSummary } from "@cloakcode/protocol";
import { SessionView, clearSessionCache } from "./SessionView";

// Controls the connection status + pending blockers the stubbed bridge reports.
const h = vi.hoisted(() => ({
  status: "open" as string,
  pending: [] as PendingBlocker[],
  emitTurn: (_inTurn: boolean) => {},
  emitEvent: (_e: unknown) => {},
  emitUsage: (_u: unknown) => {},
  emitReset: () => {},
  respond: vi.fn(async (_params: unknown) => {}),
  steer: vi.fn(async (_params: unknown) => {}),
  stop: vi.fn(async (_params: unknown) => {}),
  decide: vi.fn(async (_params: unknown) => {}),
  answer: vi.fn(async (_params: unknown) => {}),
  fetchHistory: vi.fn(async (_params: unknown) => [] as unknown[]),
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
    _url?: unknown,
    onTurn: (inTurn: boolean) => void = () => {},
    onUsage: (u: unknown) => void = () => {},
    onReset: () => void = () => {},
  ) => {
    onStatus(h.status);
    onPending(h.pending);
    h.emitTurn = onTurn;
    h.emitEvent = _onEvent as (e: unknown) => void;
    h.emitUsage = onUsage;
    h.emitReset = onReset;
    return () => {};
  },
  respondSession: h.respond,
  steerSession: h.steer,
  stopSession: h.stop,
  decideSession: h.decide,
  answerSession: h.answer,
  fetchHistory: h.fetchHistory,
}));

beforeEach(() => {
  clearSessionCache();
  h.status = "open";
  h.pending = [];
  h.emitTurn = () => {};
  h.emitEvent = () => {};
  h.emitUsage = () => {};
  h.emitReset = () => {};
  h.respond.mockClear();
  h.steer.mockClear();
  h.stop.mockClear();
  h.decide.mockClear();
  h.answer.mockClear();
  h.fetchHistory.mockClear();
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

describe("SessionView lag advisory (transcript source)", () => {
  it("shows a freshness advisory when logSource is transcript", () => {
    render(
      <SessionView
        session={session({ logSource: "transcript" })}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText(/latest reply can lag/i)).toBeTruthy();
  });

  it("hides the advisory when the debug-log is the live source", () => {
    render(
      <SessionView
        session={session({ logSource: "debug-log" })}
        onBack={() => {}}
      />,
    );
    expect(screen.queryByText(/latest reply can lag/i)).toBeNull();
  });

  it("hides the advisory when logSource is absent (older producer)", () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    expect(screen.queryByText(/latest reply can lag/i)).toBeNull();
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

  it("flips the composer live when an inTurn frame arrives (no list refresh)", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: false })}
        onBack={() => {}}
      />,
    );
    // Starts out-of-turn: a plain queued Send, no steer UI.
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Steer/ })).toBeNull();

    // A live turn frame flips it to the mid-turn composer.
    act(() => h.emitTurn(true));
    expect(screen.getByRole("button", { name: /Steer/ })).toBeTruthy();

    // And back again when the turn closes.
    act(() => h.emitTurn(false));
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Steer/ })).toBeNull();
  });

  it("header reads active after a live turn ends, not the frozen summary idle", () => {
    render(
      <SessionView
        session={session({
          owned: true,
          inTurn: false,
          status: "idle",
          idleSeconds: 960,
        })}
        onBack={() => {}}
      />,
    );
    // A live turn → the header reflects live activity, not the stale "idle 16m".
    act(() => h.emitTurn(true));
    expect(screen.getByText("working")).toBeTruthy();
    // Turn ends → "active" (just finished), NOT the frozen summary idle.
    act(() => h.emitTurn(false));
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.queryByText(/idle/)).toBeNull();
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

  it("pure Stop optimistically flips the composer back to Send on ack", async () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: true })}
        onBack={() => {}}
      />,
    );
    // `chat.cancel` writes no debug-log turn_end, so the follower won't emit
    // inTurn:false on its own — the stop ack optimistically resets the composer.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }));
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Steer/ })).toBeNull();
  });

  it("mid-turn: Queue sends via respond (queued after the current step / stale-tracking escape hatch)", () => {
    render(
      <SessionView
        session={session({ owned: true, inTurn: true })}
        onBack={() => {}}
      />,
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "just queue it" } });
    fireEvent.click(screen.getByRole("button", { name: /^Queue$/ }));
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

describe("PendingCard answer semantics", () => {
  const answersSent = (): unknown =>
    (h.answer.mock.calls[0]?.[0] as { answers?: unknown } | undefined)?.answers;

  function freeformBlocker(multiSelect?: boolean): PendingBlocker {
    return {
      toolCallId: "tc-f",
      toolName: "vscode_askQuestions",
      resolveId: "tc-f__vscode-0",
      createdAt: new Date().toISOString(),
      confirmations: [
        {
          kind: "confirmation",
          id: "q1",
          prompt: "Working style?",
          allowFreeform: true,
          ...(multiSelect ? { multiSelect: true } : {}),
          options: [
            { id: "r", label: "Read-only" },
            { id: "t", label: "Take action" },
          ],
        },
      ],
    };
  }

  it("deselects a single-select option on a second click", () => {
    h.pending = [freeformBlocker()];
    render(<SessionView session={session()} onBack={() => {}} />);

    const opt = screen.getByRole("button", { name: /Read-only/ });
    fireEvent.click(opt);
    expect(opt.className).toContain("chosen");
    // Clicking the chosen option again clears it — there was no way back.
    fireEvent.click(opt);
    expect(opt.className).not.toContain("chosen");
    expect(
      (screen.getByRole("button", { name: /Send answer/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("a typed custom answer clears the single-select option and wins", async () => {
    h.pending = [freeformBlocker()];
    render(<SessionView session={session()} onBack={() => {}} />);

    const opt = screen.getByRole("button", { name: /Read-only/ });
    fireEvent.click(opt);
    fireEvent.change(screen.getByPlaceholderText("Type a custom answer…"), {
      target: { value: "watch only, ask first" },
    });
    expect(opt.className).not.toContain("chosen");

    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(await screen.findByText("Answer sent ✓")).toBeTruthy();
    expect(answersSent()).toEqual([
      { selected: [], freeText: "watch only, ask first", hasOptions: true },
    ]);
  });

  it("a multi-select keeps its options when a custom answer is typed", async () => {
    h.pending = [freeformBlocker(true)];
    render(<SessionView session={session()} onBack={() => {}} />);

    const opt = screen.getByRole("button", { name: /Read-only/ });
    fireEvent.click(opt);
    fireEvent.change(screen.getByPlaceholderText("Type a custom answer…"), {
      target: { value: "and log it" },
    });
    expect(opt.className).toContain("chosen");

    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(await screen.findByText("Answer sent ✓")).toBeTruthy();
    expect(answersSent()).toEqual([
      {
        selected: ["Read-only"],
        freeText: "and log it",
        multiSelect: true,
        hasOptions: true,
      },
    ]);
  });
});

describe("PendingCard approve/deny", () => {
  function decisionBlocker(): PendingBlocker {
    return {
      toolCallId: "tc-cmd",
      toolName: "run_in_terminal",
      createdAt: new Date().toISOString(),
      awaitingDecision: true,
      input: { command: "rm -rf build" },
    };
  }

  it("denies a pending tool call and locks the buttons", async () => {
    h.pending = [decisionBlocker()];
    render(<SessionView session={session()} onBack={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("Denied ✓")).toBeTruthy();
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.decide.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      toolCallId: "tc-cmd",
      decision: "deny",
    });
  });

  it("approves a pending tool call", async () => {
    h.pending = [decisionBlocker()];
    render(<SessionView session={session()} onBack={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Allowed ✓")).toBeTruthy();
    expect(h.decide.mock.calls[0]?.[0]).toMatchObject({ decision: "allow" });
  });
});

describe("PendingCard answer submit", () => {
  it("submits a structured answer and confirms it was sent", async () => {
    h.pending = [
      {
        toolCallId: "tc-q",
        toolName: "vscode_askQuestions",
        resolveId: "tc-q__vscode-2",
        createdAt: new Date().toISOString(),
        confirmations: [
          {
            kind: "confirmation",
            id: "q1",
            prompt: "Proceed?",
            options: [
              { id: "y", label: "Yes" },
              { id: "n", label: "No" },
            ],
          },
        ],
      },
    ];
    render(<SessionView session={session()} onBack={() => {}} />);

    // Send is gated until an option is chosen.
    expect(
      (screen.getByRole("button", { name: /Send answer/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));

    expect(await screen.findByText("Answer sent ✓")).toBeTruthy();
    expect(h.answer).toHaveBeenCalledTimes(1);
    expect(h.answer.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-1",
      toolCallId: "tc-q__vscode-2",
    });
  });

  it("renders the telemetry bar from the server usage frame, with a partial note", async () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    act(() => {
      // A per-turn usage EVENT drives the turn badge (still client-side)…
      h.emitEvent({
        type: "append",
        seq: 1,
        part: {
          kind: "usage",
          id: "dl-usage-0",
          model: "claude-opus-4.8",
          inputTokens: 1000,
          outputTokens: 100,
          cachedTokens: 900,
          nanoAiu: 5_000_000_000,
        },
      });
      // …and the server-computed session TOTAL drives the bar + its partial flag,
      // correct even under the tail window (docs/02.6 §4.32).
      h.emitUsage({
        requests: 1,
        inputTokens: 1000,
        outputTokens: 100,
        cachedTokens: 900,
        aiu: 5,
        models: ["claude-opus-4.8"],
        partial: true,
      });
    });
    // The bar renders from the frame (synchronous); the badge flushes with the
    // buffered event on the next frame.
    await screen.findByText("partial");
    await waitFor(() =>
      expect(document.querySelector(".turn-usage")?.textContent).toContain(
        "5.00 AIU",
      ),
    );
    const bar = document.querySelector(".usage-bar");
    expect(bar?.textContent).toContain("1.0K in");
    expect(bar?.textContent).toContain("5.00 AIU");
    expect(bar?.textContent).toContain("claude-opus-4.8");
  });

  it("always shows the ⓘ info marker; no partial chip when history is not stitched", async () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    act(() => {
      // A debug-log-only session (server reports partial: false) → the ⓘ marker
      // (counts are debug-log-based) is always present, but no partial chip.
      h.emitUsage({
        requests: 1,
        inputTokens: 1000,
        outputTokens: 100,
        cachedTokens: 900,
        aiu: 5,
        models: ["claude-opus-4.8"],
        partial: false,
      });
    });
    await screen.findByText("ⓘ");
    expect(document.querySelector(".usage-info")).toBeTruthy();
    expect(document.querySelector(".usage-partial")).toBeNull(); // not stitched
  });

  it("shows the CHOSEN answer on a resolved confirmation, not the recommendation", async () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    act(() => {
      h.emitEvent({
        type: "append",
        seq: 0,
        part: {
          kind: "confirmation",
          id: "c0",
          prompt: "Working style?",
          options: [
            { id: "act", label: "Take action", recommended: true },
            { id: "ro", label: "Read-only" },
          ],
          answer: { selected: ["Read-only"], freeText: null, skipped: false },
        },
      });
      h.emitEvent({ type: "resolve", seq: 1, id: "c0" });
    });
    expect(await screen.findByText("Answered: Read-only")).toBeTruthy();
    // The recommendation is still badged, but it must NOT be the highlighted
    // row — that highlight now means "this is what was picked".
    const reco = screen.getByText("Take action").closest(".choice");
    const chosen = screen.getByText("Read-only").closest(".choice");
    expect(reco?.className).not.toContain("reco");
    expect(chosen?.className).toContain("chosen");
  });

  it("leaves the recommendation highlighted while a confirmation is unanswered", async () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    act(() => {
      h.emitEvent({
        type: "append",
        seq: 0,
        part: {
          kind: "confirmation",
          id: "c0",
          prompt: "Working style?",
          options: [{ id: "act", label: "Take action", recommended: true }],
        },
      });
    });
    const reco = (await screen.findByText("Take action")).closest(".choice");
    expect(reco?.className).toContain("reco");
    expect(document.querySelector(".blocker-answer")).toBeNull();
  });

  it("clears the view on a reset frame (the tailed source changed)", async () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    act(() => {
      h.emitEvent({
        type: "append",
        seq: 0,
        part: { kind: "markdown", id: "m0", text: "old content" },
      });
    });
    await screen.findByText("old content");
    // The debug-log appeared / the log rotated → the server sends `reset`; the
    // client drops the stale window and re-subscribes fresh underneath.
    act(() => h.emitReset());
    expect(screen.queryByText("old content")).toBeNull();
  });

  it("pages in older messages on 'Load older' and keeps them ahead of the tail", async () => {
    h.fetchHistory.mockResolvedValueOnce([
      {
        type: "append",
        seq: 3,
        part: { kind: "markdown", id: "m3", text: "older msg" },
      },
      {
        type: "append",
        seq: 4,
        part: { kind: "markdown", id: "m4", text: "older too" },
      },
    ]);
    render(<SessionView session={session()} onBack={() => {}} />);
    // The tail opens at seq 5 (> 0), so there is older history to page in.
    act(() => {
      h.emitEvent({
        type: "append",
        seq: 5,
        part: { kind: "markdown", id: "m5", text: "newest" },
      });
    });
    await screen.findByText("newest");
    const button = await screen.findByText("Load older messages");

    await act(async () => {
      fireEvent.click(button);
    });
    // Asked for the window strictly BELOW the lowest held seq (5).
    expect(h.fetchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", beforeSeq: 5 }),
    );
    expect(await screen.findByText("older msg")).toBeTruthy();
    expect(screen.getByText("older too")).toBeTruthy();
  });

  it("shows a jump-to-latest button when parked above the bottom, and returns on click", () => {
    render(<SessionView session={session()} onBack={() => {}} />);
    const el = document.querySelector("main.transcript") as HTMLElement;
    Object.defineProperty(el, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(el, "clientHeight", {
      value: 300,
      configurable: true,
    });
    // Not shown while at/near the bottom.
    expect(
      screen.queryByRole("button", { name: /jump to latest/i }),
    ).toBeNull();
    // Scrolled up (distance-to-bottom 600 > 120) ⇒ the button appears.
    el.scrollTop = 100;
    fireEvent.scroll(el);
    const jump = screen.getByRole("button", { name: /jump to latest/i });
    fireEvent.click(jump);
    expect(el.scrollTop).toBe(1000); // snapped to the bottom
    expect(
      screen.queryByRole("button", { name: /jump to latest/i }),
    ).toBeNull();
  });
});
