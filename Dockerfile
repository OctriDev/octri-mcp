# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist/

# Streamable HTTP is the transport the MCP spec defines for remote servers, and
# what a current client tries first. Set MCP_TRANSPORT=sse to serve the legacy
# HTTP+SSE endpoints instead.
ENV MCP_TRANSPORT=http
ENV PORT=3000
# Containers are reached from outside their own namespace, so the transport binds
# all interfaces here. The published port is the security boundary — keep it
# behind a proxy, and set MCP_ALLOWED_ORIGINS for any browser-based client.
ENV MCP_HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "dist/index.js"]
