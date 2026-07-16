# Standalone CloakCode gateway — serves the PWA + the WebSocket hub that
# extensions (providers) and the phone (operator) connect to. Build context is
# the REPO ROOT: `docker build -f packages/gateway/Dockerfile -t cloakcode-gateway .`
#
# Security: there is no app-layer auth yet. Do NOT expose this on an untrusted
# network — front it with your own private tunnel/ingress (the devtunnel CLI is
# not installed in the image; run the tunnel outside, or add it yourself).
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
# The committed .npmrc/lockfile target an internal Microsoft feed unreachable from
# a public Docker build (Docker Hub / a user's machine); resolve fresh from public
# npm — same workaround as .github/workflows. pnpm 11.9 also needs Node >=22.13
# (why the base is node:24). TODO(pre-public): ship a public-registry lockfile.
RUN printf 'registry=https://registry.npmjs.org/\n' > .npmrc \
  && rm -f pnpm-lock.yaml \
  && pnpm install \
  && pnpm --filter @cloakcode/protocol build \
  && pnpm --filter @cloakcode/gateway bundle \
  && pnpm --filter @cloakcode/web build

FROM node:24-slim AS runtime
WORKDIR /app
COPY --from=build /repo/packages/gateway/dist/main.mjs ./main.mjs
COPY --from=build /repo/packages/web/dist ./web
ENV CLOAKCODE_GATEWAY_HOST=0.0.0.0 \
    CLOAKCODE_GATEWAY_PORT=3543 \
    CLOAKCODE_WEB_DIR=/app/web
EXPOSE 3543
CMD ["node", "main.mjs"]
