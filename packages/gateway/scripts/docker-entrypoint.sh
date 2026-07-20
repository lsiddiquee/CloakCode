#!/bin/sh
# CloakCode gateway container entrypoint.
#
# Default path: does nothing but `exec` the gateway — the tunnel is INERT unless
# you opt in with CLOAKCODE_TUNNEL=devtunnel.
#
# With CLOAKCODE_TUNNEL=devtunnel it ensures a Dev Tunnels sign-in before start:
#   * already signed in (persisted token volume) → straight through.
#   * not signed in → a **device-code** login. This works HEADLESS: `docker run
#     -it` is NOT required — the code prints to the console / `docker logs`, you
#     finish it in any browser, and hosting starts once it completes. The login
#     provider defaults to GitHub; set CLOAKCODE_TUNNEL_PROVIDER=microsoft for a
#     Microsoft account. If the device code expires the login fails and the
#     container exits (set -eu) — just restart and try again.
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
    # Pick the login provider. Default GitHub (most CloakCode users already have a
    # GitHub account); set CLOAKCODE_TUNNEL_PROVIDER=microsoft for a Microsoft
    # account. A typo'd value fails fast instead of silently picking a provider.
    provider="${CLOAKCODE_TUNNEL_PROVIDER:-github}"
    case "$provider" in
      github) prov="-g" ;;
      microsoft) prov="" ;;
      *)
        echo "CloakCode: invalid CLOAKCODE_TUNNEL_PROVIDER='$provider' (use 'github' or 'microsoft')." >&2
        exit 1
        ;;
    esac
    # Device-code sign-in is HEADLESS — no TTY, so `docker run -it` is NOT needed.
    # `-d` forces the device-code flow: it prints a URL + code (also in
    # `docker logs`), then BLOCKS until you complete it in any browser and hosting
    # starts. If the code expires the login fails and the container exits (set -eu)
    # — just restart. Persist the token to sign in only once:
    #   -v cloakcode-devtunnel:/home/app/.local/share/DevTunnels
    echo "CloakCode: signing in to Dev Tunnels via device code (${provider})…"
    echo "CloakCode: open the URL below and enter the code (also in \`docker logs\`); hosting starts once you finish."
    devtunnel user login -d $prov
  fi
fi

exec "$@"
