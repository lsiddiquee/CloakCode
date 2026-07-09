import type { SessionStatus } from "@cloakcode/protocol";

/** Compact human age from an idle-seconds value: `0s`, `6m`, `2h`, `3d`. */
export function humanAge(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.max(0, Math.floor(seconds))}s`;
}

/** Short status word shown next to a session row. */
export function statusLabel(
  status: SessionStatus,
  idleSeconds: number,
): string {
  switch (status) {
    case "blocked":
      return `blocked ${humanAge(idleSeconds)}`;
    case "active":
      return "active";
    case "idle":
      return `idle ${humanAge(idleSeconds)}`;
  }
}

export interface ToolSummary {
  label: string;
  detail?: string;
}

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      return typeof parsed === "object" && parsed
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof input === "object" && input
    ? (input as Record<string, unknown>)
    : {};
}

function basename(p: unknown): string {
  const s = String(p ?? "");
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/**
 * A VS-Code-like human summary of a tool call ("Edited x.ts", "Ran `<cmd>`")
 * derived from the tool name + input, instead of the raw tool name.
 */
export function toolSummary(name: string, input: unknown): ToolSummary {
  const a = asObject(input);
  const file = (): string => basename(a["filePath"] ?? a["path"]);

  switch (name) {
    case "read_file": {
      const f = file();
      const start = a["startLine"];
      const end = a["endLine"];
      const lines =
        typeof start === "number" && typeof end === "number"
          ? ` (${start}–${end})`
          : "";
      return f ? { label: "Read", detail: f + lines } : { label: "Read file" };
    }
    case "create_file":
      return { label: "Created", detail: file() };
    case "replace_string_in_file":
    case "insert_edit_into_file":
    case "apply_patch":
      return { label: "Edited", detail: file() };
    case "multi_replace_string_in_file": {
      const repls = Array.isArray(a["replacements"]) ? a["replacements"] : [];
      const files = new Set(
        repls.map((r) => basename(asObject(r)["filePath"])),
      );
      files.delete("");
      const detail =
        files.size === 1
          ? ([...files][0] ?? "")
          : `${files.size || repls.length} files`;
      return { label: "Edited", detail };
    }
    case "run_in_terminal": {
      const cmd = String(a["command"] ?? "").trim();
      return {
        label: "Ran",
        detail: cmd.length > 90 ? cmd.slice(0, 90) + "…" : cmd,
      };
    }
    case "grep_search":
    case "file_search":
    case "semantic_search":
      return {
        label: "Searched",
        detail: String(a["query"] ?? a["pattern"] ?? ""),
      };
    case "list_dir":
      return { label: "Listed", detail: basename(a["path"]) };
    case "fetch_webpage": {
      const urls = Array.isArray(a["urls"])
        ? a["urls"]
        : a["url"]
          ? [a["url"]]
          : [];
      return {
        label: "Fetched",
        detail: urls.length ? String(urls[0]) : String(a["query"] ?? ""),
      };
    }
    case "get_errors":
      return { label: "Checked errors" };
    default:
      return { label: name };
  }
}

/** Past-tense history verb → present-tense imperative, for pending approvals. */
const PRESENT_TENSE: Record<string, string> = {
  Created: "Create",
  Edited: "Edit",
  Ran: "Run",
  Searched: "Search",
  Listed: "List",
  Fetched: "Fetch",
};

/**
 * Like {@link toolSummary} but phrased for a still-pending approval ("Create
 * x.ts", "Run `<cmd>`") instead of completed history ("Created", "Ran").
 */
export function approvalSummary(name: string, input: unknown): ToolSummary {
  const summary = toolSummary(name, input);
  const label = PRESENT_TENSE[summary.label] ?? summary.label;
  return summary.detail !== undefined
    ? { label, detail: summary.detail }
    : { label };
}
