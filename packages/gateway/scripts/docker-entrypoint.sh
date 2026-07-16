#!/bin/sh
# CloakCode gateway container entrypoint.
#
# Default path: does nothing but `exec` the gateway — the tunnel is INERT unless
# you opt in with CLOAKCODE_TUNNEL=devtunnel.
#
# With CLOAKCODE_TUNNEL=devtunnel it ensures a Dev Tunnels sign-in before start:
#   * already signed in (persisted token volume) → straight through.
#   * not signed in → a **device-code** login (works headless: the code prints to
#     the console / `docker logs`, you finish it in any browser, and hosting
#     starts once it completes). The provider is REQUIRED and explicit via
#     CLOAKCODE_TUNNEL_PROVIDER=github|microsoft (no default).
#
# The token persists under $HOME/.local/share/DevTunnels — mount it as a volume
# (`-v cloakcode-devtunnel:/home/app/.local/share/DevTunnels`) to sign in once.
set -eu

if [ "${CLOAKCODE_TUNNEL:-}" = "devtunnel" ]; then
  # `devtunnel user show` exits 0 whether or not you're signed in (it prints
  # "Logged in as …" vs "Not logged in."), so detect state from the output text.
  if devtunnel user show 2>/dev/null | grep -q "Logged in as"; then
    echo "CloakCode: Dev Tunnels — already signed in."
  else
    case "${CLOAKCODE_TUNNEL_PROVIDER:-}" in
      github) prov="-g" ;;
      microsoft) prov="" ;;
      *)
        echo "CloakCode: CLOAKCODE_TUNNEL=devtunnel needs a one-time sign-in." >&2
        echo "  1. Set CLOAKCODE_TUNNEL_PROVIDER=github or microsoft." >&2
        echo "  2. Run interactively (docker run -it …) and complete the device-code login." >&2
        echo "  3. Persist it so you only sign in once:" >&2
        echo "       -v cloakcode-devtunnel:/home/app/.local/share/DevTunnels" >&2
        exit 1
        ;;
    esac
    echo "CloakCode: signing in to Dev Tunnels via device code (${CLOAKCODE_TUNNEL_PROVIDER})…"
    echo "CloakCode: open the URL below and enter the code; hosting starts once you finish."
    # `-d` forces device-code (no browser needed here); it prints the code + URL
    # and blocks until you complete it, then returns.
    devtunnel user login -d $prov
  fi
fi

exec "$@"
