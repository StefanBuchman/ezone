FROM node:22-alpine

WORKDIR /app
COPY protocol.mjs server.mjs ./

ENV NODE_ENV=production
ENV PORT=8787
ENV EZONE_MAINTENANCE_DATA=/data

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8787/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
