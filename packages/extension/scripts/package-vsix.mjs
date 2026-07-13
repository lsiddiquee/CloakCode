#!/usr/bin/env node
// @ts-check
/*
 * package-vsix.mjs — build a deployable .vsix from the bundled extension.
 *
 * The workspace package is named "@cloakcode/extension" (scoped, for pnpm),
 * which vsce rejects as a VS Code extension id — and the repo ROOT already owns
 * the name "cloakcode", so we can't rename the package either. Instead we stage
 * a clean manifest with name "cloakcode" (extId → cloakcode.cloakcode) next to
 * the pre-built dist/ and package THAT. storageHashFromUri handles the resulting
 * single-segment extId (see scanner.test.ts).
 *
 * Run via `pnpm --filter @cloakcode/extension package` (bundles + builds web first).
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, ".."); // packages/extension
const src = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));

// The bundle + web must be built first (the `package` script does this).
const required = ["dist/extension.cjs", "dist/hook.cjs", "dist/web/index.html"];
for (const f of required) {
  if (!existsSync(join(EXT, f))) {
    console.error(
      `[cloakcode] missing ${f} — run \`pnpm --filter @cloakcode/extension package\` ` +
        `(it bundles + builds the web first).`,
    );
    process.exit(1);
  }
}

// Stage in a temp dir so nothing pollutes the repo.
const stage = mkdtempSync(join(tmpdir(), "cloakcode-vsix-"));
try {
  cpSync(join(EXT, "dist"), join(stage, "dist"), { recursive: true });
  if (existsSync(join(EXT, "README.md"))) {
    cpSync(join(EXT, "README.md"), join(stage, "README.md"));
  }

  // A deployable manifest: valid extension id, no scripts/deps (esbuild already
  // inlined protocol/ws/zod/qrcode-generator into dist/extension.cjs).
  const manifest = {
    name: "cloakcode",
    displayName: src.displayName,
    description: src.description,
    version: src.version,
    publisher: src.publisher,
    // license: TODO — pick an OSS license before open-sourcing (see worklist).
    repository: src.repository,
    homepage: src.homepage,
    bugs: src.bugs,
    categories: src.categories,
    keywords: src.keywords,
    engines: src.engines,
    main: "dist/extension.cjs",
    activationEvents: src.activationEvents,
    contributes: src.contributes,
  };
  for (const k of Object.keys(manifest)) {
    if (manifest[k] === undefined) delete manifest[k];
  }
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  // Staging is already clean; keep source maps out of the .vsix.
  writeFileSync(join(stage, ".vscodeignore"), "**/*.map\n.vscodeignore\n");

  const out = join(EXT, `cloakcode-${manifest.version}.vsix`);
  rmSync(out, { force: true });

  const vsce = [
    join(EXT, "node_modules/.bin/vsce"),
    resolve(EXT, "../../node_modules/.bin/vsce"),
  ].find(existsSync);
  if (!vsce) {
    console.error("[cloakcode] vsce not found — run `pnpm install`.");
    process.exit(1);
  }

  execFileSync(vsce, ["package", "--no-dependencies", "--out", out], {
    cwd: stage,
    stdio: "inherit",
  });
  console.log(`\n[cloakcode] packaged → ${out}`);
  console.log("  install:   code --install-extension " + out);
  console.log(
    `  uninstall: code --uninstall-extension ${manifest.publisher}.${manifest.name}`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
