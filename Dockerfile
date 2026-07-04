FROM node:22-alpine

WORKDIR /app

# Built-in SQLite needs the experimental flag on Node <22.5; stable from 22.5+.
# node:22-alpine ships 22.x where the flag is still needed at startup.
COPY package*.json ./
RUN npm ci --omit=dev

COPY analytics-client.js ./
COPY bootstrap-env.js ./
COPY server.js ./
COPY workers.js ./
COPY google-media.js ./
COPY media-tools.js ./
COPY templates-media.js ./
COPY workers-ui.html ./
COPY assets/ ./assets/
COPY brand/ ./brand/
COPY mcp-client.js ./
COPY skills.js ./
COPY legal-pages.js ./
COPY docs/legal ./docs/legal
COPY url-security.js ./
COPY integrations/ ./integrations/
COPY payment-webhooks.js ./
COPY paddle-billing.js ./
COPY embed-widget.js ./
COPY whatsapp-webhook.js ./
COPY whatsapp-router.js ./

# Optional: cloudflared binary so the container can expose itself publicly
# without any cloud account. Disable with INSTALL_TUNNEL=0.
ARG INSTALL_TUNNEL=1
RUN if [ "$INSTALL_TUNNEL" = "1" ]; then \
      apk add --no-cache curl ca-certificates && \
      curl -fsSL -o /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
      chmod +x /usr/local/bin/cloudflared; \
    fi

ENV NODE_OPTIONS="--experimental-sqlite --no-warnings"
ENV PORT=8765
ENV RATE_LIMIT_PER_MIN=120
ENV DB_PATH=/app/data/earnings.db
ENV TENANTS_DIR=/app/data/tenants

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8765}/health" || exit 1

CMD ["node", "server.js"]
