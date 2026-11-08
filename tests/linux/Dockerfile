FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap git \
  && rm -rf /var/lib/apt/lists/*

# The classic builder creates WORKDIR as root, so create it for node first.
RUN mkdir /app && chown node:node /app

USER node
WORKDIR /app

# The host's node_modules hold darwin-only binaries, so the image installs its own.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .
