#!/usr/bin/env bash
#
# CloakCode dev container post-create setup.
#
# Invoked by .devcontainer/devcontainer.json:
#     "postCreateCommand": "bash .devcontainer/post-create.sh"
#
# Philosophy: RESILIENT and idempotent. Must run cleanly on a fresh clone BEFORE the
# monorepo packages have any real source, and on every rebuild. We do NOT use `set -e`:
# a single optional step must never fail the whole container build. Required steps run
# straight; optional ones are guarded.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

CACHE_DIR="/.devcontainercache"

echo "==> CloakCode post-create: starting (repo root: ${REPO_ROOT})"

# 1. Persisted cache directory ----------------------------------------------
# The named volume is created as root; make it writable by the remote user.
echo "==> cache: ensuring ${CACHE_DIR} is owned by $(whoami)"
sudo mkdir -p "${CACHE_DIR}" || true
sudo chown -R "$(whoami)":"$(whoami)" "${CACHE_DIR}" || true

# 2. Git configuration -------------------------------------------------------
echo "==> git: init (if needed) + safe.directory + editor"
[ -d .git ] || git init -q || true
git config --global --add safe.directory "${REPO_ROOT}" || true
git config --global core.editor "code --wait" || true

# 3. pnpm --------------------------------------------------------------------
# Use the pnpm that ships in the base image (a real install that sits ahead of
# any corepack shim on PATH). We deliberately do NOT corepack-provision the pinned
# `packageManager` version: the Microsoft package-feed proxy (.npmrc) is a
# whole-package-metadata mirror that 404s the per-version manifest and redirects
# tarballs, so corepack/pnpm self-provisioning can't fetch pnpm from it. Instead
# `pmOnFail: ignore` (pnpm-workspace.yaml) makes pnpm use the installed version.
echo "==> pnpm: using base-image pnpm ($(pnpm --version 2>/dev/null || echo '?'))"
pnpm config set store-dir "${CACHE_DIR}/pnpm-store" || true

# 4. Global VS Code extension tooling (guarded) ------------------------------
# @vscode/vsce (package/publish .vsix), yo + generator-code (scaffold extensions).
echo "==> tooling: installing @vscode/vsce + generator-code (global, guarded)"
pnpm add -g @vscode/vsce yo generator-code >/dev/null 2>&1 || true

# 5. Install workspace dependencies if a manifest exists (guarded) -----------
# `--config.confirmModulesPurge=false` suppresses pnpm 11's interactive "the
# modules directory will be removed and reinstalled — Proceed?" prompt, which
# fires when node_modules was created by an older pnpm. post-create is
# non-interactive, so any prompt would hang or be silently auto-answered.
if [ -f pnpm-workspace.yaml ] || [ -f package.json ]; then
  echo "==> deps: pnpm install"
  pnpm install --config.confirmModulesPurge=false || true
else
  echo "==> deps: no manifest yet — skipping pnpm install"
fi

# 6. Python: Poetry + dev env (guarded) --------------------------------------
# The research/observer tooling under research/ is Poetry-managed (in-project .venv).
echo "==> python: installing poetry via pipx"
if ! command -v poetry >/dev/null 2>&1; then
  pipx install poetry >/dev/null 2>&1 || true
fi
pipx inject poetry poetry-plugin-export >/dev/null 2>&1 || true
if command -v poetry >/dev/null 2>&1 && [ -f pyproject.toml ]; then
  echo "==> python: poetry install (dev deps: ruff, mypy, pytest)"
  poetry install --no-interaction || true
else
  echo "==> python: poetry or pyproject.toml missing — skipping"
fi

# 7. pre-commit framework + git hooks (guarded) ------------------------------
echo "==> pre-commit: installing framework via pipx"
if ! command -v pre-commit >/dev/null 2>&1; then
  pipx install pre-commit >/dev/null 2>&1 || true
fi
if command -v pre-commit >/dev/null 2>&1 && [ -f .pre-commit-config.yaml ] && [ -d .git ]; then
  echo "==> pre-commit: installing pre-commit + commit-msg hooks"
  pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg || true
else
  echo "==> pre-commit: framework/config/git repo missing — skipping hook install"
fi

# 8. devtunnel CLI (remote-access tunnel for the phone client) — guarded + cached
# The Microsoft installer drops a ~59MB binary in ~/bin, which is NOT persisted
# across rebuilds, so cache it in the named volume and symlink it onto PATH each
# build (fast, offline-friendly rebuilds). Optional: a failure never fails the build.
echo "==> devtunnel: ensuring the CLI is installed (cached)"
DEVTUNNEL_CACHE="${CACHE_DIR}/bin/devtunnel"
if [ ! -x "${DEVTUNNEL_CACHE}" ]; then
  mkdir -p "${CACHE_DIR}/bin"
  curl -sL https://aka.ms/DevTunnelCliInstall | bash >/dev/null 2>&1 || true
  for cand in "${HOME}/bin/devtunnel" "${HOME}/.local/bin/devtunnel"; do
    [ -x "${cand}" ] && cp "${cand}" "${DEVTUNNEL_CACHE}" && break
  done
fi
if [ -x "${DEVTUNNEL_CACHE}" ]; then
  sudo ln -sf "${DEVTUNNEL_CACHE}" /usr/local/bin/devtunnel || true
else
  echo "==> devtunnel: install skipped/failed (optional — remote tunnel only)"
fi

echo "==> CloakCode post-create: complete."
