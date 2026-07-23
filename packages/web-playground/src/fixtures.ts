import type {
  PendingBlocker,
  SessionEvent,
  SessionSummary,
} from "@cloakcode/protocol";

// Canned data for the UI playground. Shapes match the @cloakcode/protocol
// schemas exactly (the real bridge validates them), so the App renders these as
// if they came off a live gateway. Tweak freely — this never ships.

/**
 * A deliberately varied session list: several workspaces, owned + read-only,
 * one blocked (needs input), long titles, and a spread of idle times — enough to
 * exercise grouping, ordering, the read-only toggle, and collapse.
 */
export const SESSIONS: SessionSummary[] = [
  {
    instanceId: "devcontainer:cloakcode",
    sessionId: "11111111-1111-4111-8111-111111111111",
    workspace: "cloakcode",
    workspaceHash: "wsCloak",
    title: "Redesign the read-only toggle placement",
    turns: 24,
    status: "active",
    idleSeconds: 0,
    owned: true,
    inTurn: true,
  },
  {
    instanceId: "devcontainer:cloakcode",
    sessionId: "22222222-2222-4222-8222-222222222222",
    workspace: "cloakcode",
    workspaceHash: "wsCloak",
    title: "Add a mock build so we can play with the UI without a gateway",
    turns: 8,
    status: "blocked",
    idleSeconds: 42,
    owned: true,
    inTurn: false,
  },
  {
    instanceId: "devcontainer:cloakcode",
    sessionId: "33333333-3333-4333-8333-333333333333",
    workspace: "cloakcode",
    workspaceHash: "wsCloak",
    title: "Windows desktop host: sessions not listing",
    turns: 15,
    status: "blocked",
    idleSeconds: 18,
    owned: true,
    inTurn: true,
  },
  {
    instanceId: "wsl:pet_matcher",
    sessionId: "44444444-4444-4444-8444-444444444444",
    workspace: "pet_matcher",
    workspaceHash: "wsPet",
    title: "Generate an SVG from this JPEG with a transparent background",
    turns: 19,
    status: "idle",
    idleSeconds: 26 * 3600,
    owned: true,
    inTurn: false,
  },
  {
    instanceId: "wsl:pet_matcher",
    sessionId: "55555555-5555-4555-8555-555555555555",
    workspace: "pet_matcher",
    workspaceHash: "wsPet",
    title: "Snap-fit barb has a thread problem near the tip",
    turns: 11,
    status: "idle",
    idleSeconds: 64 * 3600,
    owned: true,
    inTurn: false,
  },
  {
    instanceId: "wsl:notes",
    sessionId: "66666666-6666-4666-8666-666666666666",
    workspace: "notes",
    workspaceHash: "wsNotes",
    title: "Read-only: a session in a workspace with no extension here",
    turns: 5,
    status: "idle",
    idleSeconds: 7 * 24 * 3600,
    owned: false,
    inTurn: false,
  },
];

