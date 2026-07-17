import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage.mjs";

export default defineConfig({
  test: {
    coverage: coverage({
      // Exclude the VS Code host glue that can only run inside an extension host
      // (activation, dev-only server). The hook's process I/O glue is fenced with
      // v8-ignore in-file; its parse/dispatch logic (runHook) is unit-tested.
      exclude: ["src/extension.ts", "src/dev-server.ts"],
    }),
  },
});
