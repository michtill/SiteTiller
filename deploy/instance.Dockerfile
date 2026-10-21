# One SiteTiller instance (all six services) in one container: scripts/serve.mjs runs them, the instance data is
# the volume /instance. Build from the repository root: docker build -f deploy/instance.Dockerfile -t sitetiller:<tag> .
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cmstudio/package.json apps/cmstudio/pnpm-lock.yaml apps/cmstudio/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# esbuild (Vite) works from its platform package; its install script is not needed (as in pnpm-workspace.yaml).
RUN pnpm install --frozen-lockfile && cd apps/cmstudio && pnpm install --frozen-lockfile --ignore-workspace --config.strict-dep-builds=false
COPY . .
RUN node scripts/build.mjs

FROM node:24-bookworm-slim
# git for the histories, ssh for a remote production Git, nss_wrapper for running under any user id (a hosting
# panel uses the domain's user), Chromium for the checks, php for the hosting's Git deploy hooks of a mounted Git.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client libnss-wrapper chromium php-cli php-curl ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory '*'
WORKDIR /app
COPY --from=build /app /app
ENV SITETILLER_INSTANCE=/instance HOME=/tmp SITETILLER_PUBLIC_PREVIEW_PORT=4541
CMD ["node", "scripts/serve.mjs"]
