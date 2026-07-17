#!/usr/bin/env bash
#
# strip-lockfile-tarballs.sh — make pnpm-lock.yaml registry-portable.
#
# When you resolve dependencies through a non-default registry (e.g. an internal
# supply-chain proxy configured in your ~/.npmrc), pnpm records an absolute
# `tarball:` URL in each `resolution:` that points at THAT registry's tarball
# host — URLs a public runner / another contributor cannot reach. This strips the
# `tarball:` fragment while keeping the `integrity:` hash. On install, pnpm
# reconstructs `<registry>/<name>/-/<name>-<ver>.tgz` from the active registry and
# the integrity still matches (the tarball bytes are identical across registries),
# so every version pin is preserved and the lockfile installs from ANY registry.
#
# Run automatically by the `pnpm-lock-portable` pre-commit hook whenever
# pnpm-lock.yaml is staged; also runnable by hand: `bash scripts/strip-lockfile-tarballs.sh`.
#
# See docs/06 field notes ("Registry-portable pnpm-lock.yaml") for the full rationale.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(dirname "$0")")"

LOCK="pnpm-lock.yaml"
[ -f "${LOCK}" ] || exit 0

if grep -q ', tarball: https:' "${LOCK}"; then
  # NOT `/tarball:/d` — that would delete the whole `resolution:` line incl. the
  # integrity hash. Strip only `, tarball: https://…}` back to a closing `}`.
  sed -i -E 's/, tarball: https:[^}]*\}/}/' "${LOCK}"
  echo "strip-lockfile-tarballs: removed registry tarball URLs from ${LOCK}"
fi
