#!/usr/bin/env bash
# Build and run the workspace gateway with discoverable development switches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Environment variables remain compatible fallbacks; CLI switches win.
HOST="${CLOAKCODE_GATEWAY_HOST:-127.0.0.1}"
PORT="${CLOAKCODE_GATEWAY_PORT:-7900}"
TUNNEL="${CLOAKCODE_TUNNEL:-}"
# Empty means defer to the gateway's secure-by-exposure policy.
MFA="${CLOAKCODE_MFA:-}"
INSTANCE_ID="${CLOAKCODE_INSTANCE_ID:-}"
# The dedicated provider listener (extensions connect here). Loopback for local
# dev; use --tls-host 0.0.0.0 to reach it from another host/container.
TLS_HOST="${CLOAKCODE_TLS_HOST:-127.0.0.1}"
TLS_PORT="${CLOAKCODE_TLS_PORT:-7901}"
# Empty = wss (auto self-signed cert). Set to serve an INSECURE plain-ws listener.
INSECURE_PROVIDER="${CLOAKCODE_PROVIDER_INSECURE:-}"

usage() {
  cat <<'EOF'
Run the CloakCode gateway from workspace builds.

Usage:
  task gateway:dev -- [options]

Options:
  --devtunnel         Host a private Microsoft Dev Tunnel (default: off)
  --no-devtunnel      Disable Dev Tunnel, including an environment fallback
  --mfa               Require operator TOTP
  --no-mfa            Explicitly disable operator TOTP
  --bind <address>     Operator listener bind — PWA + phone (default: 127.0.0.1)
  --port <number>      Operator listener port (default: 7900; 0 selects an ephemeral port)
  --tls-host <address> Provider listener bind — extensions connect here (default: 127.0.0.1)
  --tls-port <number>  Provider listener port (default: 7901; 0 selects an ephemeral port)
  --insecure-provider  Serve the provider listener as INSECURE plain ws:// (no cert; warned)
  --instance-id <id>   Gateway display/TOTP/tunnel name (default: machine hostname)
  -h, --help           Show these options without building or starting anything

Examples:
  task gateway:dev
  task gateway:dev -- --devtunnel
  task gateway:dev -- --mfa
  task gateway:dev -- --devtunnel --instance-id office
  task gateway:dev -- --bind 0.0.0.0 --port 3543
  task gateway:dev -- --tls-host 0.0.0.0 --tls-port 7443
  task gateway:dev -- --insecure-provider

The equivalent CLOAKCODE_GATEWAY_HOST, CLOAKCODE_GATEWAY_PORT, CLOAKCODE_TLS_HOST,
CLOAKCODE_TLS_PORT, CLOAKCODE_PROVIDER_INSECURE, CLOAKCODE_TUNNEL, CLOAKCODE_MFA,
and CLOAKCODE_INSTANCE_ID environment variables remain supported. Explicit
switches take precedence.

Without an MFA switch or CLOAKCODE_MFA, the gateway applies its own policy:
off on loopback, required for a wide bind or Dev Tunnel.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --devtunnel)
      TUNNEL="devtunnel"
      shift
      ;;
    --no-devtunnel)
      TUNNEL=""
      shift
      ;;
    --mfa)
      MFA="required"
      shift
      ;;
    --no-mfa)
      MFA="off"
      shift
      ;;
    --bind)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "error: --bind needs an address" >&2
        exit 2
      fi
      HOST="$2"
      shift 2
      ;;
    --port)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]] || ((10#$2 > 65535)); then
        echo "error: --port needs an integer from 0 to 65535" >&2
        exit 2
      fi
      PORT="$2"
      shift 2
      ;;
    --tls-host)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "error: --tls-host needs an address" >&2
        exit 2
      fi
      TLS_HOST="$2"
      shift 2
      ;;
    --tls-port)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]] || ((10#$2 > 65535)); then
        echo "error: --tls-port needs an integer from 0 to 65535" >&2
        exit 2
      fi
      TLS_PORT="$2"
      shift 2
      ;;
    --insecure-provider)
      INSECURE_PROVIDER=1
      shift
      ;;
    --instance-id)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "error: --instance-id needs a non-empty value" >&2
        exit 2
      fi
      INSTANCE_ID="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown gateway:dev option '$1'" >&2
      echo "run 'task gateway:dev -- --help' for supported options" >&2
      exit 2
      ;;
  esac
done

case "$HOST" in
  127.0.0.1 | localhost | ::1 | "[::1]") ;;
  *)
    if [[ "$MFA" == "off" ]]; then
      echo "warning: --bind $HOST exposes an MFA-disabled development gateway" >&2
    fi
    ;;
esac

export CLOAKCODE_WEB_DIR="$ROOT/packages/web/dist"
export CLOAKCODE_GATEWAY_HOST="$HOST"
export CLOAKCODE_GATEWAY_PORT="$PORT"
export CLOAKCODE_TLS_HOST="$TLS_HOST"
export CLOAKCODE_TLS_PORT="$TLS_PORT"
export CLOAKCODE_TUNNEL="$TUNNEL"
export CLOAKCODE_VERBOSE=1
if [[ -n "$INSECURE_PROVIDER" ]]; then
  export CLOAKCODE_PROVIDER_INSECURE=1
else
  unset CLOAKCODE_PROVIDER_INSECURE
fi
if [[ -n "$MFA" ]]; then
  export CLOAKCODE_MFA="$MFA"
else
  unset CLOAKCODE_MFA
fi
if [[ -n "$INSTANCE_ID" ]]; then
  export CLOAKCODE_INSTANCE_ID="$INSTANCE_ID"
else
  unset CLOAKCODE_INSTANCE_ID
fi

cd "$ROOT"
pnpm --filter @cloakcode/protocol build
pnpm --filter @cloakcode/web build
pnpm --filter @cloakcode/gateway bundle
exec node "$ROOT/packages/gateway/dist/main.mjs"
