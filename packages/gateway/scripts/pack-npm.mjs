#!/usr/bin/env node
// @ts-check
/*
 * pack-npm.mjs — stage a self-contained, publishable @cloakcode/gateway package.
 *
 * The workspace package can't be published as-is: it depends on
 * @cloakcode/protocol via `workspace:*` (unpublished) and its `main` is the
 * unbundled tsc output. Instead we publish the esbuild BUNDLE (protocol + ws +
 * zod inlined) plus the PWA, behind a clean manifest with no runtime deps and a
 * `bin` → main.mjs so `npx @cloakcode/gateway` just works. Mirrors the
 * extension's package-vsix.mjs.
 *
 * Reads the assembled output (dist/gateway = main.mjs + web/, produced by
 * `pnpm --filter @cloakcode/gateway assemble`) and stages a publish-ready
 * package into <repo>/dist/gateway-npm, ready for:
 *     npm publish dist/gateway-npm --access public
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, ".."); // packages/gateway
const ROOT = resolve(PKG, "..", ".."); // repo root
const ASSEMBLED = join(ROOT, "dist", "gateway"); // main.mjs + web/ (from `assemble`)
const OUT = join(ROOT, "dist", "gateway-npm");

const src = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

for (const f of ["main.mjs", "web/index.html"]) {
  if (!existsSync(join(ASSEMBLED, f))) {
    console.error(
      `[cloakcode-gateway] missing ${f} in ${ASSEMBLED} — run ` +
        "`pnpm --filter @cloakcode/gateway assemble` first.",
    );
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ASSEMBLED, "main.mjs"), join(OUT, "main.mjs"));
chmodSync(join(OUT, "main.mjs"), 0o755); // executable as the npx bin
cpSync(join(ASSEMBLED, "web"), join(OUT, "web"), { recursive: true });
if (existsSync(join(PKG, "README.md"))) {
  cpSync(join(PKG, "README.md"), join(OUT, "README.md"));
}
if (existsSync(join(ROOT, "LICENSE"))) {
  cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));
}

// A clean, self-contained manifest: no dependencies (all bundled), not private,
// bin/main point at the bundle. Optional fields are copied through when present.
const manifest = {
  name: src.name,
  version: src.version,
  description: src.description,
  type: "module",
  bin: { "cloakcode-gateway": "main.mjs" },
  main: "main.mjs",
  files: ["main.mjs", "web", "README.md", "LICENSE"],
  engines: { node: ">=20" },
  repository: src.repository,
  homepage: src.homepage,
  bugs: src.bugs,
  keywords: src.keywords,
  license: src.license,
  publishConfig: { access: "public" },
};
for (const k of Object.keys(manifest)) {
  if (manifest[/** @type {keyof typeof manifest} */ (k)] === undefined) {
    delete manifest[/** @type {keyof typeof manifest} */ (k)];
  }
}
writeFileSync(
  join(OUT, "package.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`[cloakcode-gateway] staged npm package → ${OUT}`);
console.log(`  publish: npm publish "${OUT}" --access public`);
