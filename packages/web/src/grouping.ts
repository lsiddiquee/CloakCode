import type { SessionSummary } from "@cloakcode/protocol";

export interface WorkspaceGroup {
  /**
   * A representative instanceId (the first row's) for a display-only environment
   * label — NEVER a key. Grouping is by `workspaceHash`; a group is virtually
   * always single-instance after the sessionId de-dup.
   */
  instanceId: string;
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
 * workspace into two groups. Grouping on the hash collapses them.
 *
 * Ordering: owned (actionable) workspaces first, read-only (no local extension)
 * ones sunk to the bottom — a stable sort preserves first-seen order (caller
 * pre-sorts sessions newest-first) within each partition.
 */
export function groupByWorkspace(sessions: SessionSummary[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>();
  for (const s of sessions) {
    const g = map.get(s.workspaceHash) ?? {
      instanceId: s.instanceId,
      workspace: s.workspace,
      workspaceHash: s.workspaceHash,
      rows: [],
    };
    g.rows.push(s);
    map.set(s.workspaceHash, g);
  }
  return [...map.values()].sort(
    (a, b) => Number(!isOwnedGroup(a)) - Number(!isOwnedGroup(b)),
  );
}

/**
 * A group is "owned" (actionable here) only if EVERY row is owned — the same
 * rule the list header uses to decide the read-only label. Read-only groups have
 * no local extension, so they can only be observed.
 */
export function isOwnedGroup(group: WorkspaceGroup): boolean {
  return group.rows.every((s) => s.owned);
}
