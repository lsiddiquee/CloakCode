#!/usr/bin/env bash
#
# CloakCode gateway launcher.
#
# Runs the standalone gateway (serves the PWA + the WebSocket hub) and, with
# --tunnel, exposes it to your phone through a PRIVATE Microsoft Dev Tunnel.
#
# Works in two layouts, self-locating either way:
#   * assembled folder:  main.mjs + web/ sit next to this script (dist/gateway/run.sh)
#   * in-repo build:      packages/gateway/scripts/ -> ../dist/main.mjs + ../../web/dist
#
# Security: the gateway has NO app-layer auth yet. It binds 127.0.0.1 by default;
# the tunnel is always PRIVATE (never --allow-anonymous) so Dev Tunnels' own
# sign-in is the gate. Do not bind 0.0.0.0 on an untrusted network.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- locate the bundle + PWA -------------------------------------------------
if [[ -f "$HERE/main.mjs" ]]; then
  MAIN="$HERE/main.mjs"
  WEB_DEFAULT="$HERE/web"
elif [[ -f "$HERE/../dist/main.mjs" ]]; then
  MAIN="$(cd "$HERE/../dist" && pwd)/main.mjs"
  WEB_DEFAULT="$(cd "$HERE/../.." && pwd)/web/dist"
else
  echo "error: gateway bundle (main.mjs) not found." >&2
  echo "       build it first:  bash \"$HERE/assemble-gateway.sh\"" >&2
  echo "       then run:        ./dist/gateway/run.sh --tunnel" >&2
  exit 1
fi

# --- defaults (env, overridable by flags) ------------------------------------
HOST="${CLOAKCODE_GATEWAY_HOST:-127.0.0.1}"
PORT="${CLOAKCODE_GATEWAY_PORT:-7900}"
WEB_DIR="${CLOAKCODE_WEB_DIR:-$WEB_DEFAULT}"
# Empty by default so the gateway resolves the machine hostname as its instance
# id (see resolveInstanceId); only a user-set value overrides it.
INSTANCE_ID="${CLOAKCODE_INSTANCE_ID:-}"
TUNNEL="${CLOAKCODE_TUNNEL:-}"   # "devtunnel" to enable
VERBOSE="${CLOAKCODE_VERBOSE:-}" # "1" to also log per-RPC detail

install_hint() {
  case "$(uname -s)" in
    Darwin) echo "brew install --cask devtunnel" ;;
    Linux) echo "curl -sL https://aka.ms/DevTunnelCliInstall | bash" ;;
    MINGW* | MSYS* | CYGWIN*) echo "winget install Microsoft.devtunnel" ;;
    *) echo "see https://aka.ms/DevTunnelCliInstall" ;;
  esac
}

usage() {
  cat <<EOF
CloakCode gateway launcher

Usage: $(basename "${BASH_SOURCE[0]}") [options]

Options:
  --host <addr>        bind address (default 127.0.0.1; 0.0.0.0 for LAN)
  --port <n>           port (default 7900)
  --web-dir <path>     PWA directory to serve (default: the bundled web/)
  --instance-id <id>   identity: authenticator label + tunnel-name seed + phone name (default: machine hostname)
  --tunnel             expose via a PRIVATE Microsoft Dev Tunnel
  --no-tunnel          local only (default)
  --verbose            also log per-RPC detail (relay routing, sessions.list)
  -h, --help           show this help

Env equivalents:
  CLOAKCODE_GATEWAY_HOST  CLOAKCODE_GATEWAY_PORT  CLOAKCODE_WEB_DIR
  CLOAKCODE_INSTANCE_ID   CLOAKCODE_TUNNEL=devtunnel  CLOAKCODE_VERBOSE=1

Examples:
  ./run.sh --tunnel                      # phone-ready via a private tunnel
  ./run.sh --host 0.0.0.0                # LAN only, on a trusted network
  ./run.sh --tunnel --instance-id win    # distinct stable URL for this machine
EOF
}

# --- parse flags -------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:?--host needs a value}"
      shift 2
      ;;
    --port)
      PORT="${2:?--port needs a value}"
      shift 2
      ;;
    --web-dir)
      WEB_DIR="${2:?--web-dir needs a value}"
      shift 2
      ;;
    --instance-id)
      INSTANCE_ID="${2:?--instance-id needs a value}"
      shift 2
      ;;
    --tunnel)
      TUNNEL="devtunnel"
      shift
      ;;
    --no-tunnel)
      TUNNEL=""
      shift
      ;;
    --verbose)
      VERBOSE="1"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# --- preflight: node ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found — install Node.js >= 20." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if ((NODE_MAJOR < 20)); then
  echo "error: Node >= 20 required (found $(node -v))." >&2
  exit 1
fi

# --- preflight: devtunnel (only when requested) ------------------------------
if [[ "$TUNNEL" == "devtunnel" ]]; then
  if ! command -v devtunnel >/dev/null 2>&1; then
    echo "warning: --tunnel needs the 'devtunnel' CLI, which is not installed." >&2
    echo "         install: $(install_hint)" >&2
    echo "         starting WITHOUT a tunnel (local only)." >&2
    TUNNEL=""
  elif ! devtunnel user show >/dev/null 2>&1; then
    echo "warning: devtunnel is not signed in — run: devtunnel user login" >&2
    echo "         starting WITHOUT a tunnel (local only)." >&2
    TUNNEL=""
  fi
fi

# --- go ----------------------------------------------------------------------
echo "CloakCode gateway"
echo "  bundle : $MAIN"
echo "  host   : $HOST"
echo "  port   : $PORT"
echo "  web    : $WEB_DIR"
echo "  tunnel : ${TUNNEL:-off}  (instance-id: ${INSTANCE_ID:-<hostname>})"
[[ -n "$VERBOSE" ]] && echo "  verbose: on"
if [[ "$HOST" == "0.0.0.0" ]]; then
  echo "  note   : binding 0.0.0.0 exposes the gateway on your network; there is no" >&2
  echo "           app-auth yet, so only do this on a trusted LAN." >&2
fi

export CLOAKCODE_GATEWAY_HOST="$HOST"
export CLOAKCODE_GATEWAY_PORT="$PORT"
export CLOAKCODE_WEB_DIR="$WEB_DIR"
# Export only when set; empty ⇒ let the gateway default to the machine hostname.
if [ -n "$INSTANCE_ID" ]; then export CLOAKCODE_INSTANCE_ID="$INSTANCE_ID"; fi
export CLOAKCODE_TUNNEL="$TUNNEL"
export CLOAKCODE_VERBOSE="$VERBOSE"

exec node "$MAIN"
