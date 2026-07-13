#!/usr/bin/env node
// Bundle the gateway runner into a self-contained ESM file for the Docker image
// (and any standalone run). ESM is needed for main.ts's top-level await; the
// `createRequire` banner lets bundled CJS deps (ws + its optional native addons,
// which it require()s in try/catch and falls back from) resolve at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/main.mjs",
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
console.log("[cloakcode-gateway] bundled → dist/main.mjs");
