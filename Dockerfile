FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm
ARG RUNNER_VERSION=2.338.1
ENV RUNNER_VERSION=${RUNNER_VERSION}
ARG PLAYWRIGHT_VERSION=1.64.1
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates \
  && mkdir -p /opt/actions-runner /work \
  && curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" | tar -xz -C /opt/actions-runner \
  && /opt/actions-runner/bin/installdependencies.sh \
  && npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm \
  && useradd --create-home --shell /bin/bash runner \
  && chown -R runner:runner /opt/actions-runner /work
ENV PLAYWRIGHT_BROWSERS_PATH=/work/ms-playwright
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
USER runner
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -fsS http://127.0.0.1:8080/health > /dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