/** Per-session transcript, streamed on `session.subscribe`. Keyed by sessionId. */
export const TRANSCRIPTS: Record<string, SessionEvent[]> = {
  "11111111-1111-4111-8111-111111111111": [
    {
      type: "append",
      seq: 0,
      part: {
        kind: "userMessage",
        id: "u1",
        text: "The read-only checkbox looks out of place — can we move it into the header?",
      },
    },
    {
      type: "append",
      seq: 1,
      part: {
        kind: "markdown",
        id: "a1",
        text: "Sure — let me prototype option 1 (a **filter chip** row). I'll find where the checkbox lives, move it, and run the tests.",
      },
    },
    {
      type: "append",
      seq: 2,
      part: {
        kind: "thinking",
        id: "t1",
        text: "Locating the read-only checkbox in the app bar…",
      },
    },
    {
      type: "append",
      seq: 3,
      part: {
        kind: "toolCall",
        id: "call-1",
        name: "grep_search",
        input: { query: "read-only" },
        status: "done",
      },
    },
    {
      type: "append",
      seq: 4,
      part: {
        kind: "toolCall",
        id: "call-2",
        name: "read_file",
        input: { path: "packages/web/src/App.tsx", startLine: 1, endLine: 40 },
        status: "done",
      },
    },
    {
      type: "append",
      seq: 5,
      part: {
        kind: "toolCall",
        id: "call-3",
        name: "replace_string_in_file",
        input: { filePath: "packages/web/src/App.tsx" },
        status: "done",
      },
    },
    {
      type: "append",
      seq: 6,
      part: {
        kind: "toolCall",
        id: "call-4",
        name: "run_in_terminal",
        input: { command: "pnpm --filter @cloakcode/web test" },
        status: "error",
      },
    },
    {
      type: "append",
      seq: 7,
      part: {
        kind: "markdown",
        id: "a2",
        text: "The snapshot for the app bar failed (expected — the checkbox moved). Updating it and re-running.",
      },
    },
    {
      type: "append",
      seq: 8,
      part: {
        kind: "toolCall",
        id: "call-5",
        name: "run_in_terminal",
        input: { command: "pnpm --filter @cloakcode/web test -u" },
        status: "running",
      },
    },
  ],
  "22222222-2222-4222-8222-222222222222": [
    {
      type: "append",
      seq: 0,
      part: {
        kind: "userMessage",
        id: "u1",
        text: "Add a mock build with fixtures, kept in its own package.",
      },
    },
    {
      type: "append",
      seq: 1,
      part: {
        kind: "thinking",
        id: "t1",
        text: "Wiring an in-browser fake bridge…",
      },
    },
    {
      type: "append",
      seq: 2,
      part: {
        kind: "toolCall",
        id: "call-1",
        name: "run_in_terminal",
        input: { command: "pnpm --filter @cloakcode/web-playground dev" },
        status: "done",
      },
    },
  ],
  "33333333-3333-4333-8333-333333333333": [
    {
      type: "append",
      seq: 0,
      part: {
        kind: "userMessage",
        id: "u1",
        text: "On my Windows desktop VS Code, CloakCode lists 0 sessions. Why?",
      },
    },
    {
      type: "append",
      seq: 1,
      part: {
        kind: "markdown",
        id: "a1",
        text: "The storage root was hardcoded to `~/.vscode-server`, which only exists on a server/container host. On a **desktop** host transcripts live under the OS user-data dir, so nothing matched.\n\nFix: derive the root from `context.globalStorageUri` (its sibling `…/User/workspaceStorage`).",
      },
    },
    {
      type: "append",
      seq: 2,
      part: {
        kind: "toolCall",
        id: "call-1",
        name: "read_file",
        input: { path: "packages/extension/src/scanner.ts" },
        status: "done",
      },
    },
    {
      type: "append",
      seq: 3,
      part: {
        kind: "toolCall",
        id: "call-2",
        name: "replace_string_in_file",
        input: { filePath: "packages/extension/src/scanner.ts" },
        status: "done",
      },
    },
    {
      type: "append",
      seq: 4,
      part: {
        kind: "markdown",
        id: "a2",
        text: "Patched the storage-root derivation. I'd like to verify it against your real user-data dir — this reads outside the workspace, so it needs your approval.",
      },
    },
    {
      type: "append",
      seq: 5,
      part: {
        kind: "toolCall",
        id: "call-3",
        name: "run_in_terminal",
        input: {
          command: "ls '%APPDATA%/Code/User/workspaceStorage'",
        },
        status: "running",
      },
    },
  ],
  "44444444-4444-4444-8444-444444444444": [
    {
      type: "append",
      seq: 0,
      part: {
        kind: "userMessage",
        id: "u1",
        text: "Convert this pet photo to an SVG with a transparent background.",
      },
    },
    {
      type: "append",
      seq: 1,
      part: {
        kind: "markdown",
        id: "a1",
        text: "I'll trace the subject and drop the background. A vector trace works best on a high-contrast silhouette — want a **flat 2-colour** look or a **posterised** multi-tone one?",
      },
    },
  ],
  "55555555-5555-4555-8555-555555555555": [
    {
      type: "append",
      seq: 0,
      part: {
        kind: "userMessage",
        id: "u1",
        text: "The snap-fit barb tip has a thread problem — it won't seat cleanly.",
      },
    },
    {
      type: "append",
      seq: 1,
      part: {
        kind: "markdown",
        id: "a1",
        text: "A barb tip that catches usually means the lead-in chamfer is too steep. Try a **30–45° lead-in** and a small tip radius (~0.3 mm) so it deflects instead of threading.",
      },
    },
  ],
  "66666666-6666-4666-8666-666666666666": [
    {
      type: "append",
      seq: 0,
      part: {
        kind: "userMessage",
        id: "u1",
        text: "This session lives in a workspace with no CloakCode extension — it should be observe-only.",
      },
    },
    {
      type: "append",
      seq: 1,
      part: {
        kind: "markdown",
        id: "a1",
        text: "Correct — it renders **read-only**: you can watch the mirror, but the composer and blocker actions are disabled because no local extension can actuate this workspace.",
      },
    },
  ],
};

/**
 * A live pending blocker for the "blocked" session, delivered on the pending
 * channel so the App renders the needs-input affordances.
 */
export const PENDING: Record<string, PendingBlocker[]> = {
  "22222222-2222-4222-8222-222222222222": [
    {
      toolCallId: "call-blocker-1",
      toolName: "vscode_askQuestions",
      createdAt: new Date().toISOString(),
      resolveId: "call-blocker-1__vscode-0",
      confirmations: [
        {
          kind: "confirmation",
          id: "q1",
          prompt: "Where should the read-only filter live?",
          options: [
            { id: "chip", label: "Filter chip row", recommended: true },
            { id: "appbar", label: "Icon toggle in the app bar" },
            { id: "keep", label: "Keep the checkbox, restyle it" },
          ],
          allowFreeform: true,
        },
      ],
    },
  ],
  // A tool-call APPROVAL blocker (no `confirmations`; `awaitingDecision` set) —
  // CloakCode is holding the running `run_in_terminal` call, so the client shows
  // the Approve/Allow/Deny action block for the same command the transcript is
  // running. `input` carries the raw command the approval summary renders.
  "33333333-3333-4333-8333-333333333333": [
    {
      toolCallId: "call-3",
      toolName: "run_in_terminal",
      createdAt: new Date().toISOString(),
      awaitingDecision: true,
      input: { command: "ls '%APPDATA%/Code/User/workspaceStorage'" },
    },
  ],
};
