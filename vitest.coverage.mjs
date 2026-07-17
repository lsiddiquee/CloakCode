// Shared Vitest v8 coverage config for the TypeScript packages.
//
// Produces a Cobertura XML report (consumed by GitHub Code Quality via
// actions/upload-code-coverage) plus a text summary and browsable HTML. Coverage
// is scoped to real, unit-testable LOGIC: entrypoints, VS Code activation glue,
// barrels, and dev/test scaffolding are excluded per package (the project's
// testing philosophy — pure layers carry the coverage, `extension` is a thin
// adapter). See docs/06 field notes and .github/copilot-instructions.md.
//
// Usage (per package vitest.config.ts):
//   import { coverage } from "../../vitest.coverage.mjs";
//   export default defineConfig({ test: { coverage: coverage({ exclude, thresholds }) } });

/**
 * @param {{ exclude?: string[], thresholds?: { statements: number, branches: number, functions: number, lines: number } }} opts
 */
export function coverage({
  exclude = [],
  // Enforced per-package floor. 85% statements/lines/functions is the headline
  // gate ("85%+ coverage"); branches sit a little lower (75%) — branch coverage
  // naturally lags and chasing it yields low-value tests. Glue/entrypoints are
  // excluded so this measures real logic. Override per package if needed.
  thresholds = { statements: 85, branches: 75, functions: 85, lines: 85 },
} = {}) {
  return {
    provider: "v8",
    reporter: ["text-summary", "cobertura", "html"],
    reportsDirectory: "./coverage",
    // Count every source file (even ones no test imports) for an honest number.
    all: true,
    include: ["src/**/*.{ts,tsx}"],
    exclude: [
      "src/**/*.test.{ts,tsx}",
      "src/**/*.d.ts",
      "src/index.ts", // barrel re-exports — no logic
      "src/test-setup.ts",
      ...exclude,
    ],
    thresholds,
  };
}
