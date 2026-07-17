#!/usr/bin/env bash
#
# docker-gateway.sh — the ONE way to build and smoke-test the CloakCode gateway
# container image. Run it in WSL / any Docker host, or in CI, so the local flow
# and the pipeline can never drift.
#
#   scripts/docker-gateway.sh            # build the image, then smoke-test it (default)
#   scripts/docker-gateway.sh build      # build only
#   scripts/docker-gateway.sh test       # smoke-test an already-built image
#   scripts/docker-gateway.sh all        # build + smoke-test (same as no arg)
#
# Options (also settable via env):
#   --image  NAME   image tag to build/run     (env IMAGE,      default cloakcode-gateway:dev)
#   --port   PORT   host port for the test run  (env HOST_PORT,  default 3543)
#   --no-cache      build without the layer cache
#   --registry URL  private npm registry for the build (corepack + pnpm), for
#                   networks where registry.npmjs.org is blocked; env NPM_REGISTRY
#   --network MODE  docker build network (e.g. 'host' — the usual WSL2 fix for a
#                   TLS/handshake failure reaching registry.npmjs.org); env DOCKER_NETWORK
#   --keep          leave the test container running (for debugging)
#   -h | --help     show this help
#
# The image is built from the REPO ROOT with packages/gateway/Dockerfile — the
# single source of truth also used by release.yml's build-push step. The smoke
# test starts the container and asserts the gateway serves the PWA (GET / → 200
# containing "CloakCode"); it needs no secrets and writes nothing persistent.
#
# Docker is required (podman with a `docker` alias also works). It is NOT present
# in this repo's dev container, so run this on your WSL/host Docker or in CI.
set -euo pipefail

# --- Resolve the repo root so the build context and Dockerfile path are stable
# regardless of the caller's cwd. ---
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { cd "$(dirname "$0")/.." && pwd; })"
cd "${ROOT}"

DOCKERFILE="packages/gateway/Dockerfile"
IMAGE="${IMAGE:-cloakcode-gateway:dev}"
HOST_PORT="${HOST_PORT:-3543}"
CONTAINER_PORT=3543
NO_CACHE=""
NETWORK="${DOCKER_NETWORK:-}"
REGISTRY="${NPM_REGISTRY:-}"
KEEP=0
CMD="all"

# --- Parse args: first bare word is the subcommand; the rest are options. ---
while [ "$#" -gt 0 ]; do
  case "$1" in
    build | test | all) CMD="$1" ;;
    --image) IMAGE="$2"; shift ;;
    --image=*) IMAGE="${1#*=}" ;;
    --port) HOST_PORT="$2"; shift ;;
    --port=*) HOST_PORT="${1#*=}" ;;
    --no-cache) NO_CACHE="--no-cache" ;;
    --registry) REGISTRY="$2"; shift ;;
    --registry=*) REGISTRY="${1#*=}" ;;
    --network) NETWORK="$2"; shift ;;
    --network=*) NETWORK="${1#*=}" ;;
    --keep) KEEP=1 ;;
    -h | --help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "docker-gateway: unknown argument '$1' (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

DOCKER="${CLOAKCODE_DOCKER:-docker}"
if ! command -v "${DOCKER}" >/dev/null 2>&1; then
  echo "docker-gateway: '${DOCKER}' not found on PATH. Install Docker (or set CLOAKCODE_DOCKER=podman)." >&2
  exit 1
fi

log() { printf '\033[36mdocker-gateway:\033[0m %s\n' "$*"; }

build_image() {
  log "building ${IMAGE} from ${DOCKERFILE} (context: repo root)"
  local flags=(-f "${DOCKERFILE}" -t "${IMAGE}")
  [ -n "${NO_CACHE}" ] && flags+=(--no-cache)
  if [ -n "${NETWORK}" ]; then
    flags+=(--network "${NETWORK}")
    log "build network: ${NETWORK}"
  fi
  if [ -n "${REGISTRY}" ]; then
    flags+=(--build-arg "NPM_REGISTRY=${REGISTRY}")
    log "npm registry: ${REGISTRY}"
  fi
  # Forward any shell proxy settings to the build (BuildKit treats these as
  # predefined build args), so a corporate proxy reaches npm during install.
  local v
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    [ -n "${!v:-}" ] && flags+=(--build-arg "${v}=${!v}")
  done
  "${DOCKER}" build "${flags[@]}" .
  log "built ${IMAGE}"
}

smoke_test() {
  local name="cloakcode-gateway-smoke-$$"
  local url="http://127.0.0.1:${HOST_PORT}/"

  # Always clean up the throwaway container (unless --keep), dumping its logs
  # first when the test failed so a CI failure is self-explanatory.
  cleanup() {
    local status=$?
    if [ "${status}" -ne 0 ]; then
      log "FAILED — container logs:"
      "${DOCKER}" logs "${name}" 2>&1 | sed 's/^/  | /' || true
    fi
    if [ "${KEEP}" -eq 1 ]; then
      log "leaving container '${name}' running (--keep); remove it with: ${DOCKER} rm -f ${name}"
    else
      "${DOCKER}" rm -f "${name}" >/dev/null 2>&1 || true
    fi
    return "${status}"
  }
  trap cleanup EXIT

  log "starting ${IMAGE} as '${name}' on host port ${HOST_PORT}"
  "${DOCKER}" run -d --name "${name}" -p "${HOST_PORT}:${CONTAINER_PORT}" "${IMAGE}" >/dev/null

  log "waiting for the gateway to serve the PWA at ${url}"
  local attempt body
  for attempt in $(seq 1 30); do
    # Bail early with a clear message if the container died on startup.
    if [ "$("${DOCKER}" inspect -f '{{.State.Running}}' "${name}" 2>/dev/null)" != "true" ]; then
      echo "docker-gateway: container exited before serving (see logs above)" >&2
      return 1
    fi
    if body="$(curl -fsS --max-time 3 "${url}" 2>/dev/null)"; then
      if printf '%s' "${body}" | grep -q "CloakCode"; then
        log "OK — gateway served the PWA (200, body contains \"CloakCode\") after ${attempt} attempt(s)"
        trap - EXIT
        cleanup
        return 0
      fi
      echo "docker-gateway: served a response but it did not contain \"CloakCode\"" >&2
      return 1
    fi
    sleep 1
  done

  echo "docker-gateway: gateway did not respond at ${url} within 30s" >&2
  return 1
}

case "${CMD}" in
  build) build_image ;;
  test) smoke_test ;;
  all)
    build_image
    smoke_test
    ;;
esac

log "done (${CMD})"
