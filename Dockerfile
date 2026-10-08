FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json server.js decisions.js endpoints.js ./
COPY public ./public
USER bun
CMD ["bun", "server.js"]
