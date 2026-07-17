import type { SessionPart } from "@cloakcode/protocol";

type UsagePart = Extract<SessionPart, { kind: "usage" }>;

export interface UsageSummary {
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
  /**
   * True when the stream carries transcript-stitched history (`tx-` ids). Those
   * turns predate this session's debug-log and have **no** telemetry, so the
   * totals cover the recent (debug-log) turns only (docs/02 §4.14) — the view
   * shows a "partial" disclaimer.
   */
  partial: boolean;
}

/**
 * Aggregate the per-request `usage` parts into a session total. Returns `null`
 * when no telemetry is present (e.g. a pure-transcript session whose debug-log
 * was recycled away) so the view can say "unavailable" rather than show zeros.
 */
export function summarizeUsage(parts: SessionPart[]): UsageSummary | null {
  const usage = parts.filter((p): p is UsagePart => p.kind === "usage");
  if (usage.length === 0) return null;
  const models: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let nanoAiu = 0;
  let credits = 0;
  let anyAiu = false;
  let anyCredits = false;
  for (const u of usage) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cachedTokens += u.cachedTokens;
    if (u.nanoAiu !== undefined) {
      nanoAiu += u.nanoAiu;
      anyAiu = true;
    }
    if (u.credits !== undefined) {
      credits += u.credits;
      anyCredits = true;
    }
    if (!models.includes(u.model)) models.push(u.model);
  }
  return {
    requests: usage.length,
    inputTokens,
    outputTokens,
    cachedTokens,
    ...(anyAiu ? { aiu: nanoAiu / 1e9 } : {}),
    ...(anyCredits ? { credits } : {}),
    models,
    partial: parts.some((p) => p.id.startsWith("tx-")),
  };
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
