# One image for both apps (api and fake-pos); each compose service picks its command.

# ---- all dependencies, for building ----
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json yarn.lock ./
COPY apps/api/package.json apps/api/
COPY apps/fake-pos/package.json apps/fake-pos/
# --ignore-scripts: skip `prepare` (git hooks and .env setup are for developer machines only).
RUN yarn install --frozen-lockfile --ignore-scripts

# ---- compile TypeScript ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps apps
RUN yarn build

# ---- production dependencies only ----
FROM node:22-alpine AS prod-deps
WORKDIR /repo
COPY package.json yarn.lock ./
COPY apps/api/package.json apps/api/
COPY apps/fake-pos/package.json apps/fake-pos/
RUN yarn install --frozen-lockfile --ignore-scripts --production

# ---- runtime ----
FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/fake-pos/dist apps/fake-pos/dist
# Migrations are applied by the `migrate` service from this folder.
COPY apps/api/drizzle apps/api/drizzle
USER node
