# syntax=docker/dockerfile:1

# ---- build stage: compile the native deps (better-sqlite3, bcrypt) ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain required to compile the native modules from source
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install production deps against the lockfile for reproducible builds
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage: slim image with just the built app ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Bring in the already-compiled node_modules, then the app source
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node . .

# Run unprivileged; the SQLite save DB (./ff3mmo.db) is written here at runtime
RUN chown node:node /app
USER node

# server.js listens on 3000
EXPOSE 3000

# Provide JWT_SECRET at run time, e.g.:
#   docker run -e JWT_SECRET=... -p 3000:3000 ff3mmo
# Persist saves by bind-mounting the DB, e.g.:
#   -v ff3mmo-data:/app/ff3mmo.db   (or mount a data dir)
CMD ["node", "server.js"]
