FROM postgres:17-alpine AS database
# Keep PostgreSQL's bundled OpenSSL runtime libraries on the current Alpine security release.
RUN apk upgrade --no-cache libcrypto3 libssl3
COPY infrastructure/docker/staging/roles.sql /docker-entrypoint-initdb.d/01-staging-roles.sql
COPY infrastructure/docker/staging/provision-worker.sql /opt/gphkm/provision-worker.sql

FROM node:24-trixie-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-fund --no-audit

FROM dependencies AS migration
COPY src/db/migrations ./src/db/migrations
COPY scripts/*staging*.mjs ./scripts/
# The runtime entrypoint invokes Node directly and does not need the global package manager.
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
USER node
CMD ["sh", "-ec", "node scripts/migrate-staging.mjs && node scripts/seed-staging-demo.mjs"]

FROM dependencies AS worker-build
COPY src ./src
COPY scripts/customer-notification-worker.ts ./scripts/
COPY tsconfig.json ./
RUN ./node_modules/.bin/esbuild scripts/customer-notification-worker.ts --bundle --platform=node --format=esm --target=node24 --conditions=react-server --packages=external --outfile=worker.mjs

FROM dependencies AS worker-production-dependencies
RUN npm prune --omit=dev --no-fund --no-audit

FROM node:24-trixie-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=worker-production-dependencies /app/node_modules ./node_modules
COPY --from=worker-build /app/worker.mjs ./worker.mjs
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node
CMD ["node", "--conditions=react-server", "worker.mjs"]

FROM dependencies AS build
COPY src ./src
COPY public ./public
COPY next.config.ts tsconfig.json instrumentation.ts ./
# Page compilation imports the pool constructors. These build-only URLs point to
# a closed loopback port and carry no credentials.
RUN NEXT_TELEMETRY_DISABLED=1 GPHKM_STANDALONE_BUILD=true \
    DATABASE_URL=postgres://gphkm_runtime@127.0.0.1:1/build \
    MFA_PROOF_DATABASE_URL=postgres://gphkm_mfa_proof@127.0.0.1:1/build npm run build

FROM node:24-trixie-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# The web entrypoint and health check invoke Node directly.
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p .next/cache \
    && chown node:node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
