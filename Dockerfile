# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
# Code mode's Python interpreter: imported at build time, loaded at run time.
COPY vendor/ ./vendor/

RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/vendor ./vendor/

# Streamable HTTP is the transport the MCP spec defines for remote servers, and
# what a current client tries first. Set MCP_TRANSPORT=sse to serve the legacy
# HTTP+SSE endpoints instead, or MCP_TRANSPORT=stdio to run it as a local server.
ENV MCP_TRANSPORT=http
ENV PORT=3000
# Containers are reached from outside their own namespace, so the transport binds
# all interfaces here. The server then refuses to start without MCP_AUTH_TOKEN,
# and every request must send it as a bearer token. Set MCP_ALLOWED_ORIGINS for
# any browser-based client.
ENV MCP_HOST=0.0.0.0

EXPOSE 3000

USER node

# Only an HTTP transport has anything to probe; over stdio the check passes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD [ "$MCP_TRANSPORT" != "http" ] || wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
