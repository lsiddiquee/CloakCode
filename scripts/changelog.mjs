#!/usr/bin/env node
// @ts-check
/*
 * changelog.mjs — build categorized release notes from Conventional Commits.
 *
 * GitHub's own `generate_release_notes` lists merged PRs since the last tag; our
 * flow lands work on `main` directly and cuts a release via a single
 * `chore(release)` PR, so the auto notes are nearly empty (just that one PR).
 * This reads the git log instead and groups commits by conventional type into a
 * useful, human-readable changelog — the DEFAULT notes for anyone who tags a
 * release, agent or not.
 *
 * Usage:
 *   node scripts/changelog.mjs                 # last tag..HEAD → stdout
 *   node scripts/changelog.mjs --to v0.2.0     # <prev tag>..v0.2.0
 *   node scripts/changelog.mjs --from v0.1.2 --to v0.2.0
 *
 * Env (optional, for the compare link): GITHUB_SERVER_URL, GITHUB_REPOSITORY.
 * Stdlib + git only; no dependencies.
 */
import { execFileSync } from "node:child_process";

// --- git helpers ---------------------------------------------------------

/** @param {string} ref @returns {string|undefined} */
function previousTag(ref) {
  // The most recent `v*` tag reachable BEFORE `ref` (so `v0.2.0` → `v0.1.2`,
  // and an untagged HEAD → the latest release tag). Undefined ⇒ from repo root.
  try {
    return git([
      "describe",
      "--tags",
      "--abbrev=0",
      "--match",
      "v*",
      `${ref}^`,
    ]);
  } catch {
    try {
      return git(["describe", "--tags", "--abbrev=0", "--match", "v*", ref]);
    } catch {
      return undefined; // no tags yet → whole history
    }
  }
}

/**
 * @param {string|undefined} from @param {string} to
 * @returns {{hash:string, subject:string, body:string}[]}
 */
function readCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  // Unit-separate fields (\x1f), record-separate commits (\x1e) so subjects/
  // bodies with any punctuation survive intact.
  const raw = git([
    "log",
    "--no-merges",
    "--pretty=format:%h%x1f%s%x1f%b%x1e",
    range,
  ]);
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, body = ""] = r.split("\x1f");
      return { hash, subject, body };
    });
}

/** @param {string[]} a @returns {string} */
function git(a) {
  return execFileSync("git", a, { encoding: "utf8" }).trim();
}

// --- rendering -----------------------------------------------------------

// Buckets in display order. Each conventional `type` maps to one; unknown /
// non-conventional commits fall to "Other".
const SECTIONS = [
  { key: "breaking", title: "### ⚠️ Breaking changes" },
  { key: "feat", title: "### 🚀 Features" },
  { key: "fix", title: "### 🐛 Bug fixes" },
  { key: "perf", title: "### ⚡ Performance" },
  { key: "refactor", title: "### ♻️ Improvements" },
  { key: "docs", title: "### 📝 Documentation" },
  { key: "build+ci", title: "### 🏗️ Build & CI" },
  { key: "test", title: "### ✅ Tests" },
  { key: "chore+style+revert", title: "### 🧹 Chores" },
  { key: "other", title: "### 📦 Other" },
];

/** type → bucket key */
const TYPE_BUCKET = {
  feat: "feat",
  fix: "fix",
  perf: "perf",
  refactor: "refactor",
  docs: "docs",
  build: "build+ci",
  ci: "build+ci",
  test: "test",
  chore: "chore+style+revert",
  style: "chore+style+revert",
  revert: "chore+style+revert",
};

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/**
 * @param {{hash:string, subject:string, body:string}[]} commits
 * @param {{from:string|undefined, to:string}} range
 */
function render(commits, { from, to }) {
  /** @type {Record<string, string[]>} */
  const buckets = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));

  for (const c of commits) {
    const m = CONVENTIONAL.exec(c.subject);
    // Drop the release-bump commit itself — it's noise in its own notes.
    if (m && m[1] === "chore" && /^release\b/.test(m[2] ?? "")) continue;

    const breaking = Boolean(m?.[3]) || /BREAKING CHANGE/.test(c.body);
    const type = m?.[1]?.toLowerCase();
    const scope = m?.[2];
    const desc = m?.[4] ?? c.subject;

    const line = `- ${scope ? `**${scope}:** ` : ""}${desc} (${c.hash})`;
    if (breaking) buckets["breaking"].push(line);
    buckets[(type && TYPE_BUCKET[type]) || "other"].push(line);
  }

  const parts = [];
  for (const { key, title } of SECTIONS) {
    if (buckets[key].length === 0) continue;
    parts.push(title, "", ...buckets[key], "");
  }

  if (parts.length === 0) parts.push("_No notable changes._", "");

  const link = compareLink(from, to);
  if (link) parts.push(link, "");

  return parts.join("\n");
}

/** @param {string|undefined} from @param {string} to @returns {string|undefined} */
function compareLink(from, to) {
  const server = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];
  if (!from) return undefined;
  if (server && repo)
    return `**Full changelog:** ${server}/${repo}/compare/${from}...${to}`;
  return `**Full changelog:** \`${from}...${to}\``;
}

/** @param {string[]} argv @returns {{from?:string, to?:string}} */
function parseArgs(argv) {
  /** @type {{from?:string, to?:string}} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") out.from = argv[++i];
    else if (argv[i] === "--to") out.to = argv[++i];
  }
  return out;
}

// --- entry (last, so the const tables above are initialized) --------------
const args = parseArgs(process.argv.slice(2));
const to = args.to ?? "HEAD";
const from = args.from ?? previousTag(to);
process.stdout.write(render(readCommits(from, to), { from, to }));
