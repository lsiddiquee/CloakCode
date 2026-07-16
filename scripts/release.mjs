#!/usr/bin/env node
// @ts-check
/*
 * release.mjs — validate a release version, then kick off the release.
 *
 * Guards (fail-fast before anything is created):
 *   - **SemVer compliant**: plain major.minor.patch, no pre-release/build suffix
 *     (the VS Code Marketplace rejects suffixes; same rule as set-version.mjs).
 *   - **Incremental**: strictly greater than the latest released version — the
 *     highest `v*` git tag, and never below the committed root version.
 *
 * On success it dispatches the **Prepare release** workflow (needs the GitHub CLI
 * `gh`, authenticated), which creates `release/vX.Y.Z` with the version bump and a
 * PR to main. Review + merge it, then tag `vX.Y.Z` to publish (release.yml).
 *
 * Usage:  node scripts/release.mjs 0.2.0     (or:  pnpm release 0.2.0)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const version = process.argv[2];
if (!version) {
  fail(
    "usage: node scripts/release.mjs <version>   (plain SemVer, e.g. 0.2.0)",
  );
}
if (!STABLE.test(version)) {
  fail(
    `"${version}" is not a plain major.minor.patch version.\n` +
      "No pre-release/build suffix (e.g. -rc.1): the VS Code Marketplace rejects them and\n" +
      "the extension + gateway release in lockstep off one version.",
  );
}

/** @param {string} v @returns {[number, number, number]} */
const parse = (v) =>
  /** @type {[number, number, number]} */ (v.split(".").map(Number));
/** Compare two X.Y.Z strings: 1 if a>b, -1 if a<b, 0 if equal. */
function cmp(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// Latest released version = the highest `v*` tag, never below the committed root
// version (in case main was bumped without a tag yet).
try {
  execFileSync("git", ["fetch", "--tags", "--quiet"], {
    cwd: ROOT,
    stdio: "ignore",
  });
} catch {
  // offline / no remote — fall back to whatever tags are local
}
let latest = readRootVersion();
for (const tag of listVersionTags()) {
  if (cmp(tag, latest) > 0) latest = tag;
}

if (cmp(version, latest) <= 0) {
  const [a, b, c] = parse(latest);
  fail(
    `version ${version} is not incremental — the latest release is ${latest}.\n` +
      `Choose a higher version, e.g. ${a}.${b}.${c + 1} (patch), ${a}.${b + 1}.0 (minor), or ${a + 1}.0.0 (major).`,
  );
}

console.log(`Releasing v${version}  (latest released: v${latest})`);
console.log("→ dispatching the Prepare release workflow…\n");
try {
  execFileSync(
    "gh",
    ["workflow", "run", "prepare-release.yml", "-f", `version=${version}`],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
} catch {
  fail(
    "failed to dispatch the workflow — is the GitHub CLI (`gh`) installed and authenticated?",
  );
}

console.log(
  `\nNext:\n` +
    `  1. Review + merge the release/v${version} PR it opens.\n` +
    `  2. git tag v${version} && git push origin v${version}   → the Release workflow publishes.`,
);

/** @returns {string} the committed root package.json version (fallback 0.0.0). */
function readRootVersion() {
  try {
    return (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ??
      "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

/** @returns {string[]} local `vX.Y.Z` tags as bare, plain-SemVer versions. */
function listVersionTags() {
  try {
    return execFileSync("git", ["tag", "-l", "v*"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((t) => t.trim().replace(/^v/, ""))
      .filter((t) => STABLE.test(t));
  } catch {
    return [];
  }
}

/** @param {string} msg */
function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
