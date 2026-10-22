# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    LIBRARY_ROOT=/app/library \
    LIBRARIES_ROOT=/app/libraries \
    XDG_CACHE_HOME=/tmp/.cache

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# curl è usato come trasporto alternativo per AO3 (Cloudflare blocca spesso
# il client TLS di Node con 525/403); fontconfig + ttf-dejavu servono a
# @napi-rs/canvas per disegnare il testo delle copertine generate.
RUN apk add --no-cache curl fontconfig ttf-dejavu && npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY shared ./shared

# L'app gira come utente non root (node, uid 1000) e scrive solo in data,
# library e libraries; il resto del file system puo' essere montato in sola lettura.
# XDG_CACHE_HOME punta a /tmp (tmpfs) per la cache di fontconfig.
RUN mkdir -p /app/data /app/library /app/libraries && chown -R node:node /app/data /app/library /app/libraries
USER node
VOLUME ["/app/library", "/app/libraries", "/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "server/dist/server/src/index.js"]
