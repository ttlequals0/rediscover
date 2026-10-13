FROM node:22-alpine

ARG VERSION=dev
LABEL org.opencontainers.image.title="rediscover" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json ./
COPY src ./src

USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
