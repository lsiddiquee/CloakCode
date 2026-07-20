# Standalone CloakCode gateway — serves the PWA + the WebSocket hub that
# extensions (providers) and the phone (operator) connect to. Build context is
# the REPO ROOT: `docker build -f packages/gateway/Dockerfile -t cloakcode-gateway .`
#
# Security: the operator (phone) is gated by TOTP when exposed (F2a) and providers
# authenticate with a TOTP-issued or static token; still prefer a PRIVATE tunnel
# over a wide bind on an untrusted network. Persist the MFA secret across container
# replacement with `-v cloakcode-mfa:/home/app/.cloakcode` (see the gateway README).
# The image bundles the `devtunnel` CLI so it can host a private tunnel itself
# (opt in with CLOAKCODE_TUNNEL=devtunnel; headless device-code sign-in defaults
# to GitHub, CLOAKCODE_TUNNEL_PROVIDER=microsoft for Microsoft); otherwise front
# the published port with your own private tunnel/ingress.
FROM node:25-slim AS build
WORKDIR /repo
# Optional private/corporate npm registry for networks where the public
# registry.npmjs.org is unreachable (e.g. a Microsoft package-feed proxy). Empty
# ⇒ default public npm. Passed by `scripts/docker-gateway.sh --registry <url>`
# (or NPM_REGISTRY); applies to the pnpm install AND the pnpm-via-npm bootstrap.
ARG NPM_REGISTRY=
# Point npm (and thus pnpm, which reads the same ~/.npmrc) at the registry before
# anything is fetched.
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi
COPY . .
# Install pnpm via **npm**, not corepack: corepack fetches from a non-standard
# registry path (`<registry>/pnpm/<version>`) that corporate mirrors/proxies
# often 404, whereas `npm i -g` is an ordinary package install every feed serves.
# The version is pinned to the root `packageManager` field (one source of truth,
# no drift). The committed pnpm-lock.yaml is registry-portable (integrity-only,
# no absolute tarball URLs), so --frozen-lockfile installs from ANY registry with
# every version pin intact. pnpm 11.9 needs Node >=22.13 (why the base is node:24).
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" \
  && npm install -g "pnpm@${PNPM_VERSION}" \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @cloakcode/protocol build \
  && pnpm --filter @cloakcode/gateway bundle \
  && pnpm --filter @cloakcode/web build

FROM node:25-slim AS runtime
# Bundle the Microsoft Dev Tunnels CLI so `CLOAKCODE_TUNNEL=devtunnel` works out
# of the box (inert unless enabled). It's a self-contained .NET single-file that
# needs libsecret AND ICU (libicu) at runtime: the current build aborts on
# startup under invariant globalization ("Couldn't find a valid ICU package…" —
# its LimitsCommand reads TimeZoneInfo/CurrentUICulture), so we install the ICU
# runtime instead of relying on DOTNET_SYSTEM_GLOBALIZATION_INVARIANT. The libicu
# package is SO-versioned per Debian release (libicu72/76/…), so resolve whatever
# this base image ships rather than pinning. Downloaded directly (arch-aware)
# rather than via the aka.ms installer, which does its own `sudo apt-get` + PATH
# edits we don't want in an image layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libsecret-1-0 curl \
  && apt-get install -y --no-install-recommends \
       "$(apt-cache search --names-only '^libicu[0-9]+$' | cut -d' ' -f1 | sort -V | tail -n1)" \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) t=linux-x64 ;; \
       arm64) t=linux-arm64 ;; \
       *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /usr/local/bin/devtunnel "https://tunnelsassetsprod.blob.core.windows.net/cli/${t}-devtunnel" \
  && chmod 0755 /usr/local/bin/devtunnel \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# Non-root runtime user with a stable, writable HOME. Pre-create the Dev Tunnels
# token dir AND the MFA secret dir (~/.cloakcode) owned by `app` so a fresh named
# volume mounted at either inherits that ownership (Docker seeds a new volume from
# the image path). Persist the tunnel token with
# `-v cloakcode-devtunnel:/home/app/.local/share/DevTunnels` and the operator TOTP
# secret with `-v cloakcode-mfa:/home/app/.cloakcode`.
RUN useradd -m -u 10001 app \
  && mkdir -p /home/app/.local/share/DevTunnels /home/app/.cloakcode /app \
  && chmod 0700 /home/app/.cloakcode \
  && chown -R app:app /home/app /app
COPY --chmod=0755 packages/gateway/scripts/docker-entrypoint.sh /usr/local/bin/cloakcode-entrypoint.sh
USER app
WORKDIR /app
# OCI metadata: `source` links the image to the repo on GHCR (which then renders
# this repo's gateway README on the package page), the rest populate the registry
# listing. See packages/gateway/README.md for usage.
LABEL org.opencontainers.image.title="CloakCode gateway" \
      org.opencontainers.image.description="Run-it-yourself CloakCode gateway — serves the phone PWA + WebSocket hub for observing and steering GitHub Copilot from your phone." \
      org.opencontainers.image.source="https://github.com/lsiddiquee/CloakCode" \
      org.opencontainers.image.url="https://github.com/lsiddiquee/CloakCode" \
      org.opencontainers.image.documentation="https://github.com/lsiddiquee/CloakCode/blob/main/packages/gateway/README.md" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build --chown=app:app /repo/packages/gateway/dist/main.mjs ./main.mjs
COPY --from=build --chown=app:app /repo/packages/web/dist ./web
ENV CLOAKCODE_GATEWAY_HOST=0.0.0.0 \
    CLOAKCODE_GATEWAY_PORT=3543 \
    CLOAKCODE_WEB_DIR=/app/web
EXPOSE 3543
# The entrypoint handles the optional Dev Tunnels sign-in (only when
# CLOAKCODE_TUNNEL=devtunnel), then execs the CMD.
ENTRYPOINT ["cloakcode-entrypoint.sh"]
CMD ["node", "main.mjs"]
