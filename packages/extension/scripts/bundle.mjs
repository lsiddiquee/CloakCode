#!/usr/bin/env node
// Bundle the extension host entry + the Copilot hook into self-contained CJS for
// the VS Code host. Uses esbuild's JS API (not the CLI) so it's immune to the
// pnpm `.bin/esbuild` shim breaking when esbuild's postinstall swaps its launcher
// for the native binary (`node <ELF>` → SyntaxError). Mirrors gateway/bundle.mjs.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
};

// The extension host provides `vscode` at runtime — never bundle it.
await build({
  ...common,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  outfile: "dist/extension.cjs",
});

// The hook is a standalone process Copilot spawns — fully self-contained.
await build({
  ...common,
  entryPoints: ["src/hook.ts"],
  outfile: "dist/hook.cjs",
});

console.log("[cloakcode] bundled → dist/extension.cjs + dist/hook.cjs");
