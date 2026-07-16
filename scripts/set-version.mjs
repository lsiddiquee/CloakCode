#!/usr/bin/env node
// @ts-check
/*
 * set-version.mjs — stamp ONE product version into the shipped package.json
 * files (lockstep versioning).
 *
 * CloakCode ships two artifacts bound by the @cloakcode/protocol contract — the
 * VS Code extension and the gateway — so they release together on a single
 * version. This writes that version into the root manifest plus the two shipped
 * packages; vsce reads it from packages/extension/package.json and npm reads it
 * from packages/gateway/package.json.
 *
 * Usage:  node scripts/set-version.mjs 0.1.0
 *
 * SemVer only. A pre-release suffix (e.g. 0.1.0-rc.1) is REJECTED: the VS Code
 * Marketplace requires integer-only major.minor.patch and can't accept it, and
 * lockstep means one string feeds both artifacts. Cut pre-releases on the
 * extension's own pre-release lane (see docs/05) — not through this script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The manifests that carry the product version. Internal-only packages
// (protocol / agent / web) are bundled into these artifacts, so their version
// is cosmetic and left untouched to keep release diffs minimal.
const TARGETS = [
  "package.json",
  "packages/extension/package.json",
  "packages/gateway/package.json",
];

// Plain SemVer major.minor.patch, no pre-release / build metadata.
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.mjs <version>   (e.g. 0.1.0)");
  process.exit(1);
}
if (!STABLE_SEMVER.test(version)) {
  console.error(
    `error: "${version}" is not a plain major.minor.patch version.\n` +
      "The VS Code Marketplace rejects pre-release/build suffixes and lockstep feeds\n" +
      "this string to the extension too — use e.g. 0.1.0 (pre-releases go through the\n" +
      "extension's own pre-release lane; see docs/05).",
  );
  process.exit(1);
}

for (const rel of TARGETS) {
  const file = join(ROOT, rel);
  const text = readFileSync(file, "utf8");
  // Replace only the FIRST "version": "…" (the top-level package version).
  let replaced = false;
  const next = text.replace(/"version":\s*"[^"]*"/, (m) => {
    if (replaced) return m;
    replaced = true;
    return `"version": "${version}"`;
  });
  if (!replaced) {
    console.error(`error: no "version" field found in ${rel}`);
    process.exit(1);
  }
  writeFileSync(file, next);
  console.log(`  ${rel} -> ${version}`);
}

console.log(`\nStamped ${version} into ${TARGETS.length} manifests.`);
