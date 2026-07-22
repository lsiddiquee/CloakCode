/**
 * Browser-persisted session-list preferences. Purely client-side UI state
 * (localStorage) — never crosses the bridge, so it carries no session content
 * and needs no provenance tagging. Tolerant of unavailable/corrupt storage
 * (private-mode, quota, hand-edited value) — it always degrades to defaults
 * rather than throwing into render.
 */
export interface SessionListPrefs {
  /** Show read-only (no-local-extension) workspaces. Default OFF — they sink to
   * the bottom and are hidden until asked for, so the actionable ones lead. */
  showReadOnly: boolean;
  /** Show each workspace's storage-hash under its header. Default OFF — it's the
   * on-disk `workspaceStorage/<hash>` folder name, handy for finding the files. */
  showWorkspaceId: boolean;
  /** workspaceHashes whose session rows are collapsed (header still shown). */
  collapsed: string[];
}

const STORAGE_KEY = "cloakcode.sessionListPrefs.v1";

const DEFAULTS: SessionListPrefs = {
  showReadOnly: false,
  showWorkspaceId: false,
  collapsed: [],
};

export function loadPrefs(): SessionListPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SessionListPrefs>;
    return {
      showReadOnly:
        typeof parsed.showReadOnly === "boolean"
          ? parsed.showReadOnly
          : DEFAULTS.showReadOnly,
      showWorkspaceId:
        typeof parsed.showWorkspaceId === "boolean"
          ? parsed.showWorkspaceId
          : DEFAULTS.showWorkspaceId,
      collapsed: Array.isArray(parsed.collapsed)
        ? parsed.collapsed.filter((h): h is string => typeof h === "string")
        : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: SessionListPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort: storage may be full or blocked (private mode). UI still works.
  }
}
