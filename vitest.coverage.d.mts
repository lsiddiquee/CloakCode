// Types for the JS coverage helper (vitest.coverage.mjs) so config files that
// import it (e.g. packages/web/vite.config.ts, which is type-checked) stay typed.
import type { CoverageOptions } from "vitest/node";

export function coverage(opts?: {
  exclude?: string[];
  thresholds?: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };
}): CoverageOptions;
