FROM postgres:17-alpine AS database
COPY infrastructure/docker/staging/roles.sql /docker-entrypoint-initdb.d/01-staging-roles.sql

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-fund --no-audit

FROM dependencies AS migration
COPY src/db/migrations ./src/db/migrations
COPY scripts/*staging*.mjs ./scripts/
ENV NODE_ENV=production
USER node
CMD ["sh", "-ec", "node scripts/migrate-staging.mjs && node scripts/seed-staging-demo.mjs"]

FROM dependencies AS build
COPY src ./src
COPY public ./public
COPY next.config.ts tsconfig.json instrumentation.ts ./
# Page compilation imports the pool constructors. These build-only URLs point to
# a closed loopback port and carry no credentials.
RUN NEXT_TELEMETRY_DISABLED=1 GPHKM_STANDALONE_BUILD=true \
    DATABASE_URL=postgres://gphkm_runtime@127.0.0.1:1/build \
    MFA_PROOF_DATABASE_URL=postgres://gphkm_mfa_proof@127.0.0.1:1/build npm run build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
