import type { SessionPart } from "@cloakcode/protocol";

type UsagePart = Extract<SessionPart, { kind: "usage" }>;

export interface UsageTotals {
  /** Number of `llm_request` spans aggregated. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Total AI Units (`copilotUsageNanoAiu` summed ÷ 1e9); absent if none reported. */
  aiu?: number;
  /** Total credits (Windows store); absent if none reported. */
  credits?: number;
  /** Distinct models used, in first-seen order. */
  models: string[];
}

export interface UsageSummary extends UsageTotals {
  /**
   * True when the stream carries transcript-stitched history (`tx-` ids). Those
   * turns predate this session's debug-log and have **no** telemetry, so the
   * totals cover the recent (debug-log) turns only (docs/02 §4.14) — the view
   * shows a "partial" disclaimer.
   */
  partial: boolean;
}

/** Sum a set of `usage` parts (shared by the session total + per-turn badge). */
function sumUsage(usage: UsagePart[]): UsageTotals {
  const models: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let nanoAiu = 0;
  let credits = 0;
  for (const u of usage) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cachedTokens += u.cachedTokens;
    if (u.nanoAiu !== undefined) nanoAiu += u.nanoAiu;
    if (u.credits !== undefined) credits += u.credits;
    if (!models.includes(u.model)) models.push(u.model);
  }
  // Only surface a cost when it's genuinely reported (> 0). Custom / BYO models
  // leave `copilotUsageNanoAiu` absent, null, or 0 — never show a misleading
  // "0 AIU" for those; the client just omits the cost.
  return {
    requests: usage.length,
    inputTokens,
    outputTokens,
    cachedTokens,
    ...(nanoAiu > 0 ? { aiu: nanoAiu / 1e9 } : {}),
    ...(credits > 0 ? { credits } : {}),
    models,
  };
}

/**
 * Aggregate the per-request `usage` parts into a session total. Returns `null`
 * when no telemetry is present (e.g. a pure-transcript session whose debug-log
 * was recycled away) so the view can say "unavailable" rather than show zeros.
 */
export function summarizeUsage(parts: SessionPart[]): UsageSummary | null {
  const usage = parts.filter((p): p is UsagePart => p.kind === "usage");
  if (usage.length === 0) return null;
  return {
    ...sumUsage(usage),
    partial: parts.some((p) => p.id.startsWith("tx-")),
  };
}

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
