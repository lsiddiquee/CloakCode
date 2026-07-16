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
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
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
  const rootLicense = resolve(EXT, "..", "..", "LICENSE");
  if (existsSync(rootLicense)) {
    cpSync(rootLicense, join(stage, "LICENSE"));
  }

  // A deployable manifest: valid extension id, no scripts/deps (esbuild already
  // inlined protocol/ws/zod/qrcode-generator into dist/extension.cjs).
  const manifest = {
    name: "cloakcode",
    displayName: src.displayName,
    description: src.description,
    version: src.version,
    publisher: src.publisher,
    license: src.license,
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

  // Deployable output under <repo>/dist/extension — the .vsix plus simplified
  // install/uninstall scripts — mirroring the gateway's dist/gateway.
  const outDir = join(resolve(EXT, "..", ".."), "dist", "extension");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const vsixName = `cloakcode-${manifest.version}.vsix`;
  const out = join(outDir, vsixName);

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

  // Ship simplified (un)install helpers next to the .vsix. uninstall.sh also
  // removes the per-environment Copilot hook (a global the extension can't clean
  // up itself — VS Code has no uninstall hook), so a full removal is one command.
  const extId = `${manifest.publisher}.${manifest.name}`;
  writeFileSync(join(outDir, "install.sh"), installScript(vsixName, extId));
  writeFileSync(join(outDir, "uninstall.sh"), uninstallScript(extId));
  chmodSync(join(outDir, "install.sh"), 0o755);
  chmodSync(join(outDir, "uninstall.sh"), 0o755);

  console.log(`\n[cloakcode] packaged → ${outDir}`);
  console.log(`  ${vsixName}  +  install.sh / uninstall.sh`);
  console.log(`  install:   (cd "${outDir}" && ./install.sh)`);
  console.log(
    `  uninstall: (cd "${outDir}" && ./uninstall.sh)   # extension + Copilot hook`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}

/**
 * Bash to install the .vsix (editor CLI overridable via CODE_BIN).
 * @param {string} vsix @param {string} extId
 */
function installScript(vsix, extId) {
  return `#!/usr/bin/env bash
#
# Install the CloakCode VS Code extension from the .vsix in this folder.
#
# Usage: ./install.sh                     # uses \`code\`
#        CODE_BIN=code-insiders ./install.sh   # or codium / cursor / …
#
set -eo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CODE="$CODE_BIN"; [ -n "$CODE" ] || CODE=code

if ! command -v "$CODE" >/dev/null 2>&1; then
  echo "error: '$CODE' not on PATH — set CODE_BIN to your editor CLI (e.g. CODE_BIN=code-insiders)." >&2
  exit 1
fi

"$CODE" --install-extension "$DIR/${vsix}" --force
echo "Installed CloakCode (${extId}). Reload the window if VS Code was running."
`;
}

/**
 * Bash to uninstall the extension + remove the per-env Copilot hook.
 * @param {string} extId
 */
function uninstallScript(extId) {
  return `#!/usr/bin/env bash
#
# Uninstall the CloakCode extension AND remove its Copilot hook for THIS
# environment. The hook is a per-environment global the extension can't remove on
# its own (VS Code has no uninstall hook), so this cleans it up for you.
#
# Usage: ./uninstall.sh                    # uses \`code\`
#        CODE_BIN=code-insiders ./uninstall.sh
#        ./uninstall.sh --keep-hook        # leave the Copilot hook in place
#
set -eo pipefail
CODE="$CODE_BIN"; [ -n "$CODE" ] || CODE=code

if command -v "$CODE" >/dev/null 2>&1; then
  "$CODE" --uninstall-extension ${extId} || echo "  ('${extId}' was not installed for '$CODE')"
else
  echo "  ('$CODE' not on PATH — skipping the extension uninstall)"
fi

if [ "$1" != "--keep-hook" ]; then
  rm -f "$HOME/.copilot/hooks/cloakcode.json" "$HOME/.cloakcode/hook.cjs"
  echo "Removed the Copilot hook (~/.copilot/hooks/cloakcode.json, ~/.cloakcode/hook.cjs)."
fi
echo "Done. Reload the window if VS Code was running."
`;
}
