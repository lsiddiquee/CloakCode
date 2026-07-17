import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage.mjs";

export default defineConfig({
  test: {
    coverage: coverage({
      // main.ts is the CLI entrypoint (process wiring + console UI) — exercised
      // end-to-end, not unit-tested.
      exclude: ["src/main.ts"],
    }),
  },
});
