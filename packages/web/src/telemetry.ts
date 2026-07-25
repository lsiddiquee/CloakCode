import type { SessionPart, UsagePart, UsageTotals } from "@cloakcode/protocol";
import { sumUsage } from "@cloakcode/protocol";

/** One rendered transcript row: a normal part, or a per-turn usage badge. */
export type RenderRow =
  | { kind: "part"; part: SessionPart }
  | { kind: "turnUsage"; id: string; usage: UsageTotals };

/**
 * Interleave a per-turn usage badge into the parts stream: the `usage` parts of
 * a turn (all the `llm_request`s between one user message and the next) collapse
 * into a single badge placed at the **end** of that turn — one tag per turn, not
 * one per request. Turns sourced from the transcript (no telemetry) get none.
 */
export function interleaveTurnUsage(parts: SessionPart[]): RenderRow[] {
  const rows: RenderRow[] = [];
  let acc: UsagePart[] = [];
  let turnIdx = 0;
  const flush = (): void => {
    if (acc.length === 0) return;
    rows.push({
      kind: "turnUsage",
      id: `turn-usage-${turnIdx++}`,
      usage: sumUsage(acc),
    });
    acc = [];
  };
  for (const part of parts) {
    if (part.kind === "usage") {
      acc.push(part);
      continue;
    }
    // A new user message closes the previous turn — emit its badge first.
    if (part.kind === "userMessage") flush();
    rows.push({ kind: "part", part });
  }
  flush(); // trailing (in-flight / last) turn
  return rows;
}

/** Compact token counts: `364615` → `365K`, `1_250_000` → `1.3M`, `178` → `178`. */
export function compactTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

/** AI Units to a short label (`18.9`, `0.42`, `1,204`). */
export function formatAiu(aiu: number): string {
  if (aiu >= 100) return Math.round(aiu).toLocaleString();
  return aiu.toFixed(aiu >= 10 ? 1 : 2);
}
