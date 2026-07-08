# @cloakcode/agent

The **owned agent loop** — the deterministic path to *answer* a blocker remotely.

Why this exists: the research proved you cannot answer a blocker by reading files, and
command injection can only queue/steer (not deterministic). Owning the loop makes a
confirmation a first-class object CloakCode authors and can resolve via an in-memory
promise. See [docs/02-research-findings.md](../../docs/02-research-findings.md).

Contents (to build):

- A tool-calling loop that talks to a model through an **injected port** (so it stays
  pure/testable; the extension supplies a `vscode.lm`-backed implementation).
- Confirmation gates: when the loop needs input it emits a `confirmation` `SessionPart`
  and `await`s a promise that either VS Code or the phone resolves.
- Emits the normalized `SessionPart` stream from `@cloakcode/protocol`.

No `vscode` import here — that lives in `@cloakcode/extension`.
