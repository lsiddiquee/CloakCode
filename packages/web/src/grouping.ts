import type { SessionSummary } from "@cloakcode/protocol";

export interface WorkspaceGroup {
  workspace: string;
  workspaceHash: string;
  rows: SessionSummary[];
}

/**
 * Arrange the (already sessionId-deduped) session list into workspace groups,
 * keyed on `workspaceHash` — VS Code's stable, reporter-invariant
 * `workspaceStorage/<hash>`. NOT `instanceId`: that is a per-reporter label
 * (`${remoteKind}:${folder name}`), so two windows of one environment report the
 * same workspace under different instanceIds; keying on it would split one
 * workspace into two groups. Grouping on the hash collapses them. Group order is
 * first-seen (the caller pre-sorts sessions, newest first).
 */
export function groupByWorkspace(sessions: SessionSummary[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>();
  for (const s of sessions) {
    const g = map.get(s.workspaceHash) ?? {
      workspace: s.workspace,
      workspaceHash: s.workspaceHash,
      rows: [],
    };
    g.rows.push(s);
    map.set(s.workspaceHash, g);
  }
  return [...map.values()];
}
